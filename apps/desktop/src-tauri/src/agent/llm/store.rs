//! Provider configuration persistence: non-secret settings in a JSON file,
//! the API key in the macOS keychain — never together.
//!
//! Resolution precedence (implemented in [`super::ProviderChoice::resolve`]):
//! env vars (dev override) → settings file + keychain → none (agent inert).
//!
//! The keychain wrapper shells out to `/usr/bin/security` in **interactive
//! mode** (commands over stdin) so the secret never appears in an argv that
//! `ps` could observe. Service name is fixed; the account names the
//! **destination** the credential belongs to.
//!
//! ### Why the account is a destination and not a provider kind (L-262)
//!
//! It used to be the API dialect: one keychain account, `openai_compat`, for
//! every OpenAI-shaped service in existence. Dialect and destination are
//! different things, and only one of them is who you are trusting. The
//! consequence was direct — the settings form kept the stored key when the key
//! field was left blank, accepted any base URL, and the adapter then sent that
//! key as `Authorization: Bearer` to the new host. Paste an OpenAI key, later
//! point the base URL at a gateway, and the key goes to the gateway. Nothing
//! in the flow ever said so, because nothing in the storage model knew the two
//! settings were related.
//!
//! So a credential is filed under `kind@origin`, where origin is scheme, host
//! and port. Change the origin and the lookup misses: the new destination
//! simply has no key until someone provides one for it. That is the whole
//! mechanism, and it is deliberately not a warning or a confirmation dialog —
//! a key that cannot be found cannot be sent by mistake.
//!
//! One migration consequence, stated plainly: a key stored under the old
//! dialect account is adopted only when the effective origin is that dialect's
//! own default (`api.openai.com`, `api.anthropic.com`). A key that was saved
//! against a custom base URL is *not* carried over, because the old storage
//! cannot tell us which destination it was ever meant for. Those setups
//! re-enter the key once.

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
    /// "anthropic" | "openai_compat" — matches `ProviderChoice` arms. This is
    /// the API dialect: how to talk, not who to. See `profile_id`.
    pub provider_kind: Option<String>,
    /// Stable id of the preset the person chose ("openai", "gemini",
    /// "ollama", "custom"…). Display name and default endpoint come from the
    /// preset table; this is what the UI and both devices name.
    #[serde(default)]
    pub profile_id: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    /// Whether the selected model accepts image input (tier-3 gate).
    ///
    /// `None` means *never verified*, which is not the same as "no" and very
    /// much not the same as "yes" (L-263). Old settings files stored a bare
    /// bool and deserialize into `Some`, which is correct: that value was a
    /// real answer at the time. The runner treats `None` as no capability, so
    /// an unverified model is text-only rather than optimistically visual.
    #[serde(default)]
    pub vision: Option<bool>,
    /// Whether one complete tool-call round trip has been observed. Same
    /// three-state meaning as `vision`.
    #[serde(default)]
    pub tools: Option<bool>,
    /// When the capabilities above were last verified, RFC 3339. `None` while
    /// they are untested.
    #[serde(default)]
    pub verified_at: Option<String>,
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
    // Anything cached about the previous settings is now about a configuration
    // that is no longer in force.
    super::resolver::invalidate();
    let path = settings_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("creating settings dir")?;
    }
    let raw = serde_json::to_string_pretty(settings)?;
    std::fs::write(&path, raw).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

// ── credential destinations (L-262) ──────────────────────────────────────

/// The endpoint a dialect talks to when no base URL is given.
pub fn default_base_url(kind: &str) -> Option<&'static str> {
    match kind {
        "anthropic" => Some(super::anthropic::DEFAULT_BASE_URL),
        "openai_compat" => Some(super::openai_compat::DEFAULT_BASE_URL),
        _ => None,
    }
}

