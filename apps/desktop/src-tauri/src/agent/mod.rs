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
pub mod security;

pub use controller::{authorize_command, AgentController, CommandGate};
pub use executor::SkillsExecutor;
pub use llm::{LlmBrain, LlmProvider};
pub use protocol::{
    parse_inbound, AgentInbound, AgentOutbound, AgentTier, RunOutcome, StepKind, StepState,
    ToolClass,
};
pub use runner::{gate, AgentRunner, Brain, Cancel, Decision, Executor, Gate, Observation};
pub use security::{classify, is_forbidden, requires_hold, Action};
