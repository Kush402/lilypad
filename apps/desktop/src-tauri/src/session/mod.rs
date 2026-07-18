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

/// Control commands from the UI into a running session.
#[derive(Debug, Clone)]
pub enum Control {
    /// The user tapped Approve on the desktop, granting these scopes.
    Approve(Vec<String>),
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
fn recovery_timeout_for_attempt(attempt: u32) -> Duration {
    if attempt <= 1 {
        Duration::from_secs(12)
    } else {
        Duration::from_secs(20)
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
    ice_restarts: u32,
    recovery_deadline: Option<Instant>,
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
            ice_restarts: 0,
            recovery_deadline: None,
            events,
            agent: AgentController::new(),
            granted_control: false,
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
                self.peer = Some(new_peer);
                self.fsm.transition(SessionState::Negotiating);
                self.emit(SessionEvent::SessionStarting {
                    session_id: p.session_id,
                });
                log::info!(target: "lilypad::session", "offer sent, awaiting answer");
            }
            "answer" => {
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
                // Mobile-initiated recovery request — its own local network
                // path may have broken independent of the desktop's view of
                // the connection. Shares the SAME bounded budget the
                // connection-state 'failed' handler uses (`attempt_ice_restart`)
                // so a mobile-initiated and desktop-initiated restart can't
                // combine to exceed the intended cap.
                if self.attempt_ice_restart(sig).await? {
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
    async fn handle_peer_event(&mut self, ev: PeerEvent, sig: &SignalingClient) -> Result<bool> {
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
                if !was_connected {
                    // Seed rather than push: whatever's already on the OS
                    // clipboard predates this session and shouldn't be
                    // forced onto a phone that just connected.
                    self.clipboard.seed();
                }
            }
            self.gate.set_peer_connected(self.peer_connected);

            // A failed connection is recoverable if the network path changed
            // (Wi-Fi → cellular, new interface): try a bounded number of ICE
            // restarts before giving up. Without this, a dead peer left a
            // zombie session.
            if s == "failed" && self.attempt_ice_restart(sig).await? {
                return Ok(true);
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
    async fn attempt_ice_restart(&mut self, sig: &SignalingClient) -> Result<bool> {
        if self.ice_restarts >= MAX_ICE_RESTARTS {
            self.end("connection failed (ICE restarts exhausted)");
            return Ok(true);
        }
        let Some(peer) = self.peer.clone() else {
            self.end("connection failed (no active peer)");
            return Ok(true);
        };
        self.ice_restarts += 1;
        self.fsm.transition(SessionState::Recovering);
        log::warn!(target: "lilypad::session", "attempting ICE restart {}/{MAX_ICE_RESTARTS}", self.ice_restarts);
        match peer.restart_ice().await {
            Ok(sdp) => {
                sig.send(Envelope::offer(&self.room_id, &sdp))?;
                self.recovery_deadline =
                    Some(Instant::now() + recovery_timeout_for_attempt(self.ice_restarts));
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
                    Some(Control::Approve(scopes)) => {
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
                            if let Err(e) = sig.send(Envelope::pair_approved(&room_id, &scopes)) {
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
                if let Some(deadline) = runner.recovery_deadline {
                    if !runner.peer_connected && Instant::now() >= deadline {
                        runner.end("connection did not recover in time");
                        break;
                    }
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