/// Scheme, host and port of `base_url`, with no path, lowercased and with the
/// default port elided — the identity of a destination.
///
/// Path is deliberately excluded: `/v1` versus `/v1/` versus `/openai/v1` on
/// one host is the same party holding the same key. Host is not: that is a
/// different party entirely.
pub fn origin_of(base_url: &str) -> Result<String> {
    let parsed = url::Url::parse(base_url.trim())
        .map_err(|_| anyhow!("`{base_url}` is not a valid URL"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("`{base_url}` has no host"))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        anyhow::bail!("`{base_url}` must be an http or https address");
    }
    Ok(match parsed.port() {
        Some(port) => format!("{scheme}://{}:{port}", host.to_ascii_lowercase()),
        None => format!("{scheme}://{}", host.to_ascii_lowercase()),
    })
}

/// Is this destination on the loopback interface?
///
/// The one case where plain HTTP is legitimate: a local model. `localhost`
/// included, because that is what Ollama's own documentation tells people to
/// type, and a name that does not resolve to loopback is not accepted.
pub fn is_local_origin(origin: &str) -> bool {
    is_loopback(origin)
}

fn is_loopback(origin: &str) -> bool {
    let Ok(parsed) = url::Url::parse(origin) else {
        return false;
    };
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(name)) => {
            let name = name.to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
        None => false,
    }
}

/// Refuse to bind a credential to a destination that cannot protect it.
///
/// A key sent over plain HTTP to a host that is not this machine is a key
/// handed to whatever is between them. Local transport stays allowed and
/// explicit, which is the documented keyless/local-model case — it is not a
/// licence to reuse a hosted key there.
pub fn check_transport(origin: &str) -> Result<()> {
    if origin.starts_with("https://") || is_loopback(origin) {
        return Ok(());
    }
    anyhow::bail!(
        "{origin} is a plain http address that is not on this Mac.          An API key sent there is readable in transit — use https, or a local model on localhost."
    )
}

/// The keychain account a credential for (`kind`, `base_url`) lives under.
pub fn credential_account(kind: &str, base_url: Option<&str>) -> Result<String> {
    let effective = base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| default_base_url(kind).map(str::to_string))
        .ok_or_else(|| anyhow!("unknown provider kind `{kind}`"))?;
    let origin = origin_of(&effective)?;
    check_transport(&origin)?;
    Ok(format!("{kind}@{origin}"))
}

/// Was this destination the dialect's own default? Only then may a key stored
/// under the pre-L-262 dialect account be adopted — see the module notes.
fn is_default_destination(kind: &str, base_url: Option<&str>) -> bool {
    let Some(default) = default_base_url(kind) else {
        return false;
    };
    let Ok(default_origin) = origin_of(default) else {
        return false;
    };
    match base_url.map(str::trim).filter(|s| !s.is_empty()) {
        None => true,
        Some(given) => origin_of(given).is_ok_and(|origin| origin == default_origin),
    }
}

/// The key for this exact destination.
///
/// `Ok(None)` is "no key for this destination"; `Err` is "the store did not
/// answer". Collapsing the second into the first is what made a locked keychain
/// look like an unconfigured Mac (L-271).
pub fn credential_for(
    kind: &str,
    base_url: Option<&str>,
) -> std::result::Result<Option<String>, SecretUnavailable> {
    let Ok(account) = credential_account(kind, base_url) else {
        return Ok(None);
    };
    if let Some(key) = keychain_get(&account)? {
        return Ok(Some(key));
    }
    // One-time adoption of a pre-L-262 key, and only at the default endpoint.
    if is_default_destination(kind, base_url) {
        return keychain_get(kind);
    }
    Ok(None)
}

/// Store a key for this exact destination.
pub fn store_credential(kind: &str, base_url: Option<&str>, api_key: &str) -> Result<()> {
    let account = credential_account(kind, base_url)?;
    let result = keychain_set(&account, api_key);
    // A rotated key changes nothing visible in the settings file, so nothing
    // else would notice (L-278, L-282).
    super::resolver::invalidate();
    result
}

