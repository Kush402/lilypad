//! Tier-2 perception + action: the macOS Accessibility tree (P3). Reading the
//! AX tree (~50ms) and acting on real elements is 40–100× faster and grounds
//! far better than a screenshot→VLM round trip — the default execution path
//! and the moat (`docs/ask-architecture-audit.md` §5). We already hold the
//! Accessibility permission and inject via CGEvent.
//!
//! `tree` is the pure model + serialization; `macos` is the thin FFI walk.

pub mod tree;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "macos")]
pub use macos::{read_focused_tree, AxSnapshot};

// Non-macOS stub so the crate builds everywhere; the AX tier is macOS-only.
#[cfg(not(target_os = "macos"))]
mod stub {
    use super::tree::AxNode;
    use anyhow::{bail, Result};

    pub struct AxSnapshot {
        pub nodes: Vec<AxNode>,
    }
    impl AxSnapshot {
        pub fn handle(&self, _id: usize) -> Option<&()> {
            None
        }
    }
    pub fn read_focused_tree() -> Result<AxSnapshot> {
        bail!("the accessibility tier is only available on macOS")
    }
}

#[cfg(not(target_os = "macos"))]
pub use stub::{read_focused_tree, AxSnapshot};
