//! The tiered action surface. Each tier lowers an [`Action`](crate::agent::Action)
//! into a real effect; tiers are ordered cheap/safe → expensive:
//!   • tier-1 [`skills`] — deterministic allowlisted commands (this slice)
//!   • tier-2 AX-tree — accessibility read + press (a later slice)
//!   • tier-3 vision — computer-use fallback (a later slice)
//!
//! Higher tiers plug in behind the same [`Executor`](crate::agent::runner::Executor)
//! trait; for now the tier-1 [`skills::SkillsExecutor`] is the whole surface.

pub mod sandbox_exec;
pub mod skills;
pub mod verify;

pub use sandbox_exec::SandboxExecutor;
pub use skills::{plan_command, CommandSpec, SkillsExecutor};
pub use verify::{check, postcondition, resolve_user_path, Postcondition};

use anyhow::Result;

use crate::agent::runner::{Executor, Observation};
use crate::agent::Action;

/// Routes each [`Action`] to the executor that owns its tier — the single
/// `Executor` the runner drives. `RunScript` goes to the sandbox (tier
/// "sandbox"); everything else this slice handles is a tier-1 skill. AX and
/// vision tiers slot in here behind the same trait in later slices.
pub struct TieredExecutor {
    skills: SkillsExecutor,
    sandbox: SandboxExecutor,
}

impl TieredExecutor {
    pub fn from_env() -> Result<Self> {
        Ok(TieredExecutor {
            skills: SkillsExecutor,
            sandbox: SandboxExecutor::from_env()?,
        })
    }
}

impl Executor for TieredExecutor {
    async fn execute(&mut self, action: &Action) -> Result<Observation> {
        match action {
            Action::RunScript { .. } => self.sandbox.execute(action).await,
            _ => self.skills.execute(action).await,
        }
    }
}
