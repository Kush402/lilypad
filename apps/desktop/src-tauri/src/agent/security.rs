//! The security gate — the non-negotiable safety floor of the AI executor.
//!
//! Every action the model proposes, from ANY tier, is classified here by a
//! **pure, deterministic function** before it may run. The model proposes;
//! this code disposes. There is deliberately no LLM in the classification
//! path — the safety decision must be reproducible and table-testable.
//!
//! Policy (see `docs/m5.3-ai-executor-plan.md` §4):
//!   • `Safe`          → auto-run
//!   • `Sensitive`     → auto-run while the session is control-scoped, logged
//!   • `Consequential` → HOLD, require explicit phone approve/deny
//!   • `Forbidden`     → hard-refuse, never surfaced as approvable
//!
//! The gate **defaults to caution**: anything it cannot positively recognize as
//! safe/sensitive is treated as at least `Consequential`, and any match against
//! the forbidden-pattern set wins outright.

use crate::agent::protocol::{Approval, ApprovalScript, ApprovalTarget, ToolClass};

/// A structured, tier-independent representation of one thing the agent wants
/// to do. Tiers 1–3 all lower their output into this enum, so the classifier
/// sees a uniform surface regardless of how the action was produced.
///
/// `AppleScript`/`Shell` are included so the gate can defend against them even
/// though M5.3 does **not** expose raw-shell tools to the model — defense in
/// depth for any future tier that might.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Read the focused app's accessibility tree. Read-only.
    ReadAxTree,
    /// Grab the current screen (already captured for streaming; free).
    Screenshot,
    /// Move the cursor without pressing anything.
    MoveMouse { x: f64, y: f64 },
    /// Wheel scroll.
    Scroll { x: f64, y: f64, dx: f64, dy: f64 },
    /// A pointer click at a normalized coordinate.
    Click { x: f64, y: f64, count: u8 },
    /// Press an accessibility element by the `id` it was given in the most
    /// recent `read_ax_tree` snapshot.
    ///
    /// `target` is the element's resolved meaning, filled in by
    /// [`Executor::resolve`](crate::agent::runner::Executor::resolve) **before**
    /// classification. The gate needs it because `element_id` alone carries no
    /// meaning at all: id 7 is "Cancel" in one tree and "Delete Account" in the
    /// next, and a classifier that cannot tell them apart auto-runs both.
    AxPress {
        element_id: usize,
        target: Option<AxTarget>,
    },
    /// Type literal text.
    TypeText { text: String },
    /// A key chord, e.g. `["meta","KeyS"]` for ⌘S.
    Key { chord: Vec<String> },
    /// Launch/focus an app by name (tier-1 skill).
    OpenApp { name: String },
    /// Open a URL in the default browser (tier-1 skill).
    OpenUrl { url: String },
    /// Reveal a path in Finder (tier-1 skill).
    RevealInFinder { path: String },
    /// Open a file in its default app (tier-1 skill). Path is user-dir jailed.
    OpenFile { path: String },
    /// Create a folder (tier-1 skill). Path is user-dir jailed.
    NewFolder { path: String },
    /// Trigger a macOS Shortcut by name (tier-1 skill).
    RunShortcut { name: String },
    /// Raw AppleScript/JXA — NOT exposed to the model in M5.3; classified
    /// defensively.
    AppleScript { script: String },
    /// Raw shell — NOT exposed to the model in M5.3; classified defensively.
    Shell { command: String },
    /// Model-generated code run under the Seatbelt sandbox (P2, tier "sandbox").
    /// Always at least `Consequential` (held for approval) — the user sees the
    /// script before it runs — and `Forbidden` if it touches a security-
    /// critical surface. `writable_paths` and `needs_network` widen the
    /// sandbox and so raise the stakes, never lower them.
    RunScript {
        language: ScriptLanguage,
        script: String,
        /// Extra paths (beyond the scratch dir) the script may write to.
        writable_paths: Vec<String>,
        /// Whether the script needs outbound network.
        needs_network: bool,
    },
    /// The agent declares the task complete.
    Done { summary: String },
}

/// What an accessibility element actually is, resolved from the live tree at
/// the moment the action was proposed. Carried on [`Action::AxPress`] so the
/// pure classifier can judge the *effect* rather than an opaque index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AxTarget {
    /// AX role, e.g. "AXButton".
    pub role: String,
    /// The element's human label (AXTitle, else AXDescription). Empty when the
    /// control advertises none — which the gate treats as unknown, not benign.
    pub label: String,
}

