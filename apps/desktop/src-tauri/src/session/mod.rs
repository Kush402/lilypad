//! Session runner — orchestrates one remote-control session on the desktop.
//!
//! It connects signaling, registers as the desktop seat, and drives the
//! handshake: pair-request → (user approves) → session-start → offer →
//! answer → ICE → connected. It is transport-and-UI-agnostic: control comes
//! in on a channel, and it emits `SessionEvent`s the app forwards to the UI.
//!
//! `run_session` itself is now a thin orchestrator: transport (with
//! reconnect), media, and input-gating each live in their own collaborating
//! unit (see the sibling modules), and `SessionRunner` bundles the
//! session-lifetime state (peer, FSM, ICE-restart budget) behind a handful
//! of small, single-purpose methods rather than one giant `select!` arm per
//! concern. See `docs/audit/m3/architecture.md` (Finding F1) for the full
//! before/after rationale — this is that redesign.

mod clipboard_watcher;
mod fsm;
mod input_gate;
mod media_controller;
mod reconnect;
mod signaling_client;

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::Serialize;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::agent::{self, AgentController};
use crate::input::Scope;
use crate::media::CaptureMode;
use crate::rtc::{IceServerConfig, PeerEvent, WebRtcPeer};
use crate::signaling::{messages, Envelope};
use clipboard_watcher::ClipboardWatcher;
use fsm::{SessionFsm, SessionState};
use input_gate::InputGate;
use media_controller::MediaController;
use signaling_client::{SignalingClient, SignalingClientEvent};

/// How often the desktop checks its OS clipboard for changes to push to the
/// phone. A human-paced event (a copy) tolerates this easily; matches the
/// audit's own suggested 500ms-1s range. See `docs/audit/m3/prior-art.md`
/// Finding 6.
const CLIPBOARD_POLL_INTERVAL: Duration = Duration::from_millis(750);

/// The initial offer awaiting its answer — see `SessionRunner::pending_offer`.
#[derive(Debug, Clone)]
struct PendingOffer {
    sdp: String,
    sent_at: Instant,
    resends: u32,
}

/// Control commands from the UI into a running session.
#[derive(Debug, Clone)]
pub enum Control {
    /// The user tapped Approve on the desktop, granting these scopes.
    /// `trust`: they also checked "Trust this device" (M5.4) — the backend
    /// records a persistent pair enabling the no-QR reconnect.
    Approve {
        scopes: Vec<String>,
        trust: bool,
    },
    Deny,
    Disconnect,
}

/// Events the runner emits for the UI (also updates coarse session state).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    Registered,
    PairRequested {
        device_name: Option<String>,
        requested_scopes: Vec<String>,
    },
    SessionStarting {
        session_id: String,
    },
    ConnectionState {
        state: String,
    },
    InputChannelOpen,
    /// The signaling WebSocket dropped mid-session; reconnecting with backoff
    /// (media keeps flowing peer-to-peer meanwhile).
    SignalingReconnecting,
    SignalingReconnected,
    Ended {
        reason: String,
    },
    Error {
        message: String,
    },
}

/// Bounded ICE-restart budget per unhealthy period (reset when the peer
/// reports `connected` again).
///
/// Mirrors `@lilypad/protocol`'s `MAX_ICE_RESTARTS`
/// (`packages/protocol/src/constants.ts`) — Rust can't import that TS
/// constant directly. This is the AUTHORITATIVE counter (the desktop is the
/// offerer that actually performs the restart); the mobile client's own
/// counter is an independent, client-side safety valve of the same shape.
/// See `docs/audit/m3/reconnect-lifecycle.md` Findings 5 and 6.
const MAX_ICE_RESTARTS: u32 = 2;

/// How long a failed connection may spend recovering (ICE restart in flight)
/// before the session is ended instead of idling as a zombie. Scaled by
/// attempt number: a second restart often has to fall back to a slower
/// relayed-only candidate pair after a faster direct path already failed, so
/// it gets more time than the first. Mirrors `@lilypad/protocol`'s
/// `ICE_RECOVERY_TIMEOUT_MS` table.
/// How recently phone-originated traffic must have arrived to outvote a
/// pessimistic ICE state. Comfortably above the phone's 1s stats/RTCP cadence
/// AND above a typical cellular radio transition (observed live: ~2-8s
/// uplink pauses every ~11s on a flappy carrier — a 5s window let those
/// blips trigger ICE restarts that broke a stream which resumed on its own
/// seconds later). Stability outranks fast failure detection here: a truly
/// dead path stays silent past this window and the restart machinery still
/// owns it.
///
/// Widened 12s → 22s (2026-07-19): under send-side congestion the phone's
/// RTCP feedback is delayed/dropped for longer than 12s while the video is
/// still visibly playing, so a 12s window let a *false* ICE `failed` verdict
/// trigger a restart on a ~18s cycle — the constant "connecting → connected"
/// churn the user saw. The pipeline's congestion cap now prevents most of
/// that starvation; this widening is the belt-and-suspenders so a brief RTCP
/// gap never restarts a stream that's actually flowing.
///
/// Widened 22s → 34s (2026-07-20): a live cellular capture showed the phone's
/// RTCP/REMB return path go fully silent for ~30s at a stretch (no bitrate
/// retargets landed for 30s) while the forward video kept flowing with zero
/// drops — the relayed cellular return direction flaps independently of the
/// forward path. A 22s window let that silence trip a restart every ~34s, the
/// exact "connect → reconnecting → recovering" loop, on a stream that never
/// actually stopped. 34s clears the observed gap with headroom; the phone now
/// also keeps its own view alive across the gap via its video-liveness outvote
/// (`webrtc.ts` `VIDEO_LIVENESS_WINDOW_MS`), so a truly dead path still gets
/// recovered — just not a merely-silent one.
const TRAFFIC_LIVENESS_WINDOW: Duration = Duration::from_secs(34);

