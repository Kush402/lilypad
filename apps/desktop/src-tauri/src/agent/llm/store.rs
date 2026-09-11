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
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

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
    /// Whether the person allowed Ask to take screenshots at all. Their
    /// choice, not a measurement — a probe may never write this (L-286).
    ///
    /// `None` is "never asked", which the runner reads as no.
    #[serde(default)]
    pub allow_screenshots: Option<bool>,
    /// Whether the selected model **was observed** to accept image input
    /// (tier-3 gate).
    ///
    /// `None` means *never verified*, which is not the same as "no" and very
    /// much not the same as "yes" (L-263). Only the probe writes this, and
    /// only against the configuration it tested (L-282, L-286).
    #[serde(default)]
    pub vision: Option<bool>,
    /// Whether one complete tool-call round trip has been observed. Same
    /// three-state meaning as `vision`.
    #[serde(default)]
    pub tools: Option<bool>,
    /// When the capabilities above were last verified, RFC 3339. `None` while
    /// they are untested. Written only by a check that actually measured them.
    #[serde(default)]
    pub verified_at: Option<String>,
    /// What the last check against this exact configuration concluded, pass or
    /// fail — kept apart from the capabilities above (L-293).
    ///
    /// A request that never reached a model measured nothing. Folding "the key
    /// was rejected" into `tools = false` told a person their model does not
    /// support tool calling, which was neither true nor actionable, and it
    /// survived a reload as a permanent verdict on a model that had never been
    /// asked. Capability is what was proven; this is what happened last.
    #[serde(default)]
    pub last_check: Option<LastCheck>,
}

/// The outcome of the most recent connection check.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCheck {
    /// RFC 3339, when it ran.
    pub at: String,
    /// The failure kind, as `FailureKind` serializes it. `None` means it
    /// passed — which is the only state in which `tools`/`vision` were
    /// written by that run.
    #[serde(default)]
    pub failure: Option<String>,
    /// The provider's own words, already classified for the person.
    #[serde(default)]
    pub message: Option<String>,
}

fn settings_path() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    Ok(PathBuf::from(home)
        .join("Library/Application Support/Lilypad")
        .join("agent-settings.json"))
}

// ── one writer, one committed generation (L-278) ─────────────────────────
//
// The first attempt at L-278 gave the resolver an epoch and rejected a
// publication made under a superseded one. That is necessary and it is not
// sufficient, because the epoch was bumped **before** the settings file was
// written and nothing serialised the two. Three things went wrong in the gap:
//
//   - a resolution starting after the bump and before the write read the OLD
//     provider under the NEW epoch, and could then publish it as current;
//   - `std::fs::write` truncates first, so a concurrent reader could parse a
//     half-written file and fall back to defaults;
//   - the verification path did an unlocked read, compare and whole-snapshot
//     write, so a save landing in between was silently reverted (L-282).
//
// So every read and write of this file goes through one lock, the file is
// replaced atomically by rename, and the epoch is bumped **after** the new
// contents are committed. A reader therefore always observes a complete
// settings file together with the generation that describes it.

/// Serialises settings reads and writes for the whole process.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn settings_guard() -> std::sync::MutexGuard<'static, ()> {
    // A panic in another holder must not make the settings permanently
    // unreadable; the data it guards is a plain file, not an invariant.
    SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn read_at(path: &Path) -> AgentSettings {
    match std::fs::read_to_string(path) {
        Ok(raw) => migrate(serde_json::from_str(&raw).unwrap_or_default()),
        Err(_) => AgentSettings::default(),
    }
}

/// Before L-286 one field was both "let Ask take screenshots" and "this model
/// was observed to accept images". They are different claims by different
/// authors, so the stored value is read as the one the person actually made —
/// the checkbox — and the measurement survives only where a probe recorded it,
/// which is exactly what `verified_at` marks.
fn migrate(mut settings: AgentSettings) -> AgentSettings {
    if settings.allow_screenshots.is_none() {
        settings.allow_screenshots = settings.vision;
        if settings.verified_at.is_none() {
            settings.vision = None;
        }
    }
    settings
}

