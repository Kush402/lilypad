//! Tauri commands invoked from the React UI.
//!
//! Windows are label-based: every window loads `index.html` and the frontend
//! renders bubble / qr-overlay / control / diagnostics based on its window
//! label.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;

use crate::account;
use crate::auth::{with_bearer, AuthError, DesktopAuth, LinkState};
use crate::lan;
use crate::session::{run_session, Control, SessionEvent};
use crate::state::{AppState, AppStateDto, PendingRequest, SessionStatus, SharedState};

/// Max time a new session waits for the previous runner to finish tearing
/// down (its `media.stop()` joins the ScreenCaptureKit capture thread)
/// before starting anyway — bounds a stuck old teardown so a takeover can't
/// hang indefinitely.
const SESSION_TEARDOWN_WAIT: Duration = Duration::from_secs(3);
/// How long `create_pairing` waits for the session runner to register in the
/// minted room before it will show a scannable QR. A code the Mac is not
/// seated in is a phone that waits forever on "Waiting for approval…" with no
/// Approve on this side — proven 2026-08-31 (three `201`s, no desktop seat).
const PAIRING_SEAT_WAIT: Duration = Duration::from_secs(8);

type SeatNotify = Arc<std::sync::Mutex<Option<oneshot::Sender<Result<(), String>>>>>;

fn take_seat_notify(cell: &Option<SeatNotify>) -> Option<oneshot::Sender<Result<(), String>>> {
    cell.as_ref()
        .and_then(|c| c.lock().unwrap_or_else(|p| p.into_inner()).take())
}

fn pairing_not_seated() -> &'static str {
    "This Mac couldn’t join the pairing room. Check this Mac’s internet connection and try again."
}

/// Lock the shared state, recovering from poisoning instead of panicking.
/// A panic while holding this lock must NOT brick every subsequent command
/// (including the tray Panic/Disconnect handlers) — the guarded data is still
/// structurally valid, so we take it back via `into_inner`.
fn lock_state(state: &SharedState) -> MutexGuard<'_, AppState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn current_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "linux"
    }
}

/// Shape of POST /pairing/create's JSON response from the backend.
#[derive(Debug, Deserialize)]
struct BackendPairingResponse {
    token: String,
    #[serde(rename = "roomId")]
    room_id: String,
    #[serde(rename = "apiBaseUrl")]
    api_base_url: String,
    #[serde(rename = "signalingUrl")]
    signaling_url: String,
    #[serde(rename = "expiresInSeconds")]
    expires_in_seconds: u32,
}

/// What the QR overlay encodes into the QR image.
#[derive(Debug, Clone, Serialize)]
pub struct QrPayloadDto {
    pub v: u8,
    pub token: String,
    #[serde(rename = "roomId")]
    pub room_id: String,
    #[serde(rename = "apiBaseUrl")]
    pub api_base_url: String,
    #[serde(rename = "signalingUrl")]
    pub signaling_url: String,
    #[serde(rename = "expiresInSeconds")]
    pub expires_in_seconds: u32,
    /// Shown at the phone's pairing-confirmation moment so there's an actual
    /// identity signal to check before it redeems a single-use token — see
    /// `docs/audit/m3/mobile-ux.md` Finding 9.
    #[serde(rename = "deviceName")]
    pub device_name: String,
    pub platform: String,
}

#[tauri::command]
pub fn get_state(state: State<'_, SharedState>) -> AppStateDto {
    let s = lock_state(&state);
    AppStateDto {
        device_id: s.device_id.clone(),
        backend_base_url: s.backend_base_url.clone(),
        session: s.session,
        current_room_id: s.current_room_id.clone(),
        pending_request: s.pending_request.clone(),
        plugin_health: crate::health::plugin_health(),
        connection_path: s.connection_path.clone(),
        presence: s.presence.clone(),
        shared_display: s.shared_display.clone(),
    }
}

/// What the pairing window says when the backend refuses a code.
///
/// `QrOverlay` renders this string as-is, so it is the product's words, not a
/// developer's. It used to be `backend returned HTTP 429`, rendered under a
/// second prefix as "Could not reach backend: backend returned HTTP 429" —
/// which named the wrong cause twice.
fn pairing_failure(status: u16) -> &'static str {
    match status {
        429 => "Too many codes requested just now. Wait a minute, then try again.",
        401 | 403 => {
            "Lilypad couldn’t confirm this computer with the server. Try again in a moment."
        }
        400 => "Lilypad’s server rejected this request. Please update the app.",
        _ => "Lilypad’s server couldn’t create a code right now. Try again in a moment.",
    }
}

/// Ask the backend for a fresh single-use pairing token and open the QR overlay.
#[tauri::command]
pub async fn create_pairing(
    app: AppHandle,
    state: State<'_, SharedState>,
    auth: State<'_, Arc<DesktopAuth>>,
    force: bool,
) -> Result<QrPayloadDto, String> {
    // **Minting a pairing ENDS whatever session is running.** A fresh runner
    // overwrites `AppState.control_tx`, and the live session reads its sender
    // being dropped as an explicit Disconnect. That is not a bug in this
    // function — regenerating a code is supposed to start over — but it means
    // every entry point has to know, and until now each one knew separately:
    // the bubble refuses mid-session, the dashboard's "+" is disabled, and the
    // QR window asks before REGENERATING. The Settings window's "Show pairing
    // code" knew none of it, so one click there killed a session that was
    // streaming, with no warning and nothing on screen to explain it.
    //
    // Reported from the running product on 2026-08-26.
    //
    // The rule belongs here, where all of them meet, rather than in a fourth
    // copy. `force` is how the ONE deliberate path — the QR window's "yes, end
    // it and give me a new code" confirm — still gets through.
    //
    // `Pairing` is not in the list: a code on screen that nobody has scanned is
    // exactly what "New code" is for, and refusing it would break the button
    // this guard is meant to leave working.
    if !force {
        let live = lock_state(&state).session;
        if matches!(
            live,
            SessionStatus::AwaitingApproval | SessionStatus::Connecting | SessionStatus::Active
        ) {
            log::info!(
                target: "lilypad::audit",
                "pairing refused — a session is {live:?} and pairing would end it",
            );
            // The dashboard is where Disconnect lives, so send them to the
            // thing they need rather than only saying no.
            let _ = show_control(&app);
            return Err("session_active".to_owned());
        }
    }

    // Never let a user pair into a session that will silently fail: a
    // session with either permission missing would show a QR, connect the
    // phone, then never stream/inject anything with no explanation. See
    // `docs/audit/m3/desktop-ux.md` Finding 1's implementation plan point 5.
    // The frontend catches this specific error and opens Setup instead of
    // just logging it (`Bubble.tsx`).
    let permissions = permission_snapshot();
    if !permissions.screen_capture || !permissions.accessibility {
        let _ = show_setup(&app);
        return Err("permissions_required".to_owned());
    }

    // A computer nobody owns may not hand itself to a phone.
    //
    // Pairing writes a TRUST relationship — which phone may reach this Mac —
    // and on an unlinked machine that relationship belongs to no account: it
    // cannot appear in anyone's "Your devices", and nobody can revoke it.
    // [ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md) rejected
    // exactly that state ("without an owner there is nothing to authorize
    // against, no revocation story across devices"), and `docs/api.md` records
    // the backend's unowned lane as a migration allowance that goes away "when
    // P1 makes enrolment mandatory". This is the client half of that.
    //
    // `Unknown` deliberately passes. It means the backend could not be asked,
    // not that nobody owns this machine, and refusing on it would block a
    // linked user whose wifi blipped — the same mistake `LinkState` exists to
    // prevent. The pairing call that follows needs the backend anyway, so an
    // unreachable one fails honestly a moment later.
    match auth.link_state().await {
        LinkState::Linked { .. } | LinkState::Unknown(_) => {}
        LinkState::Unlinked | LinkState::Revoked | LinkState::NoIdentity => {
            let _ = show_control(&app);
            return Err("link_required".to_owned());
        }
    }

    // Snapshot what we need, then drop the lock before awaiting.
    let (device_id, base_url, offered_scopes) = {
        let s = lock_state(&state);
        (
            s.device_id.clone(),
            s.backend_base_url.clone(),
            s.offered_scopes.clone(),
        )
    };

    let device_name = crate::identity::device_name();
    let url = format!("{}/pairing/create", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "deviceId": device_id,
        "deviceName": device_name,
        "platform": current_platform(),
    });

    let resp = with_bearer(
        reqwest::Client::new().post(&url).json(&body),
        auth.bearer().await,
    )
    .send()
    .await
    .map_err(|e| {
        // The URL and the transport error go to the log. `QrOverlay` renders
        // whatever comes back here verbatim, so this string is what someone
        // trying to pair their phone actually reads.
        log::warn!(target: "lilypad::pairing", "could not reach {url}: {e}");
        "Couldn’t reach Lilypad’s server. Check this Mac’s internet connection.".to_owned()
    })?;

    if !resp.status().is_success() {
        log::warn!(
            target: "lilypad::pairing",
            "pairing code refused (HTTP {})",
            resp.status(),
        );
        return Err(pairing_failure(resp.status().as_u16()).to_owned());
    }

    let parsed: BackendPairingResponse = resp.json().await.map_err(|e| {
        log::warn!(target: "lilypad::pairing", "unreadable pairing response: {e}");
        "Lilypad’s server sent something this app could not read. Please update the app.".to_owned()
    })?;

    let payload = QrPayloadDto {
        v: 2,
        token: parsed.token,
        room_id: parsed.room_id.clone(),
        api_base_url: parsed.api_base_url,
        signaling_url: parsed.signaling_url.clone(),
        expires_in_seconds: parsed.expires_in_seconds,
        device_name,
        platform: current_platform().to_owned(),
    };

    // Start the real signaling session: connect, register as desktop, and listen
    // for a phone to redeem + request control. This replaces the M1 mock.
    // Never auto-approved: a QR pairing IS the human decision, and the phone
    // that scans it has not been trusted yet.
    //
    // Do not hand the UI a scannable code until this Mac is seated in the
    // room. HTTP 201 only minted the record — the phone can redeem against
    // that alone, then sit on "Waiting for approval…" while the overlay
    // still says "Scan to pair" and tray Approve stays disabled (session
    // never leaves Pairing). Three observed 0.1.27 pairing attempts did
    // exactly that.
    let pairing_room_id = parsed.room_id.clone();
    let (seated_tx, seated_rx) = oneshot::channel();
    spawn_session_runner_inner(
        &app,
        parsed.room_id,
        parsed.signaling_url,
        device_id,
        offered_scopes,
        false,
        Some(seated_tx),
    );
    match tokio::time::timeout(PAIRING_SEAT_WAIT, seated_rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(_))) | Ok(Err(_)) | Err(_) => {
            abort_unseated_pairing(&app, &pairing_room_id);
            return Err(pairing_not_seated().to_owned());
        }
    }
    log::info!(target: "lilypad::audit", "pairing_created — desktop seated, awaiting scan");

    open_window(&app, "qr-overlay", "Pair a phone", QR_WINDOW)?;
    crate::sync_tray_menu(&app);
    Ok(payload)
}

/// Spawn the async session runner + a task that forwards its events to the UI
/// (updating coarse session state and emitting `lilypad://session`).
/// `pub(crate)`: also the presence channel's entry point for accepted
/// connect-requests (M5.4) — a rung session and a QR session run identically.
///
/// `auto_approve` is set here, together with `current_room_id`, rather than by
/// the caller — see `claim_room`.
pub(crate) fn spawn_session_runner(
    app: &AppHandle,
    room_id: String,
    signaling_url: String,
    device_id: String,
    offered_scopes: Vec<String>,
    auto_approve: bool,
) {
    spawn_session_runner_inner(
        app,
        room_id,
        signaling_url,
        device_id,
        offered_scopes,
        auto_approve,
        None,
    );
}