/// Once the backend reports the phone's SIGNALING is gone (`peer-status`
/// online:false), we no longer need the long cellular-gap tolerance to decide
/// it's truly gone — a killed app / dead network produces NEITHER signaling NOR
/// peer-to-peer media. So while the counterpart is signaling-offline, require
/// fresh P2P traffic within this window to keep the session; past it, with
/// signaling also gone, the phone is genuinely gone — end promptly instead of
/// sitting "active" indefinitely. If media is still flowing P2P (a signaling
/// blip, not a gone phone), traffic stays fresh and the session survives until
/// the phone re-registers.
///
/// MUST be comfortably longer than `TRAFFIC_LIVENESS_WINDOW` (34s), not
/// shorter. Live cellular logs showed signaling and media blip TOGETHER for
/// up to ~34s while the phone was still alive — with the old 10s value, a
/// normal cellular gap tripped this check and false-ended a working session
/// seconds after the desktop's own "ICE reports failed but peer traffic is
/// live — ignoring" tolerance had just decided to ride it out. 45s clears
/// `TRAFFIC_LIVENESS_WINDOW` with real margin, so this only fires when media
/// has been absent well beyond the normal cellular-gap tolerance while
/// signaling is ALSO gone — i.e. the phone is genuinely gone, not merely
/// blipping.
const COUNTERPART_GONE_MEDIA_WINDOW: Duration = Duration::from_secs(45);

/// Minimum wall-clock spacing between ICE restarts, regardless of what
/// triggers them (a desktop-side "failed" verdict or a phone-initiated
/// `renegotiate`). A flapping cellular radio can ask the desktop to
/// renegotiate every few seconds; without a floor on the spacing, honoring
/// every one of those requests turns a brief radio hiccup into a restart
/// storm (repeated offers/candidate re-trickle/IDR). This does not compete
/// with `MAX_ICE_RESTARTS` — that's a budget over the whole unhealthy
/// period; this is a minimum gap between any two restarts within it. A
/// genuine request is still honored, just after the window elapses.
const MIN_ICE_RESTART_SPACING: Duration = Duration::from_secs(8);

/// How long a session must run *after* an ICE restart before that restart is
/// credited as having actually fixed something, earning the budget back.
///
/// Without this, `MAX_ICE_RESTARTS` is unreachable and therefore meaningless.
/// The heartbeat lifts a recovery deadline the moment peer traffic reads
/// fresh, and it used to reset `ice_restarts` to 0 in the same breath — but
/// fresh traffic only proves the session is USABLE, never that the restart
/// accomplished anything. On a flappy cellular path the phone re-requests a
/// renegotiate every ~20s; each one restarted ICE, traffic resumed a second
/// later, the counter reset, and the next request started again from 1/2. The
/// budget never filled, so the "hold and let traffic own recovery" brake never
/// engaged and the restarts continued indefinitely — candidate regathering, a
/// keyframe storm and a bitrate reset every time, which IS the lag the user
/// sees (observed live 2026-08-12: restarts at 23:42:05, :31, :56, 23:43:12,
/// every one logged `1/2`).
///
/// A restart that is followed by a full minute of flowing traffic genuinely
/// did its job, and a later unrelated outage deserves a fresh budget. One that
/// is followed by another restart request 20s later did not.
const ICE_RESTART_STABILITY_WINDOW: Duration = Duration::from_secs(60);

fn recovery_timeout_for_attempt(attempt: u32) -> Duration {
    if attempt <= 1 {
        Duration::from_secs(12)
    } else {
        // 30s (was 20s): a live Wi-Fi→cellular migration showed the restarted
        // path coming alive ~18s after the restart offer (phone's PLI arrived
        // over the new pair) and the 20s deadline killed it at the cusp.
        // Mirrors ICE_RECOVERY_TIMEOUT_MS in @lilypad/protocol constants.ts.
        Duration::from_secs(30)
    }
}

/// How long a runner waits for a device to redeem the QR + request pairing
/// before giving up. Comfortably past the 60s pairing-token TTL so a
/// last-second scan still works, but bounded so an abandoned QR doesn't leak
/// the signaling socket + heartbeat task forever. Overridable via
/// `LILYPAD_PAIRING_TIMEOUT_SECS` (ops knob / test hook).
const PAIRING_TIMEOUT: Duration = Duration::from_secs(120);

