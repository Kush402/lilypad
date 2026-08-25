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
mod logfile;
mod presence;
mod single_instance;
// Public so a headless example / integration test can drive a real session
// without the Tauri GUI.
pub mod account;
pub mod auth;
pub mod clipboard;
pub mod identity;
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

/// Where this build talks to, absent a `LILYPAD_BACKEND_URL` override.
///
/// This is split by build profile because the two builds have different users.
/// A debug build is run by a developer from a terminal with a backend on
/// :8080. A release build is double-clicked from /Applications by a customer
/// who has no backend, no terminal, and — critically — **no environment**:
/// macOS launches GUI apps from launchd, which does not inherit the shell, so
/// an env var is not a mechanism a customer can be served by. Shipping the dev
/// default in a release build meant every downloaded copy reached for
/// localhost:8080 and found nothing, which is exactly what v0.1.0 did.
///
/// Written as a function of the profile rather than two `#[cfg]` constants so
/// both branches are reachable from one test run — the release value is the
/// one that broke, and a test that can only see its own profile's value is
/// exactly the test that missed this.
const fn default_backend_url(debug_build: bool) -> &'static str {
    if debug_build {
        "http://localhost:8080"
    } else {
        "https://api.takedia.com"
    }
}

const DEFAULT_BACKEND_URL: &str = default_backend_url(cfg!(debug_assertions));

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
    fn apply(&self, status: SessionStatus, pairable: bool) {
        let idle = status == SessionStatus::Idle;
        let awaiting = status == SessionStatus::AwaitingApproval;
        let active = status == SessionStatus::Active;
        // Connecting is a session already in progress (approved, negotiating
        // WebRTC) — same as Active for show_qr (no new pairing mid-session);
        // disconnect/panic are already covered by `!idle` since Connecting
        // isn't Idle. Approve/deny stay disabled: approval already happened.
        let connecting = status == SessionStatus::Connecting;
        // …and only when this computer is on an account. Pairing an unowned
        // machine writes a trust relationship nobody can see or revoke
        // (ADR-0010), so "Show QR / Pair" is not an action that exists yet —
        // the same reasoning that already disables Approve while idle. The
        // dashboard is where the missing step lives, and clicking through the
        // bubble or the "+" leads there.
        let _ = self
            .show_qr
            .set_enabled(!(active || connecting) && pairable);
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
    let pairable = pairing_is_meaningful(&guard.link_state);
    drop(guard);
    tray.apply(status, pairable);
}

/// Whether offering to pair is meaningful right now.
///
/// Pairing writes a trust relationship — which phone may reach this Mac — and
/// on a computer no account owns, that relationship belongs to nobody: it
/// appears in no "Your devices" list and can be revoked from nowhere.
/// [ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md) rejected
/// that state outright, and `docs/api.md` recorded the backend's unowned lane
/// as a migration allowance ending "when P1 makes enrolment mandatory".
///
/// `Unknown` is deliberately pairable. It means the backend could not be
/// **asked**, not that this machine is unowned — the whole reason `LinkState`
/// keeps them apart. Disabling on it would tell a linked user their computer is
/// on no account because their wifi blipped. `create_pairing` re-checks for
/// real at click time, so being wrong in this direction costs an honest error
/// rather than a false claim.
fn pairing_is_meaningful(link: &auth::LinkState) -> bool {
    !matches!(
        link,
        auth::LinkState::Unlinked | auth::LinkState::Revoked | auth::LinkState::NoIdentity
    )
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open_dashboard =
        MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)?;
    let sep0 = PredefinedMenuItem::separator(app)?;
    // Starts DISABLED and is enabled by the first `sync_tray_menu` once the
    // link state is known. A fresh install is unlinked, and offering to pair it
    // before anyone has signed in is the ordering this whole change fixes.
    let show_qr = MenuItem::with_id(app, "show_qr", "Show QR / Pair", false, None::<&str>)?;
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
    // ...and to a file, because stderr goes nowhere for a `.app` launched from
    // Finder or by the login-item LaunchAgent. Without this, a customer
    // reporting a bad session leaves no evidence on their own machine — see
    // `logfile`. Falls back to stderr alone if the file cannot be opened.
    let mut builder = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("lilypad=info,lilypad_desktop=info"),
    );
    if let Some(target) = logfile::target() {
        builder.target(env_logger::Target::Pipe(target));
    }
    let _ = builder.try_init();
    if let Some(path) = logfile::path() {
        log::info!(target: "lilypad::logging", "logging to {}", path.display());
    }

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

    let mut builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());

    // Automatic updates (M6). Both plugins are desktop-only; `relaunch()` after
    // a successful install lives in the process plugin. Guarded so a future
    // mobile build (see `mobile_entry_point` above) still compiles.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .setup(|app| {
            let device_id = load_or_create_device_id(app);
            let backend = std::env::var("LILYPAD_BACKEND_URL")
                .unwrap_or_else(|_| DEFAULT_BACKEND_URL.to_string());

            // This computer's authenticated relationship with the backend
            // (M9). Managed separately from `AppState` because obtaining a
            // token is async and `AppState` lives behind a sync Mutex — a
            // command must never hold that lock across a network round trip.
            app.manage(std::sync::Arc::new(auth::DesktopAuth::new(backend.clone())));

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

            // Ask once, at launch, so the tray settles on the truth without
            // waiting for someone to open the dashboard. One request, not a
            // poller: every surface that cares already polls `get_link_state`
            // while it is open, and that call keeps this cache current.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let link = handle
                    .state::<std::sync::Arc<auth::DesktopAuth>>()
                    .link_state()
                    .await;
                {
                    let state = handle.state::<state::SharedState>();
                    let mut guard = state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    guard.link_state = link;
                }
                sync_tray_menu(&handle);
            });

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
            commands::get_link_state,
            commands::start_enrollment,
            commands::get_login_item_enabled,
            commands::set_login_item_enabled,
            commands::show_setup_window,
            commands::show_control_window,
            commands::log_file_path,
            commands::reveal_log_file,
            commands::get_account_state,
            commands::account_sign_up,
            commands::account_sign_in,
            commands::account_email_available,
            commands::account_request_password_reset,
            commands::account_confirm_password_reset,
            commands::account_sign_out,
            commands::account_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lilypad desktop");
}

