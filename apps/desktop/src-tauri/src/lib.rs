//! Lilypad desktop — Tauri v2 app: floating bubble, tray menu, QR overlay,
//! and approve/deny control window.

// The per-OS backends (CaptureBackend/InputBackend/EncoderBackend) expose a
// complete capability surface that is intentionally ahead of its callers on
// some platforms (e.g. Windows stubs) — allow the not-yet-called methods
// rather than faking calls to them.
#![allow(dead_code)]

mod agent;
mod autostart;
mod commands;
mod health;
mod presence;
mod single_instance;
// Public so a headless example / integration test can drive a real session
// without the Tauri GUI.
pub mod input;
pub mod media;
pub mod permission;
pub mod power;
pub mod rtc;
pub mod session;
pub mod signaling;
mod state;

use std::fs;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

use state::{AppState, SessionStatus, SharedState};

/// Default dev backend; override with the LILYPAD_BACKEND_URL env var.
const DEFAULT_BACKEND_URL: &str = "http://localhost:8080";

/// Persist a stable device id under the app config dir so a laptop keeps the
/// same identity across launches (used to bind pairings; real auth is M5).
fn load_or_create_device_id(app: &tauri::App) -> String {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("device_id");
        if let Ok(existing) = fs::read_to_string(&path) {
            let trimmed = existing.trim().to_string();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
        let id = format!("desktop-{}", uuid::Uuid::new_v4());
        let _ = fs::write(&path, &id);
        return id;
    }
    format!("desktop-{}", uuid::Uuid::new_v4())
}

/// The tray's menu item handles, kept around (via `app.manage`) so their
/// enabled/disabled state can be updated as the session progresses —
/// previously every item was created `true` (enabled) and never touched
/// again, so e.g. clicking "Approve" while idle fell through to
/// `approve_session`'s no-runner fallback and fabricated a fake `Active`
/// session with nothing actually connected. See
/// `docs/audit/m3/desktop-ux.md` Finding 6.
struct TrayHandles {
    show_qr: MenuItem<Wry>,
    approve: MenuItem<Wry>,
    deny: MenuItem<Wry>,
    disconnect: MenuItem<Wry>,
    panic: MenuItem<Wry>,
}

impl TrayHandles {
    /// Enable exactly the actions that are meaningful in `status`, matching
    /// the same `SessionStatus` the bubble/Control window already key off —
    /// one source of truth for "what can I do right now," not three UIs each
    /// guessing independently.
    fn apply(&self, status: SessionStatus) {
        let idle = status == SessionStatus::Idle;
        let awaiting = status == SessionStatus::AwaitingApproval;
        let active = status == SessionStatus::Active;
        // Connecting is a session already in progress (approved, negotiating
        // WebRTC) — same as Active for show_qr (no new pairing mid-session);
        // disconnect/panic are already covered by `!idle` since Connecting
        // isn't Idle. Approve/deny stay disabled: approval already happened.
        let connecting = status == SessionStatus::Connecting;
        let _ = self.show_qr.set_enabled(!(active || connecting));
        let _ = self.approve.set_enabled(awaiting);
        let _ = self.deny.set_enabled(awaiting);
        let _ = self.disconnect.set_enabled(!idle);
        let _ = self.panic.set_enabled(!idle);
    }
}

