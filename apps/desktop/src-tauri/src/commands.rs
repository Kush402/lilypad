//! Tauri commands invoked from the React UI.
//!
//! Windows are label-based: every window loads `index.html` and the frontend
//! renders bubble / qr-overlay / control / diagnostics based on its window
//! label.

use std::sync::MutexGuard;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::mpsc::unbounded_channel;

use crate::session::{run_session, Control, SessionEvent};
use crate::state::{AppState, AppStateDto, PendingRequest, SessionStatus, SharedState};

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
    }
}

/// Ask the backend for a fresh single-use pairing token and open the QR overlay.
#[tauri::command]
pub async fn create_pairing(
    app: AppHandle,
    state: State<'_, SharedState>,
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

    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("could not reach backend at {url}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("backend returned HTTP {}", resp.status()));
    }

    let parsed: BackendPairingResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad backend response: {e}"))?;

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

    open_window(&app, "qr-overlay", "Lilypad — Pair", 360.0, 500.0)?;
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

    {
        let state = app.state::<SharedState>();
        let mut s = lock_state(&state);
        s.control_tx = Some(control_tx);
        s.current_room_id = Some(room_id.clone());
        s.offered_scopes = offered_scopes;
        s.session = SessionStatus::Pairing;
        s.pending_request = None;
    }

    // Forward runner events to the UI + update coarse session state.
    let app_ev = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = event_rx.recv().await {
            apply_session_event(&app_ev, &ev);
            let _ = app_ev.emit("lilypad://session", ev);
        }
    });

    // Drive the session.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_session(signaling_url, room_id, device_id, control_rx, event_tx).await {
            log::error!(target: "lilypad::session", "session runner error: {e}");
        }
    });
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
            // fresh offer) — nothing is "pending" anymore.
            s.pending_request = None;
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
        SessionEvent::Ended { .. } => {
            s.session = SessionStatus::Idle;
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
        open_window(&app, "control", "Lilypad — Session", 400.0, 560.0)?;
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
    open_window(&app, "qr-overlay", "Lilypad — Pair", 360.0, 500.0)
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
/// (Finding 8's fix applies here too). Stops itself once both permissions
/// are satisfied or the window closes, so no timer runs for the rest of the
/// app's life once setup is done.
pub fn show_setup(app: &AppHandle) -> Result<(), String> {
    let already_open = app.get_webview_window("setup").is_some();
    open_window(app, "setup", "Lilypad — Setup", 460.0, 440.0)?;
    if !already_open {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(700));
            loop {
                interval.tick().await;
                if app.get_webview_window("setup").is_none() {
                    break;
                }
                let snapshot = permission_snapshot();
                let _ = app.emit("lilypad://permission", snapshot);
                if snapshot.screen_capture && snapshot.accessibility {
                    break;
                }
            }
        });
    }
    Ok(())
}

// ── window helpers (also called from the tray menu in lib.rs) ────────────────

pub fn show_diagnostics(app: &AppHandle) -> Result<(), String> {
    open_window(app, "diagnostics", "Lilypad — Diagnostics", 420.0, 420.0)
}

pub fn show_qr_overlay(app: &AppHandle) -> Result<(), String> {
    open_window(app, "qr-overlay", "Lilypad — Pair", 360.0, 500.0)
}

pub fn show_control(app: &AppHandle) -> Result<(), String> {
    open_window(app, "control", "Lilypad — Session", 400.0, 560.0)
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
fn open_window(app: &AppHandle, label: &str, title: &str, w: f64, h: f64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(w, h)
        .resizable(false)
        .always_on_top(true)
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
    if let Some(key) = args.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
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
