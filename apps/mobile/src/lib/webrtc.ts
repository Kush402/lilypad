import { Platform } from 'react-native';
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  MediaStream,
} from 'react-native-webrtc';
import {
  INPUT_CHANNEL_LABEL,
  INPUT_MOVE_CHANNEL_LABEL,
  APP_HEARTBEAT_INTERVAL_MS,
  MAX_ICE_RESTARTS,
  iceRecoveryTimeoutMs,
  AgentOutboundSchema,
  encodeAgentMessage,
  type IceServer,
  type SessionScope,
  type SignalingMessage,
  type CaptureMode,
  type AgentStep,
  type AgentRunEnd,
} from '@lilypad/protocol';
import { MobileSignaling, type SignalingLifecycleEvent } from './signaling';
import { AppLifecycleController } from './lifecycle';
import { InputSender } from './input';
import { getDeviceId } from './device';
import { appError, type AppError } from './errors';
import { classifyQuality, QUALITY_POLL_MS, type ConnectionQuality } from './quality';

export type ViewerState =
  | 'connecting'
  | 'awaiting_approval'
  | 'negotiating'
  | 'connected'
  | 'reconnecting_signaling'
  | 'recovering_ice'
  | 'denied'
  | 'failed'
  | 'ended';

/** Attached to a `recovering_ice` state so the UI can show "attempt N/max"
 * instead of a bare "Recovering…" with no sense of progress or bound. */
export interface RecoveryDetail {
  attempt: number;
  max: number;
}

export interface ViewerCallbacks {
  onStream: (stream: MediaStream) => void;
  onState: (state: ViewerState, detail?: RecoveryDetail) => void;
  onError: (err: AppError) => void;
  onStats: (stats: ConnectionQuality) => void;
  /** The desktop's capture resolution and active capture mode, for
   * letterbox-aware touch mapping (`docs/audit/m3/input-touch.md` Finding 1)
   * and the mode-toggle UI (`docs/audit/m3/prior-art.md` Finding 2). Fires
   * on `session-start`'s follow-up `frame-size` message and on any later
   * resolution or mode change. */
  onFrameSize: (width: number, height: number, mode: CaptureMode) => void;
  /** The desktop's OS clipboard changed. See
   * `docs/audit/m3/prior-art.md` Finding 6. */
  onClipboardUpdate: (text: string) => void;
  /** The AI agent emitted a step on its live feed (desktop → phone over the
   * reliable input channel). Optional — a viewer that doesn't surface the
   * agent simply omits it. See docs/m5.3-ai-executor-plan.md §6. */
  onAgentStep?: (step: AgentStep) => void;
  /** The AI agent run ended (completed/stopped/denied/failed). */
  onAgentRunEnd?: (end: AgentRunEnd) => void;
}

/**
 * Client-side safety valve bounding how many times THIS side asks the
 * desktop to restart ICE before giving up locally. Independent of (and,
 * via the shared `MAX_ICE_RESTARTS` constant, kept the same shape as) the
 * desktop's own authoritative budget (`apps/desktop/src-tauri/src/session/mod.rs`)
 * — the desktop's counter is the one that actually enforces the cap on the
 * side that performs the restart; this one just stops the mobile app from
 * asking forever if its own local network keeps flapping.
 */
const MAX_ICE_RESTART_REQUESTS: number = MAX_ICE_RESTARTS;

/**
 * The mobile answer-side of a session. Registers as the mobile seat, requests
 * control, answers the desktop's offer, renders its video track, and opens the
 * input path over the DataChannel the desktop creates.
 *
 * Also owns session resilience: a dropped signaling socket reconnects in the
 * background (media keeps flowing peer-to-peer meanwhile), a failed peer
 * connection triggers a bounded ICE-restart request, and app
 * backgrounding/foregrounding and network-path changes drive `pause`/
 * `resume`/`renegotiate`. See `docs/audit/m3/reconnect-lifecycle.md`
 * Findings 1, 4, and 5 — this is that redesign.
 */
