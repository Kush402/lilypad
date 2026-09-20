//! One effective configuration, resolved once and used by everything.
//!
//! ### Why this exists (L-265, L-278, L-282)
//!
//! Four different places used to work out "which provider is Ask using", and
//! they did not agree:
//!
//!   - `current_destination()` read the **settings file**, and that is what the
//!     phone was told on `agent_ready`.
//!   - `ProviderChoice::resolve()` prefers an **environment override**, and
//!     that is what actually ran.
//!   - `credential_for()` looked the key up from settings again.
//!   - `test_agent_connection` compared kind, base and model to decide whether
//!     a probe result described the saved configuration.
//!
//! A Mac with `LILYPAD_ANTHROPIC_API_KEY` set therefore disclosed one
//! destination to the phone and sent the screen to another. Nothing was
//! lying — the two answers came from two different questions, asked of two
//! different sources, and no code path ever compared them.
//!
//! So the answer is computed **once**, in one place, and carries a
//! `generation`. Disclosure quotes it, execution uses it, the key is looked up
//! through it, and a verification result may only be filed against the exact
//! generation it tested. A stale answer is discarded rather than applied
//! (L-278), because "resolved a moment ago" and "resolved for the settings that
//! are current now" are different claims.
//!
//! Two revisions, deliberately separate:
//!
//!   - `consent_revision` covers what a person is agreeing to — the origin, the
//!     model, whether it is local, and which wording was on screen. Rotating a
//!     key to the same endpoint is not a new decision about a destination.
//!   - `credential_revision` identifies the key itself, so a verification
//!     result cannot survive the key being replaced (L-282).
//!
//! Neither is ever the credential. Both are truncated SHA-256 digests, and the
//! credential digest is salted with a per-install value so the stored fragment
//! cannot be compared against a guessed key.

use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use super::{presets, store};
use crate::agent::protocol::AI_CONSENT_POLICY;

/// Which source won. The person is entitled to know when a developer override
/// is deciding where their screen goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigSource {
    /// `LILYPAD_*` environment variables.
    Environment,
    /// The settings file plus the keychain.
    Settings,
}

impl ConfigSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ConfigSource::Environment => "env",
            ConfigSource::Settings => "settings",
        }
    }
}

/// A resolved, immutable answer to "where does Ask send things right now".
#[derive(Debug, Clone)]
pub struct EffectiveConfig {
    /// Monotonic, process-wide. Only ever compared for equality.
    pub generation: u64,
    /// The **committed settings generation** this was resolved under, read in
    /// the same critical section as the settings file itself. A result may
    /// only be filed back while this is still current (L-278, L-282).
    pub committed: u64,
    pub source: ConfigSource,
    /// "anthropic" | "openai_compat".
    pub dialect: &'static str,
    pub profile_id: Option<String>,
    pub provider_name: String,
    /// scheme://host[:port].
    pub origin: String,
    /// The full base URL, including any path prefix.
    pub base_url: String,
    pub model: Option<String>,
    /// True when the endpoint is on this Mac, so nothing leaves it.
    pub local: bool,
    /// Digest of the credential. Never the credential.
    pub credential_revision: String,
    /// Digest of what a person is consenting to.
    pub consent_revision: String,
}

/// What stands in for a credential digest on the hosted path (ADR-0020).
///
/// Not a secret, not a key, and deliberately constant: there IS no System One
/// credential on a Mac running that way. Using the device token instead would
/// change `credential_revision` on every token renewal, which is L-265's
/// failure with the sign flipped — a phone's agreed revision would go stale
/// for a reason the person never caused and cannot see.
const HOSTED_CREDENTIAL: &str = "lilypad-account";

static GENERATION: AtomicU64 = AtomicU64::new(1);

fn next_generation() -> u64 {
    GENERATION.fetch_add(1, Ordering::SeqCst)
}

/// A per-install salt for the credential digest.
///
/// Without it the digest is a plain hash of the key, and a plain hash of a
/// short, structured secret is not much of a secret. This value never leaves
/// the Mac and never reaches the phone; it exists so that the fragment we do
/// keep in memory cannot be checked against a guess.
fn credential_salt() -> &'static [u8; 32] {
    use std::sync::OnceLock;
    static SALT: OnceLock<[u8; 32]> = OnceLock::new();
    SALT.get_or_init(|| {
        let mut salt = [0u8; 32];
        // A process-lifetime salt is enough: the digest is only ever compared
        // against another digest made in the same process.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mixed = Sha256::digest(format!("{seed}:{}", std::process::id()).as_bytes());
        salt.copy_from_slice(&mixed);
        salt
    })
}

