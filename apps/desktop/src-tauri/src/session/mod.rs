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
pub(crate) mod reconnect;
mod signaling_client;

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::Serialize;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::agent::{self, AgentController};
use crate::input::Scope;
use crate::media::CaptureMode;
use crate::rtc::{
    IcePolicy, IceServerConfig, PeerEvent, PeerEventGate, WebRtcPeer, PATH_LAN, PATH_RELAY,
};
use crate::signaling::{messages, Envelope};
use clipboard_watcher::{send_clipboard_update, ClipboardWatcher};
use fsm::{SessionFsm, SessionState};
use input_gate::InputGate;
use media_controller::MediaController;
use signaling_client::{SignalingClient, SignalingClientEvent};

/// How often the desktop checks its OS clipboard for changes to push to the
/// phone. A human-paced event (a copy) tolerates this easily; matches the
/// audit's own suggested 500ms-1s range. See `docs/audit/m3/prior-art.md`
/// Finding 6.
const CLIPBOARD_POLL_INTERVAL: Duration = Duration::from_millis(750);

/// A new peer owns a new queue. A send-time generation check alone cannot
/// reject callbacks already queued when signaling replaces the peer.
fn replace_peer_events(
    gate: &PeerEventGate,
    receiver: &mut UnboundedReceiver<PeerEvent>,
) -> (u64, UnboundedSender<PeerEvent>) {
    let generation = gate.next();
    let (sender, next_receiver) = mpsc::unbounded_channel();
    *receiver = next_receiver;
    (generation, sender)
}

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
    /// The phone's control channel closed. The room remains alive briefly so
    /// the same trusted phone can reclaim it, but the Mac has already
    /// suspended capture, input and Ask for that peer.
    InputChannelClosed,
    /// The signaling WebSocket dropped mid-session; reconnecting with backoff
    /// (media keeps flowing peer-to-peer meanwhile).
    SignalingReconnecting,
    SignalingReconnected,
    Ended {
        reason: String,
    },
    /// Which way the media actually ended up travelling — `lan`, `direct` or
    /// `relay`. Emitted once per connection, after ICE has chosen a pair.
    ///
    /// Not derivable from anything else the UI sees: `ConnectionState`
    /// ("connected") is true of all three, and the candidate logs say what was
    /// offered rather than what was picked. Without it, "did that session go
    /// over the relay?" could only be answered by reading stderr from a Mac
    /// app that, launched from Finder, has nowhere to write it.
    ConnectionPath {
        path: String,
    },
    /// Which display the session is showing, by the name the phone's switcher
    /// puts on its button. Emitted when media starts and on every switch, and
    /// only when there is more than one display — on a one-screen Mac there is
    /// nothing to disambiguate and a line saying so is noise.
    ///
    /// This is a consent signal, not a diagnostic. Before the switcher, "Lilypad
    /// is sharing" could only mean the main display; now a phone can move the
    /// view to another monitor, and the person sitting at the Mac should not
    /// have to guess which one somebody else is looking at.
    SharedDisplay {
        name: String,
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

/// Once the hub reports the phone's SIGNALING is gone (`peer-status`
/// online:false), we no longer wait out the long cellular-gap tolerance to
/// decide the phone is gone. A killed / swipe-killed / crashed app produces
/// a socket close immediately; inbound RTCP/PLI then stops. Outbound
/// capture does not count as liveness — without this check the Mac stayed
/// Active and encoding for the full window (observed 2026-08-29T23:40Z
/// room `9664972e`: last inbound ~23:40:51, `phone gone` at 23:41:36).
///
/// Sized to `@lilypad/protocol`'s `BACKEND_REREGISTER_GRACE_MS` (15s): a
/// flap that reclaims the mobile seat (reconnect budget 7.5s) still
/// survives; 45s of Active after the app is gone does not. Media still
/// flowing P2P outvotes this (a signaling-only blip, not a gone phone).
/// A brief iOS app-switch never produces `peer-status` — the 2s pause
/// debounce keeps the socket up.
const COUNTERPART_GONE_MEDIA_WINDOW: Duration = Duration::from_secs(15);

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

/// How long media may run without an open input DataChannel before we give
/// up on the selected ICE pair and recreate the peer as relay-only.
///
/// Observed 2026-08-29 (cellular, v0.1.22): ICE nominated a srflx↔srflx
/// "direct" pair, video decoded, `set-display` (signaling) worked, and the
/// input worker received **zero** events for the whole session. The same
/// phone on LAN (host↔host) and earlier relayed cellular sessions injected
/// fine. SCTP/DataChannel over some CGNAT reflexive pairs is a known WebRTC
/// failure mode; RTP can flow while the association never completes.
/// webrtc-rs 0.11 does not implement `setConfiguration`, so the only way
/// onto TURN is a new PeerConnection with `iceTransportPolicy: relay`.
const INPUT_CHANNEL_FALLBACK_GRACE: Duration = Duration::from_secs(6);

/// Pure decision: recreate the peer as relay-only because the input
/// DataChannel never opened on the current pair.
///
/// Skip LAN (host↔host carries SCTP) and an already-relayed path (retrying
/// relay cannot change the pair). `path == None` still qualifies — ICE
/// connected but never classified is not a reason to leave control dead.
fn input_channel_fallback_due(
    channel_open: bool,
    already_forced: bool,
    path: Option<&str>,
    connected_without_dc_since: Option<Instant>,
    now: Instant,
    grace: Duration,
) -> bool {
    if channel_open || already_forced {
        return false;
    }
    if matches!(path, Some(p) if p == PATH_LAN || p == PATH_RELAY) {
        return false;
    }
    connected_without_dc_since.is_some_and(|t| now.duration_since(t) >= grace)
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
    /// Displays attached as of the last check, in the Mac's own left-to-right
    /// order. Re-read on the heartbeat so a monitor plugged in (or pulled out)
    /// mid-session reaches the phone's switcher without a reconnect.
    displays: Vec<crate::media::Display>,
    peer: Option<Arc<WebRtcPeer>>,
    /// When the LAN control server is running, advertise its URLs to the phone.
    lan_ad: Option<crate::lan::LanEndpoints>,
    peer_connected: bool,
    /// Set once per peer, the first time `ConnectionState("connected")` is
    /// observed; reset on peer replacement — unlike `peer_connected`, reassigned on
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
    /// ICE servers from `session-start`, kept so a DataChannel-failed
    /// session can rebuild the peer as relay-only without waiting for
    /// another hub message.
    ice_servers: Vec<IceServerConfig>,
    ice_policy: IcePolicy,
    /// Last classified connection path (`lan` / `direct` / `relay`).
    connection_path: Option<&'static str>,
    input_channel_open: bool,
    /// Once the critical channel closes it cannot reopen on this peer. Keep a
    /// late queued `connected` callback from restarting capture during the
    /// trusted-rejoin grace; `discard_current_peer` resets this for the
    /// replacement PeerConnection.
    input_channel_closed: bool,
    /// While ICE is down and actual peer traffic has gone stale, capabilities
    /// are stopped even if SCTP has not closed its channel. Preserve the prior
    /// pause independently so recovery does not undo the phone's explicit pause.
    peer_suspension: bool,
    viewer_paused: bool,
    /// First moment we were `connected` without an open input DataChannel.
    connected_without_dc_since: Option<Instant>,
    /// We already recreated the peer with `iceTransportPolicy: relay`.
    forced_relay: bool,
    /// Drop events from a PeerConnection we have already replaced. See
    /// `PeerEventGate`.
    event_gate: PeerEventGate,
}

impl SessionRunner {
    fn new(
        room_id: String,
        events: UnboundedSender<SessionEvent>,
        lan_ad: Option<crate::lan::LanEndpoints>,
    ) -> Self {
        Self {
            room_id,
            fsm: SessionFsm::new(),
            media: MediaController::new(),
            gate: InputGate::new(),
            clipboard: ClipboardWatcher::new(),
            displays: Vec::new(),
            peer: None,
            lan_ad,
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
            ice_servers: Vec::new(),
            ice_policy: IcePolicy::All,
            connection_path: None,
            input_channel_open: false,
            input_channel_closed: false,
            peer_suspension: false,
            viewer_paused: false,
            connected_without_dc_since: None,
            forced_relay: false,
            event_gate: PeerEventGate::new(),
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
        let reason = reason.into();
        log::info!(target: "lilypad::session", "session ending: {reason}");
        self.emit(SessionEvent::Ended { reason });
        self.fsm.transition(SessionState::Ended);
    }

    /// Invalidate the current peer's events, stop media, and close it.
    /// Call *before* building a replacement so `ConnectionState("closed")`
    /// from the old PC cannot end the new handshake (L-195).
    async fn discard_current_peer(
        &mut self,
        peer_ev_rx: &mut UnboundedReceiver<PeerEvent>,
    ) -> (u64, UnboundedSender<PeerEvent>) {
        let next = replace_peer_events(&self.event_gate, peer_ev_rx);
        self.agent.cancel_active();
        self.media.set_paused(true);
        self.gate.set_peer_connected(false);
        self.input_channel_open = false;
        self.input_channel_closed = false;
        self.peer_suspension = false;
        self.gate.set_channel_open(false);
        self.connected_without_dc_since = None;
        self.peer_connected = false;
        self.ever_connected = false;
        self.last_peer_traffic = None;
        self.recovery_deadline = None;
        self.last_ice_restart = None;
        self.ice_restarts = 0;
        self.pending_offer = None;
        self.connection_path = None;
        if self.peer.is_some() {
            self.emit(SessionEvent::InputChannelClosed);
        }
        self.media.stop_pipeline().await;
        if let Some(old) = self.peer.take() {
            let _ = old.close().await;
        }
        next
    }

    /// Handle one inbound signaling message. `Ok(true)` means it terminates
    /// the session (mirrors the original `handle_inbound` contract exactly,
    /// including which errors are fatal to the whole runner vs. merely
    /// logged — see the call site for why).
    async fn handle_signaling_message(
        &mut self,
        env: &Envelope,
        sig: &SignalingClient,
        peer_ev_rx: &mut UnboundedReceiver<PeerEvent>,
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
                } else {
                    // Hub already moved the room to waiting_approval and the
                    // phone is showing "Waiting for approval…". Swallowing
                    // this leaves the Mac on Pairing with no Approve surface
                    // at all — tray disabled, Control idle, QR still "Scan
                    // to pair". Log it so the next one is not silent.
                    log::error!(
                        target: "lilypad::session",
                        "pair-request payload unreadable — Approve UI will not appear: {}",
                        env.payload
                    );
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
                log::info!(
                    target: "lilypad::session",
                    "session-start granted {:?} (control={})",
                    p.granted_scopes
                        .iter()
                        .map(|s| match s {
                            messages::SessionScope::View => "view",
                            messages::SessionScope::Control => "control",
                        })
                        .collect::<Vec<_>>(),
                    self.granted_control
                );
                let ice_servers: Vec<IceServerConfig> = p
                    .ice_servers
                    .iter()
                    .map(|s| IceServerConfig {
                        urls: s.url_list(),
                        username: s.username.clone().unwrap_or_default(),
                        credential: s.credential.clone().unwrap_or_default(),
                    })
                    .collect();
                let policy = match p.ice_transport_policy {
                    messages::IceTransportPolicy::All => IcePolicy::All,
                    messages::IceTransportPolicy::Relay => IcePolicy::Relay,
                };
                self.ice_servers = ice_servers.clone();
                self.ice_policy = policy;
                // Hub already asked for relay — don't later recreate "to" relay.
                self.forced_relay = matches!(policy, IcePolicy::Relay);
                // A repeat session-start must not leak the previous
                // PeerConnection (its ICE/DTLS/RTCP-reader tasks live until
                // close) AND must not let that close end this runner —
                // `discard_current_peer` bumps the event gate first.
                let replacing = self.peer.is_some();
                let (mine, peer_ev_tx) = self.discard_current_peer(peer_ev_rx).await;
                if replacing {
                    log::warn!(target: "lilypad::session", "new session-start replacing an existing peer — closing the old one");
                }
                let new_peer = Arc::new(
                    WebRtcPeer::with_gated_events(
                        ice_servers,
                        peer_ev_tx.clone(),
                        policy,
                        self.event_gate.clone(),
                        mine,
                    )
                    .await?,
                );
                // Own it before any further fallible work, so offer/signaling
                // failure still reaches the normal peer-close path.
                self.peer = Some(Arc::clone(&new_peer));
                let sdp = new_peer.create_offer().await?;
                sig.send(Envelope::offer(&self.room_id, &sdp))?;
                if let Some(ep) = &self.lan_ad {
                    let _ = sig.send(Envelope::lan_endpoints(
                        &self.room_id,
                        &ep.api_base_url,
                        &ep.signaling_url,
                        &ep.tls_cert_sha256,
                    ));
                }
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
                // Exception: if the input DataChannel never opened, an ICE restart on
                // the same PeerConnection would re-nominate the same srflx pair.
                // Recreate as relay-only instead (webrtc-rs has no setConfiguration).
                if self
                    .last_ice_restart
                    .is_some_and(|t| t.elapsed() < MIN_ICE_RESTART_SPACING)
                {
                    log::info!(
                        target: "lilypad::session",
                        "renegotiate throttled — ICE restarted {}s ago",
                        self.last_ice_restart.unwrap().elapsed().as_secs()
                    );
                } else if input_channel_fallback_due(
                    self.input_channel_open,
                    self.forced_relay,
                    self.connection_path,
                    self.connected_without_dc_since,
                    Instant::now(),
                    Duration::ZERO,
                ) {
                    if self
                        .recreate_peer_relay_only(
                            sig,
                            peer_ev_rx,
                            "phone renegotiate, input DataChannel never opened",
                        )
                        .await?
                    {
                        return Ok(true);
                    }
                } else if self.attempt_ice_restart(sig, "phone renegotiate").await? {
                    return Ok(true);
                }
            }
            "pause" => {
                // Phone backgrounded (or user paused) — stop sending video
                // without tearing down ICE/DataChannel, so resuming is instant.
                self.viewer_paused = true;
                self.sync_media_pause();
            }
            "resume" => {
                // Don't export text copied while the viewer was backgrounded.
                if self.media.is_paused() && self.granted_control {
                    self.clipboard.seed();
                }
                self.viewer_paused = false;
                self.sync_media_pause();
            }
            "set-capture-mode" => {
                if let Ok(p) =
                    serde_json::from_value::<messages::SetCaptureModePayload>(env.payload.clone())
                {
                    self.handle_set_capture_mode(p.mode, sig).await;
                }
            }
            "set-display" => {
                if let Ok(p) =
                    serde_json::from_value::<messages::SetDisplayPayload>(env.payload.clone())
                {
                    self.handle_set_display(p.display_id, sig).await;
                }
            }
            "peer-status" => {
                // Hub nudge: the phone's SIGNALING transport dropped
                // (online:false) or came back (online:true). We don't end
                // here — the heartbeat tick combines this with
                // peer-to-peer media liveness (see
                // COUNTERPART_GONE_MEDIA_WINDOW) so a signaling blip where
                // media still flows doesn't kill a working session. We DO
                // stop *sending* video immediately: a swipe-killed phone
                // will never reclaim, and encoding into the void is the
                // "Mac still Active" product bug. Capture itself stops
                // when counterpart_gone ends the session (~15s). A reclaim
                // unpauses. `pause` from a still-seated phone is separate
                // and is not undone here.
                if let Ok(p) =
                    serde_json::from_value::<messages::PeerStatusPayload>(env.payload.clone())
                {
                    self.counterpart_signaling_offline = !p.online;
                    self.sync_media_pause();
                    log::info!(
                        target: "lilypad::session",
                        "counterpart signaling {}",
                        if p.online { "online" } else { "offline — pausing send" }
                    );
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

    fn sync_media_pause(&self) {
        self.media.set_paused(
            self.viewer_paused
                || self.counterpart_signaling_offline
                || self.peer_suspension
                || self.input_channel_closed
                || !self.input_channel_open,
        );
    }

    /// Fresh inbound traffic from the phone proves the path works regardless
    /// of what the ICE state machine currently claims.
    fn peer_traffic_fresh(&self) -> bool {
        !self.input_channel_closed
            && self
                .last_peer_traffic
                .is_some_and(|t| t.elapsed() < TRAFFIC_LIVENESS_WINDOW)
    }

    /// An ICE verdict alone is insufficient: working input/RTCP still wins.
    /// Once that evidence expires, stop local capabilities while retaining the
    /// authenticated peer for the existing bounded recovery path.
    async fn suspend_stale_peer(&mut self) {
        if self.peer_connected
            || !self.ever_connected
            || self.input_channel_closed
            || self.peer_traffic_fresh()
            || self.peer_suspension
        {
            return;
        }
        self.peer_suspension = true;
        self.gate.set_peer_connected(false);
        self.media.set_paused(true);
        self.agent.cancel_active();
        self.emit(SessionEvent::InputChannelClosed);
        // A disconnected-only peer might never emit failed. It still needs a
        // deadline; repeat ticks must not keep extending that grace.
        self.recovery_deadline.get_or_insert_with(|| {
            Instant::now() + recovery_timeout_for_attempt(self.ice_restarts.max(1))
        });
        log::info!(target: "lilypad::session", "ICE down and peer traffic stale — suspending capture and control during recovery");
        self.media.stop_pipeline().await;
    }

    /// Called only for a connected callback or fresh inbound peer traffic.
    /// The original DataChannel must still be open; a truly closed channel is
    /// never revived here, and replacing the peer discards this marker.
    async fn restore_peer_capabilities(&mut self, sig: &SignalingClient) -> Result<()> {
        if !self.peer_suspension {
            return Ok(());
        }
        if self.input_channel_closed {
            return Ok(());
        }
        if !self.media.is_started() {
            if let Some(peer) = self.peer.as_ref() {
                self.media.start(Arc::clone(peer)).await?;
                self.refresh_displays();
                self.gate.set_target_display(self.media.display_id());
                self.send_frame_size(sig);
                self.emit_shared_display();
            }
        }
        self.peer_suspension = false;
        // Text copied during transport loss is not part of the resumed session.
        if self.granted_control {
            self.clipboard.seed();
        }
        self.sync_media_pause();
        self.gate.set_peer_connected(true);
        if self.input_channel_open {
            self.emit(SessionEvent::InputChannelOpen);
        }
        Ok(())
    }

    async fn handle_peer_event(&mut self, ev: PeerEvent, sig: &SignalingClient) -> Result<bool> {
        // The unreliable move channel may outlive the critical channel. It
        // must not admit Ask commands or revive liveness after control closed.
        if matches!(ev, PeerEvent::InputMessage(_)) && !self.input_channel_open {
            return Ok(false);
        }
        if matches!(ev, PeerEvent::InputChannelOpen) && self.input_channel_closed {
            return Ok(false);
        }
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
            if !self.peer_connected && !self.input_channel_closed {
                self.restore_peer_capabilities(sig).await?;
                // ICE says down, traffic says up: traffic wins for injection
                // gating — the loss reports/REMB prove the viewer is
                // receiving video, which is the property the gate protects.
                self.gate.set_peer_connected(true);
            }
        }
        if let PeerEvent::ConnectionState(s) = &ev {
            if s == "connected" && !self.input_channel_closed {
                self.restore_peer_capabilities(sig).await?;
            }
            // Begin streaming once the peer connection is live (SRTP ready).
            if s == "connected" && !self.input_channel_closed && !self.media.is_started() {
                if let Some(p) = self.peer.as_ref() {
                    match self.media.start(Arc::clone(p)).await {
                        Ok(()) => {
                            // Enumerate before announcing: the first
                            // `frame-size` is what builds the phone's
                            // switcher, and an empty list there would hide it
                            // until something else changed.
                            self.refresh_displays();
                            self.gate.set_target_display(self.media.display_id());
                            self.send_frame_size(sig);
                            self.emit_shared_display();
                        }
                        Err(e) => self.emit(SessionEvent::Error {
                            message: format!("pipeline start: {e}"),
                        }),
                    }
                }
            }
            let was_connected = self.peer_connected;
            self.peer_connected = s == "connected" && !self.input_channel_closed;
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
                self.sync_media_pause();
                self.ever_connected = true;
                if !was_connected {
                    // Seed rather than push: whatever's already on the OS
                    // clipboard predates this session and shouldn't be
                    // forced onto a phone that just connected.
                    if self.granted_control {
                        self.clipboard.seed();
                    }
                    // Ask ICE what it settled on, now that it has settled.
                    // Also after an ICE restart, because a session that
                    // recovers onto the relay has genuinely changed path and
                    // reporting the old one would be worse than reporting
                    // nothing.
                    if let Some(p) = self.peer.as_ref() {
                        if let Some(path) = p.connection_path().await {
                            self.connection_path = Some(path);
                            self.emit(SessionEvent::ConnectionPath {
                                path: path.to_owned(),
                            });
                        }
                    }
                    if !self.input_channel_open && self.connected_without_dc_since.is_none() {
                        self.connected_without_dc_since = Some(Instant::now());
                    }
                }
            }
            self.gate
                .set_peer_connected(self.peer_connected || self.peer_traffic_fresh());
            if matches!(s.as_str(), "disconnected" | "failed") {
                self.suspend_stale_peer().await;
            }

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
            self.input_channel_open = true;
            self.input_channel_closed = false;
            self.connected_without_dc_since = None;
            self.sync_media_pause();
            log::info!(target: "lilypad::session", "input DataChannel open");
        }
        if matches!(ev, PeerEvent::InputChannelClosed) {
            // This is earlier and stronger local evidence than the signaling
            // heartbeat timeout: the phone can no longer control this peer.
            // Keep the room/peer object for the bounded trusted-rejoin path,
            // but fail closed at every capability boundary immediately.
            self.gate.set_channel_open(false);
            self.gate.set_peer_connected(false);
            self.input_channel_open = false;
            self.input_channel_closed = true;
            self.peer_suspension = false;
            self.peer_connected = false;
            self.media.set_paused(true);
            self.agent.cancel_active();
            self.emit(SessionEvent::InputChannelClosed);
            log::info!(
                target: "lilypad::session",
                "input DataChannel closed — suspending capture and control while rejoin remains available"
            );
            // `set_paused` closes the send boundary synchronously. Stop the
            // capture/encoder too so the Mac does not keep recording into the
            // void (or retain its display-sleep assertion) during the grace.
            self.media.stop_pipeline().await;
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
            if self.media.is_started() || self.peer_suspension {
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

    /// Tear down the current PeerConnection and build a relay-only one.
    /// webrtc-rs 0.11's `setConfiguration` is unimplemented, so this is the
    /// only way to change `iceTransportPolicy` after the first gather.
    ///
    /// Returns `Ok(false)` after sending the new offer, or when a recreate
    /// cannot help (no ICE servers, already relay-only). Never ends the
    /// session — video can keep working while control is recovered.
    async fn recreate_peer_relay_only(
        &mut self,
        sig: &SignalingClient,
        peer_ev_rx: &mut UnboundedReceiver<PeerEvent>,
        reason: &str,
    ) -> Result<bool> {
        if self.ice_servers.is_empty() {
            log::warn!(
                target: "lilypad::session",
                "cannot force relay ({reason}) — session-start carried no ICE servers"
            );
            return Ok(false);
        }
        if matches!(self.ice_policy, IcePolicy::Relay) {
            self.forced_relay = true;
            return Ok(false);
        }
        self.forced_relay = true;
        self.connection_path = None;
        let (mine, peer_ev_tx) = self.discard_current_peer(peer_ev_rx).await;
        log::warn!(
            target: "lilypad::session",
            "recreating peer with iceTransportPolicy=relay ({reason})"
        );
        let new_peer = Arc::new(
            WebRtcPeer::with_gated_events(
                self.ice_servers.clone(),
                peer_ev_tx.clone(),
                IcePolicy::Relay,
                self.event_gate.clone(),
                mine,
            )
            .await?,
        );
        self.peer = Some(Arc::clone(&new_peer));
        let sdp = new_peer.create_offer().await?;
        sig.send(Envelope::offer(&self.room_id, &sdp))?;
        self.pending_offer = Some(PendingOffer {
            sdp,
            sent_at: Instant::now(),
            resends: 0,
        });
        self.peer = Some(new_peer);
        self.peer_connected = false;
        self.ice_policy = IcePolicy::Relay;
        self.last_ice_restart = Some(Instant::now());
        self.fsm.transition(SessionState::Recovering);
        self.emit(SessionEvent::ConnectionState {
            state: "connecting".to_owned(),
        });
        Ok(false)
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
        let displays: Vec<messages::DisplayInfo> = self
            .displays
            .iter()
            .map(|d| messages::DisplayInfo {
                id: d.id,
                name: d.name.clone(),
                width: d.width,
                height: d.height,
            })
            .collect();
        // The phone highlights a concrete id, so "no display chosen" has to be
        // resolved to the main display's own id before it goes on the wire.
        let active = self
            .media
            .display_id()
            .or_else(crate::media::main_display_id);
        if let Err(e) = sig.send(Envelope::frame_size(
            &self.room_id,
            w,
            h,
            mode,
            &displays,
            active,
        )) {
            log::warn!(target: "lilypad::session", "frame-size send failed: {e}");
        }
    }

    /// Tell the Mac's own dashboard which screen is being shared, when there is
    /// more than one it could be. See `SessionEvent::SharedDisplay`.
    fn emit_shared_display(&mut self) {
        let active = self
            .media
            .display_id()
            .or_else(crate::media::main_display_id);
        if let Some(name) = shared_display_name(&self.displays, active) {
            self.emit(SessionEvent::SharedDisplay { name });
        }
    }

    /// Re-read the attached displays; `true` when the set changed.
    fn refresh_displays(&mut self) -> bool {
        let now = crate::media::list_displays();
        if now == self.displays {
            return false;
        }
        self.displays = now;
        true
    }

    /// True when `id` names a display that is still attached.
    fn display_attached(&self, id: u32) -> bool {
        self.displays.iter().any(|d| d.id == id)
    }

    /// Handle a mobile-initiated display switch. Same cost and same brief
    /// glitch as a capture-mode switch — see `MediaController::set_display`.
    /// An id that is no longer attached is answered with the main display
    /// rather than an error: the phone's list can only ever be as fresh as
    /// the last `frame-size`, and a monitor unplugged in between is the
    /// person's own doing, not a failure to report.
    async fn handle_set_display(&mut self, display_id: u32, sig: &SignalingClient) {
        if !self.media.is_started() {
            return;
        }
        let Some(peer) = self.peer.clone() else {
            return;
        };
        self.refresh_displays();
        let target = chosen_display(&self.displays, display_id);
        if target.is_none() {
            log::warn!(
                target: "lilypad::session",
                "display {display_id} is no longer attached — showing the main display instead"
            );
        }
        match self.media.set_display(target, peer).await {
            Ok(()) => {
                log::info!(target: "lilypad::session", "capture switched to display {target:?}");
                // Taps have to follow the picture: normalized coordinates mean
                // nothing without knowing which screen they are normalized to.
                self.gate.set_target_display(self.media.display_id());
                self.send_frame_size(sig);
                self.emit_shared_display();
            }
            Err(e) => {
                log::error!(target: "lilypad::session", "display switch failed: {e}");
                self.emit(SessionEvent::Error {
                    message: format!("display switch failed: {e}"),
                });
            }
        }
    }

    /// Notice a monitor plugged in or pulled out mid-session.
    ///
    /// Two different jobs. The cheap one: tell the phone, so its switcher is
    /// the truth rather than a snapshot from when the session started. The
    /// load-bearing one: if the display being CAPTURED just went away, move to
    /// the main display before ScreenCaptureKit's now-dead stream takes the
    /// session down with it — unplugging a monitor should cost a glitch, not a
    /// reconnect.
    /// After a media failure: was it the captured display being unplugged?
    /// If so, rebuild on the main display and keep the session alive.
    /// `false` means this was some other failure and the caller should end.
    async fn recover_from_lost_display(&mut self, sig: &SignalingClient) -> bool {
        self.refresh_displays();
        let Some(lost) = self
            .media
            .display_id()
            .filter(|id| !self.display_attached(*id))
        else {
            return false;
        };
        let Some(peer) = self.peer.clone() else {
            return false;
        };
        log::warn!(
            target: "lilypad::session",
            "display {lost} was unplugged mid-session — rebuilding on the main display"
        );
        if let Err(e) = self.media.set_display(None, peer).await {
            log::error!(target: "lilypad::session", "rebuild on the main display failed: {e}");
            return false;
        }
        self.gate.set_target_display(None);
        self.send_frame_size(sig);
        self.emit_shared_display();
        true
    }

    async fn poll_displays(&mut self, sig: &SignalingClient) {
        if !self.refresh_displays() {
            return;
        }
        let lost = self
            .media
            .display_id()
            .is_some_and(|id| !self.display_attached(id));
        if lost && self.media.is_started() {
            if let Some(peer) = self.peer.clone() {
                log::info!(
                    target: "lilypad::session",
                    "the captured display was unplugged — falling back to the main display"
                );
                if let Err(e) = self.media.set_display(None, peer).await {
                    log::error!(target: "lilypad::session", "fallback to the main display failed: {e}");
                    return; // the media-failure path owns ending the session
                }
                self.gate.set_target_display(None);
            }
        }
        self.send_frame_size(sig);
        self.emit_shared_display();
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

    fn clipboard_authorized(&self) -> bool {
        self.granted_control
            && self.input_channel_open
            && !self.input_channel_closed
            && (self.peer_connected || self.peer_traffic_fresh())
            && !self.media.is_paused()
    }

    /// Private clipboard payloads have exactly one transport: the current
    /// authorized peer's reliable encrypted DataChannel. No API/LAN-signaling
    /// fallback, including when the DataChannel cannot accept the write.
    async fn poll_clipboard(&mut self) {
        if !self.clipboard_authorized() {
            return;
        }
        let Some(peer) = self.peer.as_ref() else {
            return;
        };
        if let Some(text) = self.clipboard.poll() {
            if let Err(e) =
                send_clipboard_update(&self.room_id, &text, |frame| peer.send_input_text(frame))
                    .await
            {
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
    lan_ad: Option<crate::lan::LanEndpoints>,
    lan_loopback: Option<std::sync::Arc<crate::lan::LanHub>>,
    mut control_rx: UnboundedReceiver<Control>,
    events: UnboundedSender<SessionEvent>,
) -> Result<()> {
    let mut sig =
        SignalingClient::connect(signaling_url, room_id.clone(), device_id, lan_loopback).await?;
    let _ = events.send(SessionEvent::Registered);
    log::info!(target: "lilypad::session", "registered as desktop in room {room_id}");

    let (_initial_peer_tx, mut peer_ev_rx) = mpsc::unbounded_channel::<PeerEvent>();
    // Mirrors `@lilypad/protocol`'s `APP_HEARTBEAT_INTERVAL_MS` (4s) — see
    // docs/audit/m3/reconnect-lifecycle.md Finding 6's cross-tier timing
    // budget (this must stay well under the backend's heartbeat timeout).
    // Also the app-level WS keepalive: a slower interval let an idle socket be
    // dropped on cellular-through-tunnel paths before the first beat.
    let mut heartbeat = tokio::time::interval(Duration::from_millis(4_000));
    let mut clipboard_poll = tokio::time::interval(CLIPBOARD_POLL_INTERVAL);
    let mut runner = SessionRunner::new(room_id.clone(), events, lan_ad);

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
                        match runner.handle_signaling_message(&env, &sig, &mut peer_ev_rx).await {
                            Ok(true) => break, // terminal message
                            Ok(false) => {}
                            Err(e) => {
                                // Surface recoverable message errors. A failed
                                // peer construction/recovery must tear down.
                                log::error!(target: "lilypad::session", "handling '{}' failed: {e}", env.msg_type);
                                runner.emit(SessionEvent::Error { message: format!("{}: {e}", env.msg_type) });
                                if matches!(env.msg_type.as_str(), "session-start" | "renegotiate") {
                                    runner.end(format!("{} failed: {e}", env.msg_type));
                                    break;
                                }
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
                    // Unplugging the monitor being captured kills the
                    // ScreenCaptureKit stream, and the stream dying used to
                    // end the whole session. It is a display change, not a
                    // connection failure — rebuild on the main display and
                    // keep the session.
                    if runner.recover_from_lost_display(&sig).await {
                        continue;
                    }
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
                    match runner.handle_peer_event(ev, &sig).await {
                        Ok(true) => break,
                        Ok(false) => {}
                        Err(e) => {
                            runner.end(format!("peer recovery failed: {e}"));
                            break;
                        }
                    }
                }
            }

            _ = heartbeat.tick() => {
                let _ = sig.send(Envelope::heartbeat(&room_id));
                // ICE may have gone down while its last RTCP was still fresh.
                // Re-evaluate here when that evidence ages out, even if no
                // further connection-state callback ever arrives.
                runner.suspend_stale_peer().await;
                // Pre-answer watchdog: a phone that missed the offer (socket
                // flap right after approval) gets it again instead of both
                // sides waiting each other out.
                runner.maybe_resend_offer(&sig);
                // Monitors get plugged in and pulled out mid-session. This
                // rides the 4s heartbeat rather than adding a timer: it is a
                // cheap CoreGraphics call, and 4s is well inside "I plugged
                // in a monitor and reached for my phone".
                runner.poll_displays(&sig).await;
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
                if input_channel_fallback_due(
                    runner.input_channel_open,
                    runner.forced_relay,
                    runner.connection_path,
                    runner.connected_without_dc_since,
                    Instant::now(),
                    INPUT_CHANNEL_FALLBACK_GRACE,
                ) {
                    match runner.recreate_peer_relay_only(
                        &sig,
                        &mut peer_ev_rx,
                        "input DataChannel did not open on the selected ICE pair",
                    )
                    .await {
                        Ok(true) => break,
                        Ok(false) => {}
                        Err(e) => {
                            runner.end(format!("relay recovery failed: {e}"));
                            break;
                        }
                    }
                }
            }

            _ = clipboard_poll.tick(), if runner.clipboard_authorized() => {
                runner.poll_clipboard().await;
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

/// Which display to actually capture when the phone asks for `requested`.
///
/// `None` means the main display, and it is the answer for a monitor that is
/// no longer attached: the phone's list can only ever be as fresh as the last
/// `frame-size` it received, so a monitor unplugged in between is the person's
/// own doing rather than a request to fail. What it actually got is reported
/// back in the next `frame-size` either way.
fn chosen_display(displays: &[crate::media::Display], requested: u32) -> Option<u32> {
    displays
        .iter()
        .any(|d| d.id == requested)
        .then_some(requested)
}

/// The name to show on the Mac itself for the screen being shared.
///
/// `None` on a Mac with one display: there is nothing to disambiguate, and a
/// line naming the only screen there is would be noise on every ordinary
/// session. Also `None` when the active id names nothing attached, which is the
/// instant between a monitor being pulled out and the fallback completing —
/// better to say nothing for a moment than to name the screen that just left.
fn shared_display_name(displays: &[crate::media::Display], active: Option<u32>) -> Option<String> {
    if displays.len() < 2 {
        return None;
    }
    displays
        .iter()
        .find(|d| Some(d.id) == active)
        .map(|d| d.name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stale_ice_suspends_once_and_live_traffic_restores_without_undoing_pause() {
        let (events, mut event_rx) = mpsc::unbounded_channel();
        let mut runner = SessionRunner::new("recovery-pause".into(), events, None);
        let hub = Arc::new(crate::lan::LanHub::new());
        hub.authorize_room(
            "recovery-pause",
            "desktop-12345678".into(),
            "mobile-12345678".into(),
        );
        let sig = SignalingClient::connect(
            "unused".into(),
            "recovery-pause".into(),
            "desktop-12345678".into(),
            Some(hub),
        )
        .await
        .unwrap();
        let (_, mut peer_events) = mpsc::unbounded_channel();
        runner.ever_connected = true;
        runner.input_channel_open = true;
        runner.last_peer_traffic = Some(Instant::now());
        runner.suspend_stale_peer().await;
        assert!(!runner.peer_suspension, "live traffic outvotes ICE");
        runner.last_peer_traffic = Some(Instant::now() - TRAFFIC_LIVENESS_WINDOW);
        runner.suspend_stale_peer().await;
        assert!(runner.peer_suspension);
        assert!(runner.media.is_paused());
        assert!(matches!(
            event_rx.try_recv(),
            Ok(SessionEvent::InputChannelClosed)
        ));
        let deadline = runner.recovery_deadline.unwrap();
        runner.suspend_stale_peer().await;
        assert_eq!(runner.recovery_deadline, Some(deadline));
        assert!(event_rx.try_recv().is_err());

        // Signaling recovery cannot turn capture back on, and a pause arriving
        // during ICE recovery must remain in effect after fresh RTCP returns.
        for (kind, payload) in [
            ("resume", serde_json::json!({})),
            ("peer-status", serde_json::json!({"online": true})),
            ("pause", serde_json::json!({})),
        ] {
            let env = serde_json::from_value(serde_json::json!({
                "type": kind, "roomId": "recovery-pause", "from": "mobile",
                "ts": 1, "payload": payload,
            }))
            .unwrap();
            runner
                .handle_signaling_message(&env, &sig, &mut peer_events)
                .await
                .unwrap();
            assert!(runner.media.is_paused());
            assert!(runner.peer_suspension);
        }
        runner
            .handle_peer_event(PeerEvent::VideoKeyframeRequest, &sig)
            .await
            .unwrap();
        assert!(!runner.peer_suspension);
        assert!(
            runner.media.is_paused(),
            "recovery must preserve the viewer's pause"
        );
        assert!(matches!(
            event_rx.try_recv(),
            Ok(SessionEvent::InputChannelOpen)
        ));

        runner
            .handle_peer_event(PeerEvent::InputChannelClosed, &sig)
            .await
            .unwrap();
        runner
            .handle_peer_event(PeerEvent::VideoKeyframeRequest, &sig)
            .await
            .unwrap();
        assert!(!runner.peer_traffic_fresh());
        assert!(runner.media.is_paused());
        assert!(!runner.input_channel_open);
    }

    #[test]
    fn clipboard_requires_control_a_live_current_channel_and_an_unpaused_viewer() {
        let (events, _rx) = mpsc::unbounded_channel();
        let mut runner = SessionRunner::new("clipboard-scope".into(), events, None);
        runner.input_channel_open = true;
        runner.peer_connected = true;
        assert!(
            !runner.clipboard_authorized(),
            "view-only must not read the Mac clipboard"
        );
        runner.granted_control = true;
        assert!(runner.clipboard_authorized());
        runner.media.set_paused(true);
        assert!(
            !runner.clipboard_authorized(),
            "backgrounded viewer must not receive clipboard"
        );
        runner.media.set_paused(false);
        runner.input_channel_open = false;
        assert!(!runner.clipboard_authorized());
        runner.input_channel_open = true;
        runner.input_channel_closed = true;
        runner.last_peer_traffic = Some(Instant::now());
        assert!(
            !runner.clipboard_authorized(),
            "fresh RTCP cannot revive closed control"
        );
        runner.input_channel_closed = false;
        runner.peer_connected = false;
        assert!(
            runner.clipboard_authorized(),
            "fresh traffic still outvotes a bad FSM"
        );
        runner.last_peer_traffic = None;
        assert!(!runner.clipboard_authorized());
    }

    #[tokio::test]
    async fn closed_control_cannot_be_revived_by_late_input_or_open_callbacks() {
        let (events, _rx) = mpsc::unbounded_channel();
        let mut runner = SessionRunner::new("closed-control".into(), events, None);
        let hub = Arc::new(crate::lan::LanHub::new());
        hub.authorize_room(
            "closed-control",
            "desktop-12345678".into(),
            "mobile-12345678".into(),
        );
        let sig = SignalingClient::connect(
            "unused".into(),
            "closed-control".into(),
            "desktop-12345678".into(),
            Some(hub),
        )
        .await
        .unwrap();
        runner.input_channel_closed = true;
        runner
            .handle_peer_event(
                PeerEvent::InputMessage(b"stale Ask or input".to_vec()),
                &sig,
            )
            .await
            .unwrap();
        runner
            .handle_peer_event(PeerEvent::InputChannelOpen, &sig)
            .await
            .unwrap();
        assert!(!runner.peer_connected);
        assert!(!runner.input_channel_open);
        assert!(runner.last_peer_traffic.is_none());
        // Video feedback must not revive capabilities after the critical
        // channel closed, even though it can outvote transient ICE failures.
        runner
            .handle_peer_event(PeerEvent::VideoKeyframeRequest, &sig)
            .await
            .unwrap();
        assert!(!runner.peer_connected);
        assert!(!runner.peer_traffic_fresh());
        runner.ever_connected = true;
        runner.counterpart_signaling_offline = true;
        let (_, mut peer_events) = mpsc::unbounded_channel();
        runner.discard_current_peer(&mut peer_events).await;
        assert!(
            !runner.ever_connected,
            "a new handshake must not inherit the old peer's gone timer"
        );
        assert!(runner.last_peer_traffic.is_none());
        assert!(!runner.input_channel_closed);
    }

    #[test]
    fn replacing_a_peer_discards_already_queued_callbacks_and_late_sends() {
        let gate = PeerEventGate::new();
        let (old_tx, mut rx) = mpsc::unbounded_channel();
        gate.next();
        old_tx
            .send(PeerEvent::ConnectionState("closed".into()))
            .unwrap();
        old_tx.send(PeerEvent::InputChannelClosed).unwrap();
        old_tx
            .send(PeerEvent::InputMessage(b"stale command".to_vec()))
            .unwrap();

        let (_, new_tx) = replace_peer_events(&gate, &mut rx);
        assert!(old_tx.send(PeerEvent::InputChannelOpen).is_err());
        new_tx.send(PeerEvent::InputChannelOpen).unwrap();
        assert!(matches!(rx.try_recv(), Ok(PeerEvent::InputChannelOpen)));
        assert!(rx.try_recv().is_err(), "old callbacks reached the new peer");
    }

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
    fn counterpart_gone_window_matches_reregister_grace() {
        // Product pin: 45s of Active after a killed phone was the bug
        // (2026-08-29T23:40Z room 9664972e). A flap's reconnect budget is
        // 7.5s; the hub holds the vacated seat 15s. Do not widen this
        // back to TRAFFIC_LIVENESS_WINDOW without re-opening that bug.
        assert_eq!(COUNTERPART_GONE_MEDIA_WINDOW, Duration::from_secs(15));
    }

    #[test]
    fn counterpart_gone_false_inside_reregister_grace() {
        // 10s of silence after a signaling drop is still inside the
        // reclaim window — a reconnect in flight must not look like a
        // killed app.
        let now = Instant::now();
        let last_traffic = Some(now - Duration::from_secs(10));
        assert!(!counterpart_gone(
            true,
            true,
            last_traffic,
            now,
            COUNTERPART_GONE_MEDIA_WINDOW
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

    // ── Input DataChannel fallback (cellular srflx pair, 2026-08-29) ──────

    #[test]
    fn input_fallback_waits_out_the_grace() {
        let now = Instant::now();
        let since = Some(now - Duration::from_secs(2));
        assert!(!input_channel_fallback_due(
            false,
            false,
            Some("direct"),
            since,
            now,
            INPUT_CHANNEL_FALLBACK_GRACE
        ));
    }

    #[test]
    fn input_fallback_fires_on_a_direct_pair_after_grace() {
        let now = Instant::now();
        let since = Some(now - INPUT_CHANNEL_FALLBACK_GRACE - Duration::from_millis(1));
        assert!(input_channel_fallback_due(
            false,
            false,
            Some("direct"),
            since,
            now,
            INPUT_CHANNEL_FALLBACK_GRACE
        ));
    }

    #[test]
    fn input_fallback_does_not_touch_lan_or_already_relayed_sessions() {
        let now = Instant::now();
        let since = Some(now - INPUT_CHANNEL_FALLBACK_GRACE - Duration::from_secs(1));
        assert!(!input_channel_fallback_due(
            false,
            false,
            Some("lan"),
            since,
            now,
            INPUT_CHANNEL_FALLBACK_GRACE
        ));
        assert!(!input_channel_fallback_due(
            false,
            false,
            Some("relay"),
            since,
            now,
            INPUT_CHANNEL_FALLBACK_GRACE
        ));
    }

    #[test]
    fn input_fallback_does_not_fire_once_the_channel_is_open_or_already_forced() {
        let now = Instant::now();
        let since = Some(now - INPUT_CHANNEL_FALLBACK_GRACE - Duration::from_secs(1));
        assert!(!input_channel_fallback_due(
            true,
            false,
            Some("direct"),
            since,
            now,
            INPUT_CHANNEL_FALLBACK_GRACE
        ));
        assert!(!input_channel_fallback_due(
            false,
            true,
            Some("direct"),
            since,
            now,
            INPUT_CHANNEL_FALLBACK_GRACE
        ));
    }
}

#[cfg(test)]
mod display_tests {
    use super::{chosen_display, shared_display_name};
    use crate::media::Display;

    fn display(id: u32, name: &str) -> Display {
        Display {
            id,
            name: name.to_owned(),
            width: 1920,
            height: 1080,
        }
    }

    #[test]
    fn an_attached_display_is_the_one_captured() {
        let displays = vec![display(1, "Built-in Display"), display(2, "Display 2")];
        assert_eq!(chosen_display(&displays, 2), Some(2));
    }

    #[test]
    fn a_display_unplugged_since_the_phone_last_looked_falls_back_to_the_main_one() {
        // The phone's button list is a snapshot of the last `frame-size`. A
        // monitor pulled out in between must cost a switch, not the session.
        let displays = vec![display(1, "Built-in Display")];
        assert_eq!(chosen_display(&displays, 2), None);
    }

    #[test]
    fn a_one_screen_mac_says_nothing_about_which_screen() {
        let displays = vec![display(1, "Built-in Display")];
        assert_eq!(shared_display_name(&displays, Some(1)), None);
    }

    #[test]
    fn a_two_screen_mac_names_the_one_being_watched() {
        let displays = vec![display(1, "Built-in Display"), display(2, "Display 2")];
        assert_eq!(
            shared_display_name(&displays, Some(2)).as_deref(),
            Some("Display 2")
        );
    }

    #[test]
    fn nothing_is_named_while_the_active_display_is_mid_disappearance() {
        let displays = vec![display(1, "Built-in Display"), display(2, "Display 2")];
        assert_eq!(shared_display_name(&displays, Some(99)), None);
        assert_eq!(shared_display_name(&displays, None), None);
    }
}
