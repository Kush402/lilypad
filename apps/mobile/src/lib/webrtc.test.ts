import {
  iceRecoveryTimeoutMs,
  MAX_ICE_RESTARTS,
  INPUT_CHANNEL_LABEL,
  INPUT_MOVE_CHANNEL_LABEL,
} from '@lilypad/protocol';
import { MAX_BUFFERED_AMOUNT_BYTES } from './input';
import { QUALITY_POLL_MS } from './quality';
import { ViewerConnection, type ViewerCallbacks } from './webrtc';

// --- react-native-webrtc: a minimal fake peer connection, enough to drive
// `connectionstatechange` and the offer/answer plumbing without any native
// binding (none is available under Jest's node test environment). ---
jest.mock('react-native-webrtc', () => {
  class FakeRTCPeerConnection {
    connectionState = 'new';
    private readonly listeners: Record<string, Array<(e: any) => void>> = {};
    setRemoteDescription = jest.fn().mockResolvedValue(undefined);
    setLocalDescription = jest.fn().mockResolvedValue(undefined);
    createAnswer = jest.fn().mockResolvedValue({ type: 'answer', sdp: 'fake-answer-sdp' });
    addIceCandidate = jest.fn().mockResolvedValue(undefined);
    getStats = jest.fn().mockResolvedValue(new Map());
    close = jest.fn();

    addEventListener(type: string, cb: (e: any) => void): void {
      (this.listeners[type] ??= []).push(cb);
    }

    /** Test helper: simulate the connection reaching a new state. */
    setState(state: string): void {
      this.connectionState = state;
      (this.listeners.connectionstatechange ?? []).forEach((cb) => cb({}));
    }

    /** Test helper: simulate the desktop (offerer) opening a named
     * DataChannel. Returns the fake channel so a test can assert on its
     * `.send()` calls. */
    dispatchDataChannel(label: string): any {
      const msgListeners: ((e: { data: unknown }) => void)[] = [];
      const bufferedAmountLowListeners: ((e: unknown) => void)[] = [];
      const channel = {
        label,
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        onbufferedamountlow: null as any,
        send: jest.fn(),
        close: jest.fn(),
        // Mirrors the real RTCDataChannel: the desktop sends the agent step
        // feed back on the reliable input channel, so the client listens here.
        addEventListener: jest.fn((type: string, cb: (e: any) => void) => {
          if (type === 'message') msgListeners.push(cb);
          if (type === 'bufferedamountlow') bufferedAmountLowListeners.push(cb);
        }),
        emitMessage: (data: unknown) => msgListeners.forEach((cb) => cb({ data })),
        emitBufferedAmountLow: () => {
          channel.onbufferedamountlow?.({});
          bufferedAmountLowListeners.forEach((cb) => cb({}));
        },
      };
      (this.listeners.datachannel ?? []).forEach((cb) => cb({ channel }));
      return channel;
    }
  }
  const mockPeerInstances: FakeRTCPeerConnection[] = [];
  return {
    __mockPeerInstances: mockPeerInstances,
    RTCPeerConnection: jest.fn().mockImplementation(() => {
      const inst = new FakeRTCPeerConnection();
      mockPeerInstances.push(inst);
      return inst;
    }),
    RTCSessionDescription: jest.fn().mockImplementation((init: any) => init),
    RTCIceCandidate: jest.fn().mockImplementation((init: any) => init),
    MediaStream: jest
      .fn()
      .mockImplementation((tracks: any) => ({ tracks, toURL: () => 'fake://stream' })),
  };
});

// --- MobileSignaling: a fake transport whose reconnect machinery is
// exercised separately and thoroughly in signaling.test.ts. Here we only
// need to capture the (onMessage, onLifecycle) callbacks ViewerConnection
// wires up, and jest.fn() stand-ins for every outbound call it makes. ---
jest.mock('./signaling', () => {
  const mockSignalingInstances: any[] = [];
  return {
    __mockSignalingInstances: mockSignalingInstances,
    MobileSignaling: jest
      .fn()
      .mockImplementation((_url: string, _roomId: string, onMessage: any, onLifecycle: any) => {
        const inst = {
          onMessage,
          onLifecycle: onLifecycle ?? (() => {}),
          connect: jest.fn().mockResolvedValue(undefined),
          register: jest.fn(),
          pairRequest: jest.fn(),
          answer: jest.fn(),
          iceCandidate: jest.fn(),
          renegotiate: jest.fn(),
          pause: jest.fn(),
          resume: jest.fn(),
          setCaptureMode: jest.fn(),
          setDisplay: jest.fn(),
          heartbeat: jest.fn(),
          disconnect: jest.fn(),
          close: jest.fn(),
          beginReconnect: jest.fn(),
          isReconnecting: jest.fn().mockReturnValue(false),
          isOpen: jest.fn().mockReturnValue(true),
        };
        mockSignalingInstances.push(inst);
        return inst;
      }),
  };
});

// --- AppLifecycleController: capture the callbacks object ViewerConnection
// hands it, so tests can fire onBackground/onForeground/onNetworkRestored
// directly. Its own debounce/AppState/NetInfo logic is tested in isolation
// in lifecycle.test.ts. ---
jest.mock('./lifecycle', () => {
  const mockLifecycleInstances: any[] = [];
  return {
    __mockLifecycleInstances: mockLifecycleInstances,
    AppLifecycleController: jest.fn().mockImplementation((cb: any) => {
      const inst = { cb, dispose: jest.fn() };
      mockLifecycleInstances.push(inst);
      return inst;
    }),
  };
});

