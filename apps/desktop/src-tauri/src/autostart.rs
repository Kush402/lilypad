//! Login-item autostart (macOS LaunchAgent).
//!
//! So a trusted phone can reach the Mac "whenever it's turned on and logged
//! in", Lilypad installs a per-user LaunchAgent that relaunches it at login.
//! It's enabled once on first run (the user can turn it off in the dashboard;
//! we never re-force it after that).
//!
//! Security posture (this is a background app that can stream the screen and
//! inject input, so autostart deserves scrutiny):
//!   - `LimitLoadToSessionType = Aqua` means it launches ONLY inside a
//!     logged-in GUI session — never at boot, never before login, never on
//!     the login window. Physical/login access is still required.
//!   - It grants NO new capability: screen capture and input injection each
//!     still need their own macOS TCC permission (per-app, user-controlled),
//!     and every session is gated by device trust + the per-pair connect
//!     secret, shows a visible indicator, and can be killed from the tray.
//!   - Autostart only keeps the *presence channel* ready to receive a ring —
//!     it can start no session on its own.
//!
//! Uses a hand-written plist rather than a plugin so there's no new
//! dependency and the exact contract above is visible in one place.

use std::fs;
use std::path::PathBuf;

const LABEL: &str = "com.lilypad.desktop";

fn launch_agents_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/LaunchAgents"))
}

fn plist_path() -> Option<PathBuf> {
    Some(launch_agents_dir()?.join(format!("{LABEL}.plist")))
}

/// Is the login item currently installed?
pub fn is_enabled() -> bool {
    plist_path().is_some_and(|p| p.exists())
}

/// Install the LaunchAgent pointing at the currently-running executable.
pub fn enable() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot resolve own path: {e}"))?;
    let dir = launch_agents_dir().ok_or("no HOME directory")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy();
    // Minimal, well-scoped agent: launch at login inside the GUI session, do
    // not respawn on quit (no KeepAlive), no pre-login load.
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{exe}</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
"#,
        exe = xml_escape(&exe_str),
    );
    let path = plist_path().ok_or("no HOME directory")?;
    fs::write(&path, plist).map_err(|e| e.to_string())?;
    log::info!(target: "lilypad::audit", "login_item enabled ({})", path.display());
    Ok(())
}

/// Remove the LaunchAgent.
pub fn disable() -> Result<(), String> {
    if let Some(path) = plist_path() {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    log::info!(target: "lilypad::audit", "login_item disabled");
    Ok(())
}

/// Enable the login item once, on first run — tracked by a marker in the app
/// config dir so a user who later disables it isn't overridden on the next
/// launch. Best-effort: a failure here must never block app startup.
pub fn ensure_first_run_enabled(config_dir: &std::path::Path) {
    let marker = config_dir.join("login_item_initialized");
    if marker.exists() {
        return; // already made the one-time decision
    }
    let _ = fs::create_dir_all(config_dir);
    if let Err(e) = enable() {
        log::warn!(target: "lilypad::autostart", "first-run login-item enable failed: {e}");
        return; // don't write the marker — retry next launch
    }
    let _ = fs::write(&marker, b"1");
}

/// Escape the five XML entities so an exotic path can't break the plist.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_escape_neutralizes_markup() {
        assert_eq!(
            xml_escape(r#"/a&b<c>"d'"#),
            "/a&amp;b&lt;c&gt;&quot;d&apos;"
        );
    }
}