fn spawn_session_runner_inner(
    app: &AppHandle,
    room_id: String,
    signaling_url: String,
    device_id: String,
    offered_scopes: Vec<String>,
    auto_approve: bool,
    on_seated: Option<oneshot::Sender<Result<(), String>>>,
) {
    let (control_tx, control_rx) = unbounded_channel::<Control>();
    let (event_tx, event_rx) = unbounded_channel::<SessionEvent>();
    let seated: Option<SeatNotify> = on_seated.map(|tx| Arc::new(std::sync::Mutex::new(Some(tx))));
    let app_ev = app.clone();
    let runner_room = room_id.clone();
    let seated_ev = seated.clone();

    // Drive the session.
    let advertisement = app
        .try_state::<Arc<lan::LanAdvertisement>>()
        .map(|ad| ad.inner().clone());
    let lan_ad = advertisement.as_ref().and_then(|ad| ad.snapshot());
    // A room minted by THIS desktop's embedded LAN server is joined in-process.
    // Opening a socket to it would mean verifying our own self-signed
    // certificate against webpki roots, which fails — see `lan::loopback`.
    let lan_loopback = app
        .try_state::<Arc<lan::LanHub>>()
        .filter(|_| lan::loopback::is_own_lan_room(advertisement.as_deref(), &signaling_url))
        .map(|hub| hub.inner().clone());
    if lan_loopback.is_some() {
        log::info!(
            target: "lilypad::lan",
            "joining room {room_id} on the embedded LAN hub in-process"
        );
    }
    let seated_run = seated.clone();
    let state = app.state::<SharedState>();
    let claimed_room = room_id.clone();
    install_session_runner(
        &state,
        &claimed_room,
        auto_approve,
        offered_scopes,
        control_tx,
        |old_task| {
            // Only a successful claim may start a forwarder. Otherwise a rejected
            // same-room ring's closed stream could end the runner already there.
            tauri::async_runtime::spawn(forward_session_events(event_rx, move |ev| {
                // Ownership and state mutation share a lock, so a takeover cannot
                // land between the check and applying an old runner's Ended.
                if !apply_session_event(&app_ev, &runner_room, &ev) {
                    log::debug!(
                        target: "lilypad::session",
                        "dropping event from superseded runner (room {runner_room})"
                    );
                    return;
                }
                if matches!(ev, SessionEvent::Registered) {
                    if let Some(tx) = take_seat_notify(&seated_ev) {
                        let _ = tx.send(Ok(()));
                    }
                }
                if matches!(ev, SessionEvent::Ended { .. }) {
                    if let Some(tx) = take_seat_notify(&seated_ev) {
                        let _ = tx.send(Err(
                            "session ended before this Mac joined the pairing room".to_owned(),
                        ));
                    }
                }
                let _ = app_ev.emit("lilypad://session", ev);
            }));
            tauri::async_runtime::spawn(async move {
                // Wait for the PREVIOUS session to fully tear down (its media.stop()
                // joins the capture thread) before this one starts, so screen capture
                // is never double-opened during a trusted takeover. Bounded so a stuck
                // old teardown can't hang the takeover — after the timeout we proceed
                // and accept the pre-existing brief-overlap behavior as the fallback.
                if let Some(old) = old_task {
                    let _ = tokio::time::timeout(SESSION_TEARDOWN_WAIT, old).await;
                }
                if let Err(e) = run_session(
                    signaling_url,
                    room_id,
                    device_id,
                    lan_ad,
                    lan_loopback,
                    control_rx,
                    event_tx,
                )
                .await
                {
                    log::error!(target: "lilypad::session", "session runner error: {e}");
                    if let Some(tx) = take_seat_notify(&seated_run) {
                        let _ = tx.send(Err(e.to_string()));
                    }
                }
            })
        },
    );
}

/// A runner can return before emitting anything if its first signaling connect
/// fails. Closing its stream must release that room too. The consumer applies
/// the same ownership check to this fallback as to ordinary runner events.
async fn forward_session_events(
    mut events: UnboundedReceiver<SessionEvent>,
    mut forward: impl FnMut(SessionEvent),
) {
    let mut ended = false;
    while let Some(event) = events.recv().await {
        ended |= matches!(event, SessionEvent::Ended { .. });
        forward(event);
    }
    if !ended {
        forward(SessionEvent::Ended {
            reason: "session runner stopped".to_owned(),
        });
    }
}

/// Publish the room, consent, control sender and task as one transaction.
/// Presence dispatches may run on different runtime workers. Checking for a
/// same-room ring or taking the previous sender before this lock can disconnect
/// the very runner another dispatch has just installed.
fn install_session_runner(
    state: &SharedState,
    room_id: &str,
    auto_approve: bool,
    offered_scopes: Vec<String>,
    control_tx: UnboundedSender<Control>,
    spawn: impl FnOnce(
        Option<tauri::async_runtime::JoinHandle<()>>,
    ) -> tauri::async_runtime::JoinHandle<()>,
) -> bool {
    let mut s = lock_state(state);
    if s.current_room_id.as_deref() == Some(room_id) {
        log::info!(
            target: "lilypad::session",
            "room {room_id} is already seated — ignoring duplicate ring"
        );
        return false;
    }
    if let Some(old_tx) = s.control_tx.replace(control_tx) {
        log::info!(
            target: "lilypad::audit",
            "superseding existing session — new room {room_id}"
        );
        let _ = old_tx.send(Control::Disconnect);
    }
    claim_room(&mut s, room_id, auto_approve);
    s.offered_scopes = offered_scopes;
    s.session = SessionStatus::Pairing;
    s.pending_request = None;
    s.shared_display = None;
    let old_task = s.session_task.take();
    // Spawning does not await or re-enter AppState. Keep the lock until the
    // handle is stored so a second claim cannot publish this task under its room.
    s.session_task = Some(spawn(old_task));
    true
}

/// Take ownership of `room_id` as the session this desktop is now running.
///
/// The two fields move together, under one lock, and that is the whole point.
/// `auto_approve_room` used to be set by `presence::on_connect_request` BEFORE
/// it disconnected the previous runner, while `current_room_id` was only
/// advanced here — so in the window between them the old room still matched, the
/// superseded runner's `Ended` was accepted by `apply_session_event` (the
/// forwarder's guard compares against `current_room_id`, which had not moved
/// yet) and cleared `auto_approve_room` along with everything else. The
/// reconnect that was meant to be silent then demanded a manual tap, which the
/// user experiences as the laptop ringing for a phone it already trusts. Kanban
/// L-186.
///
/// Claimed together, the guard covers both: an event from the old runner either
/// arrives while `current_room_id` is still the old room — before this claim, so
/// there is no new `auto_approve_room` to lose — or after it, where the
/// forwarder drops it as superseded.
fn claim_room(s: &mut AppState, room_id: &str, auto_approve: bool) {
    s.current_room_id = Some(room_id.to_owned());
    // Keyed by room, and cleared when this session is not an auto-approving
    // one, so a QR pairing can never inherit a trusted ring's consent.
    s.auto_approve_room = auto_approve.then(|| room_id.to_owned());
}

/// Apply the capability-bearing input channel's availability to the UI state.
/// Kept separate from the Tauri event adapter so the fail-closed status change
/// has direct regression coverage without constructing an application window.
fn apply_input_channel_event(state: &mut AppState, open: bool) {
    state.session = if open {
        SessionStatus::Active
    } else {
        state.shared_display = None;
        SessionStatus::Connecting
    };
}

/// Map a runner event onto the coarse `SessionStatus` the polling UI reads.
fn apply_session_event(app: &AppHandle, runner_room: &str, ev: &SessionEvent) -> bool {
    let state = app.state::<SharedState>();
    let mut s = lock_state(&state);
    let Some(ring) = apply_session_event_to_state(&mut s, runner_room, ev) else {
        return false;
    };
    drop(s);
    if ring {
        let _ = show_control(app);
    }
    crate::sync_tray_menu(app);
    true
}

/// `None` rejects a superseded event; `Some` carries whether to show the ring.
/// Ownership and mutation share this borrow, so a takeover cannot split them.
fn apply_session_event_to_state(
    s: &mut AppState,
    runner_room: &str,
    ev: &SessionEvent,
) -> Option<bool> {
    if s.current_room_id.as_deref() != Some(runner_room) {
        return None;
    }
    match ev {
        SessionEvent::PairRequested {
            device_name,
            requested_scopes,
        } => {
            // M5.4 "Always allow": a trusted pair rang this exact room with
            // auto-approve — skip the ring and fire the approval through the
            // normal control path (the runner's idempotence and audit logging
            // apply unchanged). Trust is NOT re-asserted on an auto-approval.
            let auto = s.auto_approve_room.is_some()
                && s.auto_approve_room.as_deref() == s.current_room_id.as_deref();
            if auto {
                if let Some(tx) = s.control_tx.clone() {
                    let scopes = s.offered_scopes.clone();
                    log::info!(
                        target: "lilypad::audit",
                        "session auto-approved — trusted device (Always allow), scopes={scopes:?}"
                    );
                    let _ = tx.send(Control::Approve {
                        scopes,
                        trust: false,
                    });
                }
                s.pending_request = None;
            } else {
                s.session = SessionStatus::AwaitingApproval;
                // Previously discarded via a `{ .. }` wildcard — this is the
                // exact information the approve/deny UI needs to show WHO is
                // asking and for WHAT. See `docs/audit/m3/desktop-ux.md` Finding 2.
                s.pending_request = Some(PendingRequest::new(
                    device_name.clone(),
                    requested_scopes.clone(),
                ));
            }
        }
        SessionEvent::SessionStarting { .. } => {
            // Approval already happened (this fires after Approve triggers a
            // fresh offer) — nothing is "pending" anymore. WebRTC negotiation
            // is starting but hasn't reached `connected` yet, so the UI moves
            // to Connecting rather than sitting on the (now stale) approve
            // card — auto-approved trusted sessions also emit this and get
            // the same honest "Connecting…" feedback.
            s.pending_request = None;
            s.session = SessionStatus::Connecting;
        }
        // ICE state alone does not mean a phone can control the Mac: the
        // input DataChannel may still be opening, may have failed on this
        // route, or may already have closed. `InputChannelOpen` below is the
        // capability-bearing boundary that earns Active. Likewise, transient
        // ICE states are recoverable and only `Ended` tears the session down.
        SessionEvent::ConnectionState { .. } => {}
        // A closed control channel is direct local proof that no phone can
        // currently operate this Mac. The runner keeps the room briefly for a
        // same-device trusted rejoin, so this is Connecting rather than Idle;
        // calling it Active during that grace is both misleading and contrary
        // to the capability suspension enforced by the runner.
        SessionEvent::InputChannelClosed => {
            apply_input_channel_event(s, false);
        }
        // A successful rejoin may deliver this after the peer's connected
        // event. Restore Active only now, once control is actually available.
        SessionEvent::InputChannelOpen => {
            apply_input_channel_event(s, true);
        }
        // Recorded rather than acted on. Nothing branches on the path — the
        // product works the same over all three — but "was that relayed?" is
        // the first question of any connectivity report, and until this landed
        // the only place the answer existed was a stderr line that a
        // Finder-launched .app has nowhere to write.
        SessionEvent::ConnectionPath { path } => {
            log::info!(target: "lilypad::session", "connection path: {path}");
            s.connection_path = Some(path.clone());
        }
        SessionEvent::SharedDisplay { name } => {
            log::info!(target: "lilypad::session", "sharing display: {name}");
            s.shared_display = Some(name.clone());
        }
        SessionEvent::Ended { .. } => {
            s.session = SessionStatus::Idle;
            s.shared_display = None;
            s.control_tx = None;
            s.current_room_id = None;
            s.pending_request = None;
            s.auto_approve_room = None;
        }
        _ => {}
    }
    // Ring only when a human decision is actually pending (auto-approved
    // rings never show the window).
    Some(matches!(ev, SessionEvent::PairRequested { .. }) && s.pending_request.is_some())
}

/// DEV-ONLY (M1): stand in for a phone redeeming the token over signaling.
/// Moves the session to AwaitingApproval and opens the control window so the
/// Approve/Deny UI is drivable without a real device. Removed once M2 lands.
///
/// Refuses outright in release builds — this used to be reachable from any
/// JS able to call `invoke()` in ANY window with no gate at all, letting
/// something other than a real phone fabricate a pairing request. See
/// `docs/audit/m3/desktop-ux.md` Finding 7. The frontend button that calls
/// this is separately compiled out of release bundles
/// (`import.meta.env.DEV` in `QrOverlay.tsx`) — this is the defense-in-depth
/// backstop for anything that might still try to invoke the command directly.
#[tauri::command]
pub fn simulate_pair_request(app: AppHandle, state: State<'_, SharedState>) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        let _ = (&app, &state);
        return Err("simulate_pair_request is only available in debug builds".to_owned());
    }
    #[cfg(debug_assertions)]
    {
        {
            let mut s = lock_state(&state);
            if s.session == SessionStatus::Pairing {
                s.session = SessionStatus::AwaitingApproval;
                s.pending_request = Some(PendingRequest::new(
                    Some("Simulated iPhone".to_owned()),
                    vec!["view".to_owned(), "control".to_owned()],
                ));
            }
        }
        log::info!(target: "lilypad::audit", "pair_request — phone requested control");
        open_window(&app, "control", "Lilypad", CONTROL_WINDOW)?;
        crate::sync_tray_menu(&app);
        Ok(())
    }
}