impl AxTarget {
    pub fn new(role: impl Into<String>, label: impl Into<String>) -> Self {
        AxTarget {
            role: role.into(),
            label: label.into(),
        }
    }
}

/// Interpreter for a sandboxed script (P2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptLanguage {
    Shell,
    Python,
}

/// Key chords that carry real destructive/consequential weight and must be
/// held even though a lone keystroke is normally `Sensitive`. Compared
/// case-insensitively against the normalized chord.
const DANGEROUS_CHORDS: &[&[&str]] = &[
    &["meta", "delete"],          // ⌘⌫ — move to Trash
    &["meta", "backspace"],       // ⌘⌫ (alt code name)
    &["meta", "shift", "delete"], // empty Trash-ish
    &["meta", "keyq"],            // ⌘Q — quit (may drop unsaved work)
    &["ctrl", "keyc"],            // ^C in a terminal — interrupt/kill
];

/// Whole words on a control's label that make pressing it consequential: it
/// sends, spends or destroys something, and no undo is promised. Matched as
/// **whole tokens**, never substrings, so "Sender" and "Reformatted" do not
/// trip the words "send" and "format".
const CONSEQUENTIAL_LABEL_WORDS: &[&str] = &[
    // Leaves the machine — irreversible the moment it is pressed.
    "send",
    "sends",
    "sending",
    "resend",
    "submit",
    "publish",
    "post",
    "share",
    // Spends money or commits to an agreement.
    "buy",
    "purchase",
    "pay",
    "order",
    "checkout",
    "subscribe",
    "donate",
    // Destroys or revokes.
    "delete",
    "remove",
    "trash",
    "erase",
    "discard",
    "destroy",
    "wipe",
    "uninstall",
    "revoke",
    "clear",
    "reset",
    "format",
    // Drops session or unsaved state.
    "quit",
    "logout",
    "signout",
    "shutdown",
    "restart",
];

/// Consequential labels whose words are individually innocent ("sign", "out").
/// Compared as substrings of the lower-cased label.
const CONSEQUENTIAL_LABEL_PHRASES: &[&str] = &[
    "move to trash",
    "empty trash",
    "log out",
    "sign out",
    "shut down",
    "delete all",
    "erase all",
    "remove all",
];

/// Substrings that mark a script/command as touching security-critical
/// surfaces. Any hit is `Forbidden` — never approvable. Lower-cased compare.
const FORBIDDEN_SUBSTRINGS: &[&str] = &[
    "keychain",
    "security ",
    "sudo",
    "rm -rf /",
    "csrutil",
    "spctl",
    "tccutil",
    "/etc/",
    "launchctl",
    "defaults write",
    "curl ",
    "wget ",
    "nc ",
    "base64 -d",
    "osascript -e",
    "do shell script",
    "chmod",
    "chown",
    "dd if=",
    "diskutil",
    "password",
];

fn normalize(parts: &[String]) -> Vec<String> {
    parts.iter().map(|p| p.to_ascii_lowercase()).collect()
}

fn chord_matches(chord: &[String], pattern: &[&str]) -> bool {
    if chord.len() != pattern.len() {
        return false;
    }
    let norm = normalize(chord);
    // Order-independent: a chord is a set of held keys.
    pattern
        .iter()
        .all(|p| norm.iter().any(|c| c == &p.to_ascii_lowercase()))
}

fn looks_forbidden(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    FORBIDDEN_SUBSTRINGS.iter().any(|s| lower.contains(s))
}

