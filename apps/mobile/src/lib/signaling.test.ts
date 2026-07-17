import { MobileSignaling, type SignalingLifecycleEvent } from './signaling';

/**
 * Jest's `react-native` preset runs tests under `jest-environment-node` — no
 * browser/RN `WebSocket` polyfill is loaded, so `MobileSignaling`'s bare
 * `new WebSocket(url)` calls resolve against whatever `global.WebSocket` is
 * set to. This fake gives full test control over open/error/close timing,
 * mirroring the same "fake transport" approach the backend's `hub.test.ts`
 * uses for its `Peer` fakes.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Test helper: the socket succeeds. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper: the socket fails before ever opening. */
  fail(): void {
    this.onerror?.();
  }

  /** Test helper: an already-open socket drops. */
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  sentType(type: string): Record<string, unknown> | undefined {
    return this.sent.map((raw) => JSON.parse(raw)).find((m) => m.type === type);
  }
}

function lastSocket(): FakeWebSocket {
  const s = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!s) throw new Error('no FakeWebSocket constructed yet');
  return s;
}

/** Advance fake timers and let any pending microtasks (the awaited `sleep`s
 * inside `runReconnect`) drain, so the loop actually reaches its next
 * `new WebSocket(...)` call before we grab `lastSocket()`. */
async function tick(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

describe('MobileSignaling', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('connect() resolves once the socket opens', async () => {
    const sig = new MobileSignaling('wss://x', 'room1', () => {});
    const p = sig.connect();
    lastSocket().open();
    await expect(p).resolves.toBeUndefined();
    expect(sig.isOpen()).toBe(true);
  });

  it('connect() rejects if the socket errors before opening', async () => {
    const sig = new MobileSignaling('wss://x', 'room1', () => {});
    const p = sig.connect();
    lastSocket().fail();
    await expect(p).rejects.toThrow('signaling connection failed');
  });

  it('a socket that never opened does not emit a "closed" lifecycle event on failure', async () => {
    const events: SignalingLifecycleEvent[] = [];
    const sig = new MobileSignaling('wss://x', 'room1', () => {}, (e) => events.push(e));
    const p = sig.connect().catch(() => undefined);
    lastSocket().fail();
    lastSocket().drop(); // RN commonly fires close right after error
    await p;
    expect(events).toEqual([]);
  });

  it('emits a "closed" lifecycle event when a previously-open socket drops', async () => {
    const events: SignalingLifecycleEvent[] = [];
    const sig = new MobileSignaling('wss://x', 'room1', () => {}, (e) => events.push(e));
    await Promise.all([sig.connect(), Promise.resolve().then(() => lastSocket().open())]);

    lastSocket().drop();

    expect(events).toEqual([{ kind: 'closed' }]);
    expect(sig.isOpen()).toBe(false);
  });

  it('decodes inbound frames and ignores malformed ones', async () => {
    const messages: unknown[] = [];
    const sig = new MobileSignaling('wss://x', 'room1', (m) => messages.push(m));
    const p = sig.connect();
    lastSocket().open();
    await p;

    lastSocket().onmessage?.({ data: 'not json at all' });
    expect(messages).toHaveLength(0);

    lastSocket().onmessage?.({
      data: JSON.stringify({
        type: 'resume',
        roomId: 'room1',
        from: 'desktop',
        ts: 0,
        payload: {},
      }),
    });
    expect(messages).toEqual([
      { type: 'resume', roomId: 'room1', from: 'desktop', ts: 0, payload: {} },
    ]);
  });

  describe('beginReconnect', () => {
    async function connected() {
      const events: SignalingLifecycleEvent[] = [];
      const sig = new MobileSignaling('wss://x', 'room1', () => {}, (e) => events.push(e));
      const p = sig.connect();
      lastSocket().open();
      await p;
      return { sig, events };
    }

    it('retries on the shared backoff schedule and succeeds, re-registering on the new socket', async () => {
      const { sig, events } = await connected();
      lastSocket().drop(); // triggers 'closed' upstream (the caller decides to reconnect)

      sig.beginReconnect('mobile-device-1');
      expect(sig.isReconnecting()).toBe(true);

      // First attempt: 500ms backoff, then a socket that fails.
      await tick(500);
      expect(FakeWebSocket.instances).toHaveLength(2);
      lastSocket().fail();

      // Second attempt: 1000ms backoff, this one succeeds.
      await tick(1000);
      expect(FakeWebSocket.instances).toHaveLength(3);
      lastSocket().open();
      await tick(0);

      expect(sig.isReconnecting()).toBe(false);
      expect(lastSocket().sentType('register')).toMatchObject({
        payload: { role: 'mobile', deviceId: 'mobile-device-1' },
      });
      expect(events).toEqual([{ kind: 'closed' }, { kind: 'reconnected' }]);
    });

    it('gives up and emits "lost" after exhausting the reconnect budget', async () => {
      const { sig, events } = await connected();
      lastSocket().drop();

      sig.beginReconnect('mobile-device-1');
      // Schedule per packages/protocol's RECONNECT_BACKOFF_MS: 500,1000,2000,4000.
      for (const backoff of [500, 1000, 2000, 4000]) {
        await tick(backoff);
        lastSocket().fail();
      }
      await tick(0);

      expect(sig.isReconnecting()).toBe(false);
      const last = events[events.length - 1];
      expect(last.kind).toBe('lost');
    });

    it('is a no-op while a reconnect is already in flight', async () => {
      const { sig } = await connected();
      lastSocket().drop();

      sig.beginReconnect('mobile-device-1');
      const countAfterFirstCall = FakeWebSocket.instances.length;
      sig.beginReconnect('mobile-device-1'); // ignored — already reconnecting
      expect(FakeWebSocket.instances).toHaveLength(countAfterFirstCall);
    });

    it('close() cancels an in-flight reconnect and suppresses further lifecycle events', async () => {
      const { sig, events } = await connected();
      lastSocket().drop();
      sig.beginReconnect('mobile-device-1');

      sig.close();
      await tick(500);
      // No new socket was ever opened for the cancelled attempt, and no
      // further lifecycle noise after close().
      expect(events).toEqual([{ kind: 'closed' }]);
      expect(sig.isReconnecting()).toBe(false);
    });
  });

  describe('protocol message shape', () => {
    it('sends pause/resume/renegotiate with the expected payloads', async () => {
      const sig = new MobileSignaling('wss://x', 'room1', () => {});
      const p = sig.connect();
      lastSocket().open();
      await p;

      sig.pause('backgrounded');
      sig.resume();
      sig.renegotiate();
      sig.setCaptureMode('text');

      expect(lastSocket().sentType('pause')).toMatchObject({ payload: { reason: 'backgrounded' } });
      expect(lastSocket().sentType('resume')).toMatchObject({ payload: {} });
      expect(lastSocket().sentType('renegotiate')).toMatchObject({
        payload: { iceRestart: true },
      });
      expect(lastSocket().sentType('set-capture-mode')).toMatchObject({
        payload: { mode: 'text' },
      });
    });
  });
});