/// Open (or focus) the QR overlay WITHOUT minting a pairing. The overlay's
/// own mount effect is the single place `create_pairing` is called from —
/// previously the bubble ALSO called it on an idle click, so every click
/// minted two rooms (three under dev StrictMode): the bubble's room was
/// orphaned instantly when the overlay's runner overwrote `control_tx`, and
/// an unlucky interleave could leave the displayed QR pointing at the dead
/// room. One creator, no race.
#[tauri::command]
pub fn show_qr_window(app: AppHandle) -> Result<(), String> {
    open_window(&app, "qr-overlay", "Pair a phone", QR_WINDOW)
}

#[tauri::command]
pub fn approve_session(
    app: AppHandle,
    state: State<'_, SharedState>,
    trust: Option<bool>,
) -> Result<(), String> {
    let (tx, scopes) = {
        let s = lock_state(&state);
        (s.control_tx.clone(), s.offered_scopes.clone())
    };
    // The audit `session_start` line is NOT written here: this command fires
    // on every Approve tap, including duplicates the runner ignores (its
    // idempotent-approval guard). The runner writes the audit event in the
    // one branch where the approval is actually honored — an audit trail
    // must record sessions that started, not buttons that were pressed.
    let result = match tx {
        Some(tx) => tx
            .send(Control::Approve {
                scopes,
                trust: trust.unwrap_or(false),
            })
            .map_err(|e| e.to_string()),
        // No active runner (offline dev) — reflect Active locally.
        None => {
            lock_state(&state).session = SessionStatus::Active;
            Ok(())
        }
    };
    crate::sync_tray_menu(&app);
    close_window(&app, "qr-overlay");
    result
}

#[tauri::command]
pub fn deny_session(app: AppHandle, state: State<'_, SharedState>) -> Result<(), String> {
    send_control_or_reset(&state, Control::Deny);
    log::info!(target: "lilypad::audit", "pair_denied — denied by user");
    close_window(&app, "qr-overlay");
    crate::sync_tray_menu(&app);
    Ok(())
}

#[tauri::command]
pub fn disconnect(app: AppHandle, state: State<'_, SharedState>) -> Result<(), String> {
    send_control_or_reset(&state, Control::Disconnect);
    log::info!(target: "lilypad::audit", "session_end — disconnected");
    crate::sync_tray_menu(&app);
    Ok(())
}

/// Panic button: kill the session immediately and close pairing/session windows.
#[tauri::command]
pub fn panic_disconnect(app: AppHandle, state: State<'_, SharedState>) -> Result<(), String> {
    send_control_or_reset(&state, Control::Disconnect);
    log::warn!(target: "lilypad::audit", "panic_disconnect — user hit panic");
    close_window(&app, "qr-overlay");
    close_window(&app, "control");
    crate::sync_tray_menu(&app);
    Ok(())
}

// ── first-run permission Setup (docs/audit/m3/desktop-ux.md Finding 1) ───────

/// Both permissions' current status in the shape the Setup window needs —
/// `NotApplicable` (e.g. Windows, which doesn't gate Accessibility) counts as
/// satisfied, matching `PermissionStatus`'s own "nothing to grant" meaning.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct PermissionStatusDto {
    pub screen_capture: bool,
    pub accessibility: bool,
}

fn permission_snapshot() -> PermissionStatusDto {
    use crate::permission::{accessibility_status, screen_capture_status, PermissionStatus};
    let satisfied = |s: PermissionStatus| {
        matches!(
            s,
            PermissionStatus::Granted | PermissionStatus::NotApplicable
        )
    };
    PermissionStatusDto {
        screen_capture: satisfied(screen_capture_status()),
        accessibility: satisfied(accessibility_status()),
    }
}

#[tauri::command]
pub fn get_permission_status() -> PermissionStatusDto {
    permission_snapshot()
}

/// Open (or focus) the Setup window from the dashboard — the editor surface
/// for permissions + the AI provider. The dashboard shows these read-only;
/// this is its "Fix" / "Configure" affordance.
#[tauri::command]
pub fn show_setup_window(app: AppHandle) -> Result<(), String> {
    show_setup(&app)
}

/// The prompting variant — triggers the native OS dialog if the user hasn't
/// decided yet. Returns the freshly-queried status right after.
#[tauri::command]
pub fn request_permission(kind: crate::permission::PermissionKind) -> bool {
    use crate::permission::PermissionStatus;
    matches!(
        crate::permission::request(kind),
        PermissionStatus::Granted | PermissionStatus::NotApplicable
    )
}

/// Deep-link straight to the relevant Settings row.
#[tauri::command]
pub fn open_permission_settings(
    app: AppHandle,
    kind: crate::permission::PermissionKind,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    // `Shell::open` is deprecated in favor of a dedicated `tauri-plugin-opener`
    // crate as of this `tauri-plugin-shell` version. Not migrating in this
    // pass: that's a whole new plugin (its own Cargo.toml entry, capabilities
    // registration, and `lib.rs` init) for what's a single "open one URL"
    // call, when `tauri-plugin-shell` is already a dependency here for
    // exactly this. Tracked as a follow-up if/when `.open()` is fully removed
    // rather than just deprecated.
    #[allow(deprecated)]
    app.shell()
        .open(kind.settings_url(), None)
        .map_err(|e| e.to_string())
}

/// Re-exec the current binary then exit — the only way some TCC grants
/// (notably Accessibility, on non-notarized dev builds) take effect for a
/// process already running. Manual respawn rather than a new
/// `tauri-plugin-process` dependency: this is a three-line operation, not
/// worth a whole plugin's integration surface.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).spawn();
    }
    app.exit(0);
}

/// Whether a setup-permission poll is already running. See `show_setup`.
static SETUP_POLL: AtomicBool = AtomicBool::new(false);

/// Open the Setup/Settings window and, if one isn't already running, start a
/// background poll broadcasting fresh permission status over
/// `lilypad://permission` every ~700ms (matching the passive-check cache
/// TTL) — an actual Tauri event stream, not another frontend poll loop
/// (Finding 8's fix applies here too).
///
/// The poll stops when the window closes, and **only** then. It used to also
/// stop the moment both permissions read granted, which made the window blind
/// to the reverse transition: a user who revokes Screen Recording in System
/// Settings while setup is open kept seeing "Granted" forever, because the one
/// thing that could have corrected the screen had already exited. Permission
/// state is not monotonic, so nothing watching it may assume it is. The cost
/// of being right is one cached TCC round-trip per 700ms for as long as a
/// window the user is actively looking at stays open.
pub fn show_setup(app: &AppHandle) -> Result<(), String> {
    // A claim, not a guess. The poll used to start whenever the window was not
    // already open, which was the same question while "closed" was the only way
    // for it to leave the screen. One-window-at-a-time HIDES instead
    // (`hide_other_primaries`), so a setup window can exist unseen for the rest
    // of the run — and re-showing it must start a poll again, without a second
    // poll surviving alongside the first. Whoever wins the flag owns the loop
    // and clears it on the way out.
    let claimed = SETUP_POLL
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    open_window(app, "setup", "Set up Lilypad", SETUP_WINDOW)?;
    if claimed {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(700));
            loop {
                interval.tick().await;
                // GONE ends the loop; merely HIDDEN only pauses it. The two
                // used to be the same exit, which lost a poll for good on a
                // window reopened inside one tick of being closed: the loop was
                // on its way out, so the reopen's `compare_exchange` found the
                // flag still taken and started nothing. Sleeping instead means
                // the window can come and go — hidden by one-window-at-a-time,
                // shown again from the tray — and the same loop serves whatever
                // is currently under the label.
                let Some(window) = app.get_webview_window("setup") else {
                    SETUP_POLL.store(false, Ordering::SeqCst);
                    break;
                };
                if !window.is_visible().unwrap_or(false) {
                    continue; // no TCC round trip for a window nobody can see
                }
                let _ = app.emit("lilypad://permission", permission_snapshot());
            }
        });
    }
    Ok(())
}

// ── window helpers (also called from the tray menu in lib.rs) ────────────────

pub fn show_diagnostics(app: &AppHandle) -> Result<(), String> {
    open_window(app, "diagnostics", "Diagnostics", DIAGNOSTICS_WINDOW)
}

pub fn show_qr_overlay(app: &AppHandle) -> Result<(), String> {
    open_window(app, "qr-overlay", "Pair a phone", QR_WINDOW)
}

pub fn show_control(app: &AppHandle) -> Result<(), String> {
    open_window(app, "control", "Lilypad", CONTROL_WINDOW)
}

/// Open (create-if-absent, else focus) the dashboard. Unlike the ring path in
/// `apply_session_event` (which only opens Control for a pending HUMAN
/// decision), this is the unconditionally-reachable entry point — the fix for
/// a real bug: a trusted phone's silent auto-reconnect never rings, so
/// without this there was no way to open the dashboard at all once the
/// window hadn't already been created this run (tray's Show-QR/Approve/Deny
/// are correctly disabled mid-session; the bubble's old `focusWindow` helper
/// only focused an ALREADY-OPEN window, never created one).
#[tauri::command]
pub fn show_control_window(app: AppHandle) -> Result<(), String> {
    show_control(&app)
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Prefer routing lifecycle commands to the active runner (which tears the
/// WebRTC session down + emits Ended); fall back to a local reset if none.
fn send_control_or_reset(state: &State<'_, SharedState>, control: Control) {
    let tx = { lock_state(state).control_tx.clone() };
    match tx {
        Some(tx) => {
            let _ = tx.send(control);
        }
        None => reset_to_idle(state),
    }
}

fn reset_to_idle(state: &State<'_, SharedState>) {
    let mut s = lock_state(state);
    s.session = SessionStatus::Idle;
    s.current_room_id = None;
    s.control_tx = None;
    s.pending_request = None;
}

/// Pairing minted a room but this Mac never sat in it. Kill that room's runner
/// so a later retry is not fighting a hung connect, and put the UI back at
/// Idle so tray Approve does not look live for a room nobody is in.
///
/// The room check is essential: a trusted presence ring can supersede this
/// pairing while `create_pairing` is awaiting its seat notification. Its
/// timeout must never abort the newer runner now stored in `session_task`.
fn abort_unseated_pairing(app: &AppHandle, expected_room_id: &str) {
    let state = app.state::<SharedState>();
    let mut s = lock_state(&state);
    clear_unseated_pairing_if_current(&mut s, expected_room_id);
}

fn clear_unseated_pairing_if_current(s: &mut AppState, expected_room_id: &str) -> bool {
    if s.current_room_id.as_deref() != Some(expected_room_id) {
        log::debug!(
            target: "lilypad::session",
            "not aborting superseded pairing room {expected_room_id}"
        );
        return false;
    }
    if let Some(handle) = s.session_task.take() {
        handle.abort();
    }
    s.session = SessionStatus::Idle;
    s.current_room_id = None;
    s.control_tx = None;
    s.pending_request = None;
    s.auto_approve_room = None;
    true
}

/// Every window this app opens is one of a fixed set of labels, each getting
/// the SAME close-request handling policy — see `handle_window_close` for
/// what happens per label/session-phase combination. Previously no
/// `on_window_event` was registered anywhere (`docs/audit/m3/desktop-ux.md`
/// Finding 5), so the native traffic-light close button left an abandoned
/// pairing attempt running for up to two minutes (`qr-overlay`) or, far
/// worse, left the runner in `AwaitingApproval` forever with no timeout and
/// no visible way back in (`control`).
/// Setup is the longest flow in the app and the only one the user leaves for
/// System Settings and comes back to, so it is the one window that must not
/// float and must be growable.
const SETUP_WINDOW: WindowSpec = WindowSpec {
    w: 560.0,
    h: 720.0,
    min_w: 420.0,
    min_h: 480.0,
    on_top: false,
};
/// Photographed with a phone; staying above other windows is the point.
const QR_WINDOW: WindowSpec = WindowSpec {
    w: 380.0,
    h: 520.0,
    min_w: 320.0,
    min_h: 420.0,
    on_top: true,
};
/// Reached for mid-session, when something else is deliberately in front.
const CONTROL_WINDOW: WindowSpec = WindowSpec {
    w: 420.0,
    h: 600.0,
    min_w: 360.0,
    min_h: 440.0,
    on_top: true,
};
/// A read-only list nobody acts on in a hurry.
const DIAGNOSTICS_WINDOW: WindowSpec = WindowSpec {
    w: 460.0,
    h: 520.0,
    min_w: 380.0,
    min_h: 360.0,
    on_top: false,
};

/// Size and behaviour of one window.
///
/// Every window used to be built `resizable(false)` and `always_on_top(true)`.
/// Both were wrong, and in different ways:
///
/// - **Not resizable** meant the Setup window's 460x440 was a hard ceiling on
///   a flow that has an account form, two permission cards, a link step, a
///   pair step and an optional Ask card in it. There was no size at which the
///   user could see the thing they were being asked to complete, and no way to
///   ask for one.
/// - **Always on top** is right for a QR you are photographing and for session
///   controls you need during a session. It is actively harmful for Setup:
///   granting a macOS permission means going to System Settings, and Setup
///   floated over System Settings while the user tried to do it.
struct WindowSpec {
    w: f64,
    h: f64,
    /// Floor, not a second guess at the ideal size — small enough to be a
    /// usable choice on an 11" display, large enough that nothing clips.
    min_w: f64,
    min_h: f64,
    on_top: bool,
}

fn open_window(app: &AppHandle, label: &str, title: &str, spec: WindowSpec) -> Result<(), String> {
    hide_other_primaries(app, label);
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(spec.w, spec.h)
        .min_inner_size(spec.min_w, spec.min_h)
        .resizable(true)
        .always_on_top(spec.on_top)
        .build()
        .map_err(|e| e.to_string())?;

    let app_for_close = app.clone();
    let label_owned = label.to_owned();
    win.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. }) {
            handle_window_close(&app_for_close, &label_owned);
        }
    });
    Ok(())
}

