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
  type DisplayInfo,
  type AgentStep,
  type AgentRunEnd,
} from '@lilypad/protocol';
import { MobileSignaling, type SignalingLifecycleEvent } from './signaling';
import { AppLifecycleController } from './lifecycle';
import { InputSender, MAX_BUFFERED_AMOUNT_BYTES } from './input';
import { getDeviceId } from './device';
import { appError, classifyHubError, type AppError } from './errors';
import { record, recordState, startSession } from './journal';
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
  /** Which displays the Mac has attached and which one the video is showing.
   * Rides the same `frame-size` message as the resolution, because those are
   * the same moments: the pipeline starting, a mode switch, a display switch,
   * and a monitor being plugged in or pulled out. Optional and possibly
   * empty — a Mac running a version older than 0.1.10 sends no list, and the
   * switcher stays hidden, exactly as it does on a single-screen Mac. */
  onDisplays?: (displays: DisplayInfo[], activeId: number | null) => void;
  /** The desktop's OS clipboard changed. See
   * `docs/audit/m3/prior-art.md` Finding 6. */
  onClipboardUpdate: (text: string) => void;
  /** The AI agent emitted a step on its live feed (desktop → phone over the
   * reliable input channel). Optional — a viewer that doesn't surface the
   * agent simply omits it. See docs/m5.3-ai-executor-plan.md §6. */
  onAgentStep?: (step: AgentStep) => void;
  /** The AI agent run ended (completed/stopped/denied/failed). */
  onAgentRunEnd?: (end: AgentRunEnd) => void;
  /** The backend delivered this pair's connect secret (M5.4 security), right
   * after a trusted approval. The viewer persists it against the desktop so
   * future no-QR reconnects can present it. */
  onPairSecret?: (secret: string) => void;
  /** Desktop advertised its LAN control-plane URLs for cached reconnect. */
  onLanEndpoints?: (endpoints: {
    apiBaseUrl: string;
    signalingUrl: string;
    tlsCertSha256: string;
  }) => void;
  /** The desktop revoked this phone's trust mid-session (the backend force-
   * ended the room with `session-end` reason `'revoked'` — see
   * `apps/backend/src/signaling/hub.ts`'s `endRoomsForDevicePair`). Fires
   * BEFORE `onState('ended')` so the screen can show a specific "access
   * revoked" message and clean up the stale local pairing, instead of the
   * generic disconnect the ordinary `ended` state implies. Optional — a
   * viewer that doesn't care just falls back to the generic ended state. */
  onRevoked?: () => void;
  /**
   * The LAPTOP left the account mid-session — it signed itself out, or its
   * owner removed it from "Your devices" (`session-end` reason
   * `'device_removed'`, from `DELETE /devices/:deviceId`).
   *
   * Deliberately NOT `onRevoked`, which drops the local pairing. The pair rows
   * and their per-pair secrets survive a device removal, and the secret is
   * never re-issued — so a phone that forgot it would have to re-scan a QR to
   * recover from something that undoes itself the moment somebody signs in on
   * that Mac again. Same end of session, different aftermath.
   */
  onDeviceRemoved?: () => void;
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
 * Grace period before treating 'disconnected' as 'failed' — ICE disconnected
 * is transient and self-recoverable, but webrtc-rs may report it when the
 * network briefly falters (e.g., DataChannel buffer fills under congestion).
 * A 5s window lets the connection self-recover without triggering the
 * destructive ICE restart cycle. Matches the desktop's TRAFFIC_LIVENESS_WINDOW
 * philosophy of 22s, but tighter for mobile's more reactive ICE stack.
 */
const DISCONNECTED_GRACE_MS = 5_000;

/**
 * Minimum interval between renegotiate requests triggered by network restoration.
 * Cellular can flicker every ~11s; this debounce prevents an ICE restart storm.
 */
const NETWORK_RESTORE_DEBOUNCE_MS = 10_000;

/**
 * How recently inbound video must have advanced for the path to count as
 * "demonstrably alive". This is the receiver's own ground truth, and it beats
 * every ICE verdict: if decoded video bytes are still climbing, the forward
 * path works — full stop — no matter what `iceConnectionState` claims.
 *
 * On a relayed cellular path the return direction (phone→desktop STUN consent
 * checks + RTCP) flaps independently of the forward video, so ICE reports
 * `disconnected` while the screen is still streaming perfectly. Requesting an
 * ICE restart there is pure self-harm: a fresh offer, candidate re-trickle, and
 * an IDR that glitches a stream that was never broken — the "connect →
 * reconnecting → recovering" loop the user sees. So while video is live we
 * DON'T renegotiate on a transient disconnect; we keep re-checking, and only
 * recover if the video ITSELF stops (a real outage). This is the phone-side
 * twin of the desktop's `peer_traffic_fresh` outvote (`session/mod.rs`), using
 * the strongest possible liveness signal.
 *
 * On cellular the forward video itself can gap for several seconds during a
 * relay hiccup while the phone is still fine — a too-tight window flips
 * `isReceivingVideo()` false on a stall that was about to resume, pushing us
 * into the escalation path for nothing. 15s tolerates those transient gaps
 * without a false "video stopped" verdict, while still catching a genuinely
 * dead stream reasonably promptly. `QUALITY_POLL_MS` is 2s, so 15s ≈ 7 missed
 * polls — deliberately not wider than that, so a truly frozen stream doesn't
 * sit on 'connected' too long.
 */
