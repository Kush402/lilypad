/**
 * Pinned TLS for the desktop LAN control plane (iOS native module).
 * Falls back to regular fetch/WebSocket when pinning is unavailable.
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { appError, ClassifiedError } from './errors';

const Native = NativeModules.LilypadLanTls as
  | ({
      fetch: (
        url: string,
        expectedSha256: string,
        method: string,
        headers: Record<string, string>,
        body: string | null,
      ) => Promise<{ status: number; body: string }>;
      /**
       * Allocate and register a pinned socket WITHOUT starting its handshake,
       * returning its id. Deliberately two calls rather than one: see
       * `connectNative` for the event this ordering exists to stop losing.
       */
      createWebSocket: (url: string, expectedSha256: string) => Promise<number>;
      /** Begin the handshake for a socket JS has finished subscribing to. */
      startWebSocket: (socketId: number) => void;
      sendWebSocket: (socketId: number, text: string) => void;
      closeWebSocket: (socketId: number) => void;
    } & {
      addListener: (eventType: string) => void;
      removeListeners: (count: number) => void;
    })
  | undefined;

const emitter = Native ? new NativeEventEmitter(Native) : null;

export function lanPinningAvailable(): boolean {
  return Native != null && (Platform.OS === 'ios' || Platform.OS === 'android');
}

export async function lanFetch(
  url: string,
  expectedSha256: string,
  init?: RequestInit,
): Promise<Response> {
  // A pin is always required here. Silently falling through to stock `fetch`
  // used to look safe because the self-signed LAN cert made the request fail
  // anyway — until the host held a publicly-trusted certificate, and the pin
  // was simply not enforced. Refuse rather than quietly unpin.
  if (!lanPinningAvailable()) {
    throw new ClassifiedError(appError('lan_pinning_unavailable'));
  }
  const headers: Record<string, string> = {};
  if (init?.headers) {
    new Headers(init.headers).forEach((v: string, k: string) => {
      headers[k] = v;
    });
  }
  const body =
    init?.body == null
      ? null
      : typeof init.body === 'string'
        ? init.body
        : JSON.stringify(init.body);
  const result = await Native!.fetch(url, expectedSha256, init?.method ?? 'GET', headers, body);
  return new Response(result.body, { status: result.status });
}

/** The authority component of a URL, lowercased, without userinfo or port. */
function hostOf(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
  if (!m || !m[1]) return null;
  const authority = m[1].slice(m[1].lastIndexOf('@') + 1);
  // IPv6 literals are bracketed, and their colons are not the port separator.
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end === -1 ? null : authority.slice(1, end).toLowerCase() || null;
  }
  const colon = authority.indexOf(':');
  return (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase() || null;
}