/// Close-request policy, keyed on (window label, current session phase):
///
/// - `qr-overlay` closed while still `Pairing` (nobody has scanned/approved
///   yet): treat it the same as an explicit Disconnect — cancel the abandoned
///   attempt now rather than let the runner + its signaling socket + heartbeat
///   task linger for up to the full 120s pairing timeout with no UI in sight.
/// - `control` closed while `AwaitingApproval`: auto-deny. Leaving this case
///   unhandled is the worse of the two bugs Finding 5 describes — a
///   `pair-request` disarms the pairing-expiry timeout entirely, so with no
///   window offering Approve/Deny and no timeout, the runner would otherwise
///   wait forever. Auto-deny is the safe default (an unanswered request
///   should not silently become perpetual limbo), matching how dismissing a
///   native permission dialog without a choice defaults to the safe outcome.
/// - Every other (label, phase) pair (`control` closed while `Active`, either
///   window closed while `Idle`) is intentionally a no-op here: an active
///   session must keep running with the window closed (Finding 4's bubble
///   fix is what restores reachability, not this handler), and there is
///   nothing to cancel outside an active pairing/approval flow.
fn handle_window_close(app: &AppHandle, label: &str) {
    let state = app.state::<SharedState>();
    let status = { lock_state(&state).session };
    match (label, status) {
        ("qr-overlay", SessionStatus::Pairing) => {
            log::info!(target: "lilypad::audit", "qr_overlay_closed_during_pairing — cancelling");
            send_control_or_reset(&state, Control::Disconnect);
        }
        ("control", SessionStatus::AwaitingApproval) => {
            log::info!(target: "lilypad::audit", "control_closed_during_awaiting_approval — auto-denying");
            send_control_or_reset(&state, Control::Deny);
            close_window(app, "qr-overlay");
        }
        _ => {}
    }
    crate::sync_tray_menu(app);
}

fn close_window(app: &AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.close();
    }
}

/// The three full-page surfaces. Exactly one of them is ever on screen.
///
/// Not an aesthetic rule. Each of these is "everything about this Mac" told a
/// different way, and two of them open at once is two answers to the same
/// question — a dashboard saying "Screen Recording: Needed" behind a Settings
/// window where it has just been granted. They also all carry the account card,
/// so signing out in one leaves the other two showing a signed-in account until
/// something happens to refresh them.
///
/// `bubble` and `qr-overlay` are deliberately NOT in this set. The bubble is
/// the always-on widget the whole design hangs off, and the QR overlay is a
/// companion to whatever opened it — being photographed by a phone while the
/// dashboard explains what to do with it is the flow working, not two windows
/// competing.
const PRIMARY_WINDOWS: [&str; 3] = ["control", "setup", "diagnostics"];

/// HIDE, never close.
///
/// `close()` fires `CloseRequested`, and `handle_window_close` reads that as a
/// decision: closing `control` during `AwaitingApproval` auto-DENIES the phone
/// asking to connect. Switching windows must not deny a session, cancel a
/// pairing, or answer any question on the user's behalf — so the window stays
/// alive with its state intact and simply stops being on screen.
fn hide_other_primaries(app: &AppHandle, keep: &str) {
    if !PRIMARY_WINDOWS.contains(&keep) {
        return;
    }
    let session = lock_state(&app.state::<SharedState>()).session;
    for label in windows_to_hide(keep, session) {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.hide();
        }
    }
}

/// Which of the primary windows step aside for `keep`.
///
/// Split out from the window handling because it is the whole decision and the
/// rest is plumbing — this is the part that can be wrong, and the part a test
/// can reach.
///
/// **The dashboard is exempt while it is busy.** `awaiting_approval` puts a
/// live Approve/Deny in it — a request that expires, from a phone with someone
/// waiting on the other end — and `connecting`/`active` put Disconnect and
/// Panic in it. Hiding any of those because somebody opened Settings would take
/// the decision, or the stop button, off the screen without touching the state
/// behind it. A window that vanishes is a kind of answer, and nothing in this
/// app may answer on the user's behalf.
fn windows_to_hide(keep: &str, session: SessionStatus) -> Vec<&'static str> {
    let control_is_busy = !matches!(session, SessionStatus::Idle | SessionStatus::Pairing);
    PRIMARY_WINDOWS
        .into_iter()
        .filter(|label| *label != keep)
        .filter(|label| !(*label == "control" && control_is_busy))
        .collect()
}

// ── The floating bubble ──────────────────────────────────────────────────────

/// Whether the floating bubble is on screen. See `prefs::Prefs::show_bubble`.
#[tauri::command]
pub fn get_bubble_visible() -> bool {
    crate::prefs::load().show_bubble
}

/// Show or hide the floating bubble, and remember which.
///
/// Both halves matter. Hiding without persisting means it comes back at the
/// next launch, which reads as the setting not working; persisting without
/// hiding means it only takes effect after a relaunch, which reads as the app
/// being slow to obey. Neither is a preference anyone would trust.
#[tauri::command]
pub fn set_bubble_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    apply_bubble_visibility(&app, visible);
    crate::prefs::save(&crate::prefs::Prefs {
        show_bubble: visible,
    })
    .map_err(|e| e.to_string())
}

/// Put the bubble where the preference says it should be. Called at launch and
/// on every change, so the two can never disagree.
pub fn apply_bubble_visibility(app: &AppHandle, visible: bool) {
    if let Some(win) = app.get_webview_window("bubble") {
        let _ = if visible { win.show() } else { win.hide() };
    }
}

// ── AI provider settings (Ask) ────────────────────────────────────────────────
// Non-secret selection persists in the app-support JSON; the API key goes to
// the macOS keychain and NEVER to disk or back out to the UI (only `has_key`).

/// What the setup screen is allowed to conclude about the stored provider.
///
/// "Configured" used to be computed from the presence of a stored key, and the
/// card treated a config it had not finished loading as configured too — an
/// `undefined !== "none"` comparison that is true before anything is known
/// (L-264). Those are four different situations and they need four different
/// words, because the recovery action differs for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadinessState {
    /// Nothing has been set up on this Mac.
    Unconfigured,
    /// Settings and a credential exist; nothing has been verified against the
    /// provider. Ask may still fail on the first real task.
    SavedUnverified,
    /// A capability probe passed. This is the only value that means usable.
    Ready,
    /// Settings exist but cannot work as they stand — no key for this
    /// destination, or a probe that failed.
    NeedsAttention,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigDto {
    pub provider_kind: Option<String>,
    /// Which preset was chosen ("openai", "ollama", …). `None` for settings
    /// written before presets existed.
    pub profile_id: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    /// The destination requests actually go to — scheme, host and port of the
    /// effective base URL. Shown on both devices so "where does this go" is
    /// never inferred from a provider name (L-262, L-265).
    pub origin: Option<String>,
    /// Whether the person allowed screenshots. Their choice; `None` is
    /// "never asked" (L-286).
    pub allow_screenshots: Option<bool>,
    /// Whether image input was **observed** to work. Three-state: `None` is
    /// untested, which is not the same as false.
    pub vision: Option<bool>,
    pub tools: Option<bool>,
    pub verified_at: Option<String>,
    /// Whether a key is stored **for this exact destination**.
    pub has_key: bool,
    pub readiness: ReadinessState,
    /// Present when the stored settings cannot work; names what to fix.
    pub problem: Option<String>,
    /// The failure kind of the last check, when it failed (L-293). Lets the
    /// card offer "Try again" for a rate limit and "Fix the setting" for a
    /// rejected key, instead of one word for every cause.
    pub last_failure: Option<String>,
    /// Which source currently wins: "env" (dev override active — settings
    /// below are stored but ignored), "settings", or "none" (agent inert).
    pub source: &'static str,
}

#[tauri::command]
pub fn get_agent_config() -> AgentConfigDto {
    use crate::agent::llm::{store, ProviderChoice};
    let settings = store::load_settings();
    let kind = settings.provider_kind.clone();
    let base = settings.base_url.clone();

    let (origin, mut problem) = match kind.as_deref() {
        Some(kind) => {
            let effective = base
                .clone()
                .or_else(|| store::default_base_url(kind).map(str::to_string));
            match effective.as_deref().map(store::origin_of) {
                Some(Ok(origin)) => match store::check_transport(&origin) {
                    Ok(()) => (Some(origin), None),
                    Err(e) => (Some(origin), Some(e.to_string())),
                },
                Some(Err(e)) => (None, Some(e.to_string())),
                None => (None, Some(format!("unknown provider kind `{kind}`"))),
            }
        }
        None => (None, None),
    };

    // Three outcomes, not two: a key, no key, or a store that would not say.
    // The last one used to read as "no key configured" (L-271).
    let key_lookup = kind
        .as_deref()
        .map(|k| store::credential_for(k, base.as_deref()));
    let has_key = matches!(key_lookup, Some(Ok(Some(_))));
    if let Some(Err(unavailable)) = &key_lookup {
        problem = Some(unavailable.0.clone());
    }

    let source = if ProviderChoice::from_env().is_some() {
        "env"
    } else if ProviderChoice::from_settings().is_some() {
        "settings"
    } else {
        "none"
    };

    let requires_key = settings
        .profile_id
        .as_deref()
        .and_then(crate::agent::llm::presets::find)
        .map(|p| p.requires_key)
        .unwrap_or(true);
    if problem.is_none() && kind.is_some() && requires_key && !has_key {
        problem = Some(
            "No key is saved for this endpoint. If you changed the address, the previous \
             key was not carried over — enter one for the new destination."
                .to_string(),
        );
    }

    // A blank model is only a working configuration where this provider has a
    // default we have actually checked against it (L-292).
    let model_chosen = settings
        .model
        .as_deref()
        .map(str::trim)
        .is_some_and(|m| !m.is_empty());
    if problem.is_none() && !model_chosen {
        if let Some(kind) = kind.as_deref() {
            if crate::agent::llm::presets::default_model_for(
                settings.profile_id.as_deref(),
                kind,
                base.as_deref(),
            )
            .is_none()
            {
                problem = Some(
                    "Choose a model. This provider has no default we have checked, and \
                     guessing one would send a request it cannot answer."
                        .to_string(),
                );
            }
        }
    }

    // What happened last, which is not what was proven (L-293). A check that
    // failed leaves the configuration needing attention even though whatever
    // was measured before it is still true.
    let last_failure = settings.last_check.as_ref().and_then(|c| {
        c.failure
            .as_ref()
            .map(|kind| (kind.clone(), c.message.clone()))
    });
    if problem.is_none() {
        if let Some((_, message)) = &last_failure {
            problem = Some(message.clone().unwrap_or_else(|| {
                "The last check against this endpoint failed. Test the connection again."
                    .to_string()
            }));
        }
    }

    // Readiness is derived, never stored: a stale "ready" flag is exactly the
    // thing L-264 is about.
    let readiness = if kind.is_none() {
        ReadinessState::Unconfigured
    } else if problem.is_some() {
        ReadinessState::NeedsAttention
    } else if settings.tools == Some(true) {
        ReadinessState::Ready
    } else if settings.tools == Some(false) {
        ReadinessState::NeedsAttention
    } else {
        ReadinessState::SavedUnverified
    };

    AgentConfigDto {
        provider_kind: settings.provider_kind,
        profile_id: settings.profile_id,
        model: settings.model,
        base_url: settings.base_url,
        origin,
        allow_screenshots: settings.allow_screenshots,
        vision: settings.vision,
        tools: settings.tools,
        verified_at: settings.verified_at,
        has_key,
        readiness,
        problem,
        last_failure: last_failure.map(|(kind, _)| kind),
        source,
    }
}