#[cfg(test)]
mod pairing_order_tests {
    use super::*;
    use crate::auth::LinkState;

    /// Reported from the running app: "Show QR / Pair" sat enabled in the tray,
    /// and the dashboard's "+" alongside it, on a computer nobody had signed
    /// into or linked. The dashboard mirrors this exact rule
    /// (`PairOrdering.test.tsx`); this is the tray's half.
    #[test]
    fn an_unowned_computer_is_not_offered_for_pairing() {
        assert!(!pairing_is_meaningful(&LinkState::Unlinked));
        assert!(!pairing_is_meaningful(&LinkState::Revoked));
        assert!(!pairing_is_meaningful(&LinkState::NoIdentity));
    }

    #[test]
    fn a_linked_computer_is() {
        assert!(pairing_is_meaningful(&LinkState::Linked {
            user_id: "u".to_owned(),
            device_id: "d".to_owned(),
        }));
    }

    /// "Could not ask" is not "nobody owns it". Refusing here would repeat the
    /// exact mistake `LinkState::Unknown` was introduced to prevent.
    #[test]
    fn an_unreachable_backend_does_not_revoke_the_offer() {
        assert!(pairing_is_meaningful(&LinkState::Unknown(
            "connection refused".to_owned()
        )));
    }

    /// v0.1.0 shipped with the dev backend as the release default, so every
    /// downloaded copy tried localhost:8080 and reached nothing. macOS starts
    /// GUI apps from launchd with no shell environment, so `LILYPAD_BACKEND_URL`
    /// could not rescue a customer — the compiled-in value is the only one they
    /// ever get. Both branches are asserted because the release branch is the
    /// one that cannot be observed from a normal `cargo test`.
    #[test]
    fn a_release_build_never_ships_the_developer_backend() {
        let release = default_backend_url(false);
        assert_eq!(release, "https://api.takedia.com");
        assert!(
            !release.contains("localhost") && !release.contains("127.0.0.1"),
            "release builds must not point at a developer machine, got {release}"
        );
        // presence.rs derives signaling from this base and maps https -> wss,
        // so an http release default would also silently downgrade the socket.
        assert!(release.starts_with("https://"), "got {release}");

        assert_eq!(default_backend_url(true), "http://localhost:8080");
    }

    /// The updater endpoint has to be reachable by a stranger.
    ///
    /// It used to be `github.com/Kush402/lilypad/releases/latest/download/…`,
    /// and the repository was private: every installed copy's update check got
    /// a 404, and the launch banner surfaced it as "Update check failed"
    /// because `phase == "error"` is one of the states it shows. The same 404
    /// was on the website's download button, so nobody outside the org could
    /// install Lilypad OR update it.
    ///
    /// The repository became public on 2026-08-23, so those URLs would resolve
    /// today. The rule stays: an installed copy checks for updates for years,
    /// and one click on a repository setting would break every one of them at
    /// once. Downloads are served from the site, which the `site` workflow
    /// fetches anonymously and byte-compares on every deploy — the failure is
    /// otherwise invisible from inside the org, because an authenticated
    /// browser and an authenticated `gh` both make a broken URL look fine.
    #[test]
    fn the_updater_endpoint_is_reachable_without_a_github_account() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let endpoints = conf["plugins"]["updater"]["endpoints"]
            .as_array()
            .expect("tauri.conf.json must configure updater endpoints");
        assert!(!endpoints.is_empty(), "at least one endpoint is required");

        for endpoint in endpoints {
            let url = endpoint.as_str().expect("each endpoint is a string");
            assert!(
                !url.contains("github.com"),
                "update URLs must not depend on repository visibility — one toggle 404s \
                 every installed copy's update check at once; got {url}"
            );
            assert!(
                url.starts_with("https://lilypadhome.takedia.com/"),
                "updates are served from the public site; got {url}"
            );
        }
    }
}
