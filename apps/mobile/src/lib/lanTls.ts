/**
 * Pinned TLS for the desktop LAN control plane (iOS native module).
 * Falls back to regular fetch/WebSocket when pinning is unavailable.
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

const Native = NativeModules.LilypadLanTls as
  | ({
      fetch: (
        url: string,
        expectedSha256: string,
        method: string,
        headers: Record<string, string>,
        body: string | null,
      ) => Promise<{ status: number; body: string }>;
      connectWebSocket: (url: string, expectedSha256: string) => Promise<number>;
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
  if (!lanPinningAvailable()) {
    return fetch(url, init);
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
  const result = await Native!.fetch(
    url,
    expectedSha256,
    init?.method ?? 'GET',
    headers,
    body,
  );
  return new Response(result.body, { status: result.status });
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
    if (this.socketId != null) {
      Native!.closeWebSocket(this.socketId);
      this.socketId = null;
    }
    this.inner?.close();
    this.cleanup();
    this.readyState = this.CLOSED;
  }

  private async connectNative(pin: string): Promise<void> {
    try {
      const id = await Native!.connectWebSocket(this.url, pin);
      this.socketId = id;
      if (!emitter) return;
      this.subs.push(
        emitter.addListener('LanTlsWebSocketOpen', (ev: { socketId: number }) => {
          if (ev.socketId !== id) return;
          this.readyState = this.OPEN;
          this.onopen?.();
        }),
      );
      this.subs.push(
        emitter.addListener('LanTlsWebSocketMessage', (ev: { socketId: number; data: string }) => {
          if (ev.socketId !== id) return;
          this.onmessage?.({ data: ev.data });
        }),
      );
      this.subs.push(
        emitter.addListener('LanTlsWebSocketClose', (ev: { socketId: number }) => {
          if (ev.socketId !== id) return;
          this.readyState = this.CLOSED;
          this.onclose?.();
          this.cleanup();
        }),
      );
    } catch {
      this.onerror?.();
      this.readyState = this.CLOSED;
    }
  }

  private wireStandard(ws: WebSocket): void {
    ws.onopen = () => {
      this.readyState = this.OPEN;
      this.onopen?.();
    };
    ws.onmessage = (e) => this.onmessage?.({ data: String(e.data) });
    ws.onerror = () => this.onerror?.();
    ws.onclose = () => {
      this.readyState = this.CLOSED;
      this.onclose?.();
    };
  }

  private cleanup(): void {
    for (const s of this.subs) s.remove();
    this.subs = [];
  }
}

/** Factory used by `MobileSignaling` — same surface as `WebSocket` constructor. */
export function createSignalingSocket(url: string, pin?: string): WebSocket | PinnedWebSocket {
  if (lanPinningAvailable() && pin) {
    return new PinnedWebSocket(url, pin);
  }
  return new WebSocket(url);
}
