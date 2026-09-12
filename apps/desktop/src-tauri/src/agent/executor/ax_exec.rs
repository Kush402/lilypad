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
use crate::agent::security::AxTarget;
use crate::agent::Action;

#[derive(Default)]
pub struct AxExecutor {
    /// The most recent read's snapshot — the id→handle table a press resolves
    /// against. `None` until the first `read_ax_tree`.
    last: Option<AxSnapshot>,
    /// The display the session is sharing. Perception is scoped to it, for the
    /// same reason the screenshot path already is: an observation of a window
    /// on an unshared monitor still goes to the model provider (L-267).
    display: crate::agent::executor::SharedDisplay,
    /// The display the last snapshot was read on. A session that switches
    /// monitors invalidates the snapshot rather than pressing an element that
    /// was chosen from a screen the phone is no longer watching.
    read_on: Option<u32>,
}

impl AxExecutor {
    pub fn new(display: crate::agent::executor::SharedDisplay) -> Self {
        AxExecutor {
            last: None,
            display,
            read_on: None,
        }
    }
}

impl Executor for AxExecutor {
    async fn execute(&mut self, action: &Action) -> Result<Observation> {
        match action {
            Action::ReadAxTree => {
                // Reading the AX tree is a blocking FFI walk; keep it off the
                // async worker.
                let display = self.display.get();
                let snapshot =
                    match tokio::task::spawn_blocking(move || ax::read_focused_tree(display)).await
                    {
                        Ok(Ok(s)) => s,
                        Ok(Err(e)) => {
                            return Ok(Observation::fail(format!(
                                "could not read the accessibility tree: {e}"
                            )))
                        }
                        Err(e) => {
                            return Ok(Observation::fail(format!("ax read task failed: {e}")))
                        }
                    };
                let text = tree::observation(&snapshot.nodes);
                self.last = Some(snapshot);
                self.read_on = display;
                Ok(Observation::ok(text))
            }
            Action::AxPress { element_id, target } => {
                if let Some(refusal) = self.cannot_press(*element_id) {
                    return Ok(refusal);
                }
                // Re-reading the screen to check the approval still describes
                // this control is the same blocking FFI walk as `read_ax_tree`
                // above, and it used to run inline on the async worker
                // (L-322). A walk of a web page is not fast — browsers build
                // their accessibility tree lazily and a large page takes
                // seconds — so holding a runtime worker for it stalls whatever
                // else that worker was carrying. In one real session capture
                // went from 34ms a frame to 70ms and produced no frames at all
                // for 19 seconds while an Ask run was pressing.
                //
                // It happens here rather than inside `press` because `&self`
                // may not be held across an await: `AxHandle` is `Send` and
                // not `Sync`, so a future holding a reference to the snapshot
                // is not `Send` and the runner cannot hold it. `&mut self` is.
                let fresh = match target {
                    None => None,
                    Some(_) => {
                        let display = self.display.get();
                        match tokio::task::spawn_blocking(move || ax::read_focused_tree(display))
                            .await
                        {
                            Ok(Ok(s)) => Some(s),
                            // An observation, not an error: the model can read
                            // again and choose, where a failed step only ends
                            // with a message nobody can act on.
                            Ok(Err(e)) => {
                                return Ok(Observation::fail(format!(
                                    "could not re-read the screen before pressing: {e}"
                                )))
                            }
                            Err(e) => {
                                return Ok(Observation::fail(format!("ax read task failed: {e}")))
                            }
                        }
                    }
                };
                Ok(self.press(*element_id, target.as_ref(), fresh))
            }
            other => bail!("AxExecutor only handles ReadAxTree/AxPress, got {other:?}"),
        }
    }

    fn resolve(&self, action: Action) -> Action {
        match action {
            // Attach what the id currently means, so the gate classifies the
            // control rather than the index. An id that resolves to nothing
            // stays `None`, which the gate treats as unknown — not as safe.
            Action::AxPress { element_id, .. } => Action::AxPress {
                element_id,
                target: self.describe(element_id),
            },
            other => other,
        }
    }
}

impl AxExecutor {
    /// What `element_id` names in the most recent read, if anything.
    fn describe(&self, element_id: usize) -> Option<AxTarget> {
        let snapshot = self.last.as_ref()?;
        tree::describe_by_id(&snapshot.nodes, element_id)
            .map(|(role, label)| AxTarget::new(role, label))
    }

    /// Every refusal that costs nothing to decide, so the expensive re-read
    /// in `execute` only happens for a press that could actually go ahead.
    fn cannot_press(&self, element_id: usize) -> Option<Observation> {
        let snapshot = match &self.last {
            Some(snapshot) => snapshot,
            None => {
                return Some(Observation::fail(
                    "no accessibility tree has been read yet — call read_ax_tree first",
                ))
            }
        };
        // The session can move to another monitor between the read and the
        // press. The ids in the old snapshot describe windows on the old
        // screen, so they are no longer a description of what the person is
        // watching (L-267).
        if self.read_on != self.display.get() {
            return Some(Observation::fail(
                "the shared screen changed since this tree was read — read it again",
            ));
        }
        // Reject a bad or non-actionable id before touching the live element.
        match tree::pressable_by_id(&snapshot.nodes, element_id) {
            None => Some(Observation::fail(format!(
                "element [{element_id}] is not in the current tree — re-read first"
            ))),
            Some(false) => Some(Observation::fail(format!(
                "element [{element_id}] is not pressable — pick one marked {{pressable}}"
            ))),
            Some(true) => None,
        }
    }