export class ViewerConnection {
  private pc: RTCPeerConnection | null = null;
  private readonly sig: MobileSignaling;
  private input: InputSender | null = null;
  /** Monotonic suffix for run ids minted by `sendAgentCommand`. */
  private agentRunCounter = 0;
  private dataChannel: { send: (d: string) => void; close: () => void; label?: string } | null =
    null;
  /** The unreliable move channel — separate from `dataChannel` above since
   * it has its own open/close lifecycle and may never open at all (older
   * peer, transient negotiation failure). `InputSender` falls back to the
   * critical channel when this is absent. See
   * `docs/audit/m3/input-touch.md` Finding 2. */
  private moveDataChannel: { send: (d: string) => void; close: () => void; label?: string } | null =
    null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lifecycle: AppLifecycleController | null = null;

  /** True once the peer connection has reached `connected` at least once and
   * hasn't since failed/closed — mirrors the desktop's `peer_connected`
   * (`session/mod.rs`), the single source of truth for "is a dropped
   * signaling socket recoverable in the background, or fatal." */
  private peerConnected = false;
  private iceRestartAttempts = 0;
  private recoveryDeadline: ReturnType<typeof setTimeout> | null = null;
  private statsPoll: ReturnType<typeof setInterval> | null = null;
  private lastInboundBytes: number | null = null;
  private lastStatsAt: number | null = null;

  constructor(
    signalingUrl: string,
    private readonly roomId: string,
    private readonly scopes: SessionScope[],
    private readonly cb: ViewerCallbacks,
  ) {
    this.sig = new MobileSignaling(
      signalingUrl,
      roomId,
      (m) => this.onSignal(m),
      (e) => this.onSignalingLifecycle(e),
    );
  }

  async start(): Promise<void> {
    this.cb.onState('connecting');
    await this.sig.connect();
    this.sig.register(getDeviceId());
    this.sig.pairRequest(getDeviceId(), `${Platform.OS} phone`, this.scopes);
    // The pair-request is now in flight — the desktop is showing "Approve /
    // Deny" to a human, not routing a packet. That wait can take a while and
    // deserves its own "look at your laptop" moment instead of reusing the
    // generic 'connecting' spinner for both. See
    // docs/audit/m3/mobile-ux.md Finding 1.
    this.cb.onState('awaiting_approval');
    this.heartbeat = setInterval(() => this.sig.heartbeat(), APP_HEARTBEAT_INTERVAL_MS);
    this.lifecycle = new AppLifecycleController({
      onBackground: () => this.sig.pause('backgrounded'),
      onForeground: () => {
        if (!this.sig.isOpen() && !this.sig.isReconnecting()) {
          this.cb.onState('reconnecting_signaling');
          this.sig.beginReconnect(getDeviceId());
        }
        this.sig.resume();
      },
      // A new network path is available — ask for a fresh ICE-restart offer
      // proactively rather than waiting for the peer connection to notice
      // the old path is dead and time out on its own (Finding 4). Bounded by
      // the desktop's own shared restart budget regardless of how often this
      // fires; harmless if the peer isn't up yet (renegotiate is a no-op
      // without a peer to restart, mirrored server-side too).
      onNetworkRestored: () => {
        if (this.pc) this.sig.renegotiate();
      },
    });
  }

  get inputSender(): InputSender | null {
    return this.input;
  }

