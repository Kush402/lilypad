//! Provider configuration persistence: non-secret settings in a JSON file,
//! the API key in the macOS keychain — never together.
//!
//! Resolution precedence (implemented in [`super::ProviderChoice::resolve`]):
//! env vars (dev override) → settings file + keychain → none (agent inert).
//!
//! The keychain wrapper shells out to `/usr/bin/security` in **interactive
//! mode** (commands over stdin) so the secret never appears in an argv that
//! `ps` could observe. Service name is fixed; the account is the provider
//! kind, so each provider keeps its own key.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "Lilypad Agent";

/// Non-secret provider selection, persisted as JSON in the app support dir.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    /// "anthropic" | "openai_compat" — matches `ProviderChoice` arms.
    pub provider_kind: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    /// Whether the selected model accepts image input (tier-3 gate).
    #[serde(default)]
    pub vision: bool,
}

fn settings_path() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    Ok(PathBuf::from(home)
        .join("Library/Application Support/Lilypad")
        .join("agent-settings.json"))
}

pub fn load_settings() -> AgentSettings {
    let Ok(path) = settings_path() else {
        return AgentSettings::default();
    };
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => AgentSettings::default(),
    }
}

pub fn save_settings(settings: &AgentSettings) -> Result<()> {
    let path = settings_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("creating settings dir")?;
    }
    let raw = serde_json::to_string_pretty(settings)?;
    std::fs::write(&path, raw).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// Run one `security(1)` interactive command, feeding the command line over
/// stdin (keeps secrets out of argv). Returns stdout on success.
#[cfg(target_os = "macos")]
fn security_interactive(command: &str) -> Result<String> {
    let mut child = Command::new("/usr/bin/security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawning security(1)")?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| anyhow!("no stdin"))?
        .write_all(command.as_bytes())
        .context("writing to security(1)")?;
    let out = child
        .wait_with_output()
        .context("waiting for security(1)")?;
    if !out.status.success() {
        return Err(anyhow!(
            "security(1) failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Quote a value for the security(1) interactive parser: wrap in double
/// quotes, escape backslash + double quote. Keys/kinds are already
/// constrained, but never trust an input into a command string.
#[cfg(target_os = "macos")]
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `security -i` reads one command per LINE, so a value containing a newline is
/// not a value — it is a second command. `quote` escapes backslashes and double
/// quotes, which is what the argument parser needs, and cannot help with a line
/// break because the split happens before parsing.
///
/// This is not only the hostile case. Copying an API key out of a provider's
/// dashboard picks up a line break often enough that it is the ordinary one,
/// and the JS side only trims the ends. Refusing is right either way: no real
/// API key contains a control character, so anything that does is a paste that
/// went wrong, and storing half of it would fail later as an authentication
/// error nobody could explain.
fn reject_control_characters(api_key: &str) -> Result<()> {
    if api_key.chars().any(char::is_control) {
        anyhow::bail!(
            "That key has a line break or control character in it — copy just the key itself and try again."
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn keychain_set(kind: &str, api_key: &str) -> Result<()> {
    reject_control_characters(api_key)?;
    // -U updates in place if the item exists.
    security_interactive(&format!(
        "add-generic-password -U -s {} -a {} -w {}\n",
        quote(KEYCHAIN_SERVICE),
        quote(kind),
        quote(api_key),
    ))
    .map(|_| ())
    // `security(1) failed: SecKeychainAddGenericPassword: User interaction is
    // not allowed.` is what a locked or declined keychain produced on the Ask
    // setup card, verbatim. Same class as the raw HTTP status that used to
    // reach the linking screen.
    .map_err(|err| {
        log::warn!(target: "lilypad::agent", "keychain write failed: {err:#}");
        anyhow!("Lilypad couldn’t save that key to the macOS keychain. If a permission box appeared, allow it and try again.")
    })
}

#[cfg(target_os = "macos")]
pub fn keychain_get(kind: &str) -> Option<String> {
    // `find-generic-password -w` prints the secret alone on stdout.
    let out = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            kind,
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None; // not found (or locked keychain) — treat as unset
    }
    let key = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!key.is_empty()).then_some(key)
}

#[cfg(target_os = "macos")]
pub fn keychain_delete(kind: &str) -> Result<()> {
    security_interactive(&format!(
        "delete-generic-password -s {} -a {}\n",
        quote(KEYCHAIN_SERVICE),
        quote(kind),
    ))
    .map(|_| ())
}

#[cfg(not(target_os = "macos"))]
pub fn keychain_set(_kind: &str, _api_key: &str) -> Result<()> {
    Err(anyhow!(
        "Lilypad can’t store an API key securely on this operating system yet."
    ))
}
#[cfg(not(target_os = "macos"))]
pub fn keychain_get(_kind: &str) -> Option<String> {
    None
}
#[cfg(not(target_os = "macos"))]
pub fn keychain_delete(_kind: &str) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_serde() {
        let s = AgentSettings {
            provider_kind: Some("openai_compat".into()),
            model: Some("some-model".into()),
            base_url: Some("http://localhost:11434/v1".into()),
            vision: true,
        };
        let raw = serde_json::to_string(&s).unwrap();
        assert!(raw.contains("providerKind"));
        let back: AgentSettings = serde_json::from_str(&raw).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn settings_default_on_missing_fields() {
        let back: AgentSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(back, AgentSettings::default());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn quote_escapes_hostile_values() {
        assert_eq!(quote(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    /// `security -i` is line-oriented, so a newline inside a value ends the
    /// command and starts another one. `quote` cannot fix that — the split
    /// happens before the argument parser sees the quotes — so the value is
    /// refused instead.
    ///
    /// The ordinary case is a paste that picked up a line break, not an attack.
    /// Either way, half a key stored silently fails later as an authentication
    /// error nobody can explain.
    #[test]
    fn a_key_with_a_line_break_is_refused_rather_than_split_into_two_commands() {
        for hostile in [
            "sk-real\nadd-generic-password -U -s evil -a evil -w stolen",
            "sk-real\rdelete-generic-password -s lilypad",
            "sk-\u{0}real",
            "sk-real\ttab",
        ] {
            let err = super::reject_control_characters(hostile)
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("line break or control character"),
                "expected a refusal for {hostile:?}, got {err}"
            );
        }
        // A real key is all printable, and must still go through.
        assert!(super::reject_control_characters("sk-ant-api03-AbC_123-xyz").is_ok());
    }
}