/** Any dotted-quad IPv4 — matches what `detect_lan_ipv4` may advertise. */
function isIpv4Literal(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Could this URL plausibly be the laptop's own LAN endpoint — the only thing a
 * LAN pin is ever valid for?
 *
 * The desktop advertises itself as a bare IPv4 literal
 * (`apps/desktop/src-tauri/src/lan/endpoints.rs` — any non-loopback,
 * non-link-local address, including Tailscale CGNAT and campus public IPs),
 * and mDNS resolves it to either another literal (Android) or a `.local` name
 * (iOS Bonjour returns `hostName`). A registrable DNS name like
 * `api.takedia.com` is never any of those, which is exactly the distinction
 * that matters here — not RFC1918 membership.
 */
export function isLanPinTarget(url: string): boolean {
  const host = hostOf(url);
  if (host == null) return false;
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (isIpv4Literal(host)) return true;
  // IPv6: loopback, link-local (fe80::/10), unique-local (fc00::/7).
  return host === '::1' || host.startsWith('fe80:') || /^f[cd][0-9a-f]{0,2}:/.test(host);
}

/** WebSocket-shaped transport backed by the pinned native socket when available. */
export class PinnedWebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = this.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  private inner: WebSocket | null = null;
  private socketId: number | null = null;
  private closing = false;
  private subs: { remove: () => void }[] = [];

  constructor(
    private readonly url: string,
    private readonly pin?: string,
  ) {
    if (lanPinningAvailable() && pin) {
      void this.connectNative(pin);
    } else {
      this.inner = new WebSocket(url);
      this.wireStandard(this.inner);
    }
  }

  send(data: string): void {
    if (this.socketId != null) {
      Native!.sendWebSocket(this.socketId, data);
      return;
    }
    this.inner?.send(data);
  }

  close(): void {
    this.closing = true;
    this.inner?.close();
    // Closing used to end here, leaving `readyState` correct and `onclose`
    // never called — so `MobileSignaling.attach()`'s handler never ran and its
    // promise could stay pending for the life of the app, holding the whole
    // `ViewerConnection` with it. `wireStandard` always fired it; the two
    // paths have to agree, because nothing above this class knows which one it
    // got. Native teardown lives in `finishClosed` so a peer-initiated close
    // releases OkHttp/URLSession resources the same way.
    this.finishClosed();
  }

  /**
   * Allocate the native socket, subscribe, and only THEN start the handshake.
   *
   * The order is the entire point. `RCTEventEmitter.sendEvent` discards an
   * event outright when `_listenerCount` is 0 (it warns and returns), and that
   * count only rises when the `addListener` calls below run. iOS used to
   * `task.resume()` one line before resolving this promise, with its delegate
   * on a background queue — so on a fast LAN the open event could beat the
   * bridge round-trip back to JS and be thrown away in Objective-C, leaving a
   * socket that was genuinely connected looking like it never opened. Android
   * had the same shape for the same reason. Splitting create from start makes
   * the race structurally impossible rather than merely unlikely.
   */
  private async connectNative(pin: string): Promise<void> {
    let id: number;
    try {
      id = await Native!.createWebSocket(this.url, pin);
    } catch {
      this.onerror?.();
      this.finishClosed();
      return;
    }
    // close() can land during that await; the id it needed did not exist yet,
    // so nothing has torn this socket down and it is on us to do it.
    if (this.closing) {
      Native!.closeWebSocket(id);
      return;
    }
    this.socketId = id;
    this.subs.push(
      emitter!.addListener('LanTlsWebSocketOpen', (ev: { socketId: number }) => {
        if (ev.socketId !== id) return;
        this.readyState = this.OPEN;
        this.onopen?.();
      }),
    );
    this.subs.push(
      emitter!.addListener('LanTlsWebSocketMessage', (ev: { socketId: number; data: string }) => {
        if (ev.socketId !== id) return;
        this.onmessage?.({ data: ev.data });
      }),
    );
    this.subs.push(
      emitter!.addListener('LanTlsWebSocketClose', (ev: { socketId: number }) => {
        if (ev.socketId !== id) return;
        this.finishClosed();
      }),
    );
    // close() can also land between the check above and start — after we
    // subscribed. Re-check so we do not handshake a socket the caller already
    // abandoned (start would no-op on a torn-down id; the emitter subs would
    // leak until GC).
    if (this.closing) {
      this.finishClosed();
      return;
    }
    Native!.startWebSocket(id);
  }

  private wireStandard(ws: WebSocket): void {
    ws.onopen = () => {
      this.readyState = this.OPEN;
      this.onopen?.();
    };
    ws.onmessage = (e) => this.onmessage?.({ data: String(e.data) });
    ws.onerror = () => this.onerror?.();
    ws.onclose = () => this.finishClosed();
  }

  /** Single close path, idempotent — a socket both told to close and reported
   * closed by the platform must announce it exactly once. */
  private finishClosed(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    if (this.socketId != null) {
      Native!.closeWebSocket(this.socketId);
      this.socketId = null;
    }
    this.cleanup();
    this.onclose?.();
  }

  private cleanup(): void {
    for (const s of this.subs) s.remove();
    this.subs = [];
  }
}

/**
 * Factory used by `MobileSignaling` — same surface as `WebSocket` constructor.
 *
 * Throws rather than quietly unpinning when handed a pin for a URL that cannot
 * be the laptop's LAN endpoint. Both readings of that mismatch are bad and
 * neither is survivable: pin it and the handshake can never complete (v0.1.21,
 * where a cloud socket carrying the Mac's self-signed pin produced no HTTP
 * upgrade, no event and no error — just "Connecting…" forever); drop the pin
 * and a caller that meant to reach the LAN gets an unauthenticated connection
 * to somewhere it did not vet. A pin is only ever valid for the address it was
 * issued for, so a mismatch is a bug in the caller and is reported as one.
 *
 * The same honesty applies when a pin is supplied and native pinning is not
 * available on this build: returning an unpinned socket would skip the control
 * with nothing the caller can detect.
 */
export function createSignalingSocket(url: string, pin?: string): WebSocket | PinnedWebSocket {
  if (pin && !isLanPinTarget(url)) {
    throw new ClassifiedError(appError('lan_pin_misapplied'));
  }
  if (pin && !lanPinningAvailable()) {
    throw new ClassifiedError(appError('lan_pinning_unavailable'));
  }
  if (lanPinningAvailable() && pin) {
    return new PinnedWebSocket(url, pin);
  }
  return new WebSocket(url);
}