fn pairing_timeout() -> Duration {
    std::env::var("LILYPAD_PAIRING_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(PAIRING_TIMEOUT)
}

/// Pure decision extracted from the heartbeat tick, mirroring
/// `bitrate_retarget_due`'s pattern (`media/pipeline.rs`) so the two-signal
/// combination is directly unit-testable independent of the async
/// orchestrator. `true` means "the counterpart is genuinely gone — end the
/// session": the counterpart's SIGNALING is reported offline, the session
/// had actually reached a real connection at some point (not still
/// negotiating — that path is owned by `recovery_deadline` instead), AND no
/// peer-to-peer media has arrived within `window`. Any one signal alone is
/// not enough: signaling-offline alone is a common cellular blip; a stale
/// `last_traffic` alone is exactly what the much longer
/// `TRAFFIC_LIVENESS_WINDOW` already tolerates for a connected session with
/// signaling still up.
fn counterpart_gone(
    signaling_offline: bool,
    ever_connected: bool,
    last_traffic: Option<Instant>,
    now: Instant,
    window: Duration,
) -> bool {
    signaling_offline
        && ever_connected
        && !last_traffic.is_some_and(|t| now.duration_since(t) < window)
}

/// Whether resumed peer traffic should earn the ICE-restart budget back.
///
/// Only once the session has been stable for `stability` since the LAST
/// restart. Resetting on traffic alone makes `MAX_ICE_RESTARTS` unreachable —
/// see `ICE_RESTART_STABILITY_WINDOW`. A session that has never restarted has
/// nothing to earn back and trivially qualifies.
fn ice_budget_earned_back(
    last_ice_restart: Option<Instant>,
    now: Instant,
    stability: Duration,
) -> bool {
    match last_ice_restart {
        None => true,
        Some(t) => now.duration_since(t) >= stability,
    }
}

/// Bundles the session-lifetime state that used to be five independent
/// `run_session` locals (`peer`, `pipeline`/`abr` via `media`, `ice_restarts`,
/// `recovery_deadline`, `peer_connected`) behind a handful of small,
/// single-purpose methods — one per concern, instead of one giant `select!`
/// arm covering all of them at once.
struct SessionRunner {
    room_id: String,
    fsm: SessionFsm,
    media: MediaController,
    gate: InputGate,
    clipboard: ClipboardWatcher,
    peer: Option<Arc<WebRtcPeer>>,
    peer_connected: bool,
    /// Set once, the first time `ConnectionState("connected")` is observed,
    /// and never cleared — unlike `peer_connected`, which is reassigned on
    /// EVERY `ConnectionState` event (`self.peer_connected = s ==
    /// "connected"`) and so flips back to `false` the moment ICE reports
    /// `disconnected`/`failed`, well before the counterpart is actually gone.
    /// The counterpart-gone check below needs "did this session ever reach a
    /// real connection" (vs. still negotiating), not "is ICE reporting
    /// connected THIS INSTANT" — a killed phone's ICE degrades to
    /// disconnected/failed quickly, which would otherwise make that check's
    /// `peer_connected` guard false and mask the exact case it exists to
    /// catch. See the heartbeat tick in `run_session`.
    ever_connected: bool,
    /// Last moment any phone-originated traffic arrived (input frames, RTCP
    /// loss reports, REMB, keyframe requests). Ground truth that outranks the
    /// ICE state machine: observed live (2026-07-17, cellular relay path)
    /// webrtc-rs declared the connection `failed` ~8s after connect while
    /// video, RTCP feedback and the input DataChannel all kept flowing — the
    /// "failed"-triggered restarts then killed a de-facto working session,
    /// and the traffic-blind input gate blocked every injection meanwhile.
    last_peer_traffic: Option<Instant>,
    ice_restarts: u32,
    recovery_deadline: Option<Instant>,
    /// When the last ICE restart was actually performed (successfully sent
    /// as a fresh offer), regardless of who triggered it. Used to enforce
    /// `MIN_ICE_RESTART_SPACING` on the phone's `renegotiate` requests — a
    /// flapping radio's request is throttled by time, not declined outright.
    last_ice_restart: Option<Instant>,
    /// The initial offer, retained until the answer arrives so it can be
    /// re-sent if the phone missed it — a 5G socket flap in the seconds
    /// after approval loses the offer in transit, and nothing else ever
    /// re-delivers it (observed live: "offer sent, awaiting answer" then
    /// silence until the recovery deadline killed the room, forcing the
    /// user to retry the connect by hand).
    pending_offer: Option<PendingOffer>,
    /// True from the moment the backend reports the phone's SIGNALING
    /// transport dropped (`peer-status` `{online:false}`) until it reports
    /// the phone back (`{online:true}`) or the peer itself (re)reaches
    /// `connected`. On its own this proves nothing — cellular signaling
    /// blips constantly while media keeps flowing P2P — so the heartbeat
    /// tick only acts on it combined with `last_peer_traffic` staleness
    /// (`COUNTERPART_GONE_MEDIA_WINDOW`): signaling gone AND no P2P media is
    /// the phone genuinely gone (app killed / network dead), not a blip.
    counterpart_signaling_offline: bool,
    events: UnboundedSender<SessionEvent>,
    /// The AI executor for this session; agent frames on the input channel are
    /// routed here. Inert until an `agent_command` arrives.
    agent: AgentController,
    /// Whether this session was granted `control` scope — the admission gate
    /// for agent commands (mirrors the input-injection scope).
    granted_control: bool,
}

impl SessionRunner {
    fn new(room_id: String, events: UnboundedSender<SessionEvent>) -> Self {
        Self {
            room_id,
            fsm: SessionFsm::new(),
            media: MediaController::new(),
            gate: InputGate::new(),
            clipboard: ClipboardWatcher::new(),
            peer: None,
            peer_connected: false,
            ever_connected: false,
            last_peer_traffic: None,
            ice_restarts: 0,
            recovery_deadline: None,
            last_ice_restart: None,
            pending_offer: None,
            counterpart_signaling_offline: false,
            events,
            agent: AgentController::new(),
            granted_control: false,
        }
    }

    /// Re-send the initial offer if the phone hasn't answered within the
    /// resend interval — bounded, and disarmed the moment an answer arrives.
    /// Driven from the orchestrator's heartbeat tick (4s), so resends fire
    /// at ~8s and ~16s; the phone applies a duplicate offer idempotently
    /// (it is the answerer — no glare is possible).
    fn maybe_resend_offer(&mut self, sig: &SignalingClient) {
        const OFFER_RESEND_AFTER: Duration = Duration::from_secs(8);
        const MAX_OFFER_RESENDS: u32 = 2;
        let Some(pending) = self.pending_offer.as_mut() else {
            return;
        };
        if pending.sent_at.elapsed() < OFFER_RESEND_AFTER {
            return;
        }
        if pending.resends >= MAX_OFFER_RESENDS {
            return; // the recovery deadline owns the give-up decision
        }
        pending.resends += 1;
        pending.sent_at = Instant::now();
        log::warn!(
            target: "lilypad::session",
            "no answer yet — re-sending offer (resend {}/{MAX_OFFER_RESENDS})",
            pending.resends
        );
        let sdp = pending.sdp.clone();
        if let Err(e) = sig.send(Envelope::offer(&self.room_id, &sdp)) {
            log::warn!(target: "lilypad::session", "offer re-send failed: {e}");
        }
    }

    fn emit(&self, ev: SessionEvent) {
        let _ = self.events.send(ev);
    }

    /// End the session: emit `Ended` and transition the FSM to its terminal
    /// state. Callers still `break` the orchestrator's loop themselves —
    /// this only centralizes the (event, state) pair every termination path
    /// must emit together.
    fn end(&mut self, reason: impl Into<String>) {
        self.emit(SessionEvent::Ended {
            reason: reason.into(),
        });
        self.fsm.transition(SessionState::Ended);
    }

    /// Handle one inbound signaling message. `Ok(true)` means it terminates
    /// the session (mirrors the original `handle_inbound` contract exactly,
    /// including which errors are fatal to the whole runner vs. merely
    /// logged — see the call site for why).
    async fn handle_signaling_message(
        &mut self,
        env: &Envelope,
        sig: &SignalingClient,
        peer_ev_tx: &UnboundedSender<PeerEvent>,
    ) -> Result<bool> {
        match env.msg_type.as_str() {
            "pair-request" => {
                // Ignore a duplicate pair-request once a session is already
                // past approval. A phone on a slow/lossy link (cellular over
                // the tunnel) that doesn't receive `session-start` promptly
                // RE-SENDS `pair-request`; without this guard the desktop
                // re-prompts and re-approves, and the second approval's
                // `session-start` (a fresh sessionId) tears down the peer that
                // is still negotiating the first one — so the handshake never
                // completes off-LAN, while on LAN it finishes before the retry
                // and the bug is invisible. Only honor a pair-request while
                // still waiting to pair.
                let state = self.fsm.state();
                if !matches!(
                    state,
                    SessionState::Registered | SessionState::AwaitingApproval
                ) {
                    log::info!(
                        target: "lilypad::session",
                        "ignoring duplicate pair-request while session is {state:?} (stale retry)"
                    );
                    return Ok(false);
                }
                if let Ok(p) =
                    serde_json::from_value::<messages::PairRequestPayload>(env.payload.clone())
                {
                    self.emit(SessionEvent::PairRequested {
                        device_name: p.device_name,
                        // `SessionEvent`'s wire shape to the frontend is
                        // unchanged (still `["view","control"]` JSON
                        // strings) — only the internal deserialize-time
                        // representation is now the strict `SessionScope`
                        // enum (see `signaling::messages`).
                        requested_scopes: p
                            .requested_scopes
                            .iter()
                            .map(|s| s.as_str().to_owned())
                            .collect(),
                    });
                    self.fsm.transition(SessionState::AwaitingApproval);
                }
            }
            "session-start" => {
                let p: messages::SessionStartPayload = serde_json::from_value(env.payload.clone())?;
                // Wire the granted scope into the input-injection boundary
                // before anything else: the desktop must know what was
                // actually granted for this session, not just that a peer
                // is about to connect. See `InputGate::set_granted_scopes`
                // and `docs/audit/m3/backend-security.md` Finding 2.
                //
                // `messages::SessionScope` (wire-level, serde-validated) and
                // `input::Scope` (the input-gating subsystem's own domain
                // type) are deliberately kept as two independent types with
                // no dependency either way — this is the one place, the
                // orchestrator, that bridges them.
                self.gate.set_granted_scopes(
                    p.granted_scopes
                        .iter()
                        .map(|s| match s {
                            messages::SessionScope::View => Scope::View,
                            messages::SessionScope::Control => Scope::Control,
                        })
                        .collect(),
                );
                // The agent may only act in a control-scoped session — record
                // the grant for the command-admission gate (same authority as
                // input injection above).
                self.granted_control = p
                    .granted_scopes
                    .iter()
                    .any(|s| matches!(s, messages::SessionScope::Control));
                let ice_servers: Vec<IceServerConfig> = p
                    .ice_servers
                    .iter()
                    .map(|s| IceServerConfig {
                        urls: s.url_list(),
                        username: s.username.clone().unwrap_or_default(),
                        credential: s.credential.clone().unwrap_or_default(),
                    })
                    .collect();
                // Defensive: a repeat session-start must not leak the
                // previous PeerConnection (its ICE/DTLS/RTCP-reader tasks
                // live until close).
                if let Some(old) = self.peer.take() {
                    log::warn!(target: "lilypad::session", "new session-start replacing an existing peer — closing the old one");
                    let _ = old.close().await;
                }
                let new_peer = Arc::new(WebRtcPeer::new(ice_servers, peer_ev_tx.clone()).await?);
                let sdp = new_peer.create_offer().await?;
                sig.send(Envelope::offer(&self.room_id, &sdp))?;
                self.pending_offer = Some(PendingOffer {
                    sdp,
                    sent_at: Instant::now(),
                    resends: 0,
                });
                self.peer = Some(new_peer);
                self.fsm.transition(SessionState::Negotiating);
                self.emit(SessionEvent::SessionStarting {
                    session_id: p.session_id,
                });
                log::info!(target: "lilypad::session", "offer sent, awaiting answer");
            }
            "answer" => {
                self.pending_offer = None; // negotiation is moving — stop resending
                if let Some(p) = self.peer.as_ref() {
                    let payload: messages::SdpPayload =
                        serde_json::from_value(env.payload.clone())?;
                    p.set_answer(payload.sdp).await?;
                }
            }
            "ice-candidate" => {
                if let Some(p) = self.peer.as_ref() {
                    let c: messages::IceCandidatePayload =
                        serde_json::from_value(env.payload.clone())?;
                    p.add_ice_candidate(c.candidate, c.sdp_mid, c.sdp_mline_index)
                        .await?;
                }
            }
            "renegotiate" => {
                // Mobile-initiated recovery request. The RECEIVER is authoritative here:
                // only the phone knows whether it's actually decoding our video, and the
                // mobile client now sends this ONLY when its own video-liveness says the
                // stream has genuinely stopped (while video flows it stays 'connected' and
                // sends nothing — apps/mobile/src/lib/webrtc.ts). So an inbound renegotiate
                // means "I'm not receiving — please ICE-restart," and we HONOR it.
                //
                // We deliberately do NOT gate this on `peer_traffic_fresh()`: when the
                // forward path is dead the phone spams PLI/keyframe-requests and loss
                // reports, which `peer_traffic_fresh()` counts as "traffic" — so gating on
                // it MISREADS a phone that's getting 0 kbps as "video is flowing" and
                // declines the exact restart it needs (observed live: sessions stranded at
                // 0 kbps while the desktop logged "declining renegotiate — video is
                // flowing"). Only the throttle guards us, so a flapping radio can't storm
                // restarts while still letting a genuine recovery through.
                if self
                    .last_ice_restart
                    .is_some_and(|t| t.elapsed() < MIN_ICE_RESTART_SPACING)
                {
                    log::info!(
                        target: "lilypad::session",
                        "renegotiate throttled — ICE restarted {}s ago",
                        self.last_ice_restart.unwrap().elapsed().as_secs()
                    );
                } else if self.attempt_ice_restart(sig, "phone renegotiate").await? {
                    return Ok(true);
                }
            }
            "pause" => {
                // Phone backgrounded (or user paused) — stop sending video
                // without tearing down ICE/DataChannel, so resuming is instant.
                self.media.set_paused(true);
            }
            "resume" => {
                self.media.set_paused(false);
            }
            "set-capture-mode" => {
                if let Ok(p) =
                    serde_json::from_value::<messages::SetCaptureModePayload>(env.payload.clone())
                {
                    self.handle_set_capture_mode(p.mode, sig).await;
                }
            }
            "peer-status" => {
                // Backend nudge: the phone's SIGNALING transport dropped
                // (online:false) or came back (online:true). We don't end
                // here — the heartbeat tick combines this with
                // peer-to-peer media liveness (see
                // COUNTERPART_GONE_MEDIA_WINDOW) so a signaling blip where
                // media still flows doesn't kill a working session.
                if let Ok(p) =
                    serde_json::from_value::<messages::PeerStatusPayload>(env.payload.clone())
                {
                    self.counterpart_signaling_offline = !p.online;
                }
            }
            "pair-denied" | "disconnect" | "session-end" => {
                self.end(env.msg_type.clone());
                return Ok(true);
            }
            "error" => {
                let message = env
                    .payload
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("signaling error")
                    .to_owned();
                self.emit(SessionEvent::Error { message });
            }
            _ => {}
        }
        Ok(false)
    }

    /// Handle one WebRTC peer event. `Ok(true)` means it terminates the
    /// session. Note the ICE-restart offer resend uses `?` deliberately (it
    /// propagates out of this method and, via the orchestrator's own `?`,
    /// out of `run_session` entirely — matching the original inline
    /// `select!` arm's behavior bit-for-bit, including its bypass of the
    /// normal teardown sequence on that specific failure).
    /// Fresh inbound traffic from the phone proves the path works regardless
    /// of what the ICE state machine currently claims.
    fn peer_traffic_fresh(&self) -> bool {
        self.last_peer_traffic
            .is_some_and(|t| t.elapsed() < TRAFFIC_LIVENESS_WINDOW)
    }

    async fn handle_peer_event(&mut self, ev: PeerEvent, sig: &SignalingClient) -> Result<bool> {
        // Any phone-originated event is liveness ground truth — record it
        // before the state machinery below gets a chance to act pessimistic.
        if matches!(
            ev,
            PeerEvent::InputMessage(_)
                | PeerEvent::VideoRemb { .. }
                | PeerEvent::VideoLossReport { .. }
                | PeerEvent::VideoKeyframeRequest
        ) {
            self.last_peer_traffic = Some(Instant::now());
            if !self.peer_connected {
                // ICE says down, traffic says up: traffic wins for injection
                // gating — the loss reports/REMB prove the viewer is
                // receiving video, which is the property the gate protects.
                self.gate.set_peer_connected(true);
            }
        }
        if let PeerEvent::ConnectionState(s) = &ev {
            // Begin streaming once the peer connection is live (SRTP ready).
            if s == "connected" && !self.media.is_started() {
                if let Some(p) = self.peer.as_ref() {
                    match self.media.start(Arc::clone(p)).await {
                        Ok(()) => self.send_frame_size(sig),
                        Err(e) => self.emit(SessionEvent::Error {
                            message: format!("pipeline start: {e}"),
                        }),
                    }
                }
            }
            let was_connected = self.peer_connected;
            self.peer_connected = s == "connected";
            if self.peer_connected {
                // Healthy again — reset the recovery budget.
                self.ice_restarts = 0;
                self.recovery_deadline = None;
                self.fsm.transition(SessionState::Connected);
                // A fresh `connected` is demonstrable proof the counterpart
                // is back, whether or not a `peer-status` online:true nudge
                // ever arrived (a reconnect implies the phone re-registered)
                // — belt-and-suspenders alongside the `peer-status` handler.
                self.counterpart_signaling_offline = false;
                self.ever_connected = true;
                if !was_connected {
                    // Seed rather than push: whatever's already on the OS
                    // clipboard predates this session and shouldn't be
                    // forced onto a phone that just connected.
                    self.clipboard.seed();
                }
            }
            self.gate
                .set_peer_connected(self.peer_connected || self.peer_traffic_fresh());

            // A failed connection is recoverable if the network path changed
            // (Wi-Fi → cellular, new interface): try a bounded number of ICE
            // restarts before giving up. Without this, a dead peer left a
            // zombie session. But a "failed" verdict with fresh inbound
            // traffic is a false negative (see `last_peer_traffic`) — the
            // restart it would trigger tears down a working session, so
            // traffic outvotes the state machine here.
            if s == "failed" {
                if self.peer_traffic_fresh() {
                    log::warn!(
                        target: "lilypad::session",
                        "ICE reports failed but peer traffic is live — ignoring"
                    );
                } else if self.attempt_ice_restart(sig, "ICE reported failed").await? {
                    return Ok(true);
                }
            }
            if s == "closed" {
                self.end("peer connection closed");
                return Ok(true);
            }
        }
        if matches!(ev, PeerEvent::InputChannelOpen) {
            self.gate.set_channel_open(true);
        }
        if matches!(ev, PeerEvent::InputChannelClosed) {
            self.gate.set_channel_open(false);
        }
        if let PeerEvent::InputMessage(bytes) = &ev {
            // Demux: an agent frame (command/stop/decision) routes to the AI
            // executor; anything else is human input. A human input frame while
            // a run is active is instant takeover — touch always wins, enforced
            // here on the desktop (authoritative) so a dropped message can't
            // strand the agent in control.
            if let Some(inbound) = agent::parse_inbound(bytes) {
                self.agent
                    .handle_inbound(inbound, self.granted_control, self.peer.clone());
            } else {
                self.agent.on_human_input();
                self.gate.handle_message(bytes.clone());
            }
        }
        match &ev {
            PeerEvent::VideoLossReport { fraction_lost } => {
                self.media.on_loss_report(*fraction_lost)
            }
            PeerEvent::VideoRemb { bitrate_bps } => self.media.on_remb(*bitrate_bps),
            PeerEvent::VideoKeyframeRequest => self.media.request_keyframe(),
            _ => {}
        }
        // A failed relay (dead outbound signaling) must not early-return past
        // the teardown block below — leaving the PeerConnection + capture/
        // encode pipeline running with no owner. Log and continue; a truly
        // dead signaling socket is caught by the inbound-closed reconnect
        // path instead.
        if let Err(e) = self.relay_and_emit(ev, sig) {
            log::warn!(target: "lilypad::session", "peer event relay failed: {e}");
        }
        Ok(false)
    }

    /// Attempt a bounded ICE restart — shared by the connection-state
    /// `failed` handler and an inbound `renegotiate` request, so both
    /// triggers draw from the SAME budget (a mobile-initiated and
    /// desktop-initiated restart can't combine to exceed the intended cap).
    /// Returns `Ok(true)` if the session should end (budget exhausted, no
    /// live peer, or the restart itself failed).
    /// `reason` is logged so a restart storm can be attributed to its actual
    /// trigger. Both call sites previously logged an identical line, which made
    /// a desktop-side `failed` verdict and a phone-requested `renegotiate`
    /// indistinguishable in a capture — the exact ambiguity that made diagnosing
    /// the 2026-08-12 cellular restart loop guesswork.
    async fn attempt_ice_restart(&mut self, sig: &SignalingClient, reason: &str) -> Result<bool> {
        if self.ice_restarts >= MAX_ICE_RESTARTS {
            // Budget exhausted. If media is still running, this is a count
            // exhausted over the unhealthy period, not proof the session is
            // actually dead — the `recovery_deadline` set by the last
            // successful restart already ends a genuinely dead session on
            // timeout, and it's lifted (with `ice_restarts` reset to 0) the
            // moment traffic resumes. Tearing down here over a transient
            // budget count would kill a de-facto-working stream; hold
            // instead and let traffic/recovery-deadline own the outcome.
            if self.media.is_started() {
                log::warn!(
                    target: "lilypad::session",
                    "ICE restart budget reached — holding; traffic/recovery-deadline owns recovery"
                );
                return Ok(false);
            }
            self.end("connection failed (ICE restarts exhausted)");
            return Ok(true);
        }
        let Some(peer) = self.peer.clone() else {
            self.end("connection failed (no active peer)");
            return Ok(true);
        };
        self.ice_restarts += 1;
        self.fsm.transition(SessionState::Recovering);
        log::warn!(
            target: "lilypad::session",
            "attempting ICE restart {}/{MAX_ICE_RESTARTS} (trigger: {reason})",
            self.ice_restarts
        );
        match peer.restart_ice().await {
            Ok(sdp) => {
                sig.send(Envelope::offer(&self.room_id, &sdp))?;
                self.recovery_deadline =
                    Some(Instant::now() + recovery_timeout_for_attempt(self.ice_restarts));
                self.last_ice_restart = Some(Instant::now());
                Ok(false)
            }
            Err(e) => {
                self.end(format!("ICE restart failed: {e}"));
                Ok(true)
            }
        }
    }

    /// Tell the phone the current capture resolution and mode, so it maps
    /// touches onto the letterboxed video content rect, not the whole view
    /// (`docs/audit/m3/input-touch.md` Finding 1), and can reflect which mode
    /// is active (`docs/audit/m3/prior-art.md` Finding 2). Best-effort: a
    /// failed send here must not tear down a healthy media session — the
    /// phone keeps its last-known mapping/mode until the next frame-size
    /// arrives.
    fn send_frame_size(&self, sig: &SignalingClient) {
        let Some((w, h)) = self.media.frame_size() else {
            return;
        };
        let mode = match self.media.mode() {
            CaptureMode::Motion => messages::CaptureMode::Motion,
            CaptureMode::Text => messages::CaptureMode::Text,
        };
        if let Err(e) = sig.send(Envelope::frame_size(&self.room_id, w, h, mode)) {
            log::warn!(target: "lilypad::session", "frame-size send failed: {e}");
        }
    }

    /// Handle a mobile-initiated capture/encode mode switch request. Forces a
    /// full capture+encoder rebuild (`MediaController::set_mode`'s own doc
    /// comment) — a brief visible glitch is expected, which is why the
    /// mobile UI shows a "Switching to Text Mode…" toast around this. Reuses
    /// the same peer-existence/media-started preconditions `session-start`'s
    /// handler establishes; a request before the peer is up or media has
    /// started is simply ignored (nothing to switch yet). See
    /// `docs/audit/m3/prior-art.md` Finding 2.
    async fn handle_set_capture_mode(
        &mut self,
        mode: messages::CaptureMode,
        sig: &SignalingClient,
    ) {
        if !self.media.is_started() {
            return;
        }
        let Some(peer) = self.peer.clone() else {
            return;
        };
        let mode = match mode {
            messages::CaptureMode::Motion => CaptureMode::Motion,
            messages::CaptureMode::Text => CaptureMode::Text,
        };
        match self.media.set_mode(mode, peer).await {
            Ok(()) => {
                log::info!(target: "lilypad::session", "capture mode switched to {}", mode.as_str());
                self.send_frame_size(sig);
            }
            Err(e) => {
                log::error!(target: "lilypad::session", "capture mode switch to {} failed: {e}", mode.as_str());
                self.emit(SessionEvent::Error {
                    message: format!("mode switch failed: {e}"),
                });
            }
        }
    }

    /// Trickle ICE candidates out to signaling, and emit the events the UI
    /// cares about (`InputMessage`/`InputChannelClosed`/RTCP-feedback events
    /// were already fully handled above by the time this runs).
    fn relay_and_emit(&mut self, ev: PeerEvent, sig: &SignalingClient) -> Result<()> {
        match ev {
            PeerEvent::IceCandidate {
                candidate,
                sdp_mid,
                sdp_mline_index,
            } => {
                sig.send(Envelope::ice_candidate(
                    &self.room_id,
                    &candidate,
                    sdp_mid,
                    sdp_mline_index,
                ))?;
            }
            PeerEvent::ConnectionState(state) => {
                self.emit(SessionEvent::ConnectionState { state });
            }
            PeerEvent::InputChannelOpen => {
                self.emit(SessionEvent::InputChannelOpen);
            }
            PeerEvent::InputChannelClosed
            | PeerEvent::InputMessage(_)
            | PeerEvent::VideoLossReport { .. }
            | PeerEvent::VideoRemb { .. }
            | PeerEvent::VideoKeyframeRequest => {} // consumed above
        }
        Ok(())
    }

    /// Check the OS clipboard and, if it changed since the last check, push a
    /// `clipboard-update` to the phone. Best-effort: a failed send here must
    /// not tear down a healthy session, same rationale as the `frame-size`
    /// send above.
    fn poll_clipboard(&mut self, sig: &SignalingClient) {
        if let Some(text) = self.clipboard.poll() {
            if let Err(e) = sig.send(Envelope::clipboard_update(&self.room_id, &text)) {
                log::warn!(target: "lilypad::session", "clipboard-update send failed: {e}");
            }
        }
    }
}

/// Run one session to completion. Returns when the session ends or errors.
pub async fn run_session(
    signaling_url: String,
    room_id: String,
    device_id: String,
    mut control_rx: UnboundedReceiver<Control>,
    events: UnboundedSender<SessionEvent>,
) -> Result<()> {
    let mut sig = SignalingClient::connect(signaling_url, room_id.clone(), device_id).await?;
    let _ = events.send(SessionEvent::Registered);
    log::info!(target: "lilypad::session", "registered as desktop in room {room_id}");

    let (peer_ev_tx, mut peer_ev_rx) = mpsc::unbounded_channel::<PeerEvent>();
    // Mirrors `@lilypad/protocol`'s `APP_HEARTBEAT_INTERVAL_MS` (4s) — see
    // docs/audit/m3/reconnect-lifecycle.md Finding 6's cross-tier timing
    // budget (this must stay well under the backend's heartbeat timeout).
    // Also the app-level WS keepalive: a slower interval let an idle socket be
    // dropped on cellular-through-tunnel paths before the first beat.
    let mut heartbeat = tokio::time::interval(Duration::from_millis(4_000));
    let mut clipboard_poll = tokio::time::interval(CLIPBOARD_POLL_INTERVAL);
    let mut runner = SessionRunner::new(room_id.clone(), events);

    // Abandoned-pairing guard: if no device redeems the QR and requests
    // pairing within this window, end the runner instead of leaking the
    // signaling socket + heartbeat task indefinitely. Disarmed once a
    // pair-request arrives.
    let mut paired = false;
    let pairing_deadline = tokio::time::sleep(pairing_timeout());
    tokio::pin!(pairing_deadline);

    loop {
        tokio::select! {
            _ = &mut pairing_deadline, if !paired => {
                log::info!(target: "lilypad::session", "pairing expired for room {room_id} — no device scanned");
                runner.end("pairing expired — no device connected");
                break;
            }

            sig_ev = sig.next_event() => {
                match sig_ev {
                    SignalingClientEvent::Message(env) => {
                        if env.msg_type == "pair-request" {
                            paired = true; // a device is engaged — disarm the pairing timeout
                        }
                        match runner.handle_signaling_message(&env, &sig, &peer_ev_tx).await {
                            Ok(true) => break, // terminal message
                            Ok(false) => {}
                            Err(e) => {
                                // Surface the failure but keep the session alive.
                                log::error!(target: "lilypad::session", "handling '{}' failed: {e}", env.msg_type);
                                runner.emit(SessionEvent::Error { message: format!("{}: {e}", env.msg_type) });
                            }
                        }
                    }
                    SignalingClientEvent::Closed => {
                        // Media + input flow peer-to-peer and don't need
                        // signaling once connected — reconnect in the
                        // BACKGROUND so this loop keeps servicing Disconnect,
                        // peer state, and input the whole time.
                        if runner.peer_connected && !sig.is_reconnecting() {
                            runner.emit(SessionEvent::SignalingReconnecting);
                            sig.begin_reconnect();
                        } else if !runner.peer_connected {
                            // Before the peer is up, signaling IS the session.
                            runner.end("signaling closed");
                            break;
                        }
                    }
                    SignalingClientEvent::Reconnected => {
                        runner.emit(SessionEvent::SignalingReconnected);
                        log::info!(target: "lilypad::session", "signaling reconnected for room {room_id}");
                    }
                    SignalingClientEvent::Lost(e) => {
                        runner.end(format!("signaling lost: {e}"));
                        break;
                    }
                }
            }

            fail = runner.media.poll_failure() => {
                if let Some(reason) = fail {
                    log::error!(target: "lilypad::session", "{reason} — ending session");
                    // Stop injecting immediately: never let input act on a
                    // screen the viewer can no longer see updating.
                    runner.gate.disable();
                    runner.emit(SessionEvent::Error { message: reason.clone() });
                    runner.end(reason);
                    break;
                }
            }

            ctrl = control_rx.recv() => {
                match ctrl {
                    Some(Control::Approve { scopes, trust }) => {
                        // Idempotent approval: a second Approve (a double-tap /
                        // re-render in the desktop UI, or a re-prompt from a
                        // retried pair-request) must NOT issue a second
                        // pair-approved — the backend mints a fresh sessionId
                        // per approval, and the second session-start tears down
                        // the peer still negotiating the first. Only the first
                        // approval, while awaiting it, is honored.
                        let state = runner.fsm.state();
                        if !matches!(
                            state,
                            SessionState::Registered | SessionState::AwaitingApproval
                        ) {
                            log::info!(
                                target: "lilypad::session",
                                "ignoring duplicate approve while session is {state:?}"
                            );
                        } else {
                            log::info!(target: "lilypad::audit", "session_start — approved by user");
                            log::info!(target: "lilypad::session", "user approved session");
                            // A dead signaling writer must end the session with a
                            // clear reason, never bubble an Err with no Ended event.
                            if let Err(e) = sig.send(Envelope::pair_approved(&room_id, &scopes, trust)) {
                                runner.end(format!("signaling send failed: {e}"));
                                break;
                            }
                        }
                    }
                    Some(Control::Deny) => {
                        let _ = sig.send(Envelope::pair_denied(&room_id, Some("denied by user")));
                        runner.end("denied");
                        break;
                    }
                    Some(Control::Disconnect) | None => {
                        let _ = sig.send(Envelope::disconnect(&room_id, Some("desktop disconnected")));
                        runner.end("disconnected");
                        break;
                    }
                }
            }

            pev = peer_ev_rx.recv() => {
                if let Some(ev) = pev {
                    if runner.handle_peer_event(ev, &sig).await? {
                        break;
                    }
                }
            }

            _ = heartbeat.tick() => {
                let _ = sig.send(Envelope::heartbeat(&room_id));
                // Pre-answer watchdog: a phone that missed the offer (socket
                // flap right after approval) gets it again instead of both
                // sides waiting each other out.
                runner.maybe_resend_offer(&sig);
                if let Some(deadline) = runner.recovery_deadline {
                    if runner.peer_traffic_fresh() {
                        // De-facto recovered: traffic is flowing even if the
                        // ICE state never (re)announced `connected`. Ending
                        // the session here would kill a working stream.
                        log::info!(
                            target: "lilypad::session",
                            "recovery deadline lifted — peer traffic is live"
                        );
                        runner.recovery_deadline = None;
                        // Traffic proves the session is usable, NOT that the
                        // restart fixed anything — only sustained stability
                        // earns the budget back. Resetting here unconditionally
                        // made MAX_ICE_RESTARTS unreachable and let a flappy
                        // radio drive restarts forever, each one logged `1/2`.
                        if ice_budget_earned_back(
                            runner.last_ice_restart,
                            Instant::now(),
                            ICE_RESTART_STABILITY_WINDOW,
                        ) {
                            runner.ice_restarts = 0;
                        }
                    } else if !runner.peer_connected && Instant::now() >= deadline {
                        runner.end("connection did not recover in time");
                        break;
                    }
                }
                // Counterpart-gone fast path: combines the backend's
                // `peer-status` signaling-liveness nudge with our own
                // peer-to-peer media liveness. A killed app / dead network
                // produces NEITHER signaling NOR P2P media, so this catches
                // that case promptly instead of waiting out the much longer
                // TRAFFIC_LIVENESS_WINDOW (34s, sized for cellular RTCP gaps
                // while signaling stays up) — while still surviving a
                // signaling-only blip as long as media keeps flowing P2P.
                // `ever_connected` (not `peer_connected`) gates this: ICE
                // reassigns `peer_connected` on every ConnectionState event
                // and flips it false the moment ICE reports
                // disconnected/failed — which is exactly what a dying phone
                // does first, so gating on the live `peer_connected` would
                // mask the case this exists to catch.
                if counterpart_gone(
                    runner.counterpart_signaling_offline,
                    runner.ever_connected,
                    runner.last_peer_traffic,
                    Instant::now(),
                    COUNTERPART_GONE_MEDIA_WINDOW,
                ) {
                    log::info!(
                        target: "lilypad::session",
                        "counterpart signaling offline and no peer-to-peer media for {}s — ending (phone gone)",
                        COUNTERPART_GONE_MEDIA_WINDOW.as_secs()
                    );
                    runner.end("peer disconnected");
                    break;
                }
            }

            _ = clipboard_poll.tick(), if runner.peer_connected => {
                runner.poll_clipboard(&sig);
            }
        }
    }

    // Never inject after disconnect: disable + release held keys/buttons
    // immediately, then let Drop join the worker thread.
    runner.gate.disable();
    // Cancel any in-flight agent run — it must not keep driving the Mac after
    // the session it belongs to has ended.
    runner.agent.cancel_active();
    // stop() joins the media thread, which can be parked up to the capture
    // frame-wait timeout (~2s) — it internally runs that off the runtime
    // worker.
    runner.media.stop().await;
    if let Some(p) = runner.peer.take() {
        let _ = p.close().await;
    }
    log::info!(target: "lilypad::session", "session runner exited for room {room_id}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counterpart_gone_false_when_media_still_flowing() {
        // Signaling-offline blip, but P2P media is fresh — a cellular
        // signaling hiccup with a working session must survive.
        let now = Instant::now();
        let last_traffic = Some(now - Duration::from_secs(2));
        assert!(!counterpart_gone(
            true,
            true,
            last_traffic,
            now,
            COUNTERPART_GONE_MEDIA_WINDOW
        ));
    }

    // ── ICE-restart budget (the 2026-08-12 cellular restart loop) ──────────
    //
    // Regression guard for a storm observed live over cellular: restarts at
    // 23:42:05, :31, :56 and 23:43:12, EVERY one logged `1/2`. The heartbeat
    // reset `ice_restarts` to 0 whenever peer traffic read fresh, so the
    // budget never filled, the "hold and let traffic own recovery" brake never
    // engaged, and each restart cost a candidate regather, a keyframe and a
    // bitrate reset — which is the lag itself.

    #[test]
    fn repeated_restarts_do_not_earn_the_budget_back() {
        // The storm's exact shape: another restart ~20s after the last one.
        // This MUST NOT refund the budget, or MAX_ICE_RESTARTS is unreachable.
        let now = Instant::now();
        let last_restart = Some(now - Duration::from_secs(20));
        assert!(!ice_budget_earned_back(
            last_restart,
            now,
            ICE_RESTART_STABILITY_WINDOW
        ));
    }

    #[test]
    fn a_restart_followed_by_sustained_traffic_earns_the_budget_back() {
        // A restart that genuinely fixed the path: a later, unrelated outage
        // deserves a full budget rather than inheriting old failures.
        let now = Instant::now();
        let last_restart = Some(now - ICE_RESTART_STABILITY_WINDOW - Duration::from_secs(1));
        assert!(ice_budget_earned_back(
            last_restart,
            now,
            ICE_RESTART_STABILITY_WINDOW
        ));
    }

    #[test]
    fn a_session_that_never_restarted_has_nothing_to_earn_back() {
        assert!(ice_budget_earned_back(
            None,
            Instant::now(),
            ICE_RESTART_STABILITY_WINDOW
        ));
    }

    #[test]
    fn budget_survives_a_storm_but_recovers_after_stability() {
        // End-to-end over the counter itself: four restarts at the observed
        // ~20s cadence must exhaust MAX_ICE_RESTARTS instead of sitting at 1.
        let start = Instant::now();
        let mut ice_restarts: u32 = 0;
        let mut last_ice_restart: Option<Instant> = None;

        for i in 0..4 {
            let at = start + Duration::from_secs(i * 20);
            // The restart itself, when the budget still allows one.
            if ice_restarts < MAX_ICE_RESTARTS {
                ice_restarts += 1;
                last_ice_restart = Some(at);
            }
            // Traffic resumes a second later and the deadline is lifted.
            if ice_budget_earned_back(
                last_ice_restart,
                at + Duration::from_secs(1),
                ICE_RESTART_STABILITY_WINDOW,
            ) {
                ice_restarts = 0;
            }
        }
        assert_eq!(
            ice_restarts, MAX_ICE_RESTARTS,
            "a ~20s restart cadence must exhaust the budget, not reset it to 1 forever"
        );

        // A full stability window of flowing traffic, and the budget returns.
        let calm = start + Duration::from_secs(3 * 20) + ICE_RESTART_STABILITY_WINDOW;
        assert!(ice_budget_earned_back(
            last_ice_restart,
            calm,
            ICE_RESTART_STABILITY_WINDOW
        ));
    }

    #[test]
    fn counterpart_gone_true_when_offline_and_connected_and_media_stale() {
        // The exact "phone killed" case: signaling gone AND no P2P media
        // for longer than the counterpart-gone window.
        let now = Instant::now();
        let last_traffic = Some(now - COUNTERPART_GONE_MEDIA_WINDOW - Duration::from_secs(1));
        assert!(counterpart_gone(
            true,
            true,
            last_traffic,
            now,
            COUNTERPART_GONE_MEDIA_WINDOW
        ));
    }

    #[test]
    fn counterpart_gone_false_when_signaling_is_not_reported_offline() {
        // No peer-status nudge (or an online:true one) — never fast-end on
        // media staleness alone; that's TRAFFIC_LIVENESS_WINDOW's job.
        let now = Instant::now();
        let last_traffic = Some(now - Duration::from_secs(60));
        assert!(!counterpart_gone(
            false,
            true,
            last_traffic,
            now,
            COUNTERPART_GONE_MEDIA_WINDOW
        ));
    }

    #[test]
    fn counterpart_gone_false_when_session_never_actually_connected() {
        // Still negotiating (never reached a real `connected`) — that path
        // is owned by `recovery_deadline`, not this fast path.
        let now = Instant::now();
        assert!(!counterpart_gone(
            true,
            false,
            None,
            now,
            COUNTERPART_GONE_MEDIA_WINDOW
        ));
    }

    #[test]
    fn counterpart_gone_true_when_no_traffic_has_ever_arrived() {
        // Offline signaling and never any P2P traffic at all (last_traffic
        // is None) is exactly as stale as any traffic beyond the window.
        let now = Instant::now();
        assert!(counterpart_gone(
            true,
            true,
            None,
            now,
            COUNTERPART_GONE_MEDIA_WINDOW
        ));
    }
}
