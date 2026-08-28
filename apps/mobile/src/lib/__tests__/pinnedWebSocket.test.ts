/**
 * The pinned LAN transport, which had no coverage at all until this file.
 *
 * Every test in `signaling.test.ts` omits the `tlsPin` argument, so all of them
 * exercise the stock-`WebSocket` fallback and `PinnedWebSocket` was never once
 * constructed by the suite. That is how a socket whose open event could be
 * dropped on the floor, and a `close()` that never called `onclose`, both
 * shipped: the code path they live on was not tested, only the one beside it.
 */
import { MobileSignaling } from '../signaling';
import { PinnedWebSocket, createSignalingSocket, isLanPinTarget, lanFetch } from '../lanTls';
import { toAppError } from '../errors';

const PIN = 'a'.repeat(64);
const LAN_URL = 'wss://10.237.92.177:8787/ws/signal';
const CLOUD_URL = 'wss://api.takedia.com/ws/signal';

/** Declared out here because a function type written INSIDE a `jest.mock`
 * factory trips babel's out-of-scope-variable guard on its parameter name. */
type NativeListener = (ev: unknown) => void;

/**
 * A stand-in for the iOS/Android module that is faithful about the two things
 * that actually bit: the platform starts the handshake the instant it is told
 * to, and an event with no JS listener is destroyed rather than queued.
 */
jest.mock('react-native', () => {
  const listeners = new Map<string, Set<NativeListener>>();
  const dropped: string[] = [];

  /**
   * `RCTEventEmitter.sendEvent` when `_listenerCount` is 0: it logs an
   * `RCTLogWarn` and returns, and the event is simply gone. Android's
   * `RCTDeviceEventEmitter.emit` reaches a JS emitter with nothing registered,
   * which amounts to the same thing. Nothing on either platform buffers.
   */
  const sendEvent = (event: string, payload: unknown): void => {
    const set = listeners.get(event);
    if (!set || set.size === 0) {
      dropped.push(event);
      return;
    }
    for (const fn of [...set]) fn(payload);
  };

  const state = {
    /** What the socket does once its handshake is started. */
    outcome: 'open' as 'open' | 'fail_before_open',
    dropped,
    calls: [] as string[],
    closed: [] as number[],
    sent: [] as { socketId: number; text: string }[],
  };

  let nextId = 1;
  const urls = new Map<number, string>();

  /**
   * Begin connecting. The result is reported synchronously here, standing in
   * for a delegate on a background queue beating the bridge round-trip — the
   * worst case, and the one that happens on a fast LAN.
   */
  const startHandshake = (id: number): void => {
    if (state.outcome === 'open') sendEvent('LanTlsWebSocketOpen', { socketId: id });
    else sendEvent('LanTlsWebSocketClose', { socketId: id });
  };

  const LilypadLanTls = {
    /**
     * The pre-fix, single-call API. Nothing in the app calls it any more; it
     * is kept here so the ordering test below reproduces the original failure
     * rather than merely asserting the new arrangement works — point
     * `connectNative` back at this and the open event is lost exactly as it
     * was in v0.1.21.
     */
    connectWebSocket: jest.fn((url: string) => {
      state.calls.push('connectWebSocket');
      const id = nextId++;
      urls.set(id, url);
      startHandshake(id);
      return Promise.resolve(id);
    }),
    createWebSocket: jest.fn((url: string) => {
      state.calls.push('createWebSocket');
      const id = nextId++;
      urls.set(id, url);
      return Promise.resolve(id);
    }),
    startWebSocket: jest.fn((socketId: number) => {
      state.calls.push('startWebSocket');
      startHandshake(socketId);
    }),
    sendWebSocket: jest.fn((socketId: number, text: string) => {
      state.sent.push({ socketId, text });
    }),
    closeWebSocket: jest.fn((socketId: number) => {
      state.closed.push(socketId);
    }),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };

  class FakeNativeEventEmitter {
    addListener(event: string, fn: NativeListener) {
      const set = listeners.get(event) ?? new Set<NativeListener>();
      set.add(fn);
      listeners.set(event, set);
      return { remove: () => set.delete(fn) };
    }
  }

  return {
    NativeModules: { LilypadLanTls },
    NativeEventEmitter: FakeNativeEventEmitter,
    Platform: { OS: 'ios' },
    __native: LilypadLanTls,
    __state: state,
    __sendEvent: sendEvent,
    __listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    /** Back to a freshly-launched app: no subscriptions carried over from the
     * previous test's socket, and ids counting from 1 again. */
    __reset: (): void => {
      listeners.clear();
      urls.clear();
      nextId = 1;
      state.outcome = 'open';
      state.dropped.length = 0;
      state.calls.length = 0;
      state.closed.length = 0;
      state.sent.length = 0;
    },
  };
});