/// Classify a proposed action. Pure and total — every `Action` maps to exactly
/// one `ToolClass`, and unknown/raw surfaces bias toward caution.
pub fn classify(action: &Action) -> ToolClass {
    match action {
        // Read-only / harmless motion.
        Action::ReadAxTree
        | Action::Screenshot
        | Action::MoveMouse { .. }
        | Action::Scroll { .. }
        | Action::Done { .. } => ToolClass::Safe,

        // Ordinary UI manipulation — real effect, but reversible and visible.
        Action::Click { .. }
        | Action::TypeText { .. }
        | Action::OpenApp { .. }
        | Action::RevealInFinder { .. }
        | Action::OpenFile { .. }
        | Action::NewFolder { .. }
        | Action::RunShortcut { .. } => ToolClass::Sensitive,

        // An accessibility press is only as safe as the control it lands on.
        Action::AxPress { target, .. } => classify_ax_press(target.as_ref()),

        // A URL is sensitive unless it smells like a scheme that can execute or
        // exfiltrate; unknown schemes are held.
        Action::OpenUrl { url } => classify_url(url),

        // A keystroke is normally sensitive, but a dangerous chord is held.
        Action::Key { chord } => {
            if DANGEROUS_CHORDS.iter().any(|p| chord_matches(chord, p)) {
                ToolClass::Consequential
            } else {
                ToolClass::Sensitive
            }
        }

        // Raw script/shell: forbidden on any security-critical hit, else held.
        Action::AppleScript { script } => {
            if looks_forbidden(script) {
                ToolClass::Forbidden
            } else {
                ToolClass::Consequential
            }
        }
        Action::Shell { command } => {
            if looks_forbidden(command) {
                ToolClass::Forbidden
            } else {
                ToolClass::Consequential
            }
        }

        // Model-generated sandboxed code: forbidden on a security-critical hit
        // (defense in depth — the sandbox already denies these, but the gate
        // refuses to even offer it), otherwise always held for approval. The
        // sandbox constrains blast radius; the human still authorizes it.
        Action::RunScript { script, .. } => {
            if looks_forbidden(script) {
                ToolClass::Forbidden
            } else {
                ToolClass::Consequential
            }
        }
    }
}

/// Does this control's label announce a consequential effect?
///
/// Deliberately conservative in the direction that costs the user nothing: a
/// false positive asks a question, a false negative sends the email.
pub fn label_is_consequential(label: &str) -> bool {
    let lower = label.to_ascii_lowercase();
    if CONSEQUENTIAL_LABEL_PHRASES
        .iter()
        .any(|p| lower.contains(p))
    {
        return true;
    }
    lower
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| CONSEQUENTIAL_LABEL_WORDS.contains(&word))
}

/// Classify an accessibility press from its resolved target.
///
/// The `None` and empty-label cases are the whole point of the change: an
/// unresolvable id and an unlabeled control are *unknown* effects, and the
/// gate's standing rule is that anything it cannot positively recognize is at
/// least `Consequential`. Auto-running them was how a Send button reached the
/// same path as benign navigation.
fn classify_ax_press(target: Option<&AxTarget>) -> ToolClass {
    match target {
        // The id named nothing in the current snapshot (or there was none).
        None => ToolClass::Consequential,
        // A control that advertises no label tells us nothing about its effect.
        Some(t) if t.label.trim().is_empty() => ToolClass::Consequential,
        Some(t) if label_is_consequential(&t.label) => ToolClass::Consequential,
        // A labeled control with no consequential word: ordinary navigation.
        Some(_) => ToolClass::Sensitive,
    }
}

/// Describe what a held action is asking permission for.
///
/// Pure and total, and deliberately built from the same `Action` the executor
/// will run — the card cannot describe grants the action does not carry,
/// because it reads them off the action itself.
pub fn approval_for(action: &Action) -> Approval {
    let mut approval = Approval {
        purpose: String::new(),
        script: None,
        writable_paths: Vec::new(),
        network: false,
        target: None,
    };
    match action {
        Action::RunScript {
            language,
            script,
            writable_paths,
            needs_network,
        } => {
            approval.purpose = match language {
                ScriptLanguage::Shell => "Run a shell script".into(),
                ScriptLanguage::Python => "Run a Python script".into(),
            };
            approval.script = Some(ApprovalScript {
                language: match language {
                    ScriptLanguage::Shell => "shell",
                    ScriptLanguage::Python => "python",
                },
                source: script.clone(),
            });
            approval.writable_paths = writable_paths.clone();
            approval.network = *needs_network;
        }
        Action::AxPress { element_id, target } => {
            approval.purpose = match target {
                Some(t) if !t.label.trim().is_empty() => {
                    format!("Press \u{201c}{}\u{201d}", t.label)
                }
                // The gate held this precisely because it could not tell what
                // the control is; say so rather than inventing a name.
                _ => format!("Press an unidentified control [{element_id}]"),
            };
            approval.target = target.as_ref().map(|t| ApprovalTarget {
                role: t.role.clone(),
                label: t.label.clone(),
            });
        }
        Action::Key { chord } => {
            approval.purpose = format!("Press {}", chord.join("+"));
        }
        Action::OpenUrl { url } => {
            approval.purpose = format!("Open {url}");
            approval.network = true;
        }
        Action::AppleScript { script } => {
            approval.purpose = "Run AppleScript".into();
            approval.script = Some(ApprovalScript {
                language: "applescript",
                source: script.clone(),
            });
        }
        Action::Shell { command } => {
            approval.purpose = "Run a shell command".into();
            approval.script = Some(ApprovalScript {
                language: "shell",
                source: command.clone(),
            });
        }
        other => {
            approval.purpose = format!("{other:?}");
        }
    }
    approval
}