const rtcMock = jest.requireMock('react-native-webrtc') as { __mockPeerInstances: any[] };
const signalingMock = jest.requireMock('./signaling') as { __mockSignalingInstances: any[] };
const lifecycleMock = jest.requireMock('./lifecycle') as { __mockLifecycleInstances: any[] };

function lastPeer() {
  const peers = rtcMock.__mockPeerInstances;
  return peers[peers.length - 1];
}
function lastSignaling() {
  const s = signalingMock.__mockSignalingInstances;
  return s[s.length - 1];
}
function lastLifecycle() {
  const l = lifecycleMock.__mockLifecycleInstances;
  return l[l.length - 1];
}

function makeCallbacks() {
  return {
    onStream: jest.fn(),
    onState: jest.fn(),
    onError: jest.fn(),
    onStats: jest.fn(),
    onFrameSize: jest.fn(),
    onDisplays: jest.fn(),
    onClipboardUpdate: jest.fn(),
    onAgentStep: jest.fn(),
    onAgentRunEnd: jest.fn(),
  } satisfies ViewerCallbacks;
}

async function startConnected(cb: ViewerCallbacks) {
  const conn = new ViewerConnection('wss://x', 'room1', ['control'], cb);
  await conn.start();
  const sig = lastSignaling();
  // Drive the handshake to a live peer connection.
  sig.onMessage({
    type: 'session-start',
    roomId: 'room1',
    from: 'desktop',
    ts: 0,
    payload: { sessionId: 's1', grantedScopes: ['control'], iceServers: [] },
  });
  const peer = lastPeer();
  peer.setState('connected');
  return { conn, sig, peer };
}