/// Re-read the current session status and push it to every UI surface that
/// mirrors it independently (today: the tray menu). Call this after any
/// command that can change `AppState.session` — centralized here rather than
/// left to each call site to remember, since forgetting one is exactly how
/// `TrayHandles` went stale in the first place.
pub(crate) fn sync_tray_menu(app: &AppHandle) {
    let Some(tray) = app.try_state::<TrayHandles>() else {
        return; // not yet built (e.g. very early in setup), or running headless in a test
    };
    let state = app.state::<SharedState>();
    let guard = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let status = guard.session;
    drop(guard);
    tray.apply(status);
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open_dashboard =
        MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)?;
    let sep0 = PredefinedMenuItem::separator(app)?;
    let show_qr = MenuItem::with_id(app, "show_qr", "Show QR / Pair", true, None::<&str>)?;
    let approve = MenuItem::with_id(app, "approve", "Approve", false, None::<&str>)?;
    let deny = MenuItem::with_id(app, "deny", "Deny", false, None::<&str>)?;
    let disconnect = MenuItem::with_id(app, "disconnect", "Disconnect", false, None::<&str>)?;
    let panic = MenuItem::with_id(app, "panic", "⛔  Panic disconnect", false, None::<&str>)?;
    let diagnostics = MenuItem::with_id(app, "diagnostics", "Diagnostics…", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit Lilypad"))?;

    let menu = Menu::with_items(
        app,
        &[
            &open_dashboard,
            &sep0,
            &show_qr,
            &approve,
            &deny,
            &sep1,
            &disconnect,
            &panic,
            &sep2,
            &diagnostics,
            &sep3,
            &quit,
        ],
    )?;

    app.manage(TrayHandles {
        show_qr: show_qr.clone(),
        approve: approve.clone(),
        deny: deny.clone(),
        disconnect: disconnect.clone(),
        panic: panic.clone(),
    });

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Lilypad")
        .menu(&menu)
        .show_menu_on_left_click(true);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open_dashboard" => {
                let _ = commands::show_control(app);
            }
            "show_qr" => {
                let _ = commands::show_qr_overlay(app);
            }
            "approve" => {
                // Tray approve never asserts trust — that's a deliberate,
                // visible checkbox decision in the Control window only.
                let _ = commands::approve_session(app.clone(), app.state(), None);
            }
            "deny" => {
                let _ = commands::deny_session(app.clone(), app.state());
            }
            "disconnect" => {
                let _ = commands::disconnect(app.clone(), app.state());
            }
            "panic" => {
                let _ = commands::panic_disconnect(app.clone(), app.state());
            }
            "diagnostics" => {
                let _ = commands::show_diagnostics(app);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `log::` macros are no-ops until a logger is installed — without this,
    // input-injection and session errors vanish instead of reaching stderr.
    // Defaults to `info` for our own crate; override with RUST_LOG as usual.
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("lilypad=info,lilypad_desktop=info"),
    )
    .try_init();

    // Refuse to be the second instance. The launch-at-login LaunchAgent and a
    // manual/dev launch would otherwise both register the same presence room
    // and fight over it at ~1 Hz — the phone-visible "keeps reconnecting"
    // churn. Whoever holds the lock owns the tray, bubble, and presence; a
    // later instance exits here before wiring any of them up. The lock is
    // leaked on purpose so it lives for the whole process (closing its fd
    // would release it).
    match single_instance::try_acquire() {
        Some(lock) => {
            Box::leak(Box::new(lock));
        }
        None => {
            log::info!(
                target: "lilypad::instance",
                "another Lilypad desktop instance is already running — exiting"
            );
            return;
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let device_id = load_or_create_device_id(app);
            let backend = std::env::var("LILYPAD_BACKEND_URL")
                .unwrap_or_else(|_| DEFAULT_BACKEND_URL.to_string());

            app.manage(Mutex::new(AppState::new(device_id, backend)));

            build_tray(app)?;

            // M5.4: standing presence connection so trusted phones can ring
            // this desktop without a QR. Reconnects forever on its own;
            // harmless when the backend is down or pre-M5.4.
            presence::spawn(app.handle().clone());

            // Launch at login (once, on first run) so a trusted phone can
            // reach this Mac whenever it's on and logged in — the "ever
            // ready" behavior. Best-effort; never blocks startup. See
            // `autostart.rs` for the security posture.
            if let Ok(dir) = app.path().app_config_dir() {
                autostart::ensure_first_run_enabled(&dir);
            }

            // First-run (or any-run, if a grant was later revoked) guidance:
            // a passive TCC check with no active request/remediation path
            // left a user to struggle through System Settings unaided. See
            // docs/audit/m3/desktop-ux.md Finding 1. Existing users who
            // already granted both permissions in an earlier build never see
            // this — it's a no-op the moment both read satisfied.
            let screen_capture_ok = matches!(
                permission::screen_capture_status(),
                permission::PermissionStatus::Granted | permission::PermissionStatus::NotApplicable
            );
            let accessibility_ok = matches!(
                permission::accessibility_status(),
                permission::PermissionStatus::Granted | permission::PermissionStatus::NotApplicable
            );
            if !screen_capture_ok || !accessibility_ok {
                let _ = commands::show_setup(app.handle());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::create_pairing,
            commands::show_qr_window,
            commands::simulate_pair_request,
            commands::approve_session,
            commands::deny_session,
            commands::disconnect,
            commands::panic_disconnect,
            commands::get_permission_status,
            commands::request_permission,
            commands::open_permission_settings,
            commands::restart_app,
            commands::get_agent_config,
            commands::set_agent_config,
            commands::list_trusted_devices,
            commands::set_pair_auto_approve,
            commands::revoke_pair,
            commands::get_login_item_enabled,
            commands::set_login_item_enabled,
            commands::show_setup_window,
            commands::show_control_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lilypad desktop");
}