/// The selectable providers, from the one table that defines them.
#[tauri::command]
pub fn list_provider_presets() -> &'static [crate::agent::llm::presets::Preset] {
    crate::agent::llm::presets::PRESETS
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentConfigArgs {
    pub provider_kind: String,
    pub profile_id: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    /// The screenshot permission, as the checkbox left it.
    ///
    /// Omitted means "leave whatever is stored alone" — it does NOT mean
    /// false. The card used to send `null` on every save and the command
    /// turned that into `false`, so editing the model silently disabled
    /// screenshots (L-263). This is a permission and never a capability: it
    /// survives a change of destination, because the person's answer to "may
    /// Ask take screenshots" does not depend on which model is selected
    /// (L-286).
    pub allow_screenshots: Option<bool>,
    /// When present and non-empty, stored in the keychain; never echoed back.
    pub api_key: Option<String>,
}

#[tauri::command]
pub fn set_agent_config(args: SetAgentConfigArgs) -> Result<AgentConfigDto, String> {
    use crate::agent::llm::store;
    if !matches!(args.provider_kind.as_str(), "anthropic" | "openai_compat") {
        return Err(format!("unknown provider kind `{}`", args.provider_kind));
    }
    let previous = store::load_settings();
    let base_url = args.base_url.filter(|s| !s.trim().is_empty());

    // Refuse before storing anything: a destination that cannot hold a
    // credential safely should not be saved as though it could.
    let account_ok = store::credential_account(&args.provider_kind, base_url.as_deref())
        .map_err(|e| e.to_string())?;
    debug_assert!(!account_ok.is_empty());

    if let Some(key) = args
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        store::store_credential(&args.provider_kind, base_url.as_deref(), key)
            .map_err(|e| e.to_string())?;
    }

    // Did this save change anything a verification result depends on? Where
    // requests go, which dialect speaks, which model — **or which key** (L-282).
    // A replaced credential was previously invisible here, so a Ready earned by
    // the old key survived onto the new one.
    let replaced_key = args
        .api_key
        .as_deref()
        .map(str::trim)
        .is_some_and(|k| !k.is_empty());
    let destination_changed = previous.provider_kind.as_deref()
        != Some(args.provider_kind.as_str())
        || previous.base_url != base_url
        || previous.model != args.model.clone().filter(|s| !s.trim().is_empty())
        || replaced_key;

    let settings = store::AgentSettings {
        provider_kind: Some(args.provider_kind),
        profile_id: args.profile_id.filter(|s| !s.trim().is_empty()),
        model: args.model.filter(|s| !s.trim().is_empty()),
        base_url,
        // Permission is the person's, so it is preserved across every save,
        // including one that changes destination (L-286).
        allow_screenshots: args.allow_screenshots.or(previous.allow_screenshots),
        // Capability is a measurement of one configuration. Change the
        // configuration and the measurement is about something else.
        vision: if destination_changed {
            None
        } else {
            previous.vision
        },
        tools: if destination_changed {
            None
        } else {
            previous.tools
        },
        verified_at: if destination_changed {
            None
        } else {
            previous.verified_at
        },
        // A check's outcome is about the configuration it ran against, exactly
        // as a capability is (L-293). Carrying a failure across a change of
        // destination would keep showing the old endpoint's error on the new
        // one; carrying a pass would be worse.
        last_check: if destination_changed {
            None
        } else {
            previous.last_check
        },
    };
    store::save_settings(&settings).map_err(|e| e.to_string())?;
    log::info!(target: "lilypad::audit", "agent_provider_configured — settings saved");
    Ok(get_agent_config())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestAgentConfigArgs {
    pub provider_kind: String,
    pub model: Option<String>,
    pub base_url: Option<String>,
    /// Whether to check image input as well as tools.
    pub vision: Option<bool>,
    /// A key typed on the setup screen but not saved yet. When absent, the
    /// stored key for this destination is used, so a person can re-test an
    /// existing setup without retyping anything.
    pub api_key: Option<String>,
}

