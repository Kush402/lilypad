import {
  encodeSignal,
  decodeSignal,
  MAX_SIGNALING_RECONNECTS,
  SIGNALING_OPEN_TIMEOUT_MS,
  jitteredBackoffMs,
  type SignalingMessage,
  type SessionScope,
  type CaptureMode,
} from '@lilypad/protocol';
import { createSignalingSocket } from './lanTls';
import { appError, ClassifiedError } from './errors';

type Handler = (msg: SignalingMessage) => void;

/**
 * Transport lifecycle events, distinct from the signaling messages
 * themselves. `closed` only fires for a socket that previously reached
 * `open` and then died — the caller (`ViewerConnection`) decides whether
 * that's fatal (no peer connection yet — signaling IS the session) or
 * backgroundable (peer already connected, media keeps flowing peer-to-peer
 * while we reconnect), exactly mirroring the desktop orchestrator's own
 * `SignalingClientEvent::Closed` handling
 * (`apps/desktop/src-tauri/src/session/mod.rs`). A socket that never
 * successfully opened doesn't fire this — `connect()`'s own promise
 * rejection already tells the caller that attempt failed.
 */
export type SignalingLifecycleEvent =
  { kind: 'closed' } | { kind: 'reconnected' } | { kind: 'lost'; error: Error };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mobile-side signaling client (WebSocket). Mirrors the desktop's
 * `SignalingClient`: a transport-only unit that reconnects itself with
 * exponential backoff on request, but leaves the "is this drop recoverable"
 * decision to its owner. See `docs/audit/m3/reconnect-lifecycle.md`
 * Finding 1 for the full redesign this implements.
 */
export class MobileSignaling {
  private ws: WebSocket | null = null;
  private closing = false;
  private reconnecting = false;
  // Bumped by close() (and only close()) so an in-flight backoff/reconnect
  // loop can tell it's been superseded and stop touching this instance.
  private reconnectToken = 0;

  constructor(
    private readonly url: string,
    private readonly roomId: string,
    private readonly onMessage: Handler,
    private readonly onLifecycle: (event: SignalingLifecycleEvent) => void = () => {},
    private readonly tlsPin?: string,
  ) {}

  connect(): Promise<void> {
    return this.attach(createSignalingSocket(this.url, this.tlsPin) as WebSocket);
  }

