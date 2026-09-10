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
}

impl Executor for AxExecutor {
    async fn execute(&mut self, action: &Action) -> Result<Observation> {
        match action {
            Action::ReadAxTree => {
                // Reading the AX tree is a blocking FFI walk; keep it off the
                // async worker.
                let snapshot = match tokio::task::spawn_blocking(ax::read_focused_tree).await {
                    Ok(Ok(s)) => s,
                    Ok(Err(e)) => {
                        return Ok(Observation::fail(format!(
                            "could not read the accessibility tree: {e}"
                        )))
                    }
                    Err(e) => return Ok(Observation::fail(format!("ax read task failed: {e}"))),
                };
                let text = tree::serialize(&snapshot.nodes);
                self.last = Some(snapshot);
                Ok(Observation::ok(format!("Accessibility tree:\n{text}")))
            }
            Action::AxPress { element_id, target } => self.press(*element_id, target.as_ref()),
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

    fn press(&self, element_id: usize, approved: Option<&AxTarget>) -> Result<Observation> {
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
                return Ok(Observation::fail(format!(
                    "element [{element_id}] handle missing"
                )));
            };
            // The gate classified a specific control, and the user may have
            // approved that control by name. Between then and now the app can
            // re-lay itself out and leave a different button under this handle.
            // Ask the live element what it is before pressing it; the snapshot
            // cannot answer, because it is a copy of what we already believed.
            if let Some(approved) = approved {
                let fresh = ax::read_focused_tree()?;
                if !snapshot.same_context(&fresh) {
                    return Ok(Observation::fail(
                        "The app or its contents changed since this action was chosen. Read again and request fresh approval."
                    ));
                }
                match ax::describe_live(handle) {
                    Some((role, label)) => {
                        let now = AxTarget::new(role, label);
                        if &now != approved {
                            return Ok(Observation::fail(format!(
                                "element [{element_id}] changed from {:?} to {:?} since it was \
                                 approved — re-read the tree and choose again",
                                approved.label, now.label
                            )));
                        }
                    }
                    None => {
                        return Ok(Observation::fail(format!(
                            "element [{element_id}] could not be re-read before pressing — \
                             re-read the tree and choose again"
                        )))
                    }
                }
            }
            match ax::macos::press(handle) {
                Ok(()) => Ok(Observation::ok(format!("pressed element [{element_id}]"))),
                Err(e) => Ok(Observation::fail(format!("press failed: {e}"))),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = snapshot;
            Ok(Observation::fail(
                "the accessibility tier is only available on macOS",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn press_without_a_read_is_rejected() {
        let ex = AxExecutor::default();
        let obs = ex.press(3, None).unwrap();
        assert!(!obs.ok);
        assert!(obs.summary.contains("read_ax_tree first"));
    }

    // The press-gating logic (unknown id, non-pressable id) is the pure
    // `tree::pressable_by_id` — exhaustively tested in `ax::tree`. Here we only
    // assert the executor's "no read yet" guard; the live FFI walk + press is
    // exercised by the on-device smoke test.

    fn snapshot(nodes: Vec<tree::AxNode>) -> AxExecutor {
        AxExecutor {
            last: Some(AxSnapshot::for_test(nodes)),
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