const VIDEO_LIVENESS_WINDOW_MS = 15_000;

const BUFFERED_AMOUNT_LOW_THRESHOLD_BYTES = MAX_BUFFERED_AMOUNT_BYTES / 2;

type DataChannelLike = {
  label?: string;
  readyState?: string;
  bufferedAmount?: number | null;
  bufferedAmountLowThreshold?: number;
  onbufferedamountlow?: ((event: unknown) => void) | null;
  send: (d: string) => void;
  close: () => void;
  addEventListener?: (type: string, cb: (event: any) => void) => void;
};

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
  private dataChannel: DataChannelLike | null = null;
  /** The unreliable move channel — separate from `dataChannel` above since
   * it has its own open/close lifecycle and may never open at all (older
   * peer, transient negotiation failure). `InputSender` falls back to the
   * critical channel when this is absent. See
   * `docs/audit/m3/input-touch.md` Finding 2. */
  private moveDataChannel: DataChannelLike | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lifecycle: AppLifecycleController | null = null;
  /** Guard against acting on callbacks after close() began — prevents
   * race conditions where signaling lifecycle events arrive while we're
   * tearing down. Checked at the top of every callback entry point. */
  private isClosed = false;

  /** True once the peer connection has reached `connected` at least once and
   * hasn't since failed/closed — mirrors the desktop's `peer_connected`
   * (`session/mod.rs`), the single source of truth for "is a dropped
   * signaling socket recoverable in the background, or fatal." */
  private peerConnected = false;
  private iceRestartAttempts = 0;
  private recoveryDeadline: ReturnType<typeof setTimeout> | null = null;
  /** Pacing timer between signaling-reconnect cycles after a `lost` verdict
   * while media is still healthy (see `onSignalingLifecycle`). */
  private lostRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private statsPoll: ReturnType<typeof setInterval> | null = null;
  /** Last quality level journalled, so only transitions are recorded. */
  private lastQualityLevel: string | null = null;
  private lastInboundBytes: number | null = null;
  private lastStatsAt: number | null = null;
  /** Wall-clock of the last poll where inbound video bytes actually advanced —
   * the receiver's proof the forward path is alive. Drives the video-liveness
   * outvote of a false `disconnected` (see `VIDEO_LIVENESS_WINDOW_MS`). */
  private lastVideoAdvanceAt: number | null = null;
  /** Timer for debouncing a lingering 'disconnected' OR 'failed' state before
   * escalating — both PC states are routed through the same video-aware
   * recheck (`armDegradedRecheck`), since ICE's severity ranking between them
   * doesn't matter once video-liveness is the ground truth. */
  private degradedGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp of last network restoration renegotiate to debounce flapping. */
  private lastNetworkRestoreRenegotiate: number = Number.NEGATIVE_INFINITY;
  private iceServers: IceServer[] = [];

  constructor(
    signalingUrl: string,
    private readonly roomId: string,
    private readonly scopes: SessionScope[],
    private readonly cb: ViewerCallbacks,
    tlsPin?: string,
  ) {
    this.sig = new MobileSignaling(
      signalingUrl,
      roomId,
      (m) => this.onSignal(m),
      (e) => this.onSignalingLifecycle(e),
      tlsPin,
    );
  }

  async start(): Promise<void> {
    startSession();
    recordState('connecting');
    this.cb.onState('connecting');
    await this.sig.connect();
    this.sig.register(getDeviceId());
    this.sig.pairRequest(getDeviceId(), `${Platform.OS} phone`, this.scopes);
    // The pair-request is now in flight — the desktop is showing "Approve /
    // Deny" to a human, not routing a packet. That wait can take a while and
    // deserves its own "look at your laptop" moment instead of reusing the
    // generic 'connecting' spinner for both. See
    // docs/audit/m3/mobile-ux.md Finding 1.
    recordState('awaiting_approval');
    this.cb.onState('awaiting_approval');
    // Fire one heartbeat immediately, then on the interval: `setInterval`
    // waits a full interval before its first call, which on a cellular path
    // through the tunnel left the freshly-registered socket idle long enough
    // to be dropped before it ever sent a keepalive (observed ~7s drop
    // mid-approval). The immediate beat closes that initial idle window.
    this.sig.heartbeat();
    this.heartbeat = setInterval(() => this.sig.heartbeat(), APP_HEARTBEAT_INTERVAL_MS);
    this.lifecycle = new AppLifecycleController({
      onBackground: () => {
        this.sig.pause('backgrounded');
        // Tell the hub the seat is vacant now, not after iOS freezes JS
        // and heartbeats stop. The desktop ends after reregister grace
        // if we never reclaim; a foreground within that window reconnects.
        this.sig.dropTransport();
      },
      onForeground: () => {
        if (!this.sig.isOpen() && !this.sig.isReconnecting()) {
          recordState('reconnecting signaling');
          this.cb.onState('reconnecting_signaling');
          this.sig.beginReconnect(getDeviceId());
        }
        this.sig.resume();
      },
      // A new network path is available — ask for a fresh ICE-restart offer
      // proactively rather than waiting for the peer connection to notice
      // the old path is dead and time out on its own (Finding 4). ONLY when
      // the peer is actually unhealthy: flappy cellular fires this event
      // constantly (observed live: every ~11s), and restarting a HEALTHY
      // connection each time was the lag itself — candidate regathering,
      // keyframe storms, bitrate pinned to the floor. A working path keeps
      // working; the ICE-failure handler still owns the broken case.
      onNetworkRestored: () => {
        // Only renegotiate if there's an unhealthy peer connection
        if (!this.pc || this.peerConnected) return;
        if (this.degradedGraceTimer) return;
        // Debounce network restoration renegotiate to prevent ICE restart storm
        const now = Date.now();
        if (now - this.lastNetworkRestoreRenegotiate < NETWORK_RESTORE_DEBOUNCE_MS) {
          return;
        }
        this.lastNetworkRestoreRenegotiate = now;
        this.sig.renegotiate();
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
    // Guard against processing after close
    if (this.isClosed) return;
    // The desktop sends agent frames as TEXT, but accept binary too — an
    // older desktop build sent them as ArrayBuffer, and dropping those left
    // the panel on "Thinking…" forever with no visible failure.
    let text: string;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      // Guarded global lookup: TextDecoder isn't in the RN type surface (and
      // may be absent on older Hermes) — legacy tolerance only, so a missing
      // decoder just drops the frame like before.
      const Decoder = (globalThis as { TextDecoder?: new () => { decode(b: ArrayBuffer): string } })
        .TextDecoder;
      if (!Decoder) return;
      try {
        text = new Decoder().decode(data);
      } catch {
        return;
      }
    } else {
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = AgentOutboundSchema.safeParse(json);
    if (!parsed.success) return;
    if (parsed.data.kind === 'agent_step') this.cb.onAgentStep?.(parsed.data);
    else this.cb.onAgentRunEnd?.(parsed.data);
  }

  /** Ask the desktop to switch capture/encode mode. See
   * `docs/audit/m3/prior-art.md` Finding 2. */
  requestCaptureMode(mode: CaptureMode): void {
    this.sig.setCaptureMode(mode);
  }

  /** Ask the desktop to show a different display. Costs the same rebuild as a
   * mode switch, so the UI gives it the same brief "Switching…" feedback. */
  requestDisplay(displayId: number): void {
    record('display requested', String(displayId));
    this.sig.setDisplay(displayId);
  }

  /** Dispatch a natural-language task to the desktop agent. Returns the runId
   * so the caller can correlate the step feed and later stop/decision calls. */
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

  private sendWhenOpen(getChannel: () => DataChannelLike | null): (data: string) => void {
    return (data: string) => {
      const channel = getChannel();
      if (!channel) return;
      // Missing `readyState` (Jest fakes) is treated as open so unit tests
      // keep covering the send path. A real RTCDataChannel is only writable
      // in `open`.
      if (channel.readyState && channel.readyState !== 'open') return;
      try {
        channel.send(data);
      } catch {
        /* channel not open */
      }
    };
  }

  private sendAgent(msg: Parameters<typeof encodeAgentMessage>[0]): void {
    if (!this.dataChannel || this.isClosed) return;
    this.sendWhenOpen(() => this.dataChannel)(encodeAgentMessage(msg));
  }

  private onSignal(m: SignalingMessage): void {
    // Guard against processing messages after close() began — prevents
    // race conditions where signaling events arrive while we're tearing down
    if (this.isClosed) return;
    switch (m.type) {
      case 'session-start':
        // Approval already happened and ICE servers are assigned — the peer
        // connection is about to be built and an offer is imminent. See
        // docs/audit/m3/mobile-ux.md Finding 1.
        recordState('negotiating');
        this.cb.onState('negotiating');
        this.setupPeer(m.payload.iceServers, m.payload.iceTransportPolicy);
        break;
      case 'offer':
        // A rejected offer application must not vanish: mid-session this is
        // an ICE-restart offer, and silently dropping it strands the session
        // in a dead-path state until the desktop's recovery deadline kills
        // it with no trace of why.
        this.handleOffer(m.payload.sdp).catch((err) => {
          // The raw text goes to the journal, not to the screen. "applying
          // offer failed: InvalidAccessError: ..." is a sentence for whoever
          // debugs it later, and this module already learned that lesson once
          // for the hub's own words a few lines below.
          record('offer failed', String(err));
          this.cb.onError(appError('unknown'));
        });
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
        this.cb.onDisplays?.(m.payload.displays ?? [], m.payload.activeDisplayId ?? null);
        break;
      case 'clipboard-update':
        // The desktop's OS clipboard changed — mirror it onto the phone's.
        // See docs/audit/m3/prior-art.md Finding 6.
        this.cb.onClipboardUpdate(m.payload.text);
        break;
      case 'pair-secret':
        this.cb.onPairSecret?.(m.payload.secret);
        break;
      case 'lan-endpoints':
        this.cb.onLanEndpoints?.({
          apiBaseUrl: m.payload.apiBaseUrl,
          signalingUrl: m.payload.signalingUrl,
          tlsCertSha256: m.payload.tlsCertSha256,
        });
        break;
      case 'pair-denied':
        // Split out from the generic 'ended' bucket: a denial is a decision,
        // not a failure — the UI shows different copy and no "reconnect"
        // affordance for it. See docs/audit/m3/mobile-ux.md Finding 1.
        recordState('denied');
        this.cb.onState('denied');
        this.close();
        break;
      case 'session-end':
        // A revoke is a distinct trigger from every other end-of-session
        // reason (peer hangup, "peer connection closed", etc.) — the backend
        // stamps this exact, stable string only when the desktop force-ended
        // the room because it revoked this phone's trust. Checked before the
        // generic handling below so the screen can show a specific message
        // and drop the now-stale local pairing instead of the ordinary
        // "ended" treatment. `disconnect` carries no such distinction (its
        // `reason` is free-text UI copy, not a machine-checked signal), so
        // it's handled separately rather than folded into this case.
        if (m.payload.reason === 'revoked') {
          this.cb.onRevoked?.();
        } else if (m.payload.reason === 'device_removed') {
          // The laptop left the account. The pairing did not — see
          // `onDeviceRemoved`.
          this.cb.onDeviceRemoved?.();
        }
        recordState('ended');
        this.cb.onState('ended');
        this.close();
        break;
      case 'disconnect':
        recordState('ended');
        this.cb.onState('ended');
        this.close();
        break;
      case 'error':
        // Not `appError('unknown', m.payload.message)`. The hub's words went
        // straight to the screen, and for the commonest of these —
        // `unauthorized_room`, which is what a re-register into a room the
        // laptop has already dropped out of looks like — those words were
        // "this device is not authorized to join this room": alarming, and
        // about the wrong thing.
        this.cb.onError(classifyHubError(m.payload.code, m.payload.message));
        break;
      default:
        break;
    }
  }

  /** Handle a transport-lifecycle event from `MobileSignaling` — the decision
   * of "is a dropped signaling socket recoverable" lives here, not in the transport
   * itself (mirrors the desktop orchestrator's identical split of
   * responsibility). */
  private onSignalingLifecycle(event: SignalingLifecycleEvent): void {
    // Guard against acting after close() began
    if (this.isClosed) return;
    switch (event.kind) {
      case 'closed':
        if (this.peerConnected) {
          recordState('reconnecting signaling');
          this.cb.onState('reconnecting_signaling');
          this.sig.beginReconnect(getDeviceId());
        } else {
          // Before the peer is up, signaling IS the session — matches the
          // desktop's own rule (`session/mod.rs`'s `SignalingClientEvent::Closed`
          // handler).
          recordState('ended');
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
          recordState('connected');
          this.cb.onState('connected');
        }
        break;
      case 'lost':
        // With live media, a lost signaling transport is a nuisance, not a
        // death: the backend holds the seat for exactly this case ("mid-
        // session transport drop — session continues peer-to-peer") and the
        // same-device eviction lets a later reconnect reclaim it. Ending a
        // WORKING stream because one ~8s cellular outage outlasted the
        // 4-attempt retry budget executed healthy sessions live. Keep
        // retrying in paced cycles instead; signaling recovers whenever the
        // radio does. Without media, signaling IS the session — end it.
        if (this.peerConnected) {
          recordState('reconnecting signaling');
          this.cb.onState('reconnecting_signaling');
          this.lostRetryTimer = setTimeout(() => {
            this.lostRetryTimer = null;
            if (this.pc && !this.isClosed) this.sig.beginReconnect(getDeviceId());
          }, 4000);
        } else {
          record('signaling lost', event.error.message);
          this.cb.onError(appError('signaling_lost'));
          recordState('ended');
          this.cb.onState('ended');
          this.close();
        }
        break;
    }
  }

  /** `iceTransportPolicy` is server-controlled (`session-start`'s optional
   * field) and only meaningful once a real dedicated TURN relay is
   * configured on the backend — see `FORCE_RELAY` in
   * `packages/shared/src/env.ts`. Omitted/`'all'` (the default) is normal
   * ICE, identical to today's behavior; `'relay'` forces both peers onto
   * the relayed-only path. */
  private setupPeer(iceServers: IceServer[], iceTransportPolicy?: 'all' | 'relay'): void {
    // Guard against acting after close() began
    if (this.isClosed) return;
    // Clear any pending recovery deadline — a new session-start invalidates
    // recovery state from any previous negotiation cycle.
    this.clearRecoveryDeadline();
    this.clearDegradedGraceTimer();
    if (this.lostRetryTimer) {
      clearTimeout(this.lostRetryTimer);
      this.lostRetryTimer = null;
    }
    const oldPc = this.pc;
    const oldDataChannel = this.dataChannel;
    const oldMoveDataChannel = this.moveDataChannel;
    this.pc = null;
    this.input = null;
    this.dataChannel = null;
    this.moveDataChannel = null;
    this.peerConnected = false;
    try {
      oldDataChannel?.close();
    } catch {
      /* ignore */
    }
    try {
      oldMoveDataChannel?.close();
    } catch {
      /* ignore */
    }
    try {
      oldPc?.close();
    } catch {
      /* ignore */
    }

    this.iceServers = iceServers;
    const pc = new RTCPeerConnection({
      iceServers: iceServers as any,
      iceTransportPolicy: iceTransportPolicy ?? 'all',
    });
    this.pc = pc;
    this.iceRestartAttempts = 0;
    this.startStatsPolling();
    const p = pc as unknown as {
      addEventListener: (t: string, cb: (e: any) => void) => void;
      connectionState: string;
    };

    p.addEventListener('track', (e: any) => {
      if (this.pc !== pc || this.isClosed) return;
      const stream: MediaStream =
        e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      this.cb.onStream(stream);
    });
    p.addEventListener('icecandidate', (e: any) => {
      if (this.pc !== pc || this.isClosed) return;
      if (e.candidate) {
        this.sig.iceCandidate(
          e.candidate.candidate,
          e.candidate.sdpMid ?? null,
          e.candidate.sdpMLineIndex ?? null,
        );
      }
    });
    p.addEventListener('connectionstatechange', () => {
      // Guard against firing after close() — peer events may arrive mid-close.
      // Check `pc` identity to ensure this is the CURRENT peer connection.
      if (this.pc !== pc || this.isClosed) return;
      const s = p.connectionState;
      if (s === 'connected') {
        this.peerConnected = true;
        this.iceRestartAttempts = 0;
        this.clearRecoveryDeadline();
        this.clearDegradedGraceTimer();
        recordState('connected');
        this.cb.onState('connected');
      } else if (s === 'failed' || s === 'disconnected') {
        // Both 'disconnected' and 'failed' are routed through the SAME
        // video-aware recheck. Historically 'failed' triggered an ICE
        // restart immediately (treating it as more severe than
        // 'disconnected'), but on a relayed cellular path the return
        // direction (phone→desktop STUN consent + RTCP) flaps independently
        // of the forward video — ICE can report 'failed' while the screen is
        // still decoding perfectly. Escalating unconditionally there was
        // exactly the "connect → reconnect → recovering" full-teardown churn
        // this redesign removes. Instead: wait out a grace window, and only
        // escalate if video itself has genuinely stopped. See
        // `armDegradedRecheck` for the video-liveness decision.
        this.armDegradedRecheck(pc, p);
      } else if (s === 'closed') {
        this.clearDegradedGraceTimer();
        // Only reached via an explicit local pc.close() — genuinely
        // terminal, matches the desktop's identical rule. But if we're
        // already closed, this is just cleanup noise.
        if (!this.isClosed) {
          this.peerConnected = false;
          recordState('ended');
          this.cb.onState('ended');
        }
      } else {
        this.clearDegradedGraceTimer();
      }
    });
    // The desktop (offerer) creates both input channels; arrival order
    // between the two is not guaranteed, so each branch wires the move
    // channel into `InputSender` if the other one has already shown up.
    p.addEventListener('datachannel', (e: any) => {
      // Guard against firing after close()
      if (this.pc !== pc || this.isClosed) return;
      if (e.channel?.label === INPUT_CHANNEL_LABEL) {
        const channel = e.channel as DataChannelLike;
        this.dataChannel = channel;
        this.configureBackpressureFlush(channel);
        this.input = new InputSender(this.sendWhenOpen(() => this.dataChannel));
        this.input.setCriticalChannelRef(channel);
        // The desktop sends the AI agent's step feed back on this same
        // reliable channel — listen for it (input, by contrast, is send-only
        // from the phone). Non-agent frames are ignored here.
        if (typeof channel.addEventListener === 'function') {
          channel.addEventListener('message', (ev: { data: unknown }) => {
            this.handleAgentFrame(ev.data);
          });
          channel.addEventListener('open', () => {
            record('input DataChannel open');
            this.input?.flush();
          });
        }
        if (this.moveDataChannel) this.wireMoveChannel();
      } else if (e.channel?.label === INPUT_MOVE_CHANNEL_LABEL) {
        const channel = e.channel as DataChannelLike;
        this.moveDataChannel = channel;
        this.configureBackpressureFlush(channel);
        if (this.input) this.wireMoveChannel();
      }
    });
  }

  private configureBackpressureFlush(channel: DataChannelLike): void {
    try {
      channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD_BYTES;
    } catch {
      /* ignore */
    }
    const flush = (): void => {
      if (
        !this.isClosed &&
        this.input &&
        (channel === this.dataChannel || channel === this.moveDataChannel)
      ) {
        this.input.flush();
      }
    };
    if (typeof channel.addEventListener === 'function') {
      channel.addEventListener('bufferedamountlow', flush);
    }
    const prev = channel.onbufferedamountlow;
    try {
      channel.onbufferedamountlow = (event: unknown) => {
        prev?.(event);
        flush();
      };
    } catch {
      /* ignore */
    }
  }

  private wireMoveChannel(): void {
    if (!this.input || !this.moveDataChannel) return;
    this.input.setMoveChannel(
      this.sendWhenOpen(() => this.moveDataChannel),
      this.moveDataChannel,
    );
  }

  /** The receiver's ground-truth liveness: has decoded video advanced within
   * the window? When true, the forward path works regardless of ICE's verdict,
   * so a `disconnected` is a false positive we must not act on. */
  private isReceivingVideo(): boolean {
    return (
      this.lastVideoAdvanceAt !== null &&
      Date.now() - this.lastVideoAdvanceAt < VIDEO_LIVENESS_WINDOW_MS
    );
  }

  /** Arm (or re-arm) the grace timer that decides what to do about a
   * lingering `disconnected` OR `failed` PC state — both funnel through here
   * (see the `connectionstatechange` handler) because the fix is identical:
   * on a relayed cellular path the return direction (phone→desktop STUN
   * consent checks + RTCP) can flap independently of the forward video, so
   * ICE's verdict — whichever of the two states it lands on — can be a false
   * positive while the screen keeps decoding perfectly.
   *
   * On grace-timer fire:
   *  - the PC self-recovered (state is no longer disconnected/failed) →
   *    nothing to do.
   *  - still degraded but `isReceivingVideo()` is true → the forward path is
   *    demonstrably alive, so this can't be a real outage. The desktop now
   *    DECLINES a renegotiate while its own traffic reads fresh (it would
   *    only disrupt a working stream), so sending one here is pointless —
   *    worse, it would leave the UI parked on 'recovering_ice' forever,
   *    since our ICE state never returns to 'connected' without a restart
   *    that never happens. Both sides must agree on the same ground truth:
   *    video is the proof the session is fine, so report 'connected'
   *    honestly, send nothing, and re-arm to keep re-checking in case video
   *    later stops. This can continue indefinitely.
   *  - still degraded and video has ACTUALLY stopped → a genuine outage.
   *    Fall through to the bounded, escalating `attemptIceRecovery`.
   */
  private armDegradedRecheck(pc: RTCPeerConnection, p: { connectionState: string }): void {
    this.clearDegradedGraceTimer();
    this.degradedGraceTimer = setTimeout(() => {
      this.degradedGraceTimer = null;
      if (this.isClosed || this.pc !== pc) return;
      // Self-recovered while we waited — nothing to do.
      if (p.connectionState !== 'disconnected' && p.connectionState !== 'failed') return;
      if (this.isReceivingVideo()) {
        // Video is the ground truth and the desktop agrees: while it's
        // flowing, this is a connected session, not a degraded one. No
        // renegotiate — the desktop would just decline it.
        recordState('connected');
        this.cb.onState('connected');
        this.armDegradedRecheck(pc, p);
        return;
      }
      // Video has actually stopped — a genuine outage. Recover.
      this.peerConnected = false;
      this.attemptIceRecovery();
    }, DISCONNECTED_GRACE_MS);
  }

  /** Clear the degraded ('disconnected'/'failed') recheck grace timer. */
  private clearDegradedGraceTimer(): void {
    if (this.degradedGraceTimer) {
      clearTimeout(this.degradedGraceTimer);
      this.degradedGraceTimer = null;
    }
  }

  /** Ask the desktop for a bounded ICE restart, mirroring the desktop's own
   * `attempt_ice_restart` (`session/mod.rs`): bounded attempts, a recovery
   * deadline, and an intermediate state distinct from the terminal 'failed'
   * so the UI shows "Reconnecting…" instead of a dead end while it's in
   * flight.
   *
   * Only reached from `armDegradedRecheck`'s no-video branch, i.e. video has
   * already been confirmed stopped at the moment this is first called — but
   * video can resume mid-recovery (another packet may land right after the
   * grace-window check), so the budget-exhausted branch re-checks
   * `isReceivingVideo()` before ever declaring 'failed': the master rule is
   * "never fail while video flows," and that must hold everywhere failure is
   * decided, not just at the call site. */
  private attemptIceRecovery(): void {
    if (this.isClosed) return;
    if (this.iceRestartAttempts >= MAX_ICE_RESTART_REQUESTS) {
      if (this.isReceivingVideo()) {
        // The real restart budget is spent, but the stream never actually
        // died. Report 'connected' — not another recovering nudge — and
        // hand back to the video-aware degraded loop so this keeps being
        // reconsidered (and can still recover for real later if video does
        // stop). No renegotiate: the desktop declines these while its own
        // traffic still reads fresh, so sending one would only strand the
        // UI on 'recovering_ice' with no way back to 'connected'.
        recordState('connected');
        this.cb.onState('connected');
        if (this.pc) {
          this.armDegradedRecheck(this.pc, this.pc as unknown as { connectionState: string });
        }
        return;
      }
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
      // Guard against firing after close
      if (this.peerConnected || this.isClosed) return;
      if (this.isReceivingVideo()) {
        // The restart offer/answer round trip didn't complete within the
        // deadline, but video is flowing again by now regardless — the
        // forward path is proof enough. Don't declare a terminal failure;
        // report 'connected' (video is the ground truth, and both sides
        // agree the session is fine) and go back to the video-aware
        // degraded loop instead of a bare return (a `disconnected`/`failed`
        // state may still be lingering).
        recordState('connected');
        this.cb.onState('connected');
        if (this.pc) {
          this.armDegradedRecheck(this.pc, this.pc as unknown as { connectionState: string });
        }
        return;
      }
      this.cb.onState('failed');
      this.cb.onError(appError('ice_failed'));
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
    this.lastVideoAdvanceAt = null;
    this.statsPoll = setInterval(() => void this.pollStats(), QUALITY_POLL_MS);
  }

  private stopStatsPolling(): void {
    if (this.statsPoll) {
      clearInterval(this.statsPoll);
      this.statsPoll = null;
    }
  }

  private async pollStats(): Promise<void> {
    if (!this.pc || this.isClosed) return;
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

    // Aggregate across EVERY inbound video stream, never "last one wins".
    //
    // An ICE restart re-uses the peer connection, so `getStats()` keeps
    // reporting the previous stream — bytes frozen at their final value —
    // alongside the new one. Reading a single entry per poll compared this
    // poll's stream against last poll's possibly-DIFFERENT stream, so the
    // delta swung between huge positives and negatives, and whenever the
    // frozen stream was read the delta was 0. `lastVideoAdvanceAt` then never
    // advanced, `isReceivingVideo()` went false after 15s, and the phone
    // requested a renegotiate for a stream that was playing perfectly — which
    // added ANOTHER stale entry, so every reconnect made it worse. That is the
    // ~25s renegotiate cadence observed live on 2026-08-12 (see
    // docs/audit/m3/reconnect-lifecycle.md Finding 9).
    //
    // The sum over all streams is monotonic while any stream advances, which
    // is exactly the "is video arriving at all" question this must answer.
    let videoBytes: number | null = null;
    // fps/loss come from the stream that has actually received the most —
    // the live one. A frozen leftover otherwise reports 0 fps and drags the
    // quality classification down while the picture is fine.
    let liveStreamBytes = -1;

    for (const stat of report.values()) {
      if (stat.type === 'candidate-pair' && (stat.nominated || stat.selected)) {
        if (typeof stat.currentRoundTripTime === 'number') {
          rttMs = Math.round(stat.currentRoundTripTime * 1000);
        }
      }
      if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
        const bytes = typeof stat.bytesReceived === 'number' ? stat.bytesReceived : 0;
        if (typeof stat.bytesReceived === 'number') {
          videoBytes = (videoBytes ?? 0) + bytes;
        }
        if (bytes > liveStreamBytes) {
          liveStreamBytes = bytes;
          if (typeof stat.framesPerSecond === 'number') {
            fps = Math.round(stat.framesPerSecond);
          }
          if (typeof stat.packetsLost === 'number' && typeof stat.packetsReceived === 'number') {
            const total = stat.packetsLost + stat.packetsReceived;
            packetLossPct = total > 0 ? (stat.packetsLost / total) * 100 : 0;
          }
        }
      }
    }

    if (videoBytes !== null) {
      const now = Date.now();
      if (this.lastInboundBytes !== null && this.lastStatsAt !== null) {
        const deltaBytes = videoBytes - this.lastInboundBytes;
        const deltaSec = (now - this.lastStatsAt) / 1000;
        if (deltaSec > 0) {
          bitrateKbps = Math.max(0, Math.round((deltaBytes * 8) / deltaSec / 1000));
        }
        // Forward path is provably alive whenever video bytes advance —
        // the signal that outvotes a false `disconnected`.
        if (deltaBytes > 0) {
          this.lastVideoAdvanceAt = now;
        }
      }
      this.lastInboundBytes = videoBytes;
      this.lastStatsAt = now;
    }

    const level = classifyQuality(rttMs, packetLossPct);
    // Only when it CHANGES. A sample every 2s would bury the transitions that
    // explain a session under a wall of identical "good" lines, and the shape
    // of a wobbly connection is exactly where the level moved and how long it
    // stayed there.
    if (level !== this.lastQualityLevel) {
      this.lastQualityLevel = level;
      record(
        `quality ${level}`,
        `rtt ${rttMs ?? '--'}ms · ${bitrateKbps ?? '--'}kbps · ${fps ?? '--'}fps · loss ${packetLossPct ?? '--'}%`,
      );
    }

    this.cb.onStats({
      level,
      rttMs,
      bitrateKbps,
      fps,
      packetLossPct,
    });
  }

  private async handleOffer(sdp: string): Promise<void> {
    // Guard against acting after close() began
    if (this.isClosed) return;
    if (!this.pc) return;
    // No `onState('negotiating')` here: the initial offer follows
    // 'session-start' (which already set it), and a later renegotiation
    // offer arrives mid-`recovering_ice` — stomping that back to a generic
    // 'negotiating' would regress the more specific, more useful state the
    // user is already seeing. See docs/audit/m3/mobile-ux.md Finding 1.
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    } catch (err) {
      // The desktop recreated its PeerConnection (new DTLS fingerprint)
      // because the input DataChannel never opened on the first ICE pair.
      // Applying that offer to this PC fails; accept it on a fresh relay-only
      // peer instead. Same iceServers as session-start — we already have them.
      record('offer rejected on current peer, recreating with relay', String(err));
      this.setupPeer(this.iceServers, 'relay');
      if (!this.pc || this.isClosed) return;
      await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    }
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sig.answer((answer as any).sdp);
  }

  close(): void {
    // Set the closed guard FIRST so any mid-close callbacks exit early.
    this.isClosed = true;
    // Clear pending timers BEFORE closing resources to prevent race fires.
    this.clearRecoveryDeadline();
    this.clearDegradedGraceTimer();
    if (this.lostRetryTimer) {
      clearTimeout(this.lostRetryTimer);
      this.lostRetryTimer = null;
    }
    this.lifecycle?.dispose();
    this.lifecycle = null;
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
    // Close PC before signaling so the 'closed' connectionstate change event
    // doesn't race with signaling close.
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    // Send disconnect BEFORE closing signaling — use raw send to avoid
    // readyState guard which would drop the message if socket is already
    // closing. The disconnect is best-effort; ignore any failure.
    try {
      this.sig.disconnect('viewer closed');
    } catch {
      /* ignore */
    }
    this.sig.close();
    // Null out after signaling close so any late-arriving callbacks see
    // consistent state (though isClosed guard should catch them first).
    this.pc = null;
    this.input = null;
    this.dataChannel = null;
    this.moveDataChannel = null;
    this.peerConnected = false;
  }
}
