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

use crate::agent::protocol::ToolClass;

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
    /// Press an accessibility element by its resolved path.
    AxPress { path: String },
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
    &["meta", "delete"],           // ⌘⌫ — move to Trash
    &["meta", "backspace"],        // ⌘⌫ (alt code name)
    &["meta", "shift", "delete"],  // empty Trash-ish
    &["meta", "keyq"],             // ⌘Q — quit (may drop unsaved work)
    &["ctrl", "keyc"],             // ^C in a terminal — interrupt/kill
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
        | Action::AxPress { .. }
        | Action::TypeText { .. }
        | Action::OpenApp { .. }
        | Action::RevealInFinder { .. }
        | Action::OpenFile { .. }
        | Action::NewFolder { .. }
        | Action::RunShortcut { .. } => ToolClass::Sensitive,

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
        assert_eq!(classify(&Action::MoveMouse { x: 0.1, y: 0.2 }), ToolClass::Safe);
        assert_eq!(
            classify(&Action::Scroll { x: 0.5, y: 0.5, dx: 0.0, dy: 10.0 }),
            ToolClass::Safe
        );
        assert_eq!(
            classify(&Action::Done { summary: "done".into() }),
            ToolClass::Safe
        );
    }

    #[test]
    fn ordinary_ui_actions_are_sensitive() {
        assert_eq!(classify(&Action::Click { x: 0.5, y: 0.5, count: 1 }), ToolClass::Sensitive);
        assert_eq!(classify(&Action::TypeText { text: "hi".into() }), ToolClass::Sensitive);
        assert_eq!(classify(&Action::OpenApp { name: "Safari".into() }), ToolClass::Sensitive);
        assert_eq!(classify(&Action::AxPress { path: "AXButton/Save".into() }), ToolClass::Sensitive);
        assert_eq!(classify(&Action::RunShortcut { name: "Note".into() }), ToolClass::Sensitive);
        assert_eq!(classify(&Action::OpenFile { path: "~/a.pdf".into() }), ToolClass::Sensitive);
        assert_eq!(classify(&Action::NewFolder { path: "~/R".into() }), ToolClass::Sensitive);
    }

    #[test]
    fn ordinary_keystrokes_are_sensitive() {
        assert_eq!(classify(&key(&["meta", "KeyS"])), ToolClass::Sensitive); // ⌘S save
        assert_eq!(classify(&key(&["Enter"])), ToolClass::Sensitive);
        assert_eq!(classify(&key(&["meta", "KeyC"])), ToolClass::Sensitive); // copy
    }

    #[test]
    fn dangerous_chords_are_held_regardless_of_order() {
        assert_eq!(classify(&key(&["meta", "delete"])), ToolClass::Consequential);
        assert_eq!(classify(&key(&["delete", "meta"])), ToolClass::Consequential); // order-independent
        assert_eq!(classify(&key(&["META", "Delete"])), ToolClass::Consequential); // case-insensitive
        assert_eq!(classify(&key(&["meta", "KeyQ"])), ToolClass::Consequential);
        assert_eq!(classify(&key(&["meta", "shift", "delete"])), ToolClass::Consequential);
    }

    #[test]
    fn http_urls_are_sensitive_other_schemes_held() {
        assert_eq!(classify(&Action::OpenUrl { url: "https://example.com".into() }), ToolClass::Sensitive);
        assert_eq!(classify(&Action::OpenUrl { url: "  HTTP://x  ".into() }), ToolClass::Sensitive);
        assert_eq!(classify(&Action::OpenUrl { url: "file:///etc/passwd".into() }), ToolClass::Consequential);
        assert_eq!(classify(&Action::OpenUrl { url: "javascript:alert(1)".into() }), ToolClass::Consequential);
        assert_eq!(classify(&Action::OpenUrl { url: "customscheme://do".into() }), ToolClass::Consequential);
    }

    #[test]
    fn raw_scripts_are_at_least_consequential() {
        assert_eq!(
            classify(&Action::AppleScript { script: "tell app \"Notes\" to make note".into() }),
            ToolClass::Consequential
        );
        assert_eq!(
            classify(&Action::Shell { command: "ls ~/Downloads".into() }),
            ToolClass::Consequential
        );
    }

    #[test]
    fn security_critical_scripts_are_forbidden() {
        assert_eq!(
            classify(&Action::Shell { command: "sudo rm -rf /".into() }),
            ToolClass::Forbidden
        );
        assert_eq!(
            classify(&Action::Shell { command: "security find-generic-password".into() }),
            ToolClass::Forbidden
        );
        assert_eq!(
            classify(&Action::AppleScript { script: "do shell script \"tccutil reset All\"".into() }),
            ToolClass::Forbidden
        );
        assert_eq!(
            classify(&Action::Shell { command: "cat ~/.ssh/id_rsa | base64 -d".into() }),
            ToolClass::Forbidden
        );
        // Case-insensitive.
        assert_eq!(
            classify(&Action::Shell { command: "SUDO reboot".into() }),
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
}