/// Replace the settings file atomically, then invalidate.
///
/// Rename over the same directory is the only write a concurrent reader cannot
/// catch half-done. The invalidation comes last so that no resolution can read
/// the new contents under the old generation, or the old contents under the
/// new one.
fn write_at(path: &Path, settings: &AgentSettings) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("creating settings dir")?;
    }
    let raw = serde_json::to_string_pretty(settings)?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, raw).with_context(|| format!("writing {}", tmp.display()))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("replacing {}", path.display()));
    }
    // Last, and only on success: anything cached now describes a configuration
    // that is no longer in force.
    super::resolver::invalidate();
    Ok(())
}

pub fn load_settings() -> AgentSettings {
    load_committed().0
}

/// The settings **and** the generation they were committed under, read
/// together so a resolution can prove its answer describes them (L-278).
pub fn load_committed() -> (AgentSettings, u64) {
    let Ok(path) = settings_path() else {
        return (AgentSettings::default(), super::resolver::epoch());
    };
    committed_at(&path)
}

/// The one critical section that makes the generation mean anything: the file
/// contents and the generation are taken together, so no caller can attribute
/// one configuration to another's generation.
fn committed_at(path: &Path) -> (AgentSettings, u64) {
    let _guard = settings_guard();
    (read_at(path), super::resolver::epoch())
}

pub fn save_settings(settings: &AgentSettings) -> Result<()> {
    save_at(&settings_path()?, settings)
}

fn save_at(path: &Path, settings: &AgentSettings) -> Result<()> {
    let _guard = settings_guard();
    write_at(path, settings)
}

/// May Ask actually send an image?
///
/// Two separate facts, and both are required (L-286). The person allowed
/// screenshots, and the selected model was **observed** to accept one. Either
/// alone is not image input: permission over an untested model is optimism,
/// and a tested model without permission is the product deciding for them.
pub fn effective_vision(settings: &AgentSettings) -> bool {
    settings.allow_screenshots.unwrap_or(false) && settings.vision == Some(true)
}

/// What happened to a verification result that arrived late.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verification {
    /// Filed against the configuration it describes.
    Recorded,
    /// The saved configuration moved on while the probe was running. The
    /// result is still true about what it tested; it is not true about what is
    /// saved, so it is not written.
    Superseded,
}

/// File a probe result, but only if the saved configuration is still the one
/// that was probed (L-282).
///
/// A compare-and-swap, not a read-modify-write of a snapshot taken minutes
/// ago: the settings are re-read inside the lock and only the three
/// verification fields are touched, so a save, a key replacement or a
/// disconnect that happened while the probe ran survives instead of being
/// reverted by an obsolete copy.
///
/// `committed` is the generation the probed configuration was resolved under.
/// Every write that could change where a request goes or which key it carries
/// bumps that generation, which is why the credential needs no separate
/// comparison here.
pub fn record_verification(
    committed: u64,
    tested: &super::effective::EffectiveConfig,
    tools: Option<bool>,
    vision: Option<bool>,
    check: LastCheck,
) -> Result<Verification> {
    let path = settings_path()?;
    record_verification_at(&path, committed, tested, tools, vision, check)
}

fn record_verification_at(
    path: &Path,
    committed: u64,
    tested: &super::effective::EffectiveConfig,
    tools: Option<bool>,
    vision: Option<bool>,
    check: LastCheck,
) -> Result<Verification> {
    let _guard = settings_guard();
    if super::resolver::epoch() != committed {
        return Ok(Verification::Superseded);
    }
    let mut saved = read_at(path);
    if !describes(&saved, tested) {
        return Ok(Verification::Superseded);
    }
    if let Some(tools) = tools {
        saved.tools = Some(tools);
    }
    // Capability only. The screenshot permission belongs to the person and a
    // probe may not answer on their behalf (L-286).
    if let Some(vision) = vision {
        saved.vision = Some(vision);
    }
    // `verified_at` answers "when was this last proven", so only a check that
    // proved something moves it. A failure records itself below instead of
    // overwriting the date a capability was actually demonstrated (L-293).
    if check.failure.is_none() {
        saved.verified_at = Some(check.at.clone());
    }
    saved.last_check = Some(check);
    write_at(path, &saved)?;
    Ok(Verification::Recorded)
}