    /// Press the element. `fresh` is the reading taken between the approval
    /// and now, present exactly when there is an approval to re-check.
    fn press(
        &self,
        element_id: usize,
        approved: Option<&AxTarget>,
        fresh: Option<AxSnapshot>,
    ) -> Observation {
        let Some(snapshot) = &self.last else {
            return Observation::fail(
                "no accessibility tree has been read yet — call read_ax_tree first",
            );
        };
        #[cfg(target_os = "macos")]
        {
            let Some(handle) = snapshot.handle(element_id) else {
                return Observation::fail(format!("element [{element_id}] handle missing"));
            };
            // The gate classified a specific control, and the user may have
            // approved that control by name. Between then and now the app can
            // re-lay itself out and leave a different button under this handle.
            // Ask the live element what it is before pressing it; the snapshot
            // cannot answer, because it is a copy of what we already believed.
            if let (Some(approved), Some(fresh)) = (approved, fresh) {
                if !snapshot.same_context(&fresh, element_id) {
                    return Observation::fail(
                        "The window changed between the approval and the press, so the approval \
                         no longer describes what would happen. Pages that update themselves do \
                         this on their own. Read the tree again and choose; if the same press \
                         keeps being refused, use a direct tool instead or finish with \
                         needs_input rather than asking the person again.",
                    );
                }
                match ax::describe_live(handle) {
                    Some((role, label)) => {
                        let now = AxTarget::new(role, label);
                        if &now != approved {
                            return Observation::fail(format!(
                                "element [{element_id}] changed from {:?} to {:?} since it was \
                                 approved — re-read the tree and choose again",
                                approved.label, now.label
                            ));
                        }
                    }
                    None => {
                        return Observation::fail(format!(
                            "element [{element_id}] could not be re-read before pressing — \
                             re-read the tree and choose again"
                        ))
                    }
                }
            }
            match ax::macos::press(handle) {
                Ok(()) => Observation::ok(format!("pressed element [{element_id}]")),
                Err(e) => Observation::fail(format!("press failed: {e}")),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (snapshot, approved, fresh);
            Observation::fail("the accessibility tier is only available on macOS")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn press_without_a_read_is_rejected() {
        let ex = AxExecutor::default();
        let obs = ex.cannot_press(3).expect("refused");
        assert!(!obs.ok);
        assert!(obs.summary.contains("read_ax_tree first"));
    }

    // The press-gating logic (unknown id, non-pressable id) is the pure
    // `tree::pressable_by_id` — exhaustively tested in `ax::tree`. Here we only
    // assert the executor's "no read yet" guard; the live FFI walk + press is
    // exercised by the on-device smoke test.

    fn snapshot(nodes: Vec<tree::AxNode>) -> AxExecutor {
        let display = crate::agent::executor::SharedDisplay::default();
        AxExecutor {
            last: Some(AxSnapshot::for_test(nodes)),
            read_on: display.get(),
            display,
        }
    }

    fn node(id: usize, role: &str, label: Option<&str>) -> tree::AxNode {
        tree::AxNode {
            id,
            depth: 1,
            role: role.into(),
            label: label.map(Into::into),
            value: None,
            pressable: true,
        }
    }

    /// L-267. A tree read while one screen was shared does not describe the
    /// screen that is shared now, so a press chosen from it is refused.
    #[test]
    fn a_display_switch_invalidates_the_last_read() {
        let executor = snapshot(vec![node(0, "AXButton", Some("Send"))]);
        executor.display.set(Some(7));
        let obs = executor.cannot_press(0).expect("refused");
        assert!(!obs.ok);
        assert!(
            obs.summary.contains("shared screen changed"),
            "{}",
            obs.summary
        );
    }

    #[test]
    fn resolve_attaches_what_the_id_currently_points_at() {
        let ex = snapshot(vec![node(7, "AXButton", Some("Send"))]);
        let resolved = ex.resolve(Action::AxPress {
            element_id: 7,
            target: None,
        });
        assert_eq!(
            resolved,
            Action::AxPress {
                element_id: 7,
                target: Some(AxTarget::new("AXButton", "Send")),
            }
        );
    }

    #[test]
    fn resolve_leaves_an_unknown_id_unresolved_rather_than_guessing() {
        // The gate reads `None` as "unknown effect" and holds. Inventing a
        // benign-looking target here would be the bug, one layer lower.
        let ex = snapshot(vec![node(7, "AXButton", Some("Send"))]);
        let resolved = ex.resolve(Action::AxPress {
            element_id: 99,
            target: None,
        });
        assert_eq!(
            resolved,
            Action::AxPress {
                element_id: 99,
                target: None
            }
        );
    }

    #[test]
    fn resolve_without_any_read_yields_no_target() {
        let ex = AxExecutor::default();
        let resolved = ex.resolve(Action::AxPress {
            element_id: 1,
            target: None,
        });
        assert!(matches!(resolved, Action::AxPress { target: None, .. }));
    }

    #[test]
    fn resolve_does_not_touch_other_actions() {
        let ex = AxExecutor::default();
        assert_eq!(ex.resolve(Action::ReadAxTree), Action::ReadAxTree);
    }
}
