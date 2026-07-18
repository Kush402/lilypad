import {
  iceRecoveryTimeoutMs,
  MAX_ICE_RESTARTS,
  INPUT_CHANNEL_LABEL,
  INPUT_MOVE_CHANNEL_LABEL,
} from '@lilypad/protocol';
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
    dispatchDataChannel(label: string): {
      label: string;
      send: jest.Mock;
      close: jest.Mock;
      addEventListener: jest.Mock;
      emitMessage: (data: unknown) => void;
    } {
      const msgListeners: ((e: { data: unknown }) => void)[] = [];
      const channel = {
        label,
        send: jest.fn(),
        close: jest.fn(),
        // Mirrors the real RTCDataChannel: the desktop sends the agent step
        // feed back on the reliable input channel, so the client listens here.
        addEventListener: jest.fn((type: string, cb: (e: { data: unknown }) => void) => {
          if (type === 'message') msgListeners.push(cb);
        }),
        emitMessage: (data: unknown) => msgListeners.forEach((cb) => cb({ data })),
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

      peer.setState('failed'); // peerConnected -> false, state -> recovering_ice
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

      peer.setState('failed'); // peerConnected -> false
      sig.onLifecycle({ kind: 'lost', error: new Error('gave up after 4 reconnect attempts') });

      expect(cb.onError).toHaveBeenCalledWith({
        code: 'signaling_lost',
        message: 'gave up after 4 reconnect attempts',
        retryable: true,
      });
      expect(cb.onState).toHaveBeenCalledWith('ended');
      expect(sig.close).toHaveBeenCalled();
    });
  });

  describe('ICE restart recovery', () => {
    it('requests a renegotiate and reports recovering_ice on a failed connection', async () => {
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      peer.setState('failed');

      expect(cb.onState).toHaveBeenCalledWith('recovering_ice', {
        attempt: 1,
        max: MAX_ICE_RESTARTS,
      });
      expect(sig.renegotiate).toHaveBeenCalledTimes(1);
    });

    it('gives up locally after exhausting its bounded restart-request budget', async () => {
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      peer.setState('failed'); // attempt 1
      peer.setState('failed'); // attempt 2
      peer.setState('failed'); // budget exhausted -> terminal failure

      expect(sig.renegotiate).toHaveBeenCalledTimes(2);
      expect(cb.onState).toHaveBeenLastCalledWith('failed');
      expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ice_failed' }));
    });

    it('resets the restart budget once the connection recovers', async () => {
      const cb = makeCallbacks();
      const { sig, peer } = await startConnected(cb);

      peer.setState('failed');
      peer.setState('connected');
      cb.onState.mockClear();
      (sig.renegotiate as jest.Mock).mockClear();

      // A fresh failure after recovering should get the full budget again,
      // not immediately terminal.
      peer.setState('failed');
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
      cb.onState.mockClear();

      jest.advanceTimersByTime(iceRecoveryTimeoutMs(1));

      expect(cb.onState).toHaveBeenCalledWith('failed');
    });

    it('clears the recovery deadline on reconnecting, so it does not fire a stale failure', async () => {
      const cb = makeCallbacks();
      const { peer } = await startConnected(cb);

      peer.setState('failed');
      peer.setState('connected'); // recovered well within the deadline
      cb.onState.mockClear();

      jest.advanceTimersByTime(iceRecoveryTimeoutMs(2)); // the longest possible deadline

      expect(cb.onState).not.toHaveBeenCalledWith('failed');
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
