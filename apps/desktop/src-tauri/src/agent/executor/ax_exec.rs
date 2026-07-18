//! Tier-2 executor (P3) — accessibility-tree perception and action.
//!
//! Handles two actions:
//!   - [`Action::ReadAxTree`] reads the focused app's AX tree, remembers the
//!     live-element handle table for this run, and returns the serialized tree
//!     as the observation the model reads.
//!   - [`Action::AxPress`] presses the element whose `id` the model chose from
//!     the most recent read.
//!
//! State (the last snapshot) lives here because `id → live element` only makes
//! sense within one read; a press for an id from a stale/absent read is
//! rejected with an honest observation rather than pressing the wrong thing.

use anyhow::{bail, Result};

use crate::agent::ax::{self, tree, AxSnapshot};
use crate::agent::runner::{Executor, Observation};
use crate::agent::Action;

#[derive(Default)]
pub struct AxExecutor {
    /// The most recent read's snapshot — the id→handle table a press resolves
    /// against. `None` until the first `read_ax_tree`.
    last: Option<AxSnapshot>,
}

impl Executor for AxExecutor {
    async fn execute(&mut self, action: &Action) -> Result<Observation> {
        match action {
            Action::ReadAxTree => {
                // Reading the AX tree is a blocking FFI walk; keep it off the
                // async worker.
                let snapshot = match tokio::task::spawn_blocking(ax::read_focused_tree).await {
                    Ok(Ok(s)) => s,
                    Ok(Err(e)) => return Ok(Observation::fail(format!("could not read the accessibility tree: {e}"))),
                    Err(e) => return Ok(Observation::fail(format!("ax read task failed: {e}"))),
                };
                let text = tree::serialize(&snapshot.nodes);
                self.last = Some(snapshot);
                Ok(Observation::ok(format!("Accessibility tree:\n{text}")))
            }
            Action::AxPress { element_id } => self.press(*element_id),
            other => bail!("AxExecutor only handles ReadAxTree/AxPress, got {other:?}"),
        }
    }
}

impl AxExecutor {
    fn press(&self, element_id: usize) -> Result<Observation> {
        let Some(snapshot) = &self.last else {
            return Ok(Observation::fail(
                "no accessibility tree has been read yet — call read_ax_tree first",
            ));
        };
        // Reject a bad or non-actionable id before touching the live element.
        match tree::pressable_by_id(&snapshot.nodes, element_id) {
            None => {
                return Ok(Observation::fail(format!(
                    "element [{element_id}] is not in the current tree — re-read first"
                )))
            }
            Some(false) => {
                return Ok(Observation::fail(format!(
                    "element [{element_id}] is not pressable — pick one marked {{pressable}}"
                )))
            }
            Some(true) => {}
        }
        #[cfg(target_os = "macos")]
        {
            let Some(handle) = snapshot.handle(element_id) else {
                return Ok(Observation::fail(format!("element [{element_id}] handle missing")));
            };
            match ax::macos::press(handle) {
                Ok(()) => Ok(Observation::ok(format!("pressed element [{element_id}]"))),
                Err(e) => Ok(Observation::fail(format!("press failed: {e}"))),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = snapshot;
            Ok(Observation::fail("the accessibility tier is only available on macOS"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn press_without_a_read_is_rejected() {
        let ex = AxExecutor::default();
        let obs = ex.press(3).unwrap();
        assert!(!obs.ok);
        assert!(obs.summary.contains("read_ax_tree first"));
    }

    // The press-gating logic (unknown id, non-pressable id) is the pure
    // `tree::pressable_by_id` — exhaustively tested in `ax::tree`. Here we only
    // assert the executor's "no read yet" guard; the live FFI walk + press is
    // exercised by the on-device smoke test.
}
