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
// The safety core + runner land before the session wiring that consumes them
// (see `docs/m5.3-ai-executor-plan.md` build order steps 1–2 vs 3). Until the
// DataChannel demux + LLM provider slice wires this subsystem into the live
// binary, its public surface is exercised only by unit tests, so silence the
// not-yet-consumed warnings here rather than scatter per-item allows. REMOVE
// this once the runner is driven from `session/`.
#![allow(dead_code, unused_imports)]

pub mod executor;
pub mod llm;
pub mod protocol;
pub mod runner;
pub mod security;

pub use executor::SkillsExecutor;
pub use llm::{LlmBrain, LlmProvider};
pub use protocol::{
    AgentInbound, AgentOutbound, AgentTier, RunOutcome, StepKind, StepState, ToolClass,
};
pub use runner::{gate, AgentRunner, Brain, Cancel, Decision, Executor, Gate, Observation};
pub use security::{classify, is_forbidden, requires_hold, Action};