const rn = jest.requireMock('react-native') as {
  __native: Record<string, jest.Mock>;
  __state: {
    outcome: 'open' | 'fail_before_open';
    dropped: string[];
    calls: string[];
    closed: number[];
    sent: { socketId: number; text: string }[];
  };
  __sendEvent: (event: string, payload: unknown) => void;
  __listenerCount: (event: string) => number;
  __reset: () => void;
};

/** `MobileSignaling.isOpen()`/`emit()` read `WebSocket.OPEN` off the global,
 * which the node test environment does not provide. */
class GlobalWebSocketStub {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
}

beforeEach(() => {
  (globalThis as any).WebSocket = GlobalWebSocketStub;
  rn.__reset();
  for (const fn of Object.values(rn.__native)) fn.mockClear();
});

/** Let `connectNative`'s awaited bridge call resolve. */
const flush = () => new Promise<void>((r) => setImmediate(() => r()));

describe('an open event the native side emits before JS can subscribe', () => {
  /**
   * The reproduction of the second, independent defect in the v0.1.21 ring
   * hang — the one that can lose a genuine LAN connection.
   *
   * JS learns a socket's id from the bridge promise, and can only subscribe to
   * that socket's events once it has it. So a native module that starts the
   * handshake before resolving is racing its own caller: iOS called
   * `task.resume()` on the line above `resolve(socketId)` with its delegate on
   * a background queue, Android's `newWebSocket` connects on the spot, and on a
   * fast LAN the open event wins. It is then thrown away in Objective-C with
   * nothing but a log warning, and the phone waits on a socket that is, in
   * fact, connected.
   *
   * Reordering the JS could only narrow that window. Splitting the native API
   * so nothing is started until JS says so closes it.
   */
  it('is still delivered, because nothing starts before the listener exists', async () => {
    const ws = new PinnedWebSocket(LAN_URL, PIN);
    const opens: number[] = [];
    ws.onopen = () => opens.push(Date.now());

    await flush();

    expect(opens).toHaveLength(1);
    expect(ws.readyState).toBe(ws.OPEN);
    // The assertion that would have caught it: not one event went unheard.
    expect(rn.__state.dropped).toEqual([]);
    // …and the reason it did not: the handshake is a separate, later call.
    expect(rn.__state.calls).toEqual(['createWebSocket', 'startWebSocket']);
  });

  it('subscribes to open, message and close before starting the handshake', async () => {
    let countsAtStart = 0;
    rn.__native.startWebSocket.mockImplementationOnce(() => {
      countsAtStart =
        rn.__listenerCount('LanTlsWebSocketOpen') +
        rn.__listenerCount('LanTlsWebSocketMessage') +
        rn.__listenerCount('LanTlsWebSocketClose');
    });

    new PinnedWebSocket(LAN_URL, PIN);
    await flush();

    expect(countsAtStart).toBe(3);
  });
});

describe('a native socket that fails before it ever opens', () => {
  /**
   * iOS emitted nothing at all for this until `didCompleteWithError` was
   * implemented: `didCloseWith` is a close handshake and the receive loop only
   * runs from `didOpenWithProtocol`, so a cancelled auth challenge reached no
   * handler. `connectWebSocket` had already resolved, so the JS `catch` was
   * past too — the connection failed and every party stayed silent.
   */
  it('rejects connect() instead of waiting out the open timeout', async () => {
    rn.__state.outcome = 'fail_before_open';
    const sig = new MobileSignaling(LAN_URL, 'room-1', () => {}, undefined, PIN);

    // No timer is advanced anywhere in this test: the rejection has to come
    // from the failure itself. If it only came from the F2 deadline, this
    // await would never return and the test would time out — which is the
    // production symptom, reproduced.
    await expect(sig.connect()).rejects.toThrow(/closed before opening/);
    expect(sig.isOpen()).toBe(false);
  });
});

describe('close()', () => {
  /**
   * `close()` used to remove the event subscriptions and set `CLOSED` without
   * calling `onclose`, so `MobileSignaling.attach()`'s handler never ran. A
   * `connect()` promise still waiting on that socket could then stay pending
   * for the life of the app, holding the `ViewerConnection` and everything it
   * owns. `wireStandard` always fired it; the two paths disagreeing is the bug,
   * because nothing above this class knows which one it was handed.
   */
  it('fires onclose, so a pending attach() settles', async () => {
    const ws = new PinnedWebSocket(LAN_URL, PIN);
    await flush();
    const closes: number[] = [];
    ws.onclose = () => closes.push(1);

    ws.close();

    expect(closes).toHaveLength(1);
    expect(ws.readyState).toBe(ws.CLOSED);
    expect(rn.__state.closed).toHaveLength(1);
  });

  it('announces the close exactly once even when the platform reports it too', async () => {
    const ws = new PinnedWebSocket(LAN_URL, PIN);
    await flush();
    const closes: number[] = [];
    ws.onclose = () => closes.push(1);

    ws.close();
    rn.__sendEvent('LanTlsWebSocketClose', { socketId: 1 });

    expect(closes).toHaveLength(1);
  });
});