  /** Parse and dispatch an agent step-feed frame from the desktop. Frames that
   * aren't valid agent-outbound messages (nothing else is sent on this channel
   * today, but be defensive) are silently ignored. */
  private handleAgentFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = AgentOutboundSchema.safeParse(json);
    if (!parsed.success) return;
    if (parsed.data.kind === 'agent_step') this.cb.onAgentStep?.(parsed.data);
    else this.cb.onAgentRunEnd?.(parsed.data);
  }

  /** Dispatch a natural-language task to the desktop agent. Returns the runId
   * so the caller can correlate the step feed and later stop/decision calls.
   * A closed channel drops the send (the caller sees no feed and can retry). */
  sendAgentCommand(text: string): string {
    const runId = `run-${Date.now()}-${(this.agentRunCounter += 1)}`;
    this.sendAgent({ kind: 'agent_command', runId, text, ts: Date.now() });
    return runId;
  }

  sendAgentStop(runId: string): void {
    this.sendAgent({ kind: 'agent_stop', runId, ts: Date.now() });
  }

  sendAgentDecision(runId: string, stepId: string, approve: boolean): void {
    this.sendAgent({ kind: 'agent_decision', runId, stepId, approve, ts: Date.now() });
  }

  private sendAgent(msg: Parameters<typeof encodeAgentMessage>[0]): void {
    try {
      this.dataChannel?.send(encodeAgentMessage(msg));
    } catch {
      /* channel not open — drop */
    }
  }

  /** Ask the desktop to switch capture/encode mode. See
   * `docs/audit/m3/prior-art.md` Finding 2. */
  requestCaptureMode(mode: CaptureMode): void {
    this.sig.setCaptureMode(mode);
  }

  private onSignal(m: SignalingMessage): void {
    switch (m.type) {
      case 'session-start':
        // Approval already happened and ICE servers are assigned — the peer
        // connection is about to be built and an offer is imminent. See
        // docs/audit/m3/mobile-ux.md Finding 1.
        this.cb.onState('negotiating');
        this.setupPeer(m.payload.iceServers);
        break;
      case 'offer':
        void this.handleOffer(m.payload.sdp);
        break;
      case 'ice-candidate':
        void this.pc
          ?.addIceCandidate(
            new RTCIceCandidate({
              candidate: m.payload.candidate,
              sdpMid: m.payload.sdpMid ?? undefined,
              sdpMLineIndex: m.payload.sdpMLineIndex ?? undefined,
            }),
          )
          .catch(() => undefined);
        break;
      case 'frame-size':
        // The desktop's capture resolution — the phone needs it to map
        // touches onto the letterboxed video rather than the whole view.
        // See docs/audit/m3/input-touch.md Finding 1.
        this.cb.onFrameSize(m.payload.width, m.payload.height, m.payload.mode);
        break;
      case 'clipboard-update':
        // The desktop's OS clipboard changed — mirror it onto the phone's.
        // See docs/audit/m3/prior-art.md Finding 6.
        this.cb.onClipboardUpdate(m.payload.text);
        break;
      case 'pair-denied':
        // Split out from the generic 'ended' bucket: a denial is a decision,
        // not a failure — the UI shows different copy and no "reconnect"
        // affordance for it. See docs/audit/m3/mobile-ux.md Finding 1.
        this.cb.onState('denied');
        this.close();
        break;
      case 'disconnect':
      case 'session-end':
        this.cb.onState('ended');
        this.close();
        break;
      case 'error':
        this.cb.onError(appError('unknown', m.payload.message));
        break;
      default:
        break;
    }
  }

  /** Handle a transport-lifecycle event from `MobileSignaling` — the decision
   * of "is a dropped socket recoverable" lives here, not in the transport
   * itself (mirrors the desktop orchestrator's identical split of
   * responsibility). */
  private onSignalingLifecycle(event: SignalingLifecycleEvent): void {
    switch (event.kind) {
      case 'closed':
        if (this.peerConnected) {
          this.cb.onState('reconnecting_signaling');
          this.sig.beginReconnect(getDeviceId());
        } else {
          // Before the peer is up, signaling IS the session — matches the
          // desktop's own rule (`session/mod.rs`'s `SignalingClientEvent::Closed`
          // handler).
          this.cb.onState('ended');
          this.close();
        }
        break;
      case 'reconnected':
        // Only overwrite the badge if the peer itself is still healthy —
        // don't stomp a more urgent 'recovering_ice'/'failed' state just
        // because signaling came back while the peer connection is still
        // unwell.
        if (this.peerConnected) {
          this.cb.onState('connected');
        }
        break;
      case 'lost':
        // Matches the desktop's `SignalingClientEvent::Lost` handling: end
        // the session unconditionally, even if media still nominally flows —
        // without signaling there is no way to recover on ICE failure, honor
        // `session-end`, or ever renegotiate again.
        this.cb.onError(appError('signaling_lost', event.error.message));
        this.cb.onState('ended');
        this.close();
        break;
    }
  }

  private setupPeer(iceServers: IceServer[]): void {
    const pc = new RTCPeerConnection({ iceServers: iceServers as any });
    this.pc = pc;
    this.iceRestartAttempts = 0;
    this.startStatsPolling();
    const p = pc as unknown as {
      addEventListener: (t: string, cb: (e: any) => void) => void;
      connectionState: string;
    };

    p.addEventListener('track', (e: any) => {
      const stream: MediaStream =
        e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      this.cb.onStream(stream);
    });
    p.addEventListener('icecandidate', (e: any) => {
      if (e.candidate) {
        this.sig.iceCandidate(
          e.candidate.candidate,
          e.candidate.sdpMid ?? null,
          e.candidate.sdpMLineIndex ?? null,
        );
      }
    });
    p.addEventListener('connectionstatechange', () => {
      const s = p.connectionState;
      if (s === 'connected') {
        this.peerConnected = true;
        this.iceRestartAttempts = 0;
        this.clearRecoveryDeadline();
        this.cb.onState('connected');
      } else if (s === 'failed' || s === 'disconnected') {
        // Treat 'disconnected' the same as 'failed': it's the ICE-level
        // signal that the current path is unhealthy and may or may not
        // self-recover — attempting a bounded restart is strictly better
        // than either silently hoping (old behavior) or immediately ending
        // the viewer on what is very often a transient blip.
        this.peerConnected = false;
        this.attemptIceRecovery();
      } else if (s === 'closed') {
        // Only reached via an explicit local pc.close() — genuinely
        // terminal, matches the desktop's identical rule.
        this.peerConnected = false;
        this.cb.onState('ended');
      }
    });
    // The desktop (offerer) creates both input channels; arrival order
    // between the two is not guaranteed, so each branch wires the move
    // channel into `InputSender` if the other one has already shown up.
    p.addEventListener('datachannel', (e: any) => {
      if (e.channel?.label === INPUT_CHANNEL_LABEL) {
        this.dataChannel = e.channel;
        this.input = new InputSender((data) => {
          try {
            this.dataChannel?.send(data);
          } catch {
            /* channel not open */
          }
        });
        // The desktop sends the AI agent's step feed back on this same
        // reliable channel — listen for it (input, by contrast, is send-only
        // from the phone). Non-agent frames are ignored here.
        if (typeof e.channel.addEventListener === 'function') {
          e.channel.addEventListener('message', (ev: { data: unknown }) => {
            this.handleAgentFrame(ev.data);
          });
        }
        if (this.moveDataChannel) this.wireMoveChannel();
      } else if (e.channel?.label === INPUT_MOVE_CHANNEL_LABEL) {
        this.moveDataChannel = e.channel;
        if (this.input) this.wireMoveChannel();
      }
    });
  }

  /** Wire the (already-arrived) move channel into `InputSender`'s send
   * callback. Only called once both `this.input` and `this.moveDataChannel`
   * are known to exist. */
  private wireMoveChannel(): void {
    this.input?.setMoveChannel((data) => {
      try {
        this.moveDataChannel?.send(data);
      } catch {
        /* channel not open */
      }
    });
  }

  /** Ask the desktop for a bounded ICE restart, mirroring the desktop's own
   * `attempt_ice_restart` (`session/mod.rs`): bounded attempts, a recovery
   * deadline, and an intermediate state distinct from the terminal 'failed'
   * so the UI shows "Reconnecting…" instead of a dead end while it's in
   * flight. */
  private attemptIceRecovery(): void {
    if (this.iceRestartAttempts >= MAX_ICE_RESTART_REQUESTS) {
      this.cb.onState('failed');
      this.cb.onError(appError('ice_failed'));
      return;
    }
    this.iceRestartAttempts += 1;
    this.cb.onState('recovering_ice', {
      attempt: this.iceRestartAttempts,
      max: MAX_ICE_RESTART_REQUESTS,
    });
    this.sig.renegotiate();
    this.clearRecoveryDeadline();
    this.recoveryDeadline = setTimeout(() => {
      this.recoveryDeadline = null;
      if (!this.peerConnected) {
        this.cb.onState('failed');
        this.cb.onError(appError('ice_failed'));
      }
    }, iceRecoveryTimeoutMs(this.iceRestartAttempts));
  }

  private clearRecoveryDeadline(): void {
    if (this.recoveryDeadline) {
      clearTimeout(this.recoveryDeadline);
      this.recoveryDeadline = null;
    }
  }

  /** Poll `RTCPeerConnection.getStats()` for the viewer's connection-quality
   * HUD — RTT off the active candidate pair, inbound video bitrate/fps/loss.
   * See docs/audit/m3/mobile-ux.md Finding 8. */
  private startStatsPolling(): void {
    this.stopStatsPolling();
    this.lastInboundBytes = null;
    this.lastStatsAt = null;
    this.statsPoll = setInterval(() => void this.pollStats(), QUALITY_POLL_MS);
  }

  private stopStatsPolling(): void {
    if (this.statsPoll) {
      clearInterval(this.statsPoll);
      this.statsPoll = null;
    }
  }

  private async pollStats(): Promise<void> {
    if (!this.pc) return;
    let report: Map<string, any>;
    try {
      report = (await this.pc.getStats()) as unknown as Map<string, any>;
    } catch {
      return;
    }

    let rttMs: number | null = null;
    let fps: number | null = null;
    let packetLossPct: number | null = null;
    let bitrateKbps: number | null = null;

    for (const stat of report.values()) {
      if (stat.type === 'candidate-pair' && (stat.nominated || stat.selected)) {
        if (typeof stat.currentRoundTripTime === 'number') {
          rttMs = Math.round(stat.currentRoundTripTime * 1000);
        }
      }
      if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
        if (typeof stat.framesPerSecond === 'number') {
          fps = Math.round(stat.framesPerSecond);
        }
        if (typeof stat.packetsLost === 'number' && typeof stat.packetsReceived === 'number') {
          const total = stat.packetsLost + stat.packetsReceived;
          packetLossPct = total > 0 ? (stat.packetsLost / total) * 100 : 0;
        }
        if (typeof stat.bytesReceived === 'number') {
          const now = Date.now();
          if (this.lastInboundBytes !== null && this.lastStatsAt !== null) {
            const deltaBytes = stat.bytesReceived - this.lastInboundBytes;
            const deltaSec = (now - this.lastStatsAt) / 1000;
            if (deltaSec > 0) {
              bitrateKbps = Math.max(0, Math.round((deltaBytes * 8) / deltaSec / 1000));
            }
          }
          this.lastInboundBytes = stat.bytesReceived;
          this.lastStatsAt = now;
        }
      }
    }

    this.cb.onStats({
      level: classifyQuality(rttMs, packetLossPct),
      rttMs,
      bitrateKbps,
      fps,
      packetLossPct,
    });
  }

  private async handleOffer(sdp: string): Promise<void> {
    if (!this.pc) return;
    // No `onState('negotiating')` here: the initial offer follows
    // 'session-start' (which already set it), and a later renegotiation
    // offer arrives mid-`recovering_ice` — stomping that back to a generic
    // 'negotiating' would regress the more specific, more useful state the
    // user is already seeing. See docs/audit/m3/mobile-ux.md Finding 1.
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sig.answer((answer as any).sdp);
  }

  close(): void {
    this.lifecycle?.dispose();
    this.lifecycle = null;
    this.clearRecoveryDeadline();
    this.stopStatsPolling();
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.input?.flush();
    try {
      this.dataChannel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.moveDataChannel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.sig.disconnect('viewer closed');
    this.sig.close();
    this.pc = null;
  }
}