describe('ViewerConnection', () => {
  beforeEach(() => {
    rtcMock.__mockPeerInstances.length = 0;
    signalingMock.__mockSignalingInstances.length = 0;
    lifecycleMock.__mockLifecycleInstances.length = 0;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('start() registers, requests pairing, and reports connecting then awaiting_approval', async () => {
    const cb = makeCallbacks();
    const conn = new ViewerConnection('wss://x', 'room1', ['view'], cb);
    await conn.start();

    const sig = lastSignaling();
    expect(sig.register).toHaveBeenCalled();
    expect(sig.pairRequest).toHaveBeenCalled();
    expect(cb.onState).toHaveBeenCalledWith('connecting');
    // The pair-request is sent, so the mobile side is now waiting on a human
    // at the laptop, not still "connecting" — see
    // docs/audit/m3/mobile-ux.md Finding 1.
    expect(cb.onState).toHaveBeenLastCalledWith('awaiting_approval');
    expect(lastLifecycle()).toBeDefined();
  });

  it('reaching session-start builds a peer connection that reports negotiating then connected', async () => {
    const cb = makeCallbacks();
    const conn = new ViewerConnection('wss://x', 'room1', ['control'], cb);
    await conn.start();
    const sig = lastSignaling();
    cb.onState.mockClear();

    sig.onMessage({
      type: 'session-start',
      roomId: 'room1',
      from: 'desktop',
      ts: 0,
      payload: { sessionId: 's1', grantedScopes: ['control'], iceServers: [] },
    });
    expect(cb.onState).toHaveBeenCalledWith('negotiating');

    lastPeer().setState('connected');
    expect(cb.onState).toHaveBeenCalledWith('connected');
  });

  it('replaces a stale peer on a new session-start without letting the old peer end the session', async () => {
    const cb = makeCallbacks();
    const { conn, sig, peer: oldPeer } = await startConnected(cb);
    const oldCritical = oldPeer.dispatchDataChannel(INPUT_CHANNEL_LABEL);
    cb.onState.mockClear();

    sig.onMessage({
      type: 'session-start',
      roomId: 'room1',
      from: 'desktop',
      ts: 1,
      payload: { sessionId: 's2', grantedScopes: ['control'], iceServers: [] },
    });
    oldPeer.setState('closed');

    expect(oldPeer.close).toHaveBeenCalled();
    expect(oldCritical.close).toHaveBeenCalled();
    expect(cb.onState).not.toHaveBeenCalledWith('ended');
    expect(conn.inputSender).toBeNull();

    const newPeer = lastPeer();
    const newCritical = newPeer.dispatchDataChannel(INPUT_CHANNEL_LABEL);
    conn.inputSender?.click(0.5, 0.5);

    expect(oldCritical.send).not.toHaveBeenCalled();
    expect(newCritical.send).toHaveBeenCalledTimes(1);
  });

  it('forwards a frame-size signal to onFrameSize (for letterbox-aware touch mapping)', async () => {
    const cb = makeCallbacks();
    const conn = new ViewerConnection('wss://x', 'room1', ['control'], cb);
    await conn.start();
    const sig = lastSignaling();

    sig.onMessage({
      type: 'frame-size',
      roomId: 'room1',
      from: 'desktop',
      ts: 0,
      payload: { width: 2560, height: 1600, mode: 'motion' },
    });

    expect(cb.onFrameSize).toHaveBeenCalledWith(2560, 1600, 'motion');
  });

  /**
   * The display list rides `frame-size` rather than a message of its own,
   * because the moments it changes are exactly the moments the frame size
   * does: the pipeline starting, a mode switch, a display switch, and a
   * monitor being plugged in or pulled out.
   */
  it('forwards the attached displays and the active one to onDisplays', async () => {
    const cb = makeCallbacks();
    const conn = new ViewerConnection('wss://x', 'room1', ['control'], cb);
    await conn.start();

    lastSignaling().onMessage({
      type: 'frame-size',
      roomId: 'room1',
      from: 'desktop',
      ts: 0,
      payload: {
        width: 2560,
        height: 1600,
        mode: 'motion',
        displays: [
          { id: 1, name: 'Built-in Display', width: 2560, height: 1600 },
          { id: 2, name: 'Display 2', width: 3440, height: 1440 },
        ],
        activeDisplayId: 2,
      },
    });

    expect(cb.onDisplays).toHaveBeenCalledWith(
      [
        { id: 1, name: 'Built-in Display', width: 2560, height: 1600 },
        { id: 2, name: 'Display 2', width: 3440, height: 1440 },
      ],
      2,
    );
  });

  /**
   * A Mac on 0.1.9 or older sends `frame-size` with no display fields at all.
   * The phone must not treat that as an error or as "zero displays with a
   * broken active id" — it reports an empty list, which the viewer renders as
   * no switcher, the same as a single-screen Mac.
   */
  it('treats a frame-size from an older desktop as simply having no display list', async () => {
    const cb = makeCallbacks();
    const conn = new ViewerConnection('wss://x', 'room1', ['control'], cb);
    await conn.start();

    lastSignaling().onMessage({
      type: 'frame-size',
      roomId: 'room1',
      from: 'desktop',
      ts: 0,
      payload: { width: 1280, height: 720, mode: 'motion' },
    });

    expect(cb.onFrameSize).toHaveBeenCalledWith(1280, 720, 'motion');
    expect(cb.onDisplays).toHaveBeenCalledWith([], null);
  });

  it('sends a set-display request when requestDisplay is called', async () => {
    const cb = makeCallbacks();
    const conn = new ViewerConnection('wss://x', 'room1', ['control'], cb);
    await conn.start();
    const sig = lastSignaling();

    conn.requestDisplay(7);

    expect(sig.setDisplay).toHaveBeenCalledWith(7);
  });

  it('sends a set-capture-mode request when requestCaptureMode is called (Finding 2)', async () => {
    const cb = makeCallbacks();
    const conn = new ViewerConnection('wss://x', 'room1', ['control'], cb);
    await conn.start();
    const sig = lastSignaling();

    conn.requestCaptureMode('text');

    expect(sig.setCaptureMode).toHaveBeenCalledWith('text');
  });

  it('forwards a clipboard-update signal to onClipboardUpdate (Finding 6)', async () => {
    const cb = makeCallbacks();
    const conn = new ViewerConnection('wss://x', 'room1', ['control'], cb);
    await conn.start();
    const sig = lastSignaling();

    sig.onMessage({
      type: 'clipboard-update',
      roomId: 'room1',
      from: 'desktop',
      ts: 0,
      payload: { text: 'copied on the laptop' },
    });

    expect(cb.onClipboardUpdate).toHaveBeenCalledWith('copied on the laptop');
  });

  it('reports "denied" (not the generic "ended") on a pair-denied signal', async () => {
    const cb = makeCallbacks();
    const conn = new ViewerConnection('wss://x', 'room1', ['view'], cb);
    await conn.start();
    const sig = lastSignaling();

    sig.onMessage({
      type: 'pair-denied',
      roomId: 'room1',
      from: 'desktop',
      ts: 0,
      payload: { reason: null },
    });

    expect(cb.onState).toHaveBeenCalledWith('denied');
    expect(sig.close).toHaveBeenCalled();
  });

  describe('session-end reason (revoke bi-directional fix)', () => {
    it('fires onRevoked (before onState("ended")) when reason is exactly "revoked"', async () => {
      const cb = { ...makeCallbacks(), onRevoked: jest.fn() };
      const conn = new ViewerConnection('wss://x', 'room1', ['view'], cb);
      await conn.start();
      const sig = lastSignaling();

      sig.onMessage({
        type: 'session-end',
        roomId: 'room1',
        from: 'desktop',
        ts: 0,
        payload: { reason: 'revoked' },
      });

      expect(cb.onRevoked).toHaveBeenCalledTimes(1);
      expect(cb.onState).toHaveBeenCalledWith('ended');
      // onRevoked must fire before the generic 'ended' state, so the screen
      // can special-case its handling ahead of the generic treatment.
      const revokedOrder = cb.onRevoked.mock.invocationCallOrder[0];
      const endedOrder =
        cb.onState.mock.invocationCallOrder[
          cb.onState.mock.calls.findIndex((call) => call[0] === 'ended')
        ];
      expect(revokedOrder).toBeLessThan(endedOrder);
    });

    /**
     * A laptop leaving the account is a different fact from a pairing ending,
     * and the phone acts differently on each: `revoked` makes it drop its
     * local pair row — taking the per-pair connect secret, which is never
     * re-issued, with it — while `device_removed` must leave it alone. The
     * pair rows survive a device removal, and re-enrolling the same key
     * restores reach with no second QR, so a phone that forgot the secret
     * would have made a reversible thing permanent.
     *
     * This became load-bearing when signing out of a Mac started routing
     * through `DELETE /devices/:deviceId` (ADR-0015): the product now promises,
     * on the sign-out confirmation and on the website, that pairings survive.
     */
    it('fires onDeviceRemoved — not onRevoked — when the LAPTOP left the account', async () => {
      const cb = { ...makeCallbacks(), onRevoked: jest.fn(), onDeviceRemoved: jest.fn() };
      const conn = new ViewerConnection('wss://x', 'room1', ['view'], cb);
      await conn.start();
      const sig = lastSignaling();

      sig.onMessage({
        type: 'session-end',
        roomId: 'room1',
        from: 'desktop',
        ts: 0,
        payload: { reason: 'device_removed' },
      });

      expect(cb.onDeviceRemoved).toHaveBeenCalledTimes(1);
      expect(cb.onRevoked).not.toHaveBeenCalled();
      expect(cb.onState).toHaveBeenCalledWith('ended');
    });

    it('does not fire onDeviceRemoved for a pairing that was revoked', async () => {
      const cb = { ...makeCallbacks(), onRevoked: jest.fn(), onDeviceRemoved: jest.fn() };
      const conn = new ViewerConnection('wss://x', 'room1', ['view'], cb);
      await conn.start();

      lastSignaling().onMessage({
        type: 'session-end',
        roomId: 'room1',
        from: 'desktop',
        ts: 0,
        payload: { reason: 'revoked' },
      });

      expect(cb.onRevoked).toHaveBeenCalledTimes(1);
      expect(cb.onDeviceRemoved).not.toHaveBeenCalled();
    });

    it('does NOT fire onRevoked for a different session-end reason', async () => {
      const cb = { ...makeCallbacks(), onRevoked: jest.fn() };
      const conn = new ViewerConnection('wss://x', 'room1', ['view'], cb);
      await conn.start();
      const sig = lastSignaling();

      sig.onMessage({
        type: 'session-end',
        roomId: 'room1',
        from: 'desktop',
        ts: 0,
        payload: { reason: 'peer connection closed' },
      });

      expect(cb.onRevoked).not.toHaveBeenCalled();
      expect(cb.onState).toHaveBeenCalledWith('ended');
    });

    it('does NOT fire onRevoked for a null session-end reason', async () => {
      const cb = { ...makeCallbacks(), onRevoked: jest.fn() };
      const conn = new ViewerConnection('wss://x', 'room1', ['view'], cb);
      await conn.start();
      const sig = lastSignaling();

      sig.onMessage({
        type: 'session-end',
        roomId: 'room1',
        from: 'desktop',
        ts: 0,
        payload: { reason: null },
      });

      expect(cb.onRevoked).not.toHaveBeenCalled();
      expect(cb.onState).toHaveBeenCalledWith('ended');
    });

    it('does NOT fire onRevoked for a plain "disconnect" message even with a revoked-looking reason', async () => {
      const cb = { ...makeCallbacks(), onRevoked: jest.fn() };
      const conn = new ViewerConnection('wss://x', 'room1', ['view'], cb);
      await conn.start();
      const sig = lastSignaling();

      sig.onMessage({
        type: 'disconnect',
        roomId: 'room1',
        from: 'desktop',
        ts: 0,
        payload: { reason: 'revoked' },
      });

      expect(cb.onRevoked).not.toHaveBeenCalled();
      expect(cb.onState).toHaveBeenCalledWith('ended');
    });
  });

  it('polls getStats once a peer connection exists and reports classified quality', async () => {
    const cb = makeCallbacks();
    const { peer } = await startConnected(cb);

    (peer.getStats as jest.Mock).mockResolvedValue(
      new Map([
        ['pair1', { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.05 }],
        [
          'in1',
          {
            type: 'inbound-rtp',
            kind: 'video',
            framesPerSecond: 30,
            packetsLost: 0,
            packetsReceived: 100,
            bytesReceived: 1000,
          },
        ],
      ]),
    );

    await jest.advanceTimersByTimeAsync(2_000);

    expect(cb.onStats).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'good', rttMs: 50, fps: 30, packetLossPct: 0 }),
    );
  });

  it('stops polling stats once closed', async () => {
    const cb = makeCallbacks();
    const { conn, peer } = await startConnected(cb);
    conn.close();
    (peer.getStats as jest.Mock).mockClear();

    await jest.advanceTimersByTimeAsync(10_000);

    expect(peer.getStats).not.toHaveBeenCalled();
  });

  describe('signaling lifecycle handling', () => {
    it('treats a signaling drop before the peer connects as fatal', async () => {
      const cb = makeCallbacks();
      const conn = new ViewerConnection('wss://x', 'room1', ['view'], cb);
      await conn.start();
      const sig = lastSignaling();

      sig.onLifecycle({ kind: 'closed' });

      expect(cb.onState).toHaveBeenCalledWith('ended');
      expect(sig.beginReconnect).not.toHaveBeenCalled();
      expect(sig.close).toHaveBeenCalled();
    });

    it('backgrounds a signaling drop once the peer is connected, and reconnects', async () => {
      const cb = makeCallbacks();
      const { sig } = await startConnected(cb);

      sig.onLifecycle({ kind: 'closed' });
      expect(cb.onState).toHaveBeenCalledWith('reconnecting_signaling');
      expect(sig.beginReconnect).toHaveBeenCalledWith(expect.any(String));

      sig.onLifecycle({ kind: 'reconnected' });
      // peerConnected is still true, so this re-affirms 'connected'.
      expect(cb.onState).toHaveBeenLastCalledWith('connected');
    });

    it('does not overwrite a recovering/failed peer state on a stale "reconnected" event', async () => {
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      peer.setState('failed'); // enters the video-aware degraded grace window
      // No video stats were ever polled, so isReceivingVideo() is false —
      // the grace timer firing escalates: peerConnected -> false, state -> recovering_ice.
      jest.advanceTimersByTime(5_000);
      cb.onState.mockClear();

      sig.onLifecycle({ kind: 'reconnected' });
      expect(cb.onState).not.toHaveBeenCalled();
    });

    it('keeps retrying on "lost" while media is healthy (backend holds the seat)', async () => {
      jest.useFakeTimers();
      try {
        const cb = makeCallbacks();
        const { sig } = await startConnected(cb);

        sig.onLifecycle({ kind: 'lost', error: new Error('gave up after 4 reconnect attempts') });

        // A working stream must NOT die because one signaling outage
        // outlasted the retry budget — observed live on flappy cellular.
        expect(cb.onError).not.toHaveBeenCalled();
        expect(cb.onState).toHaveBeenCalledWith('reconnecting_signaling');
        expect(sig.close).not.toHaveBeenCalled();

        jest.advanceTimersByTime(4_000);
        expect(sig.beginReconnect).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('ends the session on "lost" when the peer is not connected', async () => {
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      peer.setState('failed');
      // No video ever polled, so the degraded grace window escalates for
      // real: peerConnected -> false.
      jest.advanceTimersByTime(5_000);
      sig.onLifecycle({ kind: 'lost', error: new Error('gave up after 4 reconnect attempts') });

      expect(cb.onError).toHaveBeenCalledWith({
        code: 'signaling_lost',
        // Was `'gave up after 4 reconnect attempts'` — the transport's own
        // sentence, written for whoever debugs it and shown to the customer
        // instead. It goes to the session journal now; the screen gets copy.
        message: 'Lost the connection to the laptop. Connect again when you’re ready.',
        retryable: true,
      });
      expect(cb.onState).toHaveBeenCalledWith('ended');
      expect(sig.close).toHaveBeenCalled();
    });
  });

  describe('ICE restart recovery', () => {
    it('waits through a grace period before requesting ICE recovery on a failed connection', async () => {
      // 'failed' is now routed through the same video-aware grace window as
      // 'disconnected' (no immediate escalation) — see armDegradedRecheck.
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      peer.setState('failed');
      expect(sig.renegotiate).not.toHaveBeenCalled();

      jest.advanceTimersByTime(5_000);

      expect(cb.onState).toHaveBeenCalledWith('recovering_ice', {
        attempt: 1,
        max: MAX_ICE_RESTARTS,
      });
      expect(sig.renegotiate).toHaveBeenCalledTimes(1);
    });

    it('waits through a disconnected grace period before requesting ICE recovery', async () => {
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      peer.setState('disconnected');
      jest.advanceTimersByTime(4_999);

      expect(sig.renegotiate).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);

      expect(cb.onState).toHaveBeenCalledWith('recovering_ice', {
        attempt: 1,
        max: MAX_ICE_RESTARTS,
      });
      expect(sig.renegotiate).toHaveBeenCalledTimes(1);
    });

    it('cancels disconnected recovery if the peer reconnects during the grace period', async () => {
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      peer.setState('disconnected');
      jest.advanceTimersByTime(2_000);
      peer.setState('connected');
      jest.advanceTimersByTime(5_000);

      expect(sig.renegotiate).not.toHaveBeenCalled();
      expect(cb.onState).not.toHaveBeenCalledWith('recovering_ice', expect.anything());
    });

    it('does not let network-restored bypass the disconnected grace period', async () => {
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      peer.setState('disconnected');
      lastLifecycle().cb.onNetworkRestored();

      expect(sig.renegotiate).not.toHaveBeenCalled();

      jest.advanceTimersByTime(5_000);
      expect(sig.renegotiate).toHaveBeenCalledTimes(1);
    });

    it('gives up locally after exhausting its bounded restart-request budget (no video ever flowing)', async () => {
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      // No video stats are ever polled in this test, so isReceivingVideo()
      // is false throughout — every grace-window fire is a genuine
      // escalation, exercising the ordinary (non-video-saved) budget path.
      peer.setState('failed');
      jest.advanceTimersByTime(5_000); // attempt 1
      peer.setState('failed');
      jest.advanceTimersByTime(5_000); // attempt 2
      peer.setState('failed');
      jest.advanceTimersByTime(5_000); // budget exhausted -> terminal failure

      expect(sig.renegotiate).toHaveBeenCalledTimes(2);
      expect(cb.onState).toHaveBeenLastCalledWith('failed');
      expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ice_failed' }));
    });

    it('resets the restart budget once the connection recovers', async () => {
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      peer.setState('failed');
      jest.advanceTimersByTime(5_000);
      peer.setState('connected');
      cb.onState.mockClear();
      (sig.renegotiate as jest.Mock).mockClear();

      // A fresh failure after recovering should get the full budget again,
      // not immediately terminal.
      peer.setState('failed');
      jest.advanceTimersByTime(5_000);
      expect(cb.onState).toHaveBeenCalledWith('recovering_ice', {
        attempt: 1,
        max: MAX_ICE_RESTARTS,
      });
      expect(sig.renegotiate).toHaveBeenCalledTimes(1);
    });

    it('gives up if recovery does not complete within the recovery deadline', async () => {
      const cb = makeCallbacks();
      const { peer } = await startConnected(cb);

      peer.setState('failed');
      jest.advanceTimersByTime(5_000); // grace window -> attemptIceRecovery fires
      cb.onState.mockClear();

      jest.advanceTimersByTime(iceRecoveryTimeoutMs(1));

      expect(cb.onState).toHaveBeenCalledWith('failed');
    });

    it('clears the recovery deadline on reconnecting, so it does not fire a stale failure', async () => {
      const cb = makeCallbacks();
      const { peer } = await startConnected(cb);

      peer.setState('failed');
      peer.setState('connected'); // recovered well within the grace window
      cb.onState.mockClear();

      jest.advanceTimersByTime(5_000 + iceRecoveryTimeoutMs(2)); // the longest possible total wait

      expect(cb.onState).not.toHaveBeenCalledWith('failed');
    });

    it('never escalates to "failed" while video is still flowing, even when the PC reports "failed"', async () => {
      // The master rule: while isReceivingVideo() is true, the session must
      // NEVER go to 'failed' — and, now that the desktop DECLINES a
      // renegotiate while its own traffic reads fresh, the phone must not
      // send one either (that would just be ignored, and worse, would leave
      // the UI parked on 'recovering_ice' forever since ICE never returns to
      // 'connected' without the restart that never happens). Simulate a live
      // video path with bytesReceived that keeps climbing on EVERY poll (not
      // just the first two), since this test runs the clock far enough that
      // a one-time liveness blip would expire mid-test and mask the very bug
      // being guarded against.
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      let bytes = 1000;
      (peer.getStats as jest.Mock).mockImplementation(async () => {
        bytes += 1000;
        return new Map([['in1', { type: 'inbound-rtp', kind: 'video', bytesReceived: bytes }]]);
      });
      // Two poll ticks so `lastVideoAdvanceAt` actually advances (the first
      // tick only seeds `lastInboundBytes`; the delta is computed on the
      // second).
      await jest.advanceTimersByTimeAsync(QUALITY_POLL_MS);
      await jest.advanceTimersByTimeAsync(QUALITY_POLL_MS);

      peer.setState('failed');
      cb.onState.mockClear();
      (sig.renegotiate as jest.Mock).mockClear();
      // Run WAY past the grace window, the ICE-restart budget, and the
      // recovery deadline — as long as `getStats` keeps reporting advancing
      // video bytes on every poll, none of it may reach 'failed', and none
      // of it may send a renegotiate the desktop would just decline.
      await jest.advanceTimersByTimeAsync(60_000);

      expect(cb.onState).not.toHaveBeenCalledWith('failed');
      expect(cb.onState).not.toHaveBeenCalledWith('recovering_ice', expect.anything());
      expect(cb.onError).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'ice_failed' }));
      // No renegotiate — the desktop declines these while video flows, so
      // sending one is both pointless and would strand the UI. The phone
      // instead just keeps honestly reporting 'connected'.
      expect(sig.renegotiate).not.toHaveBeenCalled();
      expect(cb.onState).toHaveBeenCalledWith('connected');
    });

    // Regression guard for the 2026-08-12 cellular renegotiate loop. An ICE
    // restart re-uses the peer connection, so getStats() keeps reporting the
    // PREVIOUS inbound-rtp stream with its bytes frozen, alongside the live
    // one. Reading a single entry per poll ("last one wins") compared streams
    // against each other, so the delta read 0 whenever the frozen entry was
    // the one sampled — video looked dead while it was playing perfectly, and
    // the phone asked the desktop to ICE-restart every ~25s. Each restart left
    // behind another stale stream, so every reconnect made it worse.
    it('treats video as live when a stale stream from a previous ICE restart is still reported', async () => {
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      // 'dead' is the leftover from a previous restart: frozen forever, and
      // deliberately iterated LAST so a last-one-wins reader samples it.
      let live = 5_000;
      (peer.getStats as jest.Mock).mockImplementation(async () => {
        live += 1_000;
        return new Map<string, unknown>([
          [
            'live',
            { type: 'inbound-rtp', kind: 'video', bytesReceived: live, framesPerSecond: 30 },
          ],
          [
            'dead',
            { type: 'inbound-rtp', kind: 'video', bytesReceived: 99_000, framesPerSecond: 0 },
          ],
        ]);
      });
      await jest.advanceTimersByTimeAsync(QUALITY_POLL_MS);
      await jest.advanceTimersByTimeAsync(QUALITY_POLL_MS);

      peer.setState('failed');
      cb.onState.mockClear();
      (sig.renegotiate as jest.Mock).mockClear();
      await jest.advanceTimersByTimeAsync(60_000);

      // Video never stopped, so the phone must not ask for an ICE restart.
      expect(sig.renegotiate).not.toHaveBeenCalled();
      expect(cb.onState).not.toHaveBeenCalledWith('failed');
      expect(cb.onState).toHaveBeenCalledWith('connected');
    });

    it('reports "connected" (never renegotiates) on repeated grace-window fires while video keeps flowing', async () => {
      // Replaces the old throttled-renegotiate-nudge behavior: now that the
      // desktop declines a renegotiate while video is live, the video-aware
      // degraded loop must stay completely quiet on the wire and just keep
      // reaffirming 'connected' on every re-check.
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      const liveVideoStats = (bytes: number) =>
        new Map([['in1', { type: 'inbound-rtp', kind: 'video', bytesReceived: bytes }]]);
      let bytes = 1000;
      (peer.getStats as jest.Mock).mockImplementation(async () => {
        bytes += 1000;
        return liveVideoStats(bytes);
      });

      // Establish video liveness before degrading.
      await jest.advanceTimersByTimeAsync(QUALITY_POLL_MS);
      await jest.advanceTimersByTimeAsync(QUALITY_POLL_MS);

      peer.setState('failed');
      cb.onState.mockClear();
      (sig.renegotiate as jest.Mock).mockClear();

      // Three grace-window fires in a row (15s of degraded-but-live time),
      // all with video still advancing every poll — no renegotiate on any
      // of them, and the UI stays on 'connected' throughout.
      await jest.advanceTimersByTimeAsync(5_000);
      await jest.advanceTimersByTimeAsync(5_000);
      await jest.advanceTimersByTimeAsync(5_000);

      expect(sig.renegotiate).not.toHaveBeenCalled();
      expect(cb.onState).toHaveBeenCalledWith('connected');
      expect(cb.onState).not.toHaveBeenCalledWith('recovering_ice', expect.anything());
    });

    it('escalates for real once video stops after a degrade, even though it looked fine at first', async () => {
      const cb = makeCallbacks();
      const { peer } = await startConnected(cb);

      (peer.getStats as jest.Mock).mockResolvedValue(
        new Map([['in1', { type: 'inbound-rtp', kind: 'video', bytesReceived: 1000 }]]),
      );
      await jest.advanceTimersByTimeAsync(QUALITY_POLL_MS);
      (peer.getStats as jest.Mock).mockResolvedValue(
        new Map([['in1', { type: 'inbound-rtp', kind: 'video', bytesReceived: 2000 }]]),
      );
      await jest.advanceTimersByTimeAsync(QUALITY_POLL_MS);

      peer.setState('failed');
      // Video keeps advancing through one grace window — stays alive.
      await jest.advanceTimersByTimeAsync(5_000);
      expect(cb.onState).not.toHaveBeenCalledWith('failed');

      // Now video genuinely stops: bytesReceived stalls, and enough time
      // passes for both the video-liveness window (6s) and another grace
      // window (5s) to elapse with no advance.
      (peer.getStats as jest.Mock).mockResolvedValue(
        new Map([['in1', { type: 'inbound-rtp', kind: 'video', bytesReceived: 2000 }]]),
      );
      await jest.advanceTimersByTimeAsync(15_000);

      expect(cb.onState).toHaveBeenCalledWith('recovering_ice', {
        attempt: 1,
        max: MAX_ICE_RESTARTS,
      });
    });
  });

  describe('app lifecycle wiring', () => {
    it('onBackground sends a pause with a reason', async () => {
      const cb = makeCallbacks();
      const { sig } = await startConnected(cb);
      lastLifecycle().cb.onBackground();
      expect(sig.pause).toHaveBeenCalledWith('backgrounded');
    });

    it('onForeground resumes, and reconnects only if the socket is not open', async () => {
      const cb = makeCallbacks();
      const { sig } = await startConnected(cb);

      sig.isOpen.mockReturnValue(true);
      lastLifecycle().cb.onForeground();
      expect(sig.beginReconnect).not.toHaveBeenCalled();
      expect(sig.resume).toHaveBeenCalledTimes(1);

      sig.isOpen.mockReturnValue(false);
      sig.isReconnecting.mockReturnValue(false);
      lastLifecycle().cb.onForeground();
      expect(sig.beginReconnect).toHaveBeenCalledWith(expect.any(String));
      expect(sig.resume).toHaveBeenCalledTimes(2);
    });

    it('onNetworkRestored renegotiates only once a peer connection exists', async () => {
      const cb = makeCallbacks();
      const conn = new ViewerConnection('wss://x', 'room1', ['view'], cb);
      await conn.start();
      const sig = lastSignaling();

      lastLifecycle().cb.onNetworkRestored();
      expect(sig.renegotiate).not.toHaveBeenCalled();

      sig.onMessage({
        type: 'session-start',
        roomId: 'room1',
        from: 'desktop',
        ts: 0,
        payload: { sessionId: 's1', grantedScopes: ['view'], iceServers: [] },
      });
      lastLifecycle().cb.onNetworkRestored();
      expect(sig.renegotiate).toHaveBeenCalledTimes(1);
    });

    it('debounces repeated network-restored renegotiates without dropping the first one', async () => {
      jest.setSystemTime(0);
      const cb = makeCallbacks();
      const conn = new ViewerConnection('wss://x', 'room1', ['view'], cb);
      await conn.start();
      const sig = lastSignaling();

      sig.onMessage({
        type: 'session-start',
        roomId: 'room1',
        from: 'desktop',
        ts: 0,
        payload: { sessionId: 's1', grantedScopes: ['view'], iceServers: [] },
      });

      lastLifecycle().cb.onNetworkRestored();
      jest.advanceTimersByTime(9_999);
      lastLifecycle().cb.onNetworkRestored();
      jest.advanceTimersByTime(1);
      lastLifecycle().cb.onNetworkRestored();

      expect(sig.renegotiate).toHaveBeenCalledTimes(2);
    });
  });

  describe('close', () => {
    it('tears down the peer, lifecycle controller, and signaling transport', async () => {
      const cb = makeCallbacks();
      const { conn, sig, peer } = await startConnected(cb);
      const lifecycle = lastLifecycle();

      conn.close();

      expect(peer.close).toHaveBeenCalled();
      expect(lifecycle.dispose).toHaveBeenCalled();
      expect(sig.disconnect).toHaveBeenCalledWith('viewer closed');
      expect(sig.close).toHaveBeenCalled();
    });
  });

  // ── two-channel input wiring (docs/audit/m3/input-touch.md Finding 2) ────

  describe('dual input-channel wiring', () => {
    it('routes pointer_move onto the move channel once it arrives AFTER the critical channel', async () => {
      const cb = makeCallbacks();
      const { conn, peer } = await startConnected(cb);

      const critical = peer.dispatchDataChannel(INPUT_CHANNEL_LABEL);
      const move = peer.dispatchDataChannel(INPUT_MOVE_CHANNEL_LABEL);

      conn.inputSender?.pointerMove(0.5, 0.5);
      jest.advanceTimersByTime(20);

      expect(move.send).toHaveBeenCalledTimes(1);
      expect(critical.send).not.toHaveBeenCalled();
    });

    it('routes pointer_move onto the move channel when it arrives BEFORE the critical channel', async () => {
      const cb = makeCallbacks();
      const { conn, peer } = await startConnected(cb);

      const move = peer.dispatchDataChannel(INPUT_MOVE_CHANNEL_LABEL);
      const critical = peer.dispatchDataChannel(INPUT_CHANNEL_LABEL);

      conn.inputSender?.pointerMove(0.5, 0.5);
      jest.advanceTimersByTime(20);

      expect(move.send).toHaveBeenCalledTimes(1);
      expect(critical.send).not.toHaveBeenCalled();
    });

    it('falls back to the critical channel for moves when the move channel never arrives', async () => {
      const cb = makeCallbacks();
      const { conn, peer } = await startConnected(cb);

      const critical = peer.dispatchDataChannel(INPUT_CHANNEL_LABEL);
      // No move channel ever dispatched — matches a peer that failed to
      // negotiate it.

      conn.inputSender?.pointerMove(0.5, 0.5);
      jest.advanceTimersByTime(20);

      expect(critical.send).toHaveBeenCalledTimes(1);
    });

    it('still routes clicks/keys onto the critical channel even once the move channel is wired', async () => {
      const cb = makeCallbacks();
      const { conn, peer } = await startConnected(cb);

      const critical = peer.dispatchDataChannel(INPUT_CHANNEL_LABEL);
      const move = peer.dispatchDataChannel(INPUT_MOVE_CHANNEL_LABEL);

      conn.inputSender?.click(0.5, 0.5);

      expect(critical.send).toHaveBeenCalledTimes(1);
      expect(move.send).not.toHaveBeenCalled();
    });

    it('flushes queued critical input when the reliable channel buffer drains', async () => {
      const cb = makeCallbacks();
      const { conn, peer } = await startConnected(cb);

      const critical = peer.dispatchDataChannel(INPUT_CHANNEL_LABEL);
      critical.bufferedAmount = MAX_BUFFERED_AMOUNT_BYTES + 1;

      conn.inputSender?.click(0.5, 0.5);
      expect(critical.send).not.toHaveBeenCalled();

      critical.bufferedAmount = 0;
      critical.emitBufferedAmountLow();

      expect(critical.bufferedAmountLowThreshold).toBe(MAX_BUFFERED_AMOUNT_BYTES / 2);
      expect(critical.send).toHaveBeenCalledTimes(1);
    });

    it('does not send backed-up move-channel traffic over the critical channel', async () => {
      const cb = makeCallbacks();
      const { conn, peer } = await startConnected(cb);

      const critical = peer.dispatchDataChannel(INPUT_CHANNEL_LABEL);
      const move = peer.dispatchDataChannel(INPUT_MOVE_CHANNEL_LABEL);
      move.bufferedAmount = MAX_BUFFERED_AMOUNT_BYTES + 1;

      conn.inputSender?.pointerMove(0.5, 0.5);
      jest.advanceTimersByTime(20);

      expect(move.send).not.toHaveBeenCalled();
      expect(critical.send).not.toHaveBeenCalled();
    });
  });

  // ── AI agent channel (docs/m5.3-ai-executor-plan.md §6) ──────────────────

  describe('agent messaging over the reliable input channel', () => {
    it('sends an agent_command frame and returns a runId', async () => {
      const cb = makeCallbacks();
      const { conn, peer } = await startConnected(cb);
      const critical = peer.dispatchDataChannel(INPUT_CHANNEL_LABEL);

      const runId = conn.sendAgentCommand('open Safari');

      expect(typeof runId).toBe('string');
      expect(critical.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(critical.send.mock.calls[0][0]);
      expect(sent).toMatchObject({ kind: 'agent_command', runId, text: 'open Safari' });
    });

    it('does not silently drop agent commands just because input backpressure is active', async () => {
      const cb = makeCallbacks();
      const { conn, peer } = await startConnected(cb);
      const critical = peer.dispatchDataChannel(INPUT_CHANNEL_LABEL);
      critical.bufferedAmount = MAX_BUFFERED_AMOUNT_BYTES + 1;

      conn.sendAgentCommand('open Safari');

      expect(critical.send).toHaveBeenCalledTimes(1);
    });

    it('sends stop and decision frames', async () => {
      const cb = makeCallbacks();
      const { conn, peer } = await startConnected(cb);
      const critical = peer.dispatchDataChannel(INPUT_CHANNEL_LABEL);

      conn.sendAgentStop('run-9');
      conn.sendAgentDecision('run-9', 'run-9-1', true);

      const kinds = critical.send.mock.calls.map((c: string[]) => JSON.parse(c[0]).kind);
      expect(kinds).toEqual(['agent_stop', 'agent_decision']);
      expect(JSON.parse(critical.send.mock.calls[1][0])).toMatchObject({
        kind: 'agent_decision',
        stepId: 'run-9-1',
        approve: true,
      });
    });

    it('dispatches incoming step and run_end frames to the callbacks', async () => {
      const cb = makeCallbacks();
      const { peer } = await startConnected(cb);
      const critical = peer.dispatchDataChannel(INPUT_CHANNEL_LABEL);

      critical.emitMessage(
        JSON.stringify({
          kind: 'agent_step',
          runId: 'r',
          stepId: 'r-1',
          step: 'action',
          summary: 'Open Safari',
          tier: 'skill',
          class: 'sensitive',
          state: 'running',
          ts: 1,
        }),
      );
      critical.emitMessage(
        JSON.stringify({ kind: 'agent_run_end', runId: 'r', outcome: 'completed', ts: 2 }),
      );

      expect(cb.onAgentStep).toHaveBeenCalledTimes(1);
      expect(cb.onAgentStep.mock.calls[0][0]).toMatchObject({ stepId: 'r-1', state: 'running' });
      expect(cb.onAgentRunEnd).toHaveBeenCalledTimes(1);
    });

    it('ignores non-agent frames (input batches) on the channel', async () => {
      const cb = makeCallbacks();
      const { peer } = await startConnected(cb);
      const critical = peer.dispatchDataChannel(INPUT_CHANNEL_LABEL);

      critical.emitMessage(JSON.stringify({ kind: 'input_batch', events: [] }));
      critical.emitMessage('not json');

      expect(cb.onAgentStep).not.toHaveBeenCalled();
      expect(cb.onAgentRunEnd).not.toHaveBeenCalled();
    });
  });
});