/// Forget the key for this destination, and the legacy dialect-wide item it
/// may have been adopted from — a disconnect that leaves a usable copy behind
/// is not a disconnect (L-274).
pub fn forget_credential(kind: &str, base_url: Option<&str>) -> Result<()> {
    let mut first_error = None;
    if let Ok(account) = credential_account(kind, base_url) {
        // A store that will not say whether the item is there is not a store
        // that can be trusted to have removed it. Attempt the delete anyway and
        // report what happens.
        if !matches!(keychain_get(&account), Ok(None)) {
            if let Err(e) = keychain_delete(&account) {
                first_error = Some(e);
            }
        }
    }
    if !matches!(keychain_get(kind), Ok(None)) {
        if let Err(e) = keychain_delete(kind) {
            first_error = first_error.or(Some(e));
        }
    }
    // Whatever happened, what any resolver believes about the credential is now
    // wrong (L-278).
    super::resolver::invalidate();
    match first_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

// ── bounding the secret store (L-271) ────────────────────────────────────
//
// `security(1)` can block indefinitely: a locked keychain, or an
// authorization dialog nobody is looking at. The first attempt at bounding
// this wrapped the call in `tokio::time::timeout` around `spawn_blocking`,
// which bounds *waiting* and not the work. The process stayed, the pool
// thread stayed, and the next attempt started another one.
//
// A deadline has to be able to end the thing it is a deadline for. So the
// child is spawned rather than run to completion, polled, and **killed and
// reaped** when it overruns.

/// How long one `security(1)` invocation may take before it is killed.
pub const SECRET_STORE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// The secret store could not answer. Distinct from "there is no key": one is
/// a fact about the person's configuration, the other is a fact about this
/// moment, and they need different words in front of them.
#[derive(Debug, Clone)]
pub struct SecretUnavailable(pub String);

impl std::fmt::Display for SecretUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for SecretUnavailable {}

/// Run a child to completion, or kill it when it overruns `deadline`.
#[cfg(target_os = "macos")]
fn wait_bounded(
    mut child: std::process::Child,
    deadline: std::time::Duration,
) -> std::result::Result<std::process::Output, SecretUnavailable> {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SecretUnavailable(format!("the macOS keychain failed: {e}")));
            }
        }
        if start.elapsed() >= deadline {
            // Kill AND reap. Killing without waiting leaves a zombie, which is
            // the same accumulation in a different form.
            let _ = child.kill();
            let _ = child.wait();
            return Err(SecretUnavailable(
                "The macOS keychain did not answer. If a permission box is waiting on the Mac, \
                 allow it, then try again."
                    .to_string(),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    child
        .wait_with_output()
        .map_err(|e| SecretUnavailable(format!("the macOS keychain failed: {e}")))
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
    // Close stdin so `security -i` sees end of input and exits rather than
    // waiting for more commands.
    drop(child.stdin.take());
    let out = wait_bounded(child, SECRET_STORE_DEADLINE).map_err(|e| anyhow!("{e}"))?;
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
            "That key has a line break or control character in it. Copy just the key itself and try again."
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

/// The stored key for one account.
///
/// `Ok(None)` means the store answered and there is no such item.
/// `Err` means the store did not answer, which is a different thing and must
/// not be reported as "no key configured" (L-271).
#[cfg(target_os = "macos")]
pub fn keychain_get(kind: &str) -> std::result::Result<Option<String>, SecretUnavailable> {
    // `find-generic-password -w` prints the secret alone on stdout.
    let child = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            kind,
            "-w",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| SecretUnavailable(format!("could not ask the macOS keychain: {e}")))?;
    let out = wait_bounded(child, SECRET_STORE_DEADLINE)?;
    if !out.status.success() {
        // `security` exits non-zero both for "no such item" and for a refused
        // read. The message distinguishes them; anything else is treated as an
        // answer of "not there", which is the direction that fails closed.
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("interaction is not allowed") || stderr.contains("User canceled") {
            return Err(SecretUnavailable(
                "The macOS keychain refused to release the saved key. Unlock it, or allow the \
                 permission box, then try again."
                    .to_string(),
            ));
        }
        return Ok(None);
    }
    let key = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!key.is_empty()).then_some(key))
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
pub fn keychain_get(_kind: &str) -> std::result::Result<Option<String>, SecretUnavailable> {
    Ok(None)
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
            profile_id: Some("ollama".into()),
            model: Some("some-model".into()),
            base_url: Some("http://localhost:11434/v1".into()),
            vision: Some(true),
            tools: Some(true),
            verified_at: Some("2026-09-09T00:00:00Z".into()),
        };
        let raw = serde_json::to_string(&s).unwrap();
        assert!(raw.contains("providerKind"));
        let back: AgentSettings = serde_json::from_str(&raw).unwrap();
        assert_eq!(back, s);
    }

    /// A settings file written before capabilities were three-state still says
    /// what it said. `vision: false` was an answer, not an absence.
    #[test]
    fn a_pre_capability_settings_file_keeps_its_answer() {
        let old: AgentSettings = serde_json::from_str(
            r#"{"providerKind":"anthropic","model":"m","vision":true}"#,
        )
        .unwrap();
        assert_eq!(old.vision, Some(true));
        assert_eq!(old.tools, None, "tools was never recorded, so it is untested");
        let never: AgentSettings =
            serde_json::from_str(r#"{"providerKind":"anthropic"}"#).unwrap();
        assert_eq!(never.vision, None);
    }

    #[test]
    fn an_origin_is_scheme_host_and_port_only() {
        for (input, want) in [
            ("https://api.openai.com/v1", "https://api.openai.com"),
            ("https://API.OpenAI.com/v1/", "https://api.openai.com"),
            ("https://api.openai.com/openai/v1", "https://api.openai.com"),
            ("http://localhost:11434/v1", "http://localhost:11434"),
            ("https://gw.example.com:8443/x", "https://gw.example.com:8443"),
        ] {
            assert_eq!(origin_of(input).unwrap(), want, "for {input}");
        }
        assert!(origin_of("not a url").is_err());
        assert!(origin_of("ftp://example.com").is_err());
    }

    /// L-262. The account is the destination, so the same key cannot follow a
    /// changed base URL to a different host.
    #[test]
    fn a_credential_account_changes_when_the_destination_does() {
        let openai = credential_account("openai_compat", None).unwrap();
        assert_eq!(openai, "openai_compat@https://api.openai.com");
        // Same dialect, different party: a different account, so the lookup
        // for the gateway simply finds nothing.
        let gateway =
            credential_account("openai_compat", Some("https://gw.example.com/v1")).unwrap();
        assert_ne!(openai, gateway);
        // Same party, different path: the same account.
        assert_eq!(
            credential_account("openai_compat", Some("https://api.openai.com/v1/")).unwrap(),
            openai
        );
        // Anthropic keeps its own destination even though both are "hosted".
        assert_ne!(
            credential_account("anthropic", None).unwrap(),
            credential_account("openai_compat", None).unwrap()
        );
    }

    #[test]
    fn a_key_is_never_bound_to_a_destination_that_cannot_protect_it() {
        assert!(check_transport("https://api.openai.com").is_ok());
        assert!(check_transport("http://localhost:11434").is_ok());
        assert!(check_transport("http://127.0.0.1:8080").is_ok());
        assert!(check_transport("http://[::1]:8080").is_ok());
        let err = check_transport("http://gw.example.com")
            .unwrap_err()
            .to_string();
        assert!(err.contains("plain http"), "{err}");
        assert!(credential_account("openai_compat", Some("http://gw.example.com/v1")).is_err());
    }

    /// The migration rule, stated as a test so it cannot drift: a pre-L-262
    /// key is adopted at the dialect's own default endpoint and nowhere else.
    #[test]
    fn a_legacy_key_is_adopted_only_at_the_default_endpoint() {
        assert!(is_default_destination("openai_compat", None));
        assert!(is_default_destination(
            "openai_compat",
            Some("https://api.openai.com/v1")
        ));
        assert!(!is_default_destination(
            "openai_compat",
            Some("https://gw.example.com/v1")
        ));
        assert!(!is_default_destination(
            "openai_compat",
            Some("http://localhost:11434/v1")
        ));
        assert!(is_default_destination("anthropic", None));
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
