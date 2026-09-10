//! Named provider presets — the list a person actually chooses from.
//!
//! A preset is a support commitment, not a logo. Each entry here means: this
//! endpoint's documented contract has been mapped onto an adapter that exists,
//! and the setup screen can fill in a default destination so nobody has to
//! guess a base URL. Services whose adapters have not been written are absent
//! rather than listed hopefully — a name in this table that does not work is
//! worse than no name.
//!
//! What a preset is deliberately NOT:
//!
//!   - a claim that the selected model supports tools or images. Discovery
//!     lists models; it does not certify capability. That is what the probe in
//!     [`super::probe`] is for (L-263, L-264).
//!   - a key-format check. Providers change prefixes, and a brittle prefix
//!     list refuses valid keys while still accepting invalid ones. `auth_hint`
//!     explains what kind of credential belongs here instead.
//!   - a way around the destination binding. The credential is still filed
//!     under the effective origin (L-262); a preset only supplies its default.

/// One selectable provider.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    /// Stable id, persisted in settings. Never localized, never renamed.
    pub id: &'static str,
    pub display_name: &'static str,
    /// Which adapter speaks to it: "anthropic" or "openai_compat".
    pub dialect: &'static str,
    /// Filled into the endpoint field. Empty for `custom`, which has none.
    pub default_base_url: &'static str,
    /// What credential this endpoint takes, in the person's words. Shown on
    /// the connect step so an account password is never mistaken for an API
    /// key — a subscription login is not an API credential and never will be.
    pub auth_hint: &'static str,
    /// Whether the endpoint can list its own models.
    pub model_discovery: bool,
    /// Whether a key is required at all (a local model needs none).
    pub requires_key: bool,
    /// Shown under the endpoint field when there is something specific the
    /// person needs to know before it will work.
    pub note: &'static str,
}

/// The verified list. Adding an entry means an adapter passes the same
/// contract tests as the ones already here.
pub const PRESETS: &[Preset] = &[
    Preset {
        id: "anthropic",
        display_name: "Anthropic",
        dialect: "anthropic",
        default_base_url: "https://api.anthropic.com",
        auth_hint: "An Anthropic API key from console.anthropic.com. \
                    A Claude.ai subscription is a different thing and will not work here.",
        model_discovery: true,
        requires_key: true,
        note: "",
    },
    Preset {
        id: "openai",
        display_name: "OpenAI",
        dialect: "openai_compat",
        default_base_url: "https://api.openai.com/v1",
        auth_hint: "An OpenAI API key from platform.openai.com. \
                    A ChatGPT Plus subscription is a different thing and will not work here.",
        model_discovery: true,
        requires_key: true,
        note: "",
    },
    Preset {
        id: "gemini",
        display_name: "Google Gemini",
        dialect: "openai_compat",
        // Google documents this OpenAI-compatibility path with its own base
        // URL. Ask uses chat completions with tools and optional images, which
        // that path covers; parity for the rest of Gemini's API is not implied.
        default_base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        auth_hint: "A Gemini API key from Google AI Studio.",
        model_discovery: true,
        requires_key: true,
        note: "Uses Google's OpenAI-compatible endpoint.",
    },
    Preset {
        id: "openrouter",
        display_name: "OpenRouter",
        dialect: "openai_compat",
        default_base_url: "https://openrouter.ai/api/v1",
        auth_hint: "An OpenRouter API key from openrouter.ai/keys.",
        model_discovery: true,
        requires_key: true,
        note: "Model names are prefixed by their vendor, e.g. `anthropic/claude-sonnet-4`.",
    },
    Preset {
        id: "ollama",
        display_name: "Ollama (on this Mac)",
        dialect: "openai_compat",
        default_base_url: "http://localhost:11434/v1",
        auth_hint: "No key needed — Ollama runs on this Mac.",
        model_discovery: true,
        requires_key: false,
        // Ollama documents compatibility with parts of the OpenAI API. What a
        // local setup can actually do depends on the model that is loaded, not
        // on the endpoint, which is exactly why the probe runs.
        note: "Nothing you ask leaves this Mac. Tool and image support depend on the model you have pulled.",
    },
    Preset {
        id: "custom",
        display_name: "Other OpenAI-compatible endpoint",
        dialect: "openai_compat",
        default_base_url: "",
        auth_hint: "Whatever credential your endpoint expects as a bearer token.",
        model_discovery: true,
        requires_key: false,
        note: "Enterprise and gateway endpoints that need extra headers, a deployment id or a \
               different API version are not supported by this entry — they need their own adapter.",
    },
];

pub fn find(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_is_internally_consistent() {
        for p in PRESETS {
            assert!(
                matches!(p.dialect, "anthropic" | "openai_compat"),
                "{} names an adapter that does not exist",
                p.id
            );
            assert!(!p.auth_hint.is_empty(), "{} explains no authentication", p.id);
            if p.id == "custom" {
                assert!(p.default_base_url.is_empty());
                continue;
            }
            // Every shipped default must survive the same destination rules a
            // typed URL does — including the transport check, which is what
            // keeps a preset from being a way to smuggle in plain http.
            let origin = super::super::store::origin_of(p.default_base_url)
                .unwrap_or_else(|e| panic!("{}: {e}", p.id));
            super::super::store::check_transport(&origin)
                .unwrap_or_else(|e| panic!("{}: {e}", p.id));
        }
    }

    #[test]
    fn preset_ids_are_unique_because_settings_persist_them() {
        let mut ids: Vec<&str> = PRESETS.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate preset id");
    }

    #[test]
    fn a_local_preset_is_the_only_one_that_needs_no_key() {
        for p in PRESETS {
            if p.requires_key {
                continue;
            }
            assert!(
                p.id == "ollama" || p.id == "custom",
                "{} claims to work without a key",
                p.id
            );
        }
    }
}