/// Do these saved settings still describe the configuration a probe tested?
fn describes(saved: &AgentSettings, tested: &super::effective::EffectiveConfig) -> bool {
    if saved.provider_kind.as_deref() != Some(tested.dialect) {
        return false;
    }
    let saved_base = saved
        .base_url
        .clone()
        .or_else(|| default_base_url(tested.dialect).map(str::to_string));
    // A trailing slash is not a different endpoint, and refusing to record a
    // result over one would be a silent dead end on the setup card.
    let same_base = saved_base.as_deref().map(|b| b.trim_end_matches('/'))
        == Some(tested.base_url.trim_end_matches('/'));
    same_base
        && saved
            .model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            == tested.model.as_deref()
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
    let parsed =
        url::Url::parse(base_url.trim()).map_err(|_| anyhow!("`{base_url}` is not a valid URL"))?;
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
            allow_screenshots: Some(true),
            vision: Some(true),
            tools: Some(true),
            verified_at: Some("2026-09-09T00:00:00Z".into()),
            last_check: Some(LastCheck {
                at: "2026-09-09T00:00:00Z".into(),
                failure: Some("auth".into()),
                message: Some("rejected".into()),
            }),
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
        let old: AgentSettings =
            serde_json::from_str(r#"{"providerKind":"anthropic","model":"m","vision":true}"#)
                .unwrap();
        assert_eq!(old.vision, Some(true));
        assert_eq!(
            old.tools, None,
            "tools was never recorded, so it is untested"
        );
        let never: AgentSettings = serde_json::from_str(r#"{"providerKind":"anthropic"}"#).unwrap();
        assert_eq!(never.vision, None);
    }

    #[test]
    fn an_origin_is_scheme_host_and_port_only() {
        for (input, want) in [
            ("https://api.openai.com/v1", "https://api.openai.com"),
            ("https://API.OpenAI.com/v1/", "https://api.openai.com"),
            ("https://api.openai.com/openai/v1", "https://api.openai.com"),
            ("http://localhost:11434/v1", "http://localhost:11434"),
            (
                "https://gw.example.com:8443/x",
                "https://gw.example.com:8443",
            ),
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

    // ── L-278 / L-282 / L-286 ────────────────────────────────────────────

    use super::super::resolver::epoch_test_lock as epoch_test;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lilypad-settings-{}-{}-{:?}",
            std::process::id(),
            name,
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("agent-settings.json")
    }

    fn saved(base: &str, model: Option<&str>) -> AgentSettings {
        AgentSettings {
            provider_kind: Some("openai_compat".into()),
            base_url: Some(base.into()),
            model: model.map(str::to_string),
            ..Default::default()
        }
    }

    fn tested_config(base: &str, model: Option<&str>) -> super::super::effective::EffectiveConfig {
        super::super::effective::EffectiveConfig::draft(
            "openai_compat",
            None,
            base.to_string(),
            model.map(str::to_string),
            Some("k".into()),
        )
        .expect("draft")
    }

    /// L-278. `std::fs::write` truncates before it writes, so a reader that
    /// arrives mid-write parses nothing and falls back to defaults — a Mac
    /// that briefly looks unconfigured, or worse, resolves to no provider
    /// while one is saved. The replacement is a rename, which a reader cannot
    /// catch half-done.
    #[test]
    fn a_settings_file_is_never_observed_half_written() {
        let _turn = epoch_test();
        // Deliberately unlocked on both sides: this is about the filesystem
        // primitive, not the lock. A rename is the only replacement a reader
        // outside this process — Cursor, a backup, the person's own editor —
        // also cannot catch half-done.
        let path = scratch("atomic");
        let big = "x".repeat(64 * 1024);
        let a = saved("https://a.example.com/v1", Some(&big));
        let b = saved("https://b.example.com/v1", Some("small"));
        write_at(&path, &a).unwrap();

        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let (path, stop) = (path.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut torn = 0usize;
                let mut reads = 0usize;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let seen = read_at(&path);
                    reads += 1;
                    if seen.provider_kind.is_none() {
                        torn += 1;
                    }
                }
                (reads, torn)
            })
        };
        for i in 0..200 {
            write_at(&path, if i % 2 == 0 { &b } else { &a }).unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let (reads, torn) = reader.join().unwrap();
        assert!(reads > 0, "the reader never ran");
        assert_eq!(torn, 0, "{torn} of {reads} reads saw a half-written file");
        let _ = std::fs::remove_file(&path);
    }

    /// L-278, the property the epoch was supposed to have and did not.
    ///
    /// `save_settings` used to bump the generation **before** writing the
    /// file. A resolution starting in that gap read the OLD provider under the
    /// NEW generation and could publish it as current — an epoch check cannot
    /// catch an answer that carries the right number and the wrong contents.
    /// So the invariant is not "stale answers are discarded", it is: one
    /// generation never describes two different configurations.
    ///
    /// Measured: with the lock and the ordering as they were before this pass,
    /// this reader saw 2149 conflicts. Restoring only the old *ordering*, with
    /// the lock in place, produces none — so it is the lock that closes the
    /// window for callers in this process, and writing before invalidating is
    /// what closes it for a reader that does not hold the lock (another
    /// process, or a future caller that forgets to take it).
    #[test]
    fn one_generation_never_describes_two_configurations() {
        let _turn = epoch_test();
        let path = scratch("barrier");
        let a = saved("https://a.example.com/v1", None);
        let b = saved("https://b.example.com/v1", None);
        save_at(&path, &a).unwrap();

        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let (path, stop) = (path.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut seen: std::collections::HashMap<u64, Option<String>> =
                    std::collections::HashMap::new();
                let mut conflicts = 0usize;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let (settings, generation) = committed_at(&path);
                    match seen.entry(generation) {
                        std::collections::hash_map::Entry::Occupied(e) => {
                            if *e.get() != settings.base_url {
                                conflicts += 1;
                            }
                        }
                        std::collections::hash_map::Entry::Vacant(e) => {
                            e.insert(settings.base_url);
                        }
                    }
                }
                (seen.len(), conflicts)
            })
        };
        for i in 0..300 {
            save_at(&path, if i % 2 == 0 { &b } else { &a }).unwrap();
            // The lock is not fair, and a writer that never lets go proves
            // nothing about a reader that never runs.
            std::thread::sleep(std::time::Duration::from_micros(200));
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let (generations, conflicts) = reader.join().unwrap();
        assert!(generations > 1, "the reader observed only one generation");
        assert_eq!(
            conflicts, 0,
            "one generation described two different configurations {conflicts} times"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// L-278. The generation is bumped **after** the new contents are
    /// committed, so nothing can read the new file under the old generation or
    /// the old file under the new one.
    #[test]
    fn the_generation_changes_only_after_the_new_contents_are_readable() {
        let _turn = epoch_test();
        let path = scratch("generation");
        write_at(&path, &saved("https://a.example.com/v1", None)).unwrap();
        let before = super::super::resolver::epoch();
        write_at(&path, &saved("https://b.example.com/v1", None)).unwrap();
        let after = super::super::resolver::epoch();
        assert_ne!(
            before, after,
            "a settings write did not change the generation"
        );
        assert_eq!(
            read_at(&path).base_url.as_deref(),
            Some("https://b.example.com/v1"),
            "the generation moved on but the file had not"
        );
    }

    /// L-282, the exact interleaving the review named: a probe of A is still
    /// running when the person points the Mac at B. Releasing the probe must
    /// L-293, as the customer met it. The model was wrong for the transport,
    /// so Google refused the request and the probe measured nothing. The old
    /// call site turned every non-`Supported` value into `tools = false`, and
    /// the setup screen then said tool calling did not work — about a model
    /// that had never been asked to call a tool.
    #[test]
    fn a_request_that_never_reached_a_model_records_no_capability() {
        let _turn = epoch_test();
        let path = scratch("failed-check");
        // A configuration that HAD been proven, so a wrong write is visible.
        let mut before = saved("https://x.example.com/v1", Some("m"));
        before.tools = Some(true);
        before.vision = Some(true);
        before.verified_at = Some("2026-09-01T00:00:00Z".into());
        write_at(&path, &before).unwrap();
        let committed = super::super::resolver::epoch();
        let tested = tested_config("https://x.example.com/v1", Some("m"));

        let outcome = record_verification_at(
            &path,
            committed,
            &tested,
            // What `ProbeReport::failed` actually reports: nothing measured.
            None,
            None,
            LastCheck {
                at: "2026-09-11T00:00:00Z".into(),
                failure: Some("auth".into()),
                message: Some("The key was rejected.".into()),
            },
        )
        .unwrap();
        assert_eq!(outcome, Verification::Recorded);

        let after = read_at(&path);
        assert_eq!(
            after.tools,
            Some(true),
            "a failed request was recorded as a model that cannot call tools"
        );
        assert_eq!(after.vision, Some(true));
        assert_eq!(
            after.verified_at.as_deref(),
            Some("2026-09-01T00:00:00Z"),
            "a failure moved the date a capability was last proven"
        );
        let check = after.last_check.expect("the failure itself is recorded");
        assert_eq!(check.failure.as_deref(), Some("auth"));
        assert_eq!(check.message.as_deref(), Some("The key was rejected."));
        assert_eq!(check.at, "2026-09-11T00:00:00Z");
    }

    /// The other half: a check that passed clears the previous failure, so a
    /// recovered setup does not keep showing the error it recovered from.
    #[test]
    fn a_passing_check_replaces_the_failure_it_recovered_from() {
        let _turn = epoch_test();
        let path = scratch("recovered");
        let mut before = saved("https://y.example.com/v1", Some("m"));
        before.last_check = Some(LastCheck {
            at: "2026-09-10T00:00:00Z".into(),
            failure: Some("auth".into()),
            message: Some("The key was rejected.".into()),
        });
        write_at(&path, &before).unwrap();
        let committed = super::super::resolver::epoch();
        let tested = tested_config("https://y.example.com/v1", Some("m"));

        record_verification_at(
            &path,
            committed,
            &tested,
            Some(true),
            None,
            LastCheck {
                at: "2026-09-11T00:00:00Z".into(),
                failure: None,
                message: None,
            },
        )
        .unwrap();

        let after = read_at(&path);
        assert_eq!(after.tools, Some(true));
        assert_eq!(after.verified_at.as_deref(), Some("2026-09-11T00:00:00Z"));
        let check = after.last_check.expect("recorded");
        assert_eq!(check.failure, None, "the old failure survived a pass");
        assert_eq!(check.message, None);
    }

    /// A settings file written before this field existed reads as "nothing has
    /// been checked", not as a failure.
    #[test]
    fn a_settings_file_without_a_last_check_is_not_a_failed_one() {
        let old: AgentSettings =
            serde_json::from_str(r#"{"providerKind":"openai_compat","model":"m","tools":true}"#)
                .unwrap();
        assert_eq!(old.last_check, None);
        assert_eq!(old.tools, Some(true));
    }

    /// not revert B, and must not mark B verified on A's evidence.
    #[test]
    fn a_probe_that_finishes_after_the_endpoint_changed_cannot_overwrite_it() {
        let _turn = epoch_test();
        let path = scratch("cas");
        let a = saved("https://a.example.com/v1", Some("m"));
        write_at(&path, &a).unwrap();
        let committed = super::super::resolver::epoch();
        let tested = tested_config("https://a.example.com/v1", Some("m"));

        // …the person changes the endpoint while the probe is in flight.
        let mut b = saved("https://b.example.com/v1", Some("m"));
        b.allow_screenshots = Some(true);
        write_at(&path, &b).unwrap();

        // …and now the probe finishes.
        let outcome = record_verification_at(
            &path,
            committed,
            &tested,
            Some(true),
            Some(true),
            LastCheck {
                at: "t".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(outcome, Verification::Superseded);
        let after = read_at(&path);
        assert_eq!(
            after.base_url.as_deref(),
            Some("https://b.example.com/v1"),
            "an obsolete snapshot was written back over the newer settings"
        );
        assert_eq!(after.tools, None, "B was marked verified on A's evidence");
        assert_eq!(after.verified_at, None);
        assert_eq!(
            after.allow_screenshots,
            Some(true),
            "the person's screenshot permission was lost"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// L-282, the case a field comparison cannot see. The endpoint and the
    /// model are unchanged, so the saved settings still *describe* what was
    /// probed — but the key was replaced while the probe ran, and a result
    /// earned by the old key says nothing about the new one. Every write that
    /// changes where a request goes or which key it carries bumps the
    /// generation, which is what makes the compare-and-swap cover credentials.
    #[test]
    fn a_probe_cannot_be_filed_after_the_key_it_used_was_replaced() {
        let _turn = epoch_test();
        let path = scratch("cas-key");
        let a = saved("https://a.example.com/v1", Some("m"));
        write_at(&path, &a).unwrap();
        let committed = super::super::resolver::epoch();
        let tested = tested_config("https://a.example.com/v1", Some("m"));

        // `store_credential` does exactly this on a key rotation: nothing in
        // the settings file changes, and the generation moves.
        super::super::resolver::invalidate();

        let outcome = record_verification_at(
            &path,
            committed,
            &tested,
            Some(true),
            Some(true),
            LastCheck {
                at: "t".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            outcome,
            Verification::Superseded,
            "a result earned by the previous key was filed against the new one"
        );
        assert_eq!(read_at(&path).tools, None);
        let _ = std::fs::remove_file(&path);
    }

    /// The other half of the same rule: a probe of the configuration that is
    /// still saved is recorded, and touches nothing but the three verification
    /// fields.
    #[test]
    fn a_probe_of_the_saved_configuration_records_only_verification_fields() {
        let _turn = epoch_test();
        let path = scratch("cas-ok");
        let mut a = saved("https://a.example.com/v1", Some("m"));
        a.profile_id = Some("custom".into());
        a.allow_screenshots = Some(false);
        write_at(&path, &a).unwrap();
        let committed = super::super::resolver::epoch();
        let tested = tested_config("https://a.example.com/v1", Some("m"));
        let outcome = record_verification_at(
            &path,
            committed,
            &tested,
            Some(true),
            Some(true),
            LastCheck {
                at: "t".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(outcome, Verification::Recorded);
        let after = read_at(&path);
        assert_eq!(after.tools, Some(true));
        assert_eq!(after.vision, Some(true));
        assert_eq!(after.verified_at.as_deref(), Some("t"));
        assert_eq!(after.profile_id.as_deref(), Some("custom"));
        // L-286: a probe records what it measured. It does not answer the
        // person's question about whether Ask may take screenshots at all.
        assert_eq!(
            after.allow_screenshots,
            Some(false),
            "a probe overwrote the screenshot permission"
        );
        assert!(!effective_vision(&after), "capability alone enabled images");
        let _ = std::fs::remove_file(&path);
    }

    /// L-286. Permission and capability are different claims by different
    /// authors, and image input needs both.
    #[test]
    fn image_input_needs_permission_and_a_tested_model() {
        let mut s = AgentSettings::default();
        assert!(!effective_vision(&s), "untested and unasked is not yes");
        s.allow_screenshots = Some(true);
        assert!(!effective_vision(&s), "permission over an untested model");
        s.vision = Some(true);
        assert!(effective_vision(&s));
        s.allow_screenshots = Some(false);
        assert!(!effective_vision(&s), "a tested model overrode a refusal");
    }

    /// L-286 migration. One field used to be both, so the stored value is read
    /// as the answer the person actually gave — the checkbox — and the
    /// measurement survives only where a probe recorded it.
    #[test]
    fn a_pre_split_settings_file_keeps_the_permission_not_the_measurement() {
        let untested: AgentSettings =
            migrate(serde_json::from_str(r#"{"providerKind":"anthropic","vision":true}"#).unwrap());
        assert_eq!(untested.allow_screenshots, Some(true));
        assert_eq!(
            untested.vision, None,
            "a checkbox was carried forward as a tested capability"
        );

        let probed: AgentSettings = migrate(
            serde_json::from_str(
                r#"{"providerKind":"anthropic","vision":true,"verifiedAt":"2026-09-01T00:00:00Z"}"#,
            )
            .unwrap(),
        );
        assert_eq!(probed.allow_screenshots, Some(true));
        assert_eq!(
            probed.vision,
            Some(true),
            "a real measurement was discarded"
        );

        // Already split: left exactly as written.
        let split: AgentSettings =
            migrate(serde_json::from_str(r#"{"allowScreenshots":false,"vision":true}"#).unwrap());
        assert_eq!(split.allow_screenshots, Some(false));
        assert_eq!(split.vision, Some(true));
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
