//! Tauri commands invoked from the React UI.
//!
//! Windows are label-based: every window loads `index.html` and the frontend
//! renders bubble / qr-overlay / control / diagnostics based on its window
//! label.

use std::sync::{Arc, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::mpsc::unbounded_channel;

use crate::account;
use crate::auth::{with_bearer, DesktopAuth, LinkState};
use crate::session::{run_session, Control, SessionEvent};
use crate::state::{AppState, AppStateDto, PendingRequest, SessionStatus, SharedState};

/// Max time a new session waits for the previous runner to finish tearing
/// down (its `media.stop()` joins the ScreenCaptureKit capture thread)
/// before starting anyway — bounds a stuck old teardown so a takeover can't
/// hang indefinitely.
const SESSION_TEARDOWN_WAIT: Duration = Duration::from_secs(3);

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
) -> Result<QrPayloadDto, String> {
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

    let device_name = format!("{} desktop", current_platform());
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
    spawn_session_runner(
        &app,
        parsed.room_id,
        parsed.signaling_url,
        device_id,
        offered_scopes,
    );
    log::info!(target: "lilypad::audit", "pairing_created — room started, awaiting scan");

    open_window(&app, "qr-overlay", "Lilypad — Pair", QR_WINDOW)?;
    crate::sync_tray_menu(&app);
    Ok(payload)
}

/// Spawn the async session runner + a task that forwards its events to the UI
/// (updating coarse session state and emitting `lilypad://session`).
/// `pub(crate)`: also the presence channel's entry point for accepted
/// connect-requests (M5.4) — a rung session and a QR session run identically.
pub(crate) fn spawn_session_runner(
    app: &AppHandle,
    room_id: String,
    signaling_url: String,
    device_id: String,
    offered_scopes: Vec<String>,
) {
    let (control_tx, control_rx) = unbounded_channel::<Control>();
    let (event_tx, mut event_rx) = unbounded_channel::<SessionEvent>();

    let old_task = {
        let state = app.state::<SharedState>();
        let mut s = lock_state(&state);
        s.control_tx = Some(control_tx);
        s.current_room_id = Some(room_id.clone());
        s.offered_scopes = offered_scopes;
        s.session = SessionStatus::Pairing;
        s.pending_request = None;
        s.session_task.take()
    };

    // Forward runner events to the UI + update coarse session state. Each
    // forwarder is bound to ITS runner's room: once another runner has
    // superseded this one (M5.4 trusted takeover), the old runner's dying
    // events (its Ended, its ConnectionState flaps) must neither clobber the
    // new session's state nor reach the UI.
    let app_ev = app.clone();
    let runner_room = room_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = event_rx.recv().await {
            let current = {
                let state = app_ev.state::<SharedState>();
                let s = lock_state(&state);
                s.current_room_id.clone()
            };
            if current.as_deref() != Some(runner_room.as_str()) {
                log::debug!(
                    target: "lilypad::session",
                    "dropping event from superseded runner (room {runner_room})"
                );
                continue;
            }
            apply_session_event(&app_ev, &ev);
            let _ = app_ev.emit("lilypad://session", ev);
        }
    });

    // Drive the session.
    let handle = tauri::async_runtime::spawn(async move {
        // Wait for the PREVIOUS session to fully tear down (its media.stop()
        // joins the capture thread) before this one starts, so screen capture
        // is never double-opened during a trusted takeover. Bounded so a stuck
        // old teardown can't hang the takeover — after the timeout we proceed
        // and accept the pre-existing brief-overlap behavior as the fallback.
        if let Some(old) = old_task {
            let _ = tokio::time::timeout(SESSION_TEARDOWN_WAIT, old).await;
        }
        if let Err(e) = run_session(signaling_url, room_id, device_id, control_rx, event_tx).await {
            log::error!(target: "lilypad::session", "session runner error: {e}");
        }
    });
    {
        let state = app.state::<SharedState>();
        let mut s = lock_state(&state);
        s.session_task = Some(handle);
    }
}

/// Map a runner event onto the coarse `SessionStatus` the polling UI reads.
fn apply_session_event(app: &AppHandle, ev: &SessionEvent) {
    let state = app.state::<SharedState>();
    let mut s = lock_state(&state);
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
                        "session auto-approved — trusted device (Always allow)"
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
        // `failed`/`disconnected`/`closed` are NOT terminal from the UI's
        // point of view: the runner treats them as recoverable (ICE restart,
        // reconnect) and stays alive. Clearing `control_tx` here used to
        // silently disable the Disconnect/Panic buttons while capture+encode
        // kept running — a real safety bug. Only `Ended` (the runner's own
        // definitive terminal signal) tears down UI state and the control
        // channel. We reflect `connected` as Active and leave transient states
        // showing Active so the indicator doesn't flicker to Idle mid-recovery.
        SessionEvent::ConnectionState { state } => {
            if state == "connected" {
                s.session = SessionStatus::Active;
            }
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
    let ring = matches!(ev, SessionEvent::PairRequested { .. }) && s.pending_request.is_some();
    drop(s);
    if ring {
        let _ = show_control(app);
    }
    crate::sync_tray_menu(app);
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
        open_window(&app, "control", "Lilypad — Session", CONTROL_WINDOW)?;
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
    open_window(&app, "qr-overlay", "Lilypad — Pair", QR_WINDOW)
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

/// Open the first-run Setup window and, if it wasn't already open, start a
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
    let already_open = app.get_webview_window("setup").is_some();
    open_window(app, "setup", "Lilypad — Setup", SETUP_WINDOW)?;
    if !already_open {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(700));
            loop {
                interval.tick().await;
                if app.get_webview_window("setup").is_none() {
                    break;
                }
                let _ = app.emit("lilypad://permission", permission_snapshot());
            }
        });
    }
    Ok(())
}

