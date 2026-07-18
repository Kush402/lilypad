//! The tiered action surface. Each tier lowers an [`Action`](crate::agent::Action)
//! into a real effect; tiers are ordered cheap/safe → expensive:
//!   • tier-1 [`skills`] — deterministic allowlisted commands (this slice)
//!   • tier-2 AX-tree — accessibility read + press (a later slice)
//!   • tier-3 vision — computer-use fallback (a later slice)
//!
//! Higher tiers plug in behind the same [`Executor`](crate::agent::runner::Executor)
//! trait; for now the tier-1 [`skills::SkillsExecutor`] is the whole surface.

pub mod ax_exec;
pub mod sandbox_exec;
pub mod skills;
pub mod verify;
pub mod vision;

pub use ax_exec::AxExecutor;
pub use sandbox_exec::SandboxExecutor;
pub use skills::{plan_command, CommandSpec, SkillsExecutor};
pub use verify::{check, postcondition, resolve_user_path, Postcondition};
pub use vision::VisionExecutor;

use anyhow::Result;

use crate::agent::runner::{Executor, Observation};
use crate::agent::Action;

/// Routes each [`Action`] to the executor that owns its tier — the single
/// `Executor` the runner drives:
///   - `Screenshot` → the vision tier (P4)
///   - `ReadAxTree` / `AxPress` → the accessibility tier (P3)
///   - `RunScript` → the sandbox tier (P2)
///   - everything else → tier-1 skills (P1)
pub struct TieredExecutor {
    skills: SkillsExecutor,
    sandbox: SandboxExecutor,
    ax: AxExecutor,
    vision: VisionExecutor,
}

impl TieredExecutor {
    pub fn from_env() -> Result<Self> {
        Ok(TieredExecutor {
            skills: SkillsExecutor,
            sandbox: SandboxExecutor::from_env()?,
            ax: AxExecutor::default(),
            vision: VisionExecutor,
        })
    }
}

impl Executor for TieredExecutor {
    async fn execute(&mut self, action: &Action) -> Result<Observation> {
        match action {
            Action::Screenshot => self.vision.execute(action).await,
            Action::ReadAxTree | Action::AxPress { .. } => self.ax.execute(action).await,
            Action::RunScript { .. } => self.sandbox.execute(action).await,
            _ => self.skills.execute(action).await,
        }
    }
}
