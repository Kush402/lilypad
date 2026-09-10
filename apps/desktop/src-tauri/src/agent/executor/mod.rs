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

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::Result;

use crate::agent::runner::{Executor, Observation};
use crate::agent::Action;

/// Sentinel for "whatever macOS calls the main display".
const MAIN_DISPLAY: u64 = u64::MAX;

/// The display the phone is currently watching, shared with a running agent.
///
/// Ask's perception has to follow the session: a screenshot of a monitor the
/// phone is not sharing shows the model — and the configured provider — a
/// screen the person did not choose to share. Cheap to read (one atomic) and
/// cloneable into the run's task, so a mid-run display switch is visible to
/// the next capture without restarting the run.
#[derive(Clone)]
pub struct SharedDisplay(Arc<AtomicU64>);

impl Default for SharedDisplay {
    fn default() -> Self {
        SharedDisplay(Arc::new(AtomicU64::new(MAIN_DISPLAY)))
    }
}

impl SharedDisplay {
    pub fn new() -> Self {
        Self::default()
    }

    /// Point perception at the display the session is now sharing.
    pub fn set(&self, display_id: Option<u32>) {
        self.0
            .store(display_id.map_or(MAIN_DISPLAY, u64::from), Ordering::SeqCst);
    }

    /// The current target; `None` means the main display.
    pub fn get(&self) -> Option<u32> {
        match self.0.load(Ordering::SeqCst) {
            MAIN_DISPLAY => None,
            id => Some(id as u32),
        }
    }
}

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
    /// Build the executor bound to the display the session is sharing, so the
    /// vision tier can never look at a screen the phone is not watching.
    pub fn from_env(display: SharedDisplay) -> Result<Self> {
        Ok(TieredExecutor {
            skills: SkillsExecutor,
            sandbox: SandboxExecutor::from_env()?,
            ax: AxExecutor::new(display.clone()),
            vision: VisionExecutor::new(display),
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

    fn resolve(&self, action: Action) -> Action {
        // Two tiers need to see an action before it is classified and shown:
        // the accessibility tier, because an element id means nothing without
        // the tree it came from, and the sandbox tier, because a granted path
        // must be jailed and bound to the object it names *before* the card is
        // built from it.
        match action {
            a @ Action::RunScript { .. } => self.sandbox.resolve(a),
            other => self.ax.resolve(other),
        }
    }
}
