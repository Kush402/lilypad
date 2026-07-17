//! The tiered action surface. Each tier lowers an [`Action`](crate::agent::Action)
//! into a real effect; tiers are ordered cheap/safe → expensive:
//!   • tier-1 [`skills`] — deterministic allowlisted commands (this slice)
//!   • tier-2 AX-tree — accessibility read + press (a later slice)
//!   • tier-3 vision — computer-use fallback (a later slice)
//!
//! Higher tiers plug in behind the same [`Executor`](crate::agent::runner::Executor)
//! trait; for now the tier-1 [`skills::SkillsExecutor`] is the whole surface.

pub mod skills;

pub use skills::{plan_command, CommandSpec, SkillsExecutor};