fn classify_url(url: &str) -> ToolClass {
    let lower = url.trim().to_ascii_lowercase();
    // http(s)/mailto are the ordinary, sensitive cases.
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
    {
        return ToolClass::Sensitive;
    }
    // Schemes that can invoke local handlers/scripts are held for review; a
    // `file:`/`javascript:`/custom scheme is not auto-openable.
    ToolClass::Consequential
}

/// Convenience: does this classification require a human hold before running?
pub fn requires_hold(class: ToolClass) -> bool {
    matches!(class, ToolClass::Consequential)
}

/// Convenience: is this action outright refused (never even offered for
/// approval)?
pub fn is_forbidden(class: ToolClass) -> bool {
    matches!(class, ToolClass::Forbidden)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(parts: &[&str]) -> Action {
        Action::Key {
            chord: parts.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn read_only_and_motion_are_safe() {
        assert_eq!(classify(&Action::ReadAxTree), ToolClass::Safe);
        assert_eq!(classify(&Action::Screenshot), ToolClass::Safe);
        assert_eq!(
            classify(&Action::MoveMouse { x: 0.1, y: 0.2 }),
            ToolClass::Safe
        );
        assert_eq!(
            classify(&Action::Scroll {
                x: 0.5,
                y: 0.5,
                dx: 0.0,
                dy: 10.0
            }),
            ToolClass::Safe
        );
        assert_eq!(
            classify(&Action::Done {
                summary: "done".into()
            }),
            ToolClass::Safe
        );
    }

    #[test]
    fn ordinary_ui_actions_are_sensitive() {
        assert_eq!(
            classify(&Action::Click {
                x: 0.5,
                y: 0.5,
                count: 1
            }),
            ToolClass::Sensitive
        );
        assert_eq!(
            classify(&Action::TypeText { text: "hi".into() }),
            ToolClass::Sensitive
        );
        assert_eq!(
            classify(&Action::OpenApp {
                name: "Safari".into()
            }),
            ToolClass::Sensitive
        );
        // An accessibility press is only auto-run once its target is known to
        // be ordinary. This assertion used to pass an unresolved `AxPress`,
        // which is exactly the hole L-227… L-228 closed; flipped rather than
        // deleted so the change of policy is visible here.
        assert_eq!(
            classify(&Action::AxPress {
                element_id: 7,
                target: Some(AxTarget::new("AXButton", "Back")),
            }),
            ToolClass::Sensitive
        );
        assert_eq!(
            classify(&Action::RunShortcut {
                name: "Note".into()
            }),
            ToolClass::Sensitive
        );
        assert_eq!(
            classify(&Action::OpenFile {
                path: "~/a.pdf".into()
            }),
            ToolClass::Sensitive
        );
        assert_eq!(
            classify(&Action::NewFolder { path: "~/R".into() }),
            ToolClass::Sensitive
        );
    }

    #[test]
    fn ordinary_keystrokes_are_sensitive() {
        assert_eq!(classify(&key(&["meta", "KeyS"])), ToolClass::Sensitive); // ⌘S save
        assert_eq!(classify(&key(&["Enter"])), ToolClass::Sensitive);
        assert_eq!(classify(&key(&["meta", "KeyC"])), ToolClass::Sensitive); // copy
    }

    #[test]
    fn dangerous_chords_are_held_regardless_of_order() {
        assert_eq!(
            classify(&key(&["meta", "delete"])),
            ToolClass::Consequential
        );
        assert_eq!(
            classify(&key(&["delete", "meta"])),
            ToolClass::Consequential
        ); // order-independent
        assert_eq!(
            classify(&key(&["META", "Delete"])),
            ToolClass::Consequential
        ); // case-insensitive
        assert_eq!(classify(&key(&["meta", "KeyQ"])), ToolClass::Consequential);
        assert_eq!(
            classify(&key(&["meta", "shift", "delete"])),
            ToolClass::Consequential
        );
    }

    #[test]
    fn http_urls_are_sensitive_other_schemes_held() {
        assert_eq!(
            classify(&Action::OpenUrl {
                url: "https://example.com".into()
            }),
            ToolClass::Sensitive
        );
        assert_eq!(
            classify(&Action::OpenUrl {
                url: "  HTTP://x  ".into()
            }),
            ToolClass::Sensitive
        );
        assert_eq!(
            classify(&Action::OpenUrl {
                url: "file:///etc/passwd".into()
            }),
            ToolClass::Consequential
        );
        assert_eq!(
            classify(&Action::OpenUrl {
                url: "javascript:alert(1)".into()
            }),
            ToolClass::Consequential
        );
        assert_eq!(
            classify(&Action::OpenUrl {
                url: "customscheme://do".into()
            }),
            ToolClass::Consequential
        );
    }

    #[test]
    fn raw_scripts_are_at_least_consequential() {
        assert_eq!(
            classify(&Action::AppleScript {
                script: "tell app \"Notes\" to make note".into()
            }),
            ToolClass::Consequential
        );
        assert_eq!(
            classify(&Action::Shell {
                command: "ls ~/Downloads".into()
            }),
            ToolClass::Consequential
        );
    }

    #[test]
    fn security_critical_scripts_are_forbidden() {
        assert_eq!(
            classify(&Action::Shell {
                command: "sudo rm -rf /".into()
            }),
            ToolClass::Forbidden
        );
        assert_eq!(
            classify(&Action::Shell {
                command: "security find-generic-password".into()
            }),
            ToolClass::Forbidden
        );
        assert_eq!(
            classify(&Action::AppleScript {
                script: "do shell script \"tccutil reset All\"".into()
            }),
            ToolClass::Forbidden
        );
        assert_eq!(
            classify(&Action::Shell {
                command: "cat ~/.ssh/id_rsa | base64 -d".into()
            }),
            ToolClass::Forbidden
        );
        // Case-insensitive.
        assert_eq!(
            classify(&Action::Shell {
                command: "SUDO reboot".into()
            }),
            ToolClass::Forbidden
        );
    }

    #[test]
    fn sandboxed_scripts_are_held_or_forbidden() {
        // A benign script is held for approval (never auto-run).
        assert_eq!(
            classify(&Action::RunScript {
                language: ScriptLanguage::Shell,
                script: "zip -r out.zip .".into(),
                writable_paths: vec![],
                needs_network: false,
            }),
            ToolClass::Consequential
        );
        // A security-critical script is refused outright, even sandboxed.
        assert_eq!(
            classify(&Action::RunScript {
                language: ScriptLanguage::Shell,
                script: "cat ~/.ssh/id_rsa | base64 -d".into(),
                writable_paths: vec![],
                needs_network: false,
            }),
            ToolClass::Forbidden
        );
        assert_eq!(
            classify(&Action::RunScript {
                language: ScriptLanguage::Python,
                script: "import os; os.system('sudo rm -rf /')".into(),
                writable_paths: vec![],
                needs_network: false,
            }),
            ToolClass::Forbidden
        );
    }

    #[test]
    fn hold_and_forbidden_helpers_agree_with_classes() {
        assert!(requires_hold(ToolClass::Consequential));
        assert!(!requires_hold(ToolClass::Sensitive));
        assert!(!requires_hold(ToolClass::Forbidden)); // forbidden is refused, not held
        assert!(is_forbidden(ToolClass::Forbidden));
        assert!(!is_forbidden(ToolClass::Consequential));
    }

    // ── L-228: an accessibility press is classified by its target ──
    //
    // The provider exposes `ax_press` and the gate used to auto-run every one
    // of them, so a Send, Buy or Delete button followed the same path as
    // benign navigation. These fixtures are the distinction the gate now makes.

    fn press(label: &str) -> Action {
        Action::AxPress {
            element_id: 7,
            target: Some(AxTarget::new("AXButton", label)),
        }
    }

    #[test]
    fn benign_navigation_still_runs_without_asking() {
        for label in [
            "Back",
            "Next",
            "Open",
            "Show Details",
            "Cancel",
            "Close",
            "Refresh",
            "Sender",
        ] {
            assert_eq!(
                classify(&press(label)),
                ToolClass::Sensitive,
                "{label:?} should not need approval"
            );
        }
    }

    #[test]
    fn sending_purchasing_and_deleting_are_held() {
        for label in [
            "Send",
            "Send Message",
            "Resend invitation",
            "Submit",
            "Post",
            "Publish",
            "Share",
            "Buy now",
            "Purchase",
            "Pay $42.00",
            "Place order",
            "Checkout",
            "Subscribe",
            "Delete",
            "Delete Account",
            "Remove",
            "Move to Trash",
            "Empty Trash",
            "Erase All Content",
            "Uninstall",
            "Revoke access",
            "Reset",
            "Sign Out",
            "Log Out",
            "Shut Down",
            "Quit",
        ] {
            assert_eq!(
                classify(&press(label)),
                ToolClass::Consequential,
                "{label:?} must be held for approval"
            );
        }
    }

    #[test]
    fn an_unresolved_target_is_held_rather_than_assumed_harmless() {
        // No read yet, or an id that names nothing in the current tree. The
        // gate's standing rule is that what it cannot recognize is at least
        // Consequential; this is that rule reaching `ax_press` at last.
        assert_eq!(
            classify(&Action::AxPress {
                element_id: 7,
                target: None,
            }),
            ToolClass::Consequential
        );
    }

    #[test]
    fn an_unlabeled_control_is_held() {
        assert_eq!(
            classify(&Action::AxPress {
                element_id: 7,
                target: Some(AxTarget::new("AXButton", "   ")),
            }),
            ToolClass::Consequential
        );
    }

    #[test]
    fn consequential_words_match_whole_tokens_not_substrings() {
        // The cost of a substring match is a gate that holds everything and
        // trains the user to tap Approve without reading.
        assert!(!label_is_consequential("Sender"));
        assert!(!label_is_consequential("Resender column"));
        assert!(!label_is_consequential("Reformatted view"));
        assert!(!label_is_consequential("Ordering options"));
        assert!(label_is_consequential("Send"));
        assert!(label_is_consequential("SEND NOW"));
        assert!(label_is_consequential("Delete\u{2026}"));
    }

    #[test]
    fn approval_is_bound_to_the_target_so_a_changed_button_is_a_different_action() {
        // Two presses of the same id are not the same action once the label
        // differs — which is what lets the executor detect substitution
        // between approval and press.
        let approved = press("Save Draft");
        let substituted = press("Send");
        assert_ne!(approved, substituted);
        assert_eq!(classify(&approved), ToolClass::Sensitive);
        assert_eq!(classify(&substituted), ToolClass::Consequential);
    }

    // ── L-229: the approval derived from the action ──

    #[test]
    fn a_script_approval_carries_source_paths_and_network() {
        let a = approval_for(&Action::RunScript {
            language: ScriptLanguage::Python,
            script: "import os".into(),
            writable_paths: vec!["/tmp/work".into()],
            needs_network: true,
        });
        assert_eq!(a.purpose, "Run a Python script");
        let script = a.script.expect("source must travel with the approval");
        assert_eq!(script.language, "python");
        assert_eq!(script.source, "import os");
        assert_eq!(a.writable_paths, vec!["/tmp/work".to_string()]);
        assert!(a.network);
    }

    #[test]
    fn identical_summaries_still_produce_different_approvals() {
        let quiet = approval_for(&Action::RunScript {
            language: ScriptLanguage::Shell,
            script: "echo hi".into(),
            writable_paths: vec![],
            needs_network: false,
        });
        let loud = approval_for(&Action::RunScript {
            language: ScriptLanguage::Shell,
            script: "echo hi".into(),
            writable_paths: vec!["/Users/me".into()],
            needs_network: true,
        });
        assert_eq!(quiet.purpose, loud.purpose);
        assert_ne!(quiet, loud);
    }

    #[test]
    fn an_ax_approval_names_the_control_it_will_press() {
        let a = approval_for(&Action::AxPress {
            element_id: 7,
            target: Some(AxTarget::new("AXButton", "Delete Account")),
        });
        assert!(a.purpose.contains("Delete Account"));
        let t = a.target.expect("the control must travel with the approval");
        assert_eq!(t.label, "Delete Account");
    }

    #[test]
    fn an_unidentified_control_says_so_instead_of_inventing_a_name() {
        let a = approval_for(&Action::AxPress {
            element_id: 7,
            target: None,
        });
        assert!(a.purpose.contains("unidentified"));
        assert!(a.target.is_none());
    }
}