describe('a pin may only be applied to the address it was issued for', () => {
  /**
   * The root cause of the reported hang, guarded at the transport itself.
   *
   * The phone's LAN probe failed (laptop and phone on different campus
   * subnets), `requestConnectForPair` correctly fell back to cloud — and the
   * caller passed the laptop's pin along anyway. `createSignalingSocket` pinned
   * whenever a pin was present and never looked at the URL, so the phone opened
   * a socket to `api.takedia.com` pinned to the Mac's self-signed certificate.
   * That can never match. Six rings, six rooms the desktop took its seat in,
   * and not one WebSocket upgrade from the phone.
   */
  it('refuses a public host, loudly and classified', () => {
    let thrown: unknown;
    try {
      createSignalingSocket(CLOUD_URL, PIN);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    // Classified, not a bare Error: a silent downgrade to an unpinned socket
    // would be the other way to get this wrong, and a raw throw would reach
    // the user as "Something went wrong".
    expect(toAppError(thrown).code).toBe('lan_pin_misapplied');
  });

  it('leaves an unpinned cloud socket alone', () => {
    expect(() => createSignalingSocket(CLOUD_URL)).not.toThrow();
  });

  /**
   * A pin that cannot be enforced is not a pin. Stock `fetch`/`WebSocket` used
   * to be the silent fallback whenever the native module was missing — which
   * looked fine against a self-signed LAN cert (the OS rejected it anyway) and
   * would have quietly skipped the control against a publicly-trusted one.
   */
  it('refuses a pin when native pinning is unavailable', async () => {
    const prev = (jest.requireMock('react-native') as { Platform: { OS: string } }).Platform.OS;
    (jest.requireMock('react-native') as { Platform: { OS: string } }).Platform.OS = 'web';
    try {
      let thrown: unknown;
      try {
        createSignalingSocket(LAN_URL, PIN);
      } catch (e) {
        thrown = e;
      }
      expect(toAppError(thrown).code).toBe('lan_pinning_unavailable');

      let fetchThrown: unknown;
      try {
        await lanFetch(`https://10.0.0.1:8787/health`, PIN);
      } catch (e) {
        fetchThrown = e;
      }
      expect(toAppError(fetchThrown).code).toBe('lan_pinning_unavailable');
    } finally {
      (jest.requireMock('react-native') as { Platform: { OS: string } }).Platform.OS = prev;
    }
  });

  it('accepts every shape the laptop actually advertises itself as', () => {
    // `detect_lan_ipv4` returns any non-loopback non-link-local IPv4 — RFC1918,
    // Tailscale CGNAT, even a campus public address — plus Android mDNS
    // literals and iOS Bonjour `.local` names.
    for (const url of [
      'wss://10.237.92.177:8787/ws/signal',
      'wss://192.168.1.20:8787/ws/signal',
      'wss://172.16.4.4:8787/ws/signal',
      'wss://172.32.0.1:8787/ws/signal', // outside 172.16/12; desktop may still advertise
      'wss://100.64.1.2:8787/ws/signal', // Tailscale CGNAT
      'wss://8.8.8.8/ws/signal', // public literal the Mac could own
      'wss://169.254.10.1:8787/ws/signal',
      'wss://kushs-macbook.local:8787/ws/signal',
      'wss://[fe80::1]:8787/ws/signal',
    ]) {
      expect(isLanPinTarget(url)).toBe(true);
    }
  });

  it('does not mistake a DNS name for a laptop', () => {
    for (const url of [
      CLOUD_URL,
      'wss://10.takedia.com/ws/signal', // a DNS name that starts like an octet
      'wss://example.com:8787/ws/signal',
    ]) {
      expect(isLanPinTarget(url)).toBe(false);
    }
  });
});

describe('peer-initiated close tears down the native socket', () => {
  it('calls closeWebSocket from finishClosed so OkHttp/URLSession are released', async () => {
    const ws = new PinnedWebSocket(LAN_URL, PIN);
    await flush();
    expect(ws.readyState).toBe(ws.OPEN);

    rn.__sendEvent('LanTlsWebSocketClose', { socketId: 1 });

    expect(ws.readyState).toBe(ws.CLOSED);
    expect(rn.__state.closed).toEqual([1]);
  });
});