fn digest(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        // Length-prefixed so ("ab","c") and ("a","bc") cannot collide.
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    hex16(&hasher.finalize())
}

fn hex16(bytes: &[u8]) -> String {
    bytes.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn credential_digest(key: Option<&str>) -> String {
    match key {
        None => "none".to_string(),
        Some(key) => {
            let mut hasher = Sha256::new();
            hasher.update(credential_salt());
            hasher.update(key.as_bytes());
            hex16(&hasher.finalize())
        }
    }
}

impl EffectiveConfig {
    /// Resolve the current configuration, reading the keychain.
    ///
    /// Blocking: this is the call that shells out to `security(1)`. It runs on
    /// the resolver's own worker, never on a session path (L-271).
    pub fn resolve_blocking(
    ) -> std::result::Result<Option<(EffectiveConfig, String)>, store::SecretUnavailable> {
        let (settings, committed) = store::load_committed();
        Self::resolve_from(&settings, committed)
    }

    /// Resolve from settings that were already read, together with the
    /// generation they were read under.
    ///
    /// The resolver reads both in one critical section and passes them here,
    /// so the answer and the generation it is published under describe the
    /// same bytes (L-278).
    pub fn resolve_from(
        settings: &store::AgentSettings,
        committed: u64,
    ) -> std::result::Result<Option<(EffectiveConfig, String)>, store::SecretUnavailable> {
        // Environment first, matching `ProviderChoice::resolve`. That
        // precedence is the whole reason this function exists.
        if let Some(config) = Self::from_env(committed) {
            return Ok(Some(config));
        }
        Self::from_settings(settings, committed)
    }

    fn from_env(committed: u64) -> Option<(EffectiveConfig, String)> {
        use super::{anthropic, openai_compat};
        let (dialect, base_url, model, key) =
            if let Some(c) = anthropic::AnthropicConfig::from_env() {
                (
                    "anthropic",
                    c.base_url.clone(),
                    Some(c.model.clone()),
                    c.api_key.clone(),
                )
            } else {
                let c = openai_compat::OpenAiCompatConfig::from_env()?;
                (
                    "openai_compat",
                    c.base_url.clone(),
                    Some(c.model.clone()),
                    c.api_key.clone(),
                )
            };
        Self::assemble(
            ConfigSource::Environment,
            committed,
            dialect,
            None,
            base_url,
            model,
            Some(key),
        )
    }

    fn from_settings(
        settings: &store::AgentSettings,
        committed: u64,
    ) -> std::result::Result<Option<(EffectiveConfig, String)>, store::SecretUnavailable> {
        let Some(kind) = settings.provider_kind.as_deref() else {
            return Ok(None);
        };
        let dialect = match kind {
            "anthropic" => "anthropic",
            "openai_compat" => "openai_compat",
            _ => return Ok(None),
        };
        let Some(base_url) = settings
            .base_url
            .clone()
            .or_else(|| store::default_base_url(dialect).map(str::to_string))
        else {
            return Ok(None);
        };
        // Propagated, not swallowed: a keychain that will not answer is not a
        // Mac with no provider configured.
        let key = store::credential_for(dialect, settings.base_url.as_deref())?;
        // A hosted endpoint with no key resolves to nothing, exactly as
        // `from_settings` on `ProviderChoice` already decided.
        if key.is_none() && settings.base_url.is_none() {
            return Ok(None);
        }
        Ok(Self::assemble(
            ConfigSource::Settings,
            committed,
            dialect,
            settings.profile_id.clone(),
            base_url,
            settings.model.clone(),
            key,
        ))
    }

    fn assemble(
        source: ConfigSource,
        committed: u64,
        dialect: &'static str,
        profile_id: Option<String>,
        base_url: String,
        model: Option<String>,
        key: Option<String>,
    ) -> Option<(EffectiveConfig, String)> {
        let origin = store::origin_of(&base_url).ok()?;
        let local = store::is_local_origin(&origin);
        let preset = profile_id.as_deref().and_then(presets::find);
        let provider_name = preset
            .map(|p| p.display_name.to_string())
            // Settings written before presets existed, and every environment
            // override, still have to name something truthful. The origin is
            // the honest fallback.
            .unwrap_or_else(|| origin.clone());
        let credential_revision = credential_digest(key.as_deref());
        let consent_revision = digest(&[
            &AI_CONSENT_POLICY.to_string(),
            source.as_str(),
            &origin,
            model.as_deref().unwrap_or(""),
            if local { "local" } else { "remote" },
        ]);
        let config = EffectiveConfig {
            generation: next_generation(),
            committed,
            source,
            dialect,
            profile_id,
            provider_name,
            origin,
            base_url,
            model,
            local,
            credential_revision,
            consent_revision,
        };
        Some((config, key.unwrap_or_default()))
    }

    /// Build a snapshot for a configuration the person is *editing* but has not
    /// saved, so a probe can be bound to exactly what it tested (L-282).
    pub fn draft(
        dialect: &'static str,
        profile_id: Option<String>,
        base_url: String,
        model: Option<String>,
        key: Option<String>,
    ) -> Option<EffectiveConfig> {
        Self::assemble(
            ConfigSource::Settings,
            // A draft is not a committed configuration; whatever is current
            // when it is built is the only honest answer, and the caller that
            // files a result supplies the generation it actually resolved.
            super::resolver::epoch(),
            dialect,
            profile_id,
            base_url,
            model,
            key,
        )
        .map(|(config, _)| config)
    }

    /// The non-secret disclosure the phone receives.
    pub fn destination(&self) -> crate::agent::protocol::AgentDestination {
        crate::agent::protocol::AgentDestination {
            profile_id: self.profile_id.clone(),
            provider_name: self.provider_name.clone(),
            origin: self.origin.clone(),
            model: self.model.clone(),
            local: self.local,
            consent_policy: AI_CONSENT_POLICY,
            consent_revision: self.consent_revision.clone(),
            source: self.source.as_str().to_string(),
            mode: if self.dialect == "jev" {
                "system_one"
            } else {
                "model"
            },
            // On the hosted path Lilypad hands the same text to another
            // company, and the phone has to say whose. `for_hosted_jev` is the
            // only thing that names this provider, so it is also the only
            // destination that carries the hop.
            hosted_via: (self.provider_name == super::jev::HOSTED_PROVIDER_NAME)
                .then_some(super::jev::PROVIDER_NAME),
            instant: None,
        }
    }

    /// The destination when Lilypad's own loop runs the task (ADR-0020):
    /// one System One model, no language model behind it, and a consent
    /// revision of its own because it is a different thing to agree to.
    pub fn for_jev(
        committed: u64,
        source: ConfigSource,
        base_url: String,
        key: &str,
        provider_name: &str,
    ) -> Option<EffectiveConfig> {
        let (mut config, _) = Self::assemble(
            source,
            committed,
            "jev",
            None,
            base_url,
            Some(super::jev::MODEL.to_string()),
            Some(key.to_string()),
        )?;
        config.provider_name = provider_name.to_string();
        Some(config)
    }

    /// The same, for Lilypad's own account (ADR-0020).
    ///
    /// Separate because there is **no credential on this Mac** to digest. The
    /// bearer is a device token minted per request, which changes on every
    /// renewal and is not a configuration the person chose — digesting it
    /// would invalidate every phone's agreed revision each time a token was
    /// refreshed, which is L-265's failure with the sign flipped. What
    /// identifies this destination is its origin and its model, and those are
    /// in the digest already.
    pub fn for_hosted_jev(committed: u64, base_url: String) -> Option<EffectiveConfig> {
        let (mut config, _) = Self::assemble(
            ConfigSource::Settings,
            committed,
            "jev",
            None,
            base_url,
            Some(super::jev::MODEL.to_string()),
            Some(HOSTED_CREDENTIAL.to_string()),
        )?;
        config.provider_name = super::jev::HOSTED_PROVIDER_NAME.to_string();
        Some(config)
    }

    /// The revision for this destination together with instant actions sent
    /// to `origin` (ADR-0019). Agreeing to both is a different decision from
    /// agreeing to this one alone, so it is a different digest.
    pub fn instant_revision(&self, origin: &str, model: &str) -> String {
        digest(&[&self.consent_revision, "instant", origin, model])
    }

    /// Does a verification result about `other` describe this configuration?
    ///
    /// Every field a probe's answer depends on, including the credential. A
    /// probe of a draft key must not mark a different saved key Ready (L-282).
    pub fn same_target(&self, other: &EffectiveConfig) -> bool {
        self.source == other.source
            && self.dialect == other.dialect
            && self.origin == other.origin
            && self.base_url == other.base_url
            && self.model == other.model
            && self.credential_revision == other.credential_revision
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(origin: &str, model: Option<&str>, key: Option<&str>) -> EffectiveConfig {
        EffectiveConfig::assemble(
            ConfigSource::Settings,
            0,
            "openai_compat",
            None,
            origin.to_string(),
            model.map(str::to_string),
            key.map(str::to_string),
        )
        .expect("assemble")
        .0
    }

    #[test]
    fn a_changed_destination_changes_the_consent_revision() {
        let a = config("https://api.openai.com/v1", Some("m"), Some("k"));
        // Same party, different path: the person's decision is unchanged.
        let same = config("https://api.openai.com/v1/", Some("m"), Some("k"));
        assert_eq!(a.consent_revision, same.consent_revision);

        for changed in [
            config("https://gw.example.com/v1", Some("m"), Some("k")),
            config("https://api.openai.com/v1", Some("other"), Some("k")),
        ] {
            assert_ne!(
                a.consent_revision, changed.consent_revision,
                "a material change kept the same consent revision"
            );
        }
        // Rotating the key to the same endpoint is not a new destination.
        let rotated = config("https://api.openai.com/v1", Some("m"), Some("k2"));
        assert_eq!(a.consent_revision, rotated.consent_revision);
    }

    #[test]
    fn a_rotated_key_invalidates_verification_but_not_consent() {
        // L-282: a probe result must not survive the key being replaced.
        let a = config("https://api.openai.com/v1", Some("m"), Some("k"));
        let rotated = config("https://api.openai.com/v1", Some("m"), Some("k2"));
        assert_ne!(a.credential_revision, rotated.credential_revision);
        assert!(!a.same_target(&rotated));
    }

    #[test]
    fn an_environment_override_is_a_different_destination_from_the_same_settings() {
        // L-265: the disclosure used to come from settings while execution came
        // from the environment, and nothing compared them.
        let from_settings = config("https://api.openai.com/v1", Some("m"), Some("k"));
        let from_env = EffectiveConfig::assemble(
            ConfigSource::Environment,
            0,
            "openai_compat",
            None,
            "https://api.openai.com/v1".to_string(),
            Some("m".to_string()),
            Some("k".to_string()),
        )
        .expect("assemble")
        .0;
        assert_ne!(from_settings.consent_revision, from_env.consent_revision);
        assert!(!from_settings.same_target(&from_env));
    }

    #[test]
    fn a_credential_revision_is_never_the_credential() {
        let secret = "sk-ant-super-secret-value";
        let c = config("https://api.anthropic.com", None, Some(secret));
        assert!(!c.credential_revision.contains("sk-"));
        assert!(!c.credential_revision.contains(secret));
        assert_eq!(c.credential_revision.len(), 16);
        // Absent is its own value, not an empty hash.
        assert_eq!(
            config("http://localhost:11434/v1", None, None).credential_revision,
            "none"
        );
    }

    #[test]
    fn a_local_endpoint_is_marked_local_from_the_origin_not_the_name() {
        let local = config("http://localhost:11434/v1", None, None);
        assert!(local.local);
        assert!(!config("https://api.openai.com/v1", None, Some("k")).local);
    }

    /// ADR-0020: the hosted way puts Lilypad in the data path and hands the
    /// same reading to another company. The phone can only say so if the Mac
    /// discloses the hop, and a personal key — same loop, same model — must
    /// not claim one that does not exist.
    #[test]
    fn only_the_hosted_way_discloses_the_company_behind_lilypad() {
        let hosted = EffectiveConfig::for_hosted_jev(0, "https://api.takedia.com".to_string())
            .expect("hosted config")
            .destination();
        assert_eq!(
            hosted.provider_name,
            super::super::jev::HOSTED_PROVIDER_NAME
        );
        assert_eq!(hosted.mode, "system_one");
        assert_eq!(hosted.hosted_via, Some(super::super::jev::PROVIDER_NAME));

        let own_key = EffectiveConfig::for_jev(
            0,
            ConfigSource::Settings,
            "https://api.typesafe.ai".to_string(),
            "k",
            super::super::jev::PROVIDER_NAME,
        )
        .expect("personal config")
        .destination();
        assert_eq!(own_key.mode, "system_one");
        assert_eq!(own_key.hosted_via, None);
        assert_ne!(own_key.consent_revision, hosted.consent_revision);
    }

    #[test]
    fn generations_are_unique() {
        let a = config("https://api.openai.com/v1", None, Some("k"));
        let b = config("https://api.openai.com/v1", None, Some("k"));
        assert_ne!(a.generation, b.generation);
    }
}
