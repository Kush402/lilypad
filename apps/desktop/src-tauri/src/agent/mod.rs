//! AI executor foundation (M5.3) — a text-commanded agent that runs on this
//! desktop, controls the Mac, and is watched + interruptible from the phone.
//!
//! See `docs/m5.3-ai-executor-plan.md` for the full design. This module is
//! built vertical-slice-first: the pure, OS-free safety core (`protocol` +
//! `security`) lands first, then the runner loop, then the tiered executors.
//!
//! Layering mirrors the input subsystem: a pure, unit-testable core
//! (`security::classify`, the runner loop behind a mock executor) sits above a
//! thin per-OS action surface, so the risky logic never needs a live Mac to
//! test.
//!
// A handful of the convenience re-exports below and helper methods are part of
// the subsystem's coherent public surface but not all consumed outside their
// defining module yet (later tiers/UI will); allow that without scattering
// per-item attributes.
#![allow(dead_code, unused_imports)]

pub mod controller;
pub mod executor;
pub mod llm;
pub mod protocol;
pub mod runner;
pub mod sandbox;
pub mod security;

pub use controller::{authorize_command, AgentController, CommandGate};
pub use executor::{SandboxExecutor, SkillsExecutor, TieredExecutor};
pub use llm::{LlmBrain, LlmProvider};
pub use protocol::{
    parse_inbound, AgentInbound, AgentOutbound, AgentTier, RunOutcome, StepKind, StepState,
    ToolClass,
};
pub use runner::{gate, AgentRunner, Brain, Cancel, Decision, Executor, Gate, Observation};
pub use security::{classify, is_forbidden, requires_hold, Action};

#[cfg(test)]
mod agnosticism {
    /// Tripwire for the model-agnostic mandate (`docs/ask-architecture-audit.md`
    /// §6): the ENGINE — controller, runner, gate, executors, wire protocol —
    /// must never name a vendor. Providers live exclusively behind
    /// `llm::ProviderChoice`/`AnyProvider`; if this test fails, provider logic
    /// leaked out of the adapter layer.
    #[test]
    fn engine_is_provider_blind() {
        let engine_sources: &[(&str, &str)] = &[
            ("controller.rs", include_str!("controller.rs")),
            ("runner.rs", include_str!("runner.rs")),
            ("security.rs", include_str!("security.rs")),
            ("protocol.rs", include_str!("protocol.rs")),
            ("executor/mod.rs", include_str!("executor/mod.rs")),
            ("executor/skills.rs", include_str!("executor/skills.rs")),
            ("executor/sandbox_exec.rs", include_str!("executor/sandbox_exec.rs")),
            ("executor/verify.rs", include_str!("executor/verify.rs")),
            ("sandbox/mod.rs", include_str!("sandbox/mod.rs")),
            ("sandbox/profile.rs", include_str!("sandbox/profile.rs")),
        ];
        // Vendor identifiers, matched case-insensitively. "gpt-" and
        // "claude-" (with hyphen) so prose words can't false-positive.
        let forbidden = [
            "anthropic",
            "openai",
            "claude-",
            "gpt-",
            "gemini",
            "deepseek",
            "openrouter",
            "ollama",
            "mistral",
        ];
        for (file, source) in engine_sources {
            let lower = source.to_lowercase();
            for needle in forbidden {
                assert!(
                    !lower.contains(needle),
                    "provider identifier `{needle}` leaked into engine file `{file}` — \
                     provider-specific logic belongs in agent/llm/ adapters only"
                );
            }
        }
    }
}