  /**
   * Open one socket and wire it up; resolves/rejects on that socket's own
   * open/error outcome. Shared by the initial `connect()` and every
   * reconnect attempt so both paths behave identically — which is also why the
   * deadline lives here rather than in `connect()`, so a reconnect attempt
   * cannot inherit the unbounded version.
   *
   * Every exit is bounded now. It used to settle only from `onopen`/`onerror`,
   * on the reasonable-sounding assumption that a socket always reports one or
   * the other. A socket does not: on v0.1.21 a phone pinned a cloud endpoint to
   * the laptop's LAN certificate, the TLS handshake could never complete, iOS
   * emitted nothing at all for a connection that failed before opening — and
   * this promise stayed pending, holding the Viewer on "Connecting…" with no
   * error to show. The pin bug is fixed above; this is the guarantee that the
   * next thing to swallow an event costs a user ten seconds instead of a
   * session.
   */
  private attach(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = ws;
      let opened = false;
      let settled = false;
      let openTimer: ReturnType<typeof setTimeout> | null = null;
      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        if (openTimer) clearTimeout(openTimer);
        openTimer = null;
        outcome();
      };
      openTimer = setTimeout(() => {
        settle(() => {
          // Close before rejecting: a socket nobody is waiting on any more is
          // still a socket, and one that opens late would otherwise sit there
          // registered as this client's transport with its promise long gone.
          ws.close();
          reject(new ClassifiedError(appError('signaling_timeout')));
        });
      }, SIGNALING_OPEN_TIMEOUT_MS);
      ws.onopen = () => {
        opened = true;
        settle(resolve);
      };
      ws.onerror = () => settle(() => reject(new Error('signaling connection failed')));
      ws.onmessage = (e: WebSocketMessageEvent) => {
        try {
          this.onMessage(decodeSignal(String(e.data)));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        // A close before the open is this attempt failing, and it is the shape
        // Android already reported (`onFailure` → `LanTlsWebSocketClose`) and
        // iOS now does too. Left unsettled it was a silent hang: no error, no
        // retry, no way for the caller to learn anything happened.
        settle(() => reject(new Error('signaling connection closed before opening')));
        // A newer socket already replaced this one, or close() tore this
        // client down intentionally — either way, this specific socket's
        // death isn't news.
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.closing) return;
        if (opened) this.onLifecycle({ kind: 'closed' });
      };
    });
  }

  private emit(msg: SignalingMessage): void {
    // Guard on OPEN, not just non-null: `attach()` assigns `this.ws` before
    // the socket opens, and RN's WebSocket.send THROWS on a CONNECTING
    // socket. In a Release build that unhandled throw is a fatal abort —
    // observed live as the cellular crash-on-flap (the 4s heartbeat firing
    // while a reconnect attempt was still connecting; crash reports'
    // SIGABRT-in-void-TurboModule is ExceptionsManager reporting it).
    // Dropping the frame is always safer: heartbeats have a next tick, and
    // everything else rides the reconnect → re-register recovery path.
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(encodeSignal(msg));
    } catch {
      /* socket died between check and send — the close handler recovers */
    }
  }

  isReconnecting(): boolean {
    return this.reconnecting;
  }

  /** Is the socket currently open and usable? Lets a caller (e.g. on app
   * foreground) tell "still fine" apart from "needs a reconnect" without
   * reaching into the transport itself. */
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Re-establish the socket with exponential backoff, re-registering as the
   * mobile seat on success so the backend routes room traffic to the new
   * socket (the hub's reregister grace lets the same `deviceId` reclaim its
   * vacated seat). A no-op if a reconnect is already in flight or this
   * client has been closed. */
  beginReconnect(deviceId: string): void {
    if (this.reconnecting || this.closing) return;
    this.reconnecting = true;
    const token = ++this.reconnectToken;
    void this.runReconnect(deviceId, token);
  }

  private async runReconnect(deviceId: string, token: number): Promise<void> {
    for (let attempt = 0; attempt < MAX_SIGNALING_RECONNECTS; attempt++) {
      await sleep(jitteredBackoffMs(attempt));
      if (token !== this.reconnectToken || this.closing) return;
      try {
        await this.attach(createSignalingSocket(this.url, this.tlsPin) as WebSocket);
      } catch {
        continue; // this attempt failed — try the next backoff step
      }
      if (token !== this.reconnectToken || this.closing) return;
      this.reconnecting = false;
      this.register(deviceId);
      this.onLifecycle({ kind: 'reconnected' });
      return;
    }
    if (token !== this.reconnectToken || this.closing) return;
    this.reconnecting = false;
    this.onLifecycle({
      kind: 'lost',
      error: new Error(`gave up after ${MAX_SIGNALING_RECONNECTS} reconnect attempts`),
    });
  }

  register(deviceId: string, opts?: { rejoin?: boolean }): void {
    this.emit({
      type: 'register',
      roomId: this.roomId,
      from: 'mobile',
      ts: Date.now(),
      payload: { role: 'mobile', deviceId, ...(opts?.rejoin ? { rejoin: true } : {}) },
    });
  }

  pairRequest(deviceId: string, deviceName: string | null, requestedScopes: SessionScope[]): void {
    this.emit({
      type: 'pair-request',
      roomId: this.roomId,
      from: 'mobile',
      ts: Date.now(),
      payload: { deviceId, deviceName, requestedScopes },
    });
  }

  answer(sdp: string): void {
    this.emit({
      type: 'answer',
      roomId: this.roomId,
      from: 'mobile',
      ts: Date.now(),
      payload: { type: 'answer', sdp },
    });
  }

  iceCandidate(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): void {
    this.emit({
      type: 'ice-candidate',
      roomId: this.roomId,
      from: 'mobile',
      ts: Date.now(),
      payload: { candidate, sdpMid, sdpMLineIndex },
    });
  }

  renegotiate(): void {
    this.emit({
      type: 'renegotiate',
      roomId: this.roomId,
      from: 'mobile',
      ts: Date.now(),
      payload: { iceRestart: true },
    });
  }

  pause(reason: string | null = null): void {
    this.emit({
      type: 'pause',
      roomId: this.roomId,
      from: 'mobile',
      ts: Date.now(),
      payload: { reason },
    });
  }

  resume(): void {
    this.emit({
      type: 'resume',
      roomId: this.roomId,
      from: 'mobile',
      ts: Date.now(),
      payload: {},
    });
  }

  setCaptureMode(mode: CaptureMode): void {
    this.emit({
      type: 'set-capture-mode',
      roomId: this.roomId,
      from: 'mobile',
      ts: Date.now(),
      payload: { mode },
    });
  }

  setDisplay(displayId: number): void {
    this.emit({
      type: 'set-display',
      roomId: this.roomId,
      from: 'mobile',
      ts: Date.now(),
      payload: { displayId },
    });
  }

  heartbeat(): void {
    this.emit({
      type: 'heartbeat',
      roomId: this.roomId,
      from: 'mobile',
      ts: Date.now(),
      payload: {},
    });
  }

  disconnect(reason: string | null): void {
    this.emit({
      type: 'disconnect',
      roomId: this.roomId,
      from: 'mobile',
      ts: Date.now(),
      payload: { reason },
    });
  }

  /** Close the current socket without marking this client dead, so a later
   * `beginReconnect` can reclaim the seat. Used when the app is backgrounded
   * past the 2s debounce: iOS will freeze JS next, and without this the hub
   * waits out the 25s heartbeat timeout before telling the desktop the
   * phone is gone. Does not send `disconnect` — that would hang up a brief
   * switch that already survived the debounce. Nulling `ws` before `close()`
   * makes `onclose` treat this as a superseded socket, so we do not fire
   * `{kind:'closed'}` and start reconnecting while still backgrounded. */
  dropTransport(): void {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }

  close(): void {
    this.closing = true;
    this.reconnectToken++; // cancels any in-flight reconnect loop
    this.reconnecting = false;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