/// Run the capability probe and record what it found.
///
/// Nothing here touches the screen or any of the person's files: the probe
/// sends its own generated image. A key given here is used and dropped; it is
/// stored only by `set_agent_config`.
#[tauri::command]
pub async fn test_agent_connection(
    args: TestAgentConfigArgs,
) -> Result<crate::agent::llm::probe::ProbeReport, String> {
    use crate::agent::llm::{probe, store, AnyProvider, ProviderChoice};

    let base_url = args.base_url.filter(|s| !s.trim().is_empty());
    let origin = store::credential_account(&args.provider_kind, base_url.as_deref())
        .map_err(|e| e.to_string())?
        .split_once('@')
        .map(|(_, origin)| origin.to_string())
        .unwrap_or_default();

    let key = args
        .api_key
        .clone()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .or_else(|| {
            store::credential_for(&args.provider_kind, base_url.as_deref())
                .ok()
                .flatten()
        });
    // The exact credential this probe used, so the result can be bound to it.
    let probed_key = key.clone();

    let want_vision = args.vision.unwrap_or(false);
    // Which model a blank field means, per provider (L-292). Asking is the
    // honest outcome where this endpoint has no id we have validated: probing
    // another vendor's default proves nothing and produces an error the person
    // cannot act on.
    let stored_profile = store::load_settings().profile_id;
    let default_model = crate::agent::llm::presets::default_model_for(
        stored_profile.as_deref(),
        &args.provider_kind,
        base_url.as_deref(),
    );
    let chosen_model = args.model.clone().filter(|s| !s.trim().is_empty());
    let resolved_model = match chosen_model.clone() {
        Some(model) => model,
        None => default_model
            .ok_or_else(|| {
                "Choose a model for this provider first — there is no default we have \
                 checked against this endpoint."
                    .to_string()
            })?
            .to_string(),
    };
    let choice = match args.provider_kind.as_str() {
        "anthropic" => {
            let model = resolved_model.clone();
            let key = key.ok_or_else(|| "Enter an API key first.".to_string())?;
            let mut c = crate::agent::llm::anthropic::AnthropicConfig::new(key, model);
            if let Some(base) = base_url.clone() {
                c.base_url = base;
            }
            c.vision = want_vision;
            ProviderChoice::Anthropic(c)
        }
        "openai_compat" => {
            let mut c = crate::agent::llm::openai_compat::OpenAiCompatConfig::new(
                key.unwrap_or_else(|| "none".into()),
                resolved_model.clone(),
            );
            if let Some(base) = base_url.clone() {
                c.base_url = base;
            }
            c.vision = want_vision;
            ProviderChoice::OpenAiCompat(c)
        }
        other => return Err(format!("unknown provider kind `{other}`")),
    };

    let model = match &choice {
        ProviderChoice::Anthropic(c) => c.model.clone(),
        ProviderChoice::OpenAiCompat(c) => c.model.clone(),
    };
    let provider = AnyProvider::new(choice);
    let report = probe::run(&provider, origin, model, want_vision).await;
    // Three states, exactly as for vision (L-293). `Untested` is what a probe
    // returns when the request never reached a model — a rejected key, an
    // exhausted quota, a dead network, an id the endpoint does not know. None
    // of those measured tool calling, and recording `false` told people their
    // model does not support a feature that was never asked about.
    let report_tools = report.tools;
    let report_vision = report.vision;
    // What happened, kept apart from what was proven.
    let check = store::LastCheck {
        at: now_rfc3339(),
        failure: report
            .failure
            .map(|kind| {
                serde_json::to_value(kind)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_else(|| format!("{kind:?}"))
            })
            .filter(|_| !report.ok),
        message: if report.ok {
            None
        } else {
            report.message.clone()
        },
    };

    // Record the result against the stored settings only when it describes the
    // stored settings. A probe of an unsaved draft proves nothing about what
    // is on disk.
    // L-282: a probe result may only be filed against the exact configuration
    // it tested, credential included. Comparing kind, base and model was not
    // enough — a valid draft key could mark a *different* saved key Ready, and
    // a probe that finished late could overwrite newer state.
    //
    // Both snapshots are built on the blocking pool, because resolving the
    // saved one reads the keychain.
    let dialect: &'static str = match args.provider_kind.as_str() {
        "anthropic" => "anthropic",
        _ => "openai_compat",
    };
    let tested_base = base_url.clone();
    let tested_model = args.model.clone().filter(|s| !s.trim().is_empty());
    let tested_key = probed_key.clone();
    let persisted = tokio::task::spawn_blocking(move || {
        use crate::agent::llm::effective::EffectiveConfig;
        // The settings and the generation that describes them, read together.
        // Everything below is decided against this one snapshot, and the write
        // at the end refuses if the generation has moved on (L-278, L-282).
        let (stored, committed) = store::load_committed();
        let Some(saved) = EffectiveConfig::resolve_from(&stored, committed)
            .ok()
            .flatten()
            .map(|(config, _)| config)
        else {
            return Err("this Mac has no saved AI configuration to record the result against");
        };
        let Some(tested) = EffectiveConfig::draft(
            dialect,
            stored.profile_id.clone(),
            tested_base.clone().unwrap_or_else(|| {
                store::default_base_url(dialect)
                    .unwrap_or_default()
                    .to_string()
            }),
            tested_model.clone(),
            tested_key,
        ) else {
            return Err("the tested configuration could not be resolved");
        };
        if !saved.same_target(&tested) {
            // Perfectly normal: the person is testing a draft before saving it.
            // The result is still returned to them; it just is not filed
            // against a configuration it does not describe.
            return Ok(false);
        }
        // Only the verification fields, onto a freshly re-read snapshot, under
        // the settings lock, and only while `committed` is still current. The
        // previous version wrote back a whole settings snapshot taken before
        // the probe ran, so a save, key change or disconnect during the probe
        // was silently reverted (L-282).
        let measured = |capability: probe::Capability| match capability {
            probe::Capability::Supported => Some(true),
            probe::Capability::Unsupported => Some(false),
            // Not asked, or asked and never reached. Either way nothing was
            // measured, and nothing is written.
            probe::Capability::Untested => None,
        };
        match store::record_verification(
            committed,
            &tested,
            measured(report_tools),
            measured(report_vision),
            check,
        ) {
            Ok(store::Verification::Recorded) => Ok(true),
            // Not an error: the person changed something while the check ran,
            // and the newer state is the one that should survive.
            Ok(store::Verification::Superseded) => Ok(false),
            Err(_) => Err("the result could not be saved to this Mac's settings"),
        }
    })
    .await
    .unwrap_or(Err("the check could not be completed"));

    let mut report = report;
    match persisted {
        Ok(true) => report.recorded = true,
        Ok(false) => report.recorded = false,
        Err(reason) => {
            report.recorded = false;
            report.message = Some(match report.message.take() {
                Some(existing) => format!("{existing} ({reason})"),
                None => reason.to_string(),
            });
        }
    }
    Ok(report)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListModelsArgs {
    pub provider_kind: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

/// Where a provider publishes what its models are *for*, and how to ask.
///
/// Google is the one that matters here: its OpenAI-compatible catalogue
/// returns Live, embedding and image ids beside the chat ones with nothing to
/// tell them apart, and its own metadata route says which is which (L-291).
/// The request is pinned to the same origin the catalogue came from, so this
/// can never become a second destination the key is sent to.
fn method_metadata_url(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim_end_matches('/');
    let origin = crate::agent::llm::store::origin_of(trimmed).ok()?;
    if !origin.ends_with("://generativelanguage.googleapis.com") {
        return None;
    }
    // `…/v1beta/openai` is the compatibility path; `…/v1beta/models` is the
    // metadata beside it.
    let root = trimmed.strip_suffix("/openai")?;
    Some(format!("{root}/models"))
}

/// How many pages of Google's catalogue to walk before giving up. Google
/// publishes well under a thousand models; this is a bound on a loop driven by
/// a remote value, not a guess at the catalogue size.
const MAX_METADATA_PAGES: usize = 8;

/// Ask Google what its models support.
///
/// Any failure yields whatever was collected so far — "nothing known" for the
/// rest, never "nothing supported" (see `models::google_method_index`). A page
/// that fails halfway leaves the models it would have covered `unknown` and
/// offered, which is the same degradation as no metadata at all.
///
/// **Paged.** `models.list` returns 50 per page by default and Google's
/// catalogue is longer than that, so a single request covers part of it. Since
/// an unmentioned model is offered, stopping at page one puts the Live Audio
/// model back on the list whenever it sits past the boundary.
async fn fetch_method_index(
    client: &reqwest::Client,
    url: &str,
    key: Option<&str>,
) -> crate::agent::llm::models::MethodIndex {
    use crate::agent::llm::{http, models};
    let mut index = models::MethodIndex::new();
    let mut page_token: Option<String> = None;

    for _ in 0..MAX_METADATA_PAGES {
        let paged = match &page_token {
            Some(token) => format!("{url}?pageSize=200&pageToken={token}"),
            None => format!("{url}?pageSize=200"),
        };
        let mut request = client.get(paged);
        if let Some(key) = key {
            // A header, not a query parameter: a key in a URL ends up in logs.
            request = request.header("x-goog-api-key", key);
        }
        let Ok(resp) = request.send().await else {
            return index;
        };
        if !resp.status().is_success() {
            return index;
        }
        let Ok(raw) = http::collect_bounded(resp).await else {
            return index;
        };
        let Ok(json) = http::parse_success(&raw) else {
            return index;
        };
        models::extend_method_index(&mut index, &json);
        match models::next_page_token(&json) {
            Some(token) => page_token = Some(token),
            None => break,
        }
    }
    index
}

/// The models the endpoint offers, each with what is known about whether Ask
/// can use it (L-291).
///
/// A listing is a catalogue, not a capability statement — it says a name is
/// accepted, not that the model behind it calls tools or reads images. That is
/// what `test_agent_connection` is for. What is added here is narrower and
/// came from a real failure: where the provider publishes which methods a
/// model supports, a model that cannot serve a chat request at all is marked
/// unsuitable before anyone selects it. Everything else stays `unknown` and
/// is offered as before — a gateway with no `/models` route is still not an
/// error, because the id can always be typed.
#[tauri::command]
pub async fn list_agent_models(
    args: ListModelsArgs,
) -> Result<Vec<crate::agent::llm::models::ModelOption>, String> {
    use crate::agent::llm::{http, store};

    let base_url = args
        .base_url
        .filter(|s| !s.trim().is_empty())
        .or_else(|| store::default_base_url(&args.provider_kind).map(str::to_string))
        .ok_or_else(|| format!("unknown provider kind `{}`", args.provider_kind))?;
    let origin = store::origin_of(&base_url).map_err(|e| e.to_string())?;
    store::check_transport(&origin).map_err(|e| e.to_string())?;

    let key = args
        .api_key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .or_else(|| {
            store::credential_for(&args.provider_kind, Some(base_url.as_str()))
                .ok()
                .flatten()
        });

    let metadata_key = key.clone();
    let trimmed = base_url.trim_end_matches('/');
    // The same bounded, redirect-refusing client every other provider request
    // uses (L-281, L-284). A fresh `Client::new()` here had no connect or
    // whole-request deadline, so an endpoint that accepted the connection and
    // then stalled left "Listing…" running forever — a body-size limit does not
    // bound a peer that never finishes its headers — and it followed redirects,
    // which is how a discovery call could have carried the key to another host.
    let client = crate::agent::llm::provider_client();
    let request = match args.provider_kind.as_str() {
        "anthropic" => {
            let mut req = client
                .get(format!("{trimmed}/v1/models"))
                .header("anthropic-version", "2023-06-01");
            if let Some(key) = key {
                req = req.header("x-api-key", key);
            }
            req
        }
        "openai_compat" => {
            let mut req = client.get(format!("{trimmed}/models"));
            if let Some(key) = key {
                req = req.header("authorization", format!("Bearer {key}"));
            }
            req
        }
        other => return Err(format!("unknown provider kind `{other}`")),
    };

    let resp = request
        .send()
        .await
        .map_err(|e| http::classify_transport(&e).message)?;
    // A refused redirect arrives as an ordinary 3xx. Say where it wanted to go
    // rather than reporting a bare status nobody can act on.
    if resp.status().is_redirection() {
        let location = http::location_of(&resp);
        return Err(http::refused_redirect(resp.status().as_u16(), location.as_deref()).message);
    }
    let status = resp.status();
    // Same order as every other provider call: status, bounded body, then
    // parse (L-275, L-276).
    let raw = http::collect_bounded(resp)
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(http::classify(status.as_u16(), &raw).message);
    }
    let json = http::parse_success(&raw).map_err(|e| e.message)?;
    let mut ids: Vec<String> = json
        .get("data")
        .and_then(|d| d.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.get("id").and_then(|v| v.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();

    let index = match method_metadata_url(&base_url) {
        Some(url) => fetch_method_index(&client, &url, metadata_key.as_deref()).await,
        None => crate::agent::llm::models::MethodIndex::new(),
    };
    Ok(crate::agent::llm::models::options(&ids, &index))
}

/// Remove the credential for the configured destination and forget the
/// provider selection (L-274).
///
/// Manual remote control is untouched — it never needed a provider — and the
/// failure is reported rather than swallowed: a disconnect that says it
/// worked while the key is still in the keychain is the worse outcome.
#[tauri::command]
pub fn disconnect_agent_provider() -> Result<AgentConfigDto, String> {
    use crate::agent::llm::store;
    let settings = store::load_settings();
    let Some(kind) = settings.provider_kind.clone() else {
        return Ok(get_agent_config());
    };
    store::forget_credential(&kind, settings.base_url.as_deref()).map_err(|e| e.to_string())?;
    store::save_settings(&store::AgentSettings::default()).map_err(|e| e.to_string())?;
    log::info!(target: "lilypad::audit", "agent_provider_disconnected");
    Ok(get_agent_config())
}

fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Enough for "when was this last verified" without pulling in a date
    // library for one string.
    let days = secs / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    let rest = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// Howard Hinnant's days-from-civil, inverted. Public-domain algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ── Trusted devices dashboard (M5.4) ────────────────────────────────────────
// Thin HTTP glue to the backend's /devices/pairs management endpoints —
// proxied through Rust (reqwest) rather than fetched from the webview so no
// CORS surface needs opening on the backend. Payloads pass through as JSON;
// the UI owns the shape (mirrors @lilypad/protocol's TrustedPairListing).

/// Every phone this desktop trusts, for the dashboard list.
#[tauri::command]
pub async fn list_trusted_devices(
    state: State<'_, SharedState>,
    auth: State<'_, Arc<DesktopAuth>>,
) -> Result<serde_json::Value, String> {
    let (device_id, base_url) = {
        let s = lock_state(&state);
        (s.device_id.clone(), s.backend_base_url.clone())
    };
    let url = format!(
        "{}/devices/pairs?desktopDeviceId={}",
        base_url.trim_end_matches('/'),
        device_id
    );
    let resp = with_bearer(reqwest::Client::new().get(&url), auth.bearer().await)
        .send()
        .await
        .map_err(|e| format!("could not reach backend: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("backend returned HTTP {}", resp.status()));
    }
    resp.json().await.map_err(|e| format!("bad response: {e}"))
}

/// Flip a pair's "connect without approval" (Always allow) setting.
#[tauri::command]
pub async fn set_pair_auto_approve(
    state: State<'_, SharedState>,
    auth: State<'_, Arc<DesktopAuth>>,
    pair_id: String,
    auto_approve: bool,
) -> Result<(), String> {
    let base_url = lock_state(&state).backend_base_url.clone();
    let url = format!("{}/devices/pairs/{pair_id}", base_url.trim_end_matches('/'));
    let resp = with_bearer(
        reqwest::Client::new()
            .patch(&url)
            .json(&serde_json::json!({ "autoApprove": auto_approve })),
        auth.bearer().await,
    )
    .send()
    .await
    .map_err(|e| format!("could not reach backend: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("backend returned HTTP {}", resp.status()));
    }
    log::info!(target: "lilypad::audit", "pair_auto_approve set to {auto_approve}");
    Ok(())
}

// ── Account linking (P1) ────────────────────────────────────────────────────
// [ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md) — this
// computer is added to an account by a phone that is already signed in. There
// is no OAuth client here and no browser round-trip.

/// This computer's relationship with an account, as the dashboard renders it.
#[derive(Debug, Serialize)]
pub struct LinkStateDto {
    /// "unlinked" | "linked" | "revoked" | "no_identity" | "unknown"
    pub state: &'static str,
    pub user_id: Option<String>,
    pub device_id: Option<String>,
    /// Present only for "unknown" — why the answer could not be obtained.
    pub detail: Option<String>,
}

impl From<LinkState> for LinkStateDto {
    fn from(s: LinkState) -> Self {
        let base = Self {
            state: "unlinked",
            user_id: None,
            device_id: None,
            detail: None,
        };
        match s {
            LinkState::Unlinked => base,
            LinkState::Linked { user_id, device_id } => Self {
                state: "linked",
                user_id: Some(user_id),
                device_id: Some(device_id),
                ..base
            },
            LinkState::Revoked => Self {
                state: "revoked",
                ..base
            },
            LinkState::NoIdentity => Self {
                state: "no_identity",
                ..base
            },
            LinkState::Unknown(detail) => Self {
                state: "unknown",
                detail: Some(detail),
                ..base
            },
        }
    }
}

/// Is this computer linked to an account?
///
/// Also the completion signal for linking: it flips to "linked" the moment a
/// phone approves, so the enrollment screen polls this rather than needing a
/// push channel or a second endpoint (ADR-0008).
#[tauri::command]
pub async fn get_link_state(
    app: AppHandle,
    state: State<'_, SharedState>,
    auth: State<'_, Arc<DesktopAuth>>,
) -> Result<LinkStateDto, String> {
    let link = auth.link_state().await;
    // Remember it for the tray, which is rebuilt synchronously and cannot
    // await. The dashboard and the setup wizard both poll this every 3s while
    // open, and the bubble now opens the dashboard, so a real session settles
    // this within seconds of launch.
    lock_state(&state).link_state = link.clone();
    crate::sync_tray_menu(&app);
    Ok(link.into())
}

/// What the phone scans to add this computer to its account.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentQrDto {
    pub code: String,
    pub expires_in_seconds: u64,
    pub api_base_url: String,
    pub device_name: String,
    pub platform: String,
}

/// Mint a single-use enrollment code for this computer.
///
/// The code is bound server-side to this machine's public key, so intercepting
/// it does not let an attacker enroll a different machine — it can only ever
/// enroll THIS one, onto whichever account scans it.
#[tauri::command]
pub async fn start_enrollment(
    state: State<'_, SharedState>,
    auth: State<'_, Arc<DesktopAuth>>,
) -> Result<EnrollmentQrDto, String> {
    let device_id = lock_state(&state).device_id.clone();
    let device_name = crate::identity::device_name();
    // `device_id` and not some other identifier: the backend resolves ownership
    // by (kind, fingerprint), and enrolling under anything else would link a
    // second row while every authorization check kept seeing the unlinked one.
    let minted = auth
        .request_enrollment_code(&device_id, &device_name, current_platform())
        .await
        .map_err(|e| e.to_string())?;
    Ok(EnrollmentQrDto {
        code: minted.code,
        expires_in_seconds: minted.expires_in_seconds,
        api_base_url: minted.api_base_url,
        device_name,
        platform: current_platform().to_owned(),
    })
}

/// Whether Lilypad relaunches at login (macOS LaunchAgent).
#[tauri::command]
pub fn get_login_item_enabled() -> bool {
    crate::autostart::is_enabled()
}

/// Turn the login item on/off from the dashboard.
#[tauri::command]
pub fn set_login_item_enabled(enabled: bool) -> Result<(), String> {
    if enabled {
        crate::autostart::enable()
    } else {
        crate::autostart::disable()
    }
}

/// Revoke a pair — the phone can no longer connect without a fresh QR pairing.
#[tauri::command]
pub async fn revoke_pair(
    state: State<'_, SharedState>,
    auth: State<'_, Arc<DesktopAuth>>,
    pair_id: String,
) -> Result<(), String> {
    let base_url = lock_state(&state).backend_base_url.clone();
    let url = format!("{}/devices/pairs/{pair_id}", base_url.trim_end_matches('/'));
    let resp = with_bearer(reqwest::Client::new().delete(&url), auth.bearer().await)
        .send()
        .await
        .map_err(|e| format!("could not reach backend: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("backend returned HTTP {}", resp.status()));
    }
    log::info!(target: "lilypad::audit", "device_revoked — pair {pair_id}");
    Ok(())
}

// ── account ([ADR-0012](../../../../docs/adr/0012-password-authentication.md)) ──
//
// The desktop had no way to sign in at all: ADR-0008 gives it no OAuth client,
// and magic link needs a mail sender that production does not have. Email +
// password is the one method that needs neither, which is what makes an
// account identity possible on this machine.
//
// **Signing in here is what puts this machine on the account**
// ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)). It used
// to cost a separate ceremony — a phone scanning an enrollment QR — which made
// ownership mean one thing on a phone (immediate, at sign-in) and another on a
// Mac, and left a customer who had signed in on both looking at a "Your
// devices" list with one device in it.
//
// Ownership still buys no REACH. A phone can only see this screen through a
// `trusted_devices` pair with a per-pair secret, which is what the QR ceremony
// creates and the only thing `/connect/request` consults.

/// The account this laptop is signed in to, read from the keychain only.
#[tauri::command]
pub fn get_account_state() -> account::AccountState {
    account::Account::state()
}

fn account_client(state: &State<'_, SharedState>) -> account::Account {
    account::Account::new(lock_state(state).backend_base_url.clone())
}

/// Sign-in, and then the thing that makes signing in mean something: this Mac
/// joins the account it just signed in to.
///
/// **The enrollment failure is reported, and the sign-in is not undone.** Those
/// are two different facts and a customer is entitled to both. The account
/// session is genuinely established — the keychain has it, the dashboard will
/// say who is signed in, and nothing is gained by pretending otherwise. But a
/// silent failure here would leave the exact state this change exists to
/// remove: signed in on a Mac that is on no account, with no indication why.
/// The likeliest cause is a machine already owned by a different account, whose
/// remedy the server spells out.
/// Tell every window the account changed.
///
/// Each window is its own webview holding its own React state, and
/// `open_window` hides the others rather than closing them — so a window that
/// read the account once keeps that answer until it is remounted, which may be
/// never. Without this event, signing in on the dashboard left Settings
/// showing a sign-in form for the account it was already signed in to. One
/// product cannot hold two answers to "who is signed in".
///
/// `app.emit` reaches every window, including hidden ones, which is the whole
/// point: the window that is wrong is by definition the one nobody is looking
/// at yet.
fn announce_account(app: &AppHandle) {
    let _ = app.emit("lilypad://account", ());
}

async fn sign_in_and_enrol(
    app: &AppHandle,
    state: &State<'_, SharedState>,
    auth: &State<'_, Arc<DesktopAuth>>,
    signed_in: account::SignedIn,
) -> Result<account::AccountState, String> {
    let device_id = lock_state(state).device_id.clone();
    // `device_id`, not any other identifier: the backend resolves ownership by
    // (kind, fingerprint), and enrolling under anything else would own a second
    // row while every authorization check kept reading the unowned one.
    let name = crate::identity::device_name();
    let enrol = || {
        auth.enroll(
            &signed_in.access_token,
            &device_id,
            &name,
            current_platform(),
        )
    };

    let result = match enrol().await {
        Ok(session) => Ok(session),
        // ONE retry, for exactly one refusal, and the delay is the fix rather
        // than a hope.
        //
        // `DeviceRegistry.claim` admits a revoked row only for a credential
        // minted strictly AFTER the revocation, and it compares against the
        // access token's `iat` — which JWT records in whole SECONDS. Sign out
        // and straight back in, and the fresh token's `iat` rounds down to
        // before the revocation that happened a few hundred milliseconds
        // earlier. The server genuinely cannot tell that credential from the
        // stale one the guard exists to refuse, so it correctly refuses both.
        //
        // Now that sign-out revokes this Mac (`account_sign_out`), that second
        // is on the ordinary path: "sign out, then sign back in" is the most
        // obvious thing a person does after signing out by mistake. Waiting the
        // second out resolves the ambiguity instead of widening the server's
        // window, which is the half that must not move.
        Err(e) if matches!(e.downcast_ref::<AuthError>(), Some(AuthError::Revoked)) => {
            log::info!(
                target: "lilypad::auth",
                "enrollment refused as revoked — retrying past the credential's issuing second",
            );
            tokio::time::sleep(Duration::from_millis(1_200)).await;
            enrol().await
        }
        Err(e) => Err(e),
    };

    if let Err(e) = result {
        // Roll the local session back. `Account::sign_in` has already written
        // the credential to the keychain by this point, so returning an error
        // without this leaves the app claiming to be signed out on a Mac whose
        // keychain says otherwise — and the next read of `get_account_state`
        // flips it back, with no explanation and nothing on screen to act on.
        // Signing in is one act; it either happened or it did not.
        if let Err(rollback) = account::Account::sign_out() {
            log::warn!(target: "lilypad::account", "could not roll back a failed sign-in: {rollback}");
        }
        // Announced on the failure path too. The rollback above is itself a
        // change of account state, and a window that had optimistically drawn
        // the signed-in card needs to hear about it.
        announce_account(app);
        return Err(e.to_string());
    }
    // Ownership moved with the sign-in (ADR-0015), so the tray's pairing item
    // is stale as well — and it is rebuilt synchronously from `link_state`,
    // which only `get_link_state` writes. The event makes every open window
    // re-read it, and that read is what syncs the tray.
    announce_account(app);
    Ok(signed_in.state)
}

#[tauri::command]
pub async fn account_sign_up(
    app: AppHandle,
    state: State<'_, SharedState>,
    auth: State<'_, Arc<DesktopAuth>>,
    name: String,
    email: String,
    password: String,
) -> Result<account::AccountState, String> {
    let signed_in = account_client(&state)
        .sign_up(&name, &email, &password)
        .await
        .map_err(|e| e.to_string())?;
    sign_in_and_enrol(&app, &state, &auth, signed_in).await
}

#[tauri::command]
pub async fn account_sign_in(
    app: AppHandle,
    state: State<'_, SharedState>,
    auth: State<'_, Arc<DesktopAuth>>,
    email: String,
    password: String,
) -> Result<account::AccountState, String> {
    let signed_in = account_client(&state)
        .sign_in(&email, &password)
        .await
        .map_err(|e| e.to_string())?;
    sign_in_and_enrol(&app, &state, &auth, signed_in).await
}

/// Whether the backend can send mail, so the dashboard can stop offering a
/// password reset that can only answer 503. Fails open — see
/// `Account::email_available`.
#[tauri::command]
pub async fn account_email_available(state: State<'_, SharedState>) -> Result<bool, String> {
    Ok(account_client(&state).email_available().await)
}

#[tauri::command]
pub async fn account_request_password_reset(
    state: State<'_, SharedState>,
    email: String,
) -> Result<(), String> {
    account_client(&state)
        .request_password_reset(&email)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn account_confirm_password_reset(
    app: AppHandle,
    state: State<'_, SharedState>,
    auth: State<'_, Arc<DesktopAuth>>,
    email: String,
    code: String,
    password: String,
) -> Result<account::AccountState, String> {
    let signed_in = account_client(&state)
        .confirm_password_reset(&email, &code, &password)
        .await
        .map_err(|e| e.to_string())?;
    sign_in_and_enrol(&app, &state, &auth, signed_in).await
}

/// Delete the account permanently — every device, every pairing, every session.
///
/// Distinct from `account_sign_out` in the only way that matters: sign-out is
/// local and reversible, this is neither. It re-authenticates with the password
/// and passes the user's typed address to the server untouched.
#[tauri::command]
pub async fn account_delete(
    app: AppHandle,
    state: State<'_, SharedState>,
    confirm_email: String,
    password: String,
) -> Result<(), String> {
    account_client(&state)
        .delete(&confirm_email, &password)
        .await
        .map_err(|e| e.to_string())?;
    announce_account(&app);
    Ok(())
}

/// Sign out of this Mac — and take the Mac off the account with it.
///
/// **This used to be a local act, and that was a real hole rather than a
/// design.** It deleted the stored account record and nothing else: the device
/// key kept authenticating, the presence seat stayed occupied, every paired
/// phone could still ring this machine, and a session already running kept
/// streaming the screen of someone who had just pressed "Sign out". The old
/// comment here called that deliberate, on the grounds that removing a computer
/// from an account was a phone's job. [ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)
/// ended that split: signing IN is what puts this Mac on the account, so
/// signing out is what takes it off, on the same screen, by the same person.
///
/// Three things, in this order, and the order is the point:
///
/// 1. **End any live session, locally and first.** It needs no network and
///    cannot fail, so the one guarantee that must not depend on the wifi is
///    made before anything that can.
/// 2. **Release the device** (`DeviceAuth::release`) — which also ends the
///    presence seat and revokes the account's refresh tokens, server-side.
/// 3. **Forget the account** locally.
///
/// Step 3 does NOT run if step 2 failed, and that is deliberate. A Mac that
/// showed "signed out" while still answering to every paired phone is the exact
/// state this whole command exists to prevent, and it is worse than a sign-out
/// that says it could not finish. The error names the connection, because that
/// is what it always is.
#[tauri::command]
pub async fn account_sign_out(
    app: AppHandle,
    state: State<'_, SharedState>,
    auth: State<'_, Arc<DesktopAuth>>,
) -> Result<(), String> {
    send_control_or_reset(&state, Control::Disconnect);
    log::info!(target: "lilypad::audit", "sign_out — releasing this computer from its account");
    auth.release().await.map_err(|e| e.to_string())?;
    account::Account::sign_out().map_err(|e| e.to_string())?;
    // The tray's pairing item is gated on link state, which just became false.
    {
        let mut s = lock_state(&state);
        s.link_state = LinkState::Unlinked;
    }
    crate::sync_tray_menu(&app);
    announce_account(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Which session states make minting a pairing code destructive.
    ///
    /// Extracted so the rule is testable without a Tauri app: `create_pairing`
    /// is an async command that needs an `AppHandle`, a `SharedState` and a
    /// backend, and none of that is needed to answer the question that was
    /// actually wrong.
    ///
    /// `Pairing` must stay OUT. A code on screen that nobody has scanned is
    /// exactly what the QR window's "New code" button replaces, and refusing
    /// that would break the button this guard exists to leave working.
    #[test]
    fn pairing_is_refused_only_when_it_would_end_something() {
        let destructive = |s: SessionStatus| {
            matches!(
                s,
                SessionStatus::AwaitingApproval | SessionStatus::Connecting | SessionStatus::Active
            )
        };
        assert!(destructive(SessionStatus::Active), "a live session");
        assert!(
            destructive(SessionStatus::Connecting),
            "a session mid-negotiation"
        );
        assert!(
            destructive(SessionStatus::AwaitingApproval),
            "a phone waiting on an answer"
        );
        assert!(!destructive(SessionStatus::Idle), "nothing to end");
        assert!(
            !destructive(SessionStatus::Pairing),
            "an unscanned code is what New code replaces"
        );
    }

    /// One window at a time — and the one exception that keeps it safe.
    #[test]
    fn opening_a_window_steps_the_others_aside() {
        assert_eq!(
            windows_to_hide("setup", SessionStatus::Idle),
            vec!["control", "diagnostics"]
        );
        assert_eq!(
            windows_to_hide("control", SessionStatus::Idle),
            vec!["setup", "diagnostics"]
        );
    }

    /// The dashboard holds the Approve/Deny for a phone that is waiting, and
    /// the Disconnect/Panic for a session that is live. Opening Settings must
    /// not take either off the screen.
    #[test]
    fn a_busy_dashboard_is_never_hidden() {
        for session in [
            SessionStatus::AwaitingApproval,
            SessionStatus::Connecting,
            SessionStatus::Active,
        ] {
            assert_eq!(
                windows_to_hide("setup", session),
                vec!["diagnostics"],
                "{session:?} hid the dashboard out from under a live decision"
            );
        }
    }

    /// A companion, not a competitor: the pairing QR is photographed by a phone
    /// while the window that explains it stays put.
    #[test]
    fn the_pairing_qr_hides_nothing() {
        assert!(windows_to_hide("qr-overlay", SessionStatus::Pairing).contains(&"control"));
        // …and `hide_other_primaries` never reaches this function for it — the
        // label is not a primary window, which is the guard that matters.
        assert!(!PRIMARY_WINDOWS.contains(&"qr-overlay"));
        assert!(!PRIMARY_WINDOWS.contains(&"bubble"));
    }

    /// What the pairing window puts in front of someone adding their phone.
    ///
    /// `QrOverlay` renders these strings verbatim. The old text was
    /// `backend returned HTTP 429`, shown under a "Could not reach backend:"
    /// prefix — implementation detail, and the wrong cause named twice.
    #[test]
    fn a_refused_pairing_code_is_explained_in_words() {
        for status in [400u16, 401, 403, 429, 500, 502, 503] {
            let message = pairing_failure(status);
            assert!(
                !message.contains("HTTP")
                    && !message.contains("backend returned")
                    && !message.contains(&status.to_string()),
                "HTTP {status} leaks implementation: {message}"
            );
            assert!(
                message.ends_with('.') && message.chars().next().unwrap().is_uppercase(),
                "HTTP {status} is not a sentence: {message}"
            );
        }
        assert!(pairing_failure(429).contains("Wait a minute"));
        // Too old for the server is the one case retrying cannot fix.
        assert!(!pairing_failure(400).contains("Try again"));
    }

    #[test]
    fn an_unseated_pairing_is_explained_in_words() {
        let message = pairing_not_seated();
        assert!(!message.contains("HTTP") && !message.contains("seat"));
        assert!(message.ends_with('.') && message.chars().next().unwrap().is_uppercase());
        assert!(message.contains("pairing room"));
    }

    #[test]
    fn a_stale_pairing_timeout_cannot_abort_its_successor() {
        let mut state = AppState::new("desktop".to_owned(), "https://example.test".to_owned());
        state.current_room_id = Some("new-room".to_owned());
        state.session = SessionStatus::Connecting;
        state.auto_approve_room = Some("new-room".to_owned());

        assert!(!clear_unseated_pairing_if_current(
            &mut state,
            "old-pairing-room"
        ));
        assert_eq!(state.current_room_id.as_deref(), Some("new-room"));
        assert_eq!(state.session, SessionStatus::Connecting);
        assert_eq!(state.auto_approve_room.as_deref(), Some("new-room"));
    }

    #[test]
    fn an_unseated_current_pairing_is_reset_for_retry() {
        let mut state = AppState::new("desktop".to_owned(), "https://example.test".to_owned());
        state.current_room_id = Some("pairing-room".to_owned());
        state.session = SessionStatus::Pairing;

        assert!(clear_unseated_pairing_if_current(
            &mut state,
            "pairing-room"
        ));
        assert_eq!(state.current_room_id, None);
        assert_eq!(state.session, SessionStatus::Idle);
    }

    #[test]
    fn a_closed_input_channel_is_not_presented_as_an_active_controller() {
        let mut state = AppState::new("desktop".to_owned(), "https://example.test".to_owned());
        state.session = SessionStatus::Active;
        state.shared_display = Some("Display 2".to_owned());

        apply_input_channel_event(&mut state, false);
        assert_eq!(state.session, SessionStatus::Connecting);
        assert_eq!(state.shared_display, None);

        apply_input_channel_event(&mut state, true);
        assert_eq!(state.session, SessionStatus::Active);
    }

    #[test]
    fn superseded_runner_events_cannot_change_the_new_rooms_state_or_consent() {
        let mut state = AppState::new("desktop".to_owned(), "https://example.test".to_owned());
        claim_room(&mut state, "new-room", true);
        state.session = SessionStatus::Connecting;
        state.shared_display = Some("New display".to_owned());
        let (control_tx, mut control_rx) = unbounded_channel();
        state.control_tx = Some(control_tx);

        for event in [
            SessionEvent::Ended {
                reason: "old runner stopped".to_owned(),
            },
            SessionEvent::PairRequested {
                device_name: Some("Old phone".to_owned()),
                requested_scopes: vec!["control".to_owned()],
            },
            SessionEvent::InputChannelOpen,
            SessionEvent::InputChannelClosed,
        ] {
            assert_eq!(
                apply_session_event_to_state(&mut state, "old-room", &event),
                None
            );
            assert_eq!(state.current_room_id.as_deref(), Some("new-room"));
            assert_eq!(state.auto_approve_room.as_deref(), Some("new-room"));
            assert_eq!(state.session, SessionStatus::Connecting);
            assert_eq!(state.shared_display.as_deref(), Some("New display"));
            assert!(state.pending_request.is_none());
            assert!(matches!(
                control_rx.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ));
        }
    }

    #[tokio::test]
    async fn concurrent_room_claims_keep_the_room_sender_and_task_together() {
        for rooms in [["same-room", "same-room"], ["first-room", "second-room"]] {
            let state = Arc::new(SharedState::new(AppState::new(
                "desktop".to_owned(),
                "https://example.test".to_owned(),
            )));
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let runtime = tokio::runtime::Handle::current();
            let mut claims = std::thread::scope(|scope| {
                let threads: Vec<_> = rooms
                    .into_iter()
                    .enumerate()
                    .map(|(index, room)| {
                        let state = state.clone();
                        let barrier = barrier.clone();
                        let runtime = runtime.clone();
                        scope.spawn(move || {
                            let (control_tx, control_rx) = unbounded_channel();
                            let mut task_id = None;
                            let mut previous = None;
                            barrier.wait();
                            let installed = install_session_runner(
                                &state,
                                room,
                                index == 0,
                                vec![room.to_owned()],
                                control_tx,
                                |old| {
                                    previous = old;
                                    let handle = tauri::async_runtime::JoinHandle::Tokio(
                                        runtime.spawn(std::future::pending::<()>()),
                                    );
                                    task_id = Some(handle.inner().id());
                                    handle
                                },
                            );
                            (room, index == 0, installed, task_id, previous, control_rx)
                        })
                    })
                    .collect();
                threads
                    .into_iter()
                    .map(|thread| thread.join().unwrap())
                    .collect::<Vec<_>>()
            });
            let mut current = lock_state(&state);
            let current_task = current.session_task.take().unwrap();
            let mut winners = 0;
            for (room, auto_approve, installed, task_id, previous, receiver) in &mut claims {
                if *task_id == Some(current_task.inner().id()) {
                    winners += 1;
                    assert!(*installed);
                    assert_eq!(current.current_room_id.as_deref(), Some(*room));
                    assert_eq!(
                        current.auto_approve_room.as_deref(),
                        auto_approve.then_some(*room)
                    );
                    assert_eq!(current.offered_scopes, vec![*room]);
                    assert_eq!(current.session, SessionStatus::Pairing);
                    assert!(matches!(
                        receiver.try_recv(),
                        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
                    ));
                    current
                        .control_tx
                        .as_ref()
                        .unwrap()
                        .send(Control::Deny)
                        .unwrap();
                    assert!(matches!(receiver.try_recv(), Ok(Control::Deny)));
                } else if *installed {
                    assert!(matches!(receiver.try_recv(), Ok(Control::Disconnect)));
                } else {
                    // No task (and hence no terminal-event forwarder) may be
                    // started for a duplicate ring of the currently owned room.
                    assert!(task_id.is_none());
                    assert!(previous.is_none());
                }
            }
            assert_eq!(winners, 1);
            assert_eq!(
                claims.iter().filter(|claim| claim.2).count(),
                if rooms[0] == rooms[1] { 1 } else { 2 }
            );
            assert_eq!(
                claims.iter().filter(|claim| claim.4.is_some()).count(),
                if rooms[0] == rooms[1] { 0 } else { 1 }
            );
            for (_, _, _, _, previous, _) in &claims {
                if let Some(previous) = previous {
                    assert!(claims
                        .iter()
                        .any(|claim| claim.3 == Some(previous.inner().id())));
                    previous.abort();
                }
            }
            current_task.abort();
        }
    }

    #[tokio::test]
    async fn initial_signaling_failure_releases_only_its_own_room() {
        for superseded in [false, true] {
            let mut state = AppState::new("desktop".to_owned(), "https://example.test".to_owned());
            claim_room(&mut state, "failed-room", true);
            state.session = SessionStatus::Pairing;
            let (control_tx, control_rx) = unbounded_channel();
            state.control_tx = Some(control_tx);
            let (event_tx, event_rx) = unbounded_channel();
            let result = run_session(
                "invalid signaling URL".to_owned(),
                "failed-room".to_owned(),
                "desktop".to_owned(),
                None,
                None,
                control_rx,
                event_tx,
            )
            .await;
            assert!(result.is_err());
            if superseded {
                claim_room(&mut state, "new-room", true);
                state.session = SessionStatus::Connecting;
            }
            let mut accepted = 0;
            forward_session_events(event_rx, |event| {
                if apply_session_event_to_state(&mut state, "failed-room", &event).is_some() {
                    accepted += 1;
                    assert!(matches!(event, SessionEvent::Ended { .. }));
                }
            })
            .await;
            if superseded {
                assert_eq!(accepted, 0);
                assert_eq!(state.current_room_id.as_deref(), Some("new-room"));
                assert_eq!(state.session, SessionStatus::Connecting);
                assert_eq!(state.auto_approve_room.as_deref(), Some("new-room"));
                assert!(state.control_tx.is_some());
            } else {
                assert_eq!(accepted, 1);
                assert!(state.current_room_id.is_none());
                assert_eq!(state.session, SessionStatus::Idle);
                assert!(state.auto_approve_room.is_none());
                assert!(state.control_tx.is_none());
            }
        }
    }

    #[tokio::test]
    async fn a_normal_runner_end_is_not_repeated_when_the_stream_closes() {
        let (events, receiver) = unbounded_channel();
        events
            .send(SessionEvent::Ended {
                reason: "disconnected".to_owned(),
            })
            .unwrap();
        drop(events);
        let mut forwarded = Vec::new();
        forward_session_events(receiver, |event| forwarded.push(event)).await;
        assert_eq!(forwarded.len(), 1);
        assert!(
            matches!(&forwarded[0], SessionEvent::Ended { reason } if reason == "disconnected")
        );
    }
}

/// A render error from one of the webviews, written where support can find it.
///
/// The webview console does NOT reach `~/Library/Logs/Lilypad`: that would need
/// `tauri-plugin-log` with a webview target, and this app installs `env_logger`
/// directly. So a React error boundary that only called `console.error` would
/// tell the customer their crash "has been written to the log" while writing
/// nothing, and the report they then sent would describe a healthy app. This is
/// the one line that makes that claim true.
///
/// Bounded, because a component stack is unbounded and a log file is not.
#[tauri::command]
pub fn log_ui_error(window_label: String, message: String) {
    const LIMIT: usize = 4_000;
    let mut message = message;
    if message.len() > LIMIT {
        // On a char boundary — `String::truncate` panics in the middle of a
        // multi-byte character, and an error report is the worst possible place
        // to introduce a second crash.
        let cut = (0..=LIMIT)
            .rev()
            .find(|i| message.is_char_boundary(*i))
            .unwrap_or(0);
        message.truncate(cut);
        message.push_str("… (truncated)");
    }
    log::error!(target: "lilypad::ui", "{window_label} failed to render: {message}");
}

/// Where this Mac writes its log, and a way to get to it.
///
/// A log a customer cannot find is a log that only helps developers. The path
/// goes into the copyable diagnostics report so a support conversation can name
/// it, and `reveal_log_file` opens Finder on it so nobody has to be told how to
/// reach `~/Library/Logs`.
#[tauri::command]
pub fn log_file_path() -> Option<String> {
    crate::logfile::path().map(|p| p.display().to_string())
}

/// Select the log file in Finder. macOS-only, like the rest of this app's
/// shell integration; elsewhere it reports that there is nothing to open
/// rather than pretending it worked.
#[tauri::command]
pub fn reveal_log_file() -> Result<(), String> {
    let path = crate::logfile::path().ok_or("no log file path on this system")?;
    #[cfg(target_os = "macos")]
    {
        // `-R` reveals rather than opens: a 5 MB log opened in TextEdit is not
        // what someone attaching it to an email wants.
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("could not reveal the log file: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(format!("the log file is at {}", path.display()))
    }
}