// ── window helpers (also called from the tray menu in lib.rs) ────────────────

pub fn show_diagnostics(app: &AppHandle) -> Result<(), String> {
    open_window(
        app,
        "diagnostics",
        "Lilypad — Diagnostics",
        DIAGNOSTICS_WINDOW,
    )
}

pub fn show_qr_overlay(app: &AppHandle) -> Result<(), String> {
    open_window(app, "qr-overlay", "Lilypad — Pair", QR_WINDOW)
}

pub fn show_control(app: &AppHandle) -> Result<(), String> {
    open_window(app, "control", "Lilypad — Session", CONTROL_WINDOW)
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

// ── AI provider settings (Ask) ────────────────────────────────────────────────
// Non-secret selection persists in the app-support JSON; the API key goes to
// the macOS keychain and NEVER to disk or back out to the UI (only `has_key`).

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigDto {
    pub provider_kind: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub vision: bool,
    pub has_key: bool,
    /// Which source currently wins: "env" (dev override active — settings
    /// below are stored but ignored), "settings", or "none" (agent inert).
    pub source: &'static str,
}

#[tauri::command]
pub fn get_agent_config() -> AgentConfigDto {
    use crate::agent::llm::{store, ProviderChoice};
    let settings = store::load_settings();
    let has_key = settings
        .provider_kind
        .as_deref()
        .map(|k| store::keychain_get(k).is_some())
        .unwrap_or(false);
    let source = if ProviderChoice::from_env().is_some() {
        "env"
    } else if ProviderChoice::from_settings().is_some() {
        "settings"
    } else {
        "none"
    };
    AgentConfigDto {
        provider_kind: settings.provider_kind,
        model: settings.model,
        base_url: settings.base_url,
        vision: settings.vision,
        has_key,
        source,
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentConfigArgs {
    pub provider_kind: String,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub vision: Option<bool>,
    /// When present and non-empty, stored in the keychain; never echoed back.
    pub api_key: Option<String>,
}

#[tauri::command]
pub fn set_agent_config(args: SetAgentConfigArgs) -> Result<AgentConfigDto, String> {
    use crate::agent::llm::store;
    if !matches!(args.provider_kind.as_str(), "anthropic" | "openai_compat") {
        return Err(format!("unknown provider kind `{}`", args.provider_kind));
    }
    if let Some(key) = args
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        store::keychain_set(&args.provider_kind, key).map_err(|e| e.to_string())?;
    }
    let settings = store::AgentSettings {
        provider_kind: Some(args.provider_kind),
        model: args.model.filter(|s| !s.trim().is_empty()),
        base_url: args.base_url.filter(|s| !s.trim().is_empty()),
        vision: args.vision.unwrap_or(false),
    };
    store::save_settings(&settings).map_err(|e| e.to_string())?;
    log::info!(target: "lilypad::audit", "agent_provider_configured — settings saved");
    Ok(get_agent_config())
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
    let device_name = format!("{} desktop", current_platform());
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
// **Signing in here never links this machine.** That still costs a phone
// approving an enrollment code, and the backend enforces it rather than
// trusting this client to — `/devices/enroll` refuses `kind: "desktop"`.

/// The account this laptop is signed in to, read from the keychain only.
#[tauri::command]
pub fn get_account_state() -> account::AccountState {
    account::Account::state()
}

fn account_client(state: &State<'_, SharedState>) -> account::Account {
    account::Account::new(lock_state(state).backend_base_url.clone())
}

#[tauri::command]
pub async fn account_sign_up(
    state: State<'_, SharedState>,
    name: String,
    email: String,
    password: String,
) -> Result<account::AccountState, String> {
    account_client(&state)
        .sign_up(&name, &email, &password)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn account_sign_in(
    state: State<'_, SharedState>,
    email: String,
    password: String,
) -> Result<account::AccountState, String> {
    account_client(&state)
        .sign_in(&email, &password)
        .await
        .map_err(|e| e.to_string())
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
    state: State<'_, SharedState>,
    email: String,
    code: String,
    password: String,
) -> Result<account::AccountState, String> {
    account_client(&state)
        .confirm_password_reset(&email, &code, &password)
        .await
        .map_err(|e| e.to_string())
}

/// Delete the account permanently — every device, every pairing, every session.
///
/// Distinct from `account_sign_out` in the only way that matters: sign-out is
/// local and reversible, this is neither. It re-authenticates with the password
/// and passes the user's typed address to the server untouched.
#[tauri::command]
pub async fn account_delete(
    state: State<'_, SharedState>,
    confirm_email: String,
    password: String,
) -> Result<(), String> {
    account_client(&state)
        .delete(&confirm_email, &password)
        .await
        .map_err(|e| e.to_string())
}

/// Forget the account session on this machine. Leaves the device key and every
/// pairing alone — removing this computer from the account is done from a
/// phone, and is a different act.
#[tauri::command]
pub fn account_sign_out() -> Result<(), String> {
    account::Account::sign_out().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
