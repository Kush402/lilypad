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
use crate::input::keys::Chord;
use crate::input::{Modifier, PointerButton};

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
    /// Look at the screen: the elements that can be acted on, what is focused
    /// and which app is in front — plus a screenshot for a model that can see.
    /// Read-only.
    ReadScreen,
    /// Move the pointer without pressing anything.
    MoveMouse { to: Target },
    /// Wheel scroll, at a point or wherever the pointer is.
    Scroll {
        target: Option<Target>,
        direction: ScrollDirection,
        /// Wheel clicks.
        amount: u32,
        modifiers: Vec<Modifier>,
        hit: Option<Hit>,
    },
    /// A pointer click. `count` 1..3.
    Click {
        target: Target,
        button: PointerButton,
        count: u8,
        modifiers: Vec<Modifier>,
        /// What is under the point, filled in by `Executor::resolve` before
        /// classification — the same reason `AxPress` carries its target.
        hit: Option<Hit>,
    },
    /// Press at `from`, move to `to`, release.
    Drag {
        from: Target,
        to: Target,
        modifiers: Vec<Modifier>,
        hit: Option<Hit>,
        hit_to: Option<Hit>,
    },
    /// Press and hold a button (released by `MouseUp` or the end of the run).
    MouseDown {
        target: Option<Target>,
        button: PointerButton,
        hit: Option<Hit>,
    },
    MouseUp {
        target: Option<Target>,
        button: PointerButton,
        hit: Option<Hit>,
    },
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
    /// Perform a named accessibility action (`AXPress`, `AXShowMenu`, …) on
    /// an element from the most recent reading.
    AxPerform {
        element_id: usize,
        action: String,
        target: Option<AxTarget>,
        hit: Option<Hit>,
    },
    /// Replace an element's value outright, the way a person would select all
    /// and retype it.
    SetValue {
        element_id: usize,
        text: String,
        target: Option<AxTarget>,
        hit: Option<Hit>,
    },
    /// Type literal text into whatever has keyboard focus.
    TypeText { text: String, focus: Option<Hit> },
    /// Press key chords in order, `repeat` times.
    Key {
        chords: Vec<Chord>,
        repeat: u32,
        focus: Option<Hit>,
    },
    /// Hold a chord down for a while.
    HoldKey {
        chord: Chord,
        ms: u64,
        focus: Option<Hit>,
    },
    /// Do nothing for a while, then look again.
    Wait { ms: u64 },
    /// Look closely at a region of the screen: normalized `[x0, y0, x1, y1]`.
    Zoom { region: [f64; 4] },
    /// Report where the pointer is.
    CursorPosition,
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
        /// Paths under the user's home the script may read. The sandbox denies
        /// every other home path, so an undeclared read fails rather than
        /// silently succeeding — and each declared one is on the approval card
        /// the person reads before the script runs (L-247).
        readable_paths: Vec<String>,
        /// Whether the script needs outbound network.
        needs_network: bool,
    },
    /// The agent declares the task complete.
    Done { summary: String },
}

/// Where a pointer action lands: a normalized point on the shared display, or
/// an element from the most recent screen reading.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Target {
    Point {
        x: f64,
        y: f64,
    },
    Element(usize),
    /// Wherever the pointer already is.
    Here,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

/// What an action would actually touch, read from the live screen before the
/// gate sees it: the element under the point (or with keyboard focus), and the
/// app that owns it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Hit {
    pub element: Option<AxTarget>,
    /// The owning app, as a person would name it ("Mail").
    pub app: String,
    /// The element or app is Lilypad itself.
    pub own: bool,
    /// The app is a surface Ask never operates (a password prompt, a privacy
    /// consent dialog, the login window), named for the refusal.
    pub protected: Option<String>,
    /// A password field, or macOS secure keyboard input is on.
    pub secure: bool,
    /// The app is a terminal, where typed text is a command.
    pub terminal: bool,
}

/// How much the person has handed over for this run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Autonomy {
    /// Every click, drag, value change, URL and consequential key is held for
    /// an explicit approve on the phone. What a phone that predates full
    /// control gets.
    #[default]
    Supervised,
    /// The person granted full control: everything runs, except what the
    /// floor refuses in every mode.
    Full,
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
    &["meta", "delete"],                    // ⌘⌫ — move to Trash
    &["meta", "backspace"],                 // ⌘⌫ (alt code name)
    &["meta", "shift", "delete"],           // empty Trash-ish
    &["meta", "shift", "backspace"],        // ⇧⌘⌫ — empty Trash
    &["meta", "alt", "backspace"],          // ⌥⌘⌫ — delete immediately
    &["meta", "alt", "shift", "backspace"], // ⌥⇧⌘⌫ — empty Trash, no prompt
    &["meta", "keyq"],                      // ⌘Q — quit (may drop unsaved work)
    &["meta", "alt", "escape"],             // ⌥⌘⎋ — Force Quit
    &["ctrl", "keyc"],                      // ^C in a terminal — interrupt/kill
];

/// Chords that end the person's session or take the Mac away from them:
/// lock, log out, sleep, restart, shut down. Refused in every mode — none of
/// them is a step in a task, and every one of them strands the person who
/// handed the Mac over.
const SESSION_ENDING_CHORDS: &[&[&str]] = &[
    &["ctrl", "meta", "keyq"],         // ⌃⌘Q — lock screen
    &["meta", "shift", "keyq"],        // ⇧⌘Q — log out
    &["meta", "alt", "shift", "keyq"], // ⌥⇧⌘Q — log out, no prompt
    &["ctrl", "meta", "f12"],          // some keyboards map lock here
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

fn chord_matches(chord: &Chord, pattern: &[&str]) -> bool {
    let parts = chord.canonical();
    if parts.len() != pattern.len() {
        return false;
    }
    // Order-independent: a chord is a set of held keys.
    pattern
        .iter()
        .all(|p| parts.iter().any(|c| c == &p.to_ascii_lowercase()))
}

fn looks_forbidden(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    FORBIDDEN_SUBSTRINGS.iter().any(|s| lower.contains(s))
}

/// Commands that are never typed into a terminal, on top of
/// [`FORBIDDEN_SUBSTRINGS`]: recursive deletion and taking the machine down.
/// Typed text in a terminal is a command the moment Return follows it.
const TERMINAL_FORBIDDEN: &[&str] = &[
    "rm -rf", "rm -fr", "rm -r ", "rm -f ", "mkfs", "shutdown", "reboot", "halt", "killall", ":(){",
];

fn terminal_forbidden(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    looks_forbidden(text) || TERMINAL_FORBIDDEN.iter().any(|s| lower.contains(s))
}

/// Classify a proposed action. Pure and total — every `Action` maps to exactly
/// one `ToolClass`, and unknown/raw surfaces bias toward caution.
///
/// This is the supervised policy. [`floor`] is checked first and wins in
/// every mode; [`gate_class`] applies the run's autonomy on top.
pub fn classify(action: &Action) -> ToolClass {
    if floor(action).is_some() {
        return ToolClass::Forbidden;
    }
    match action {
        // Read-only / harmless motion.
        Action::ReadAxTree
        | Action::Screenshot
        | Action::ReadScreen
        | Action::MoveMouse { .. }
        | Action::Scroll { .. }
        | Action::Wait { .. }
        | Action::Zoom { .. }
        | Action::CursorPosition
        | Action::Done { .. } => ToolClass::Safe,

        // Ordinary input — real effect, but reversible and visible.
        Action::TypeText { .. }
        | Action::HoldKey { .. }
        | Action::OpenApp { .. }
        | Action::RevealInFinder { .. }
        | Action::OpenFile { .. }
        | Action::NewFolder { .. }
        | Action::RunShortcut { .. } => ToolClass::Sensitive,

        // A click lands on whatever is under the point, and a point carries no
        // meaning of its own — the same reason every accessibility press is
        // held (L-228). Under supervision, every one is asked.
        Action::Click { .. }
        | Action::Drag { .. }
        | Action::MouseDown { .. }
        | Action::MouseUp { .. }
        | Action::SetValue { .. }
        | Action::AxPerform { .. } => ToolClass::Consequential,

        // An accessibility press is only as safe as the control it lands on.
        Action::AxPress { target, .. } => classify_ax_press(target.as_ref()),

        // Every model-chosen URL is held: the URL itself can transmit data.
        Action::OpenUrl { url } => classify_url(url),

        // A keystroke is normally sensitive, but a dangerous chord is held.
        Action::Key { chords, .. } => {
            if chords
                .iter()
                .any(|c| DANGEROUS_CHORDS.iter().any(|p| chord_matches(c, p)))
            {
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

/// The class an action runs under in this run: [`classify`], with the
/// person's grant applied. Full control runs what supervision would hold;
/// nothing ever runs what the floor or the forbidden list refuses.
pub fn gate_class(action: &Action, autonomy: Autonomy) -> ToolClass {
    match (classify(action), autonomy) {
        (ToolClass::Consequential, Autonomy::Full) if touches_known(action) => ToolClass::Sensitive,
        (class, _) => class,
    }
}

/// Did `Executor::resolve` find what this action lands on? The floor can only
/// refuse what it can see: a point or a keyboard focus whose owner could not
/// be read (a busy app, an accessibility timeout — Lilypad's own window when
/// its main thread is busy) may be Lilypad itself or a permission prompt. So
/// full control does not run those unasked; the person approves them, as under
/// supervision. Actions that land on no element (a URL, an app by name) have
/// nothing to find.
fn touches_known(action: &Action) -> bool {
    match action {
        Action::Click { hit, .. }
        | Action::MouseDown { hit, .. }
        | Action::MouseUp { hit, .. }
        | Action::AxPerform { hit, .. }
        | Action::SetValue { hit, .. } => hit.is_some(),
        Action::Drag { hit, hit_to, .. } => hit.is_some() && hit_to.is_some(),
        Action::Key { focus, .. } | Action::HoldKey { focus, .. } => focus.is_some(),
        _ => true,
    }
}

/// The part of the policy that full control does not change (ADR-0018).
///
/// Returns why `action` is refused, in words for the person and the model, or
/// `None`. Deliberately short: this is the basic floor the owner asked for,
/// not a second approval system.
pub fn floor(action: &Action) -> Option<String> {
    let hits: Vec<&Hit> = match action {
        Action::Click { hit, .. }
        | Action::Scroll { hit, .. }
        | Action::MouseDown { hit, .. }
        | Action::MouseUp { hit, .. }
        | Action::AxPerform { hit, .. }
        | Action::SetValue { hit, .. } => hit.iter().collect(),
        Action::Drag { hit, hit_to, .. } => hit.iter().chain(hit_to.iter()).collect(),
        Action::TypeText { focus, .. }
        | Action::Key { focus, .. }
        | Action::HoldKey { focus, .. } => focus.iter().collect(),
        _ => Vec::new(),
    };
    for hit in &hits {
        if hit.own {
            return Some("Ask never operates Lilypad itself.".into());
        }
        if let Some(surface) = &hit.protected {
            return Some(format!(
                "Ask never operates {surface}. Those are for the person at the Mac."
            ));
        }
    }
    let typing = matches!(
        action,
        Action::TypeText { .. }
            | Action::Key { .. }
            | Action::HoldKey { .. }
            | Action::SetValue { .. }
    );
    if typing && hits.iter().any(|h| h.secure) {
        return Some("Ask never types into a password field.".into());
    }
    match action {
        Action::Key { chords, .. } => {
            if chords
                .iter()
                .any(|c| SESSION_ENDING_CHORDS.iter().any(|p| chord_matches(c, p)))
            {
                return Some(
                    "That shortcut locks the screen or ends the session; Ask never presses it."
                        .into(),
                );
            }
        }
        Action::TypeText { text, focus }
        | Action::SetValue {
            text, hit: focus, ..
        } => {
            if focus.as_ref().is_some_and(|f| f.terminal) && terminal_forbidden(text) {
                return Some(
                    "That command deletes files, stops the Mac, or touches passwords, system \
                     settings or the network from a terminal; Ask never types it."
                        .into(),
                );
            }
        }
        Action::OpenApp { name } => {
            let n = name.trim().to_ascii_lowercase();
            if n == "lilypad" || n.starts_with("lilypad.") {
                return Some("Ask never operates Lilypad itself.".into());
            }
        }
        _ => {}
    }
    None
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
        // A name is not an effect contract. "OK", "Continue", localized
        // labels and app-authored labels can all commit irreversible actions.
        // Until a trusted semantic skill proves the effect, hold every press.
        Some(_) => ToolClass::Consequential,
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
        readable_paths: Vec::new(),
        network: false,
        target: None,
    };
    match action {
        Action::RunScript {
            language,
            script,
            writable_paths,
            readable_paths,
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
            approval.readable_paths = readable_paths.clone();
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
        Action::Click { hit, .. }
        | Action::Drag { hit, .. }
        | Action::MouseDown { hit, .. }
        | Action::MouseUp { hit, .. }
        | Action::AxPerform { hit, .. }
        | Action::SetValue { hit, .. } => {
            approval.purpose = describe(action);
            approval.target =
                hit.as_ref()
                    .and_then(|h| h.element.as_ref())
                    .map(|t| ApprovalTarget {
                        role: t.role.clone(),
                        label: t.label.clone(),
                    });
        }
        Action::OpenUrl { url } => {
            // Origin first, then the whole URL. A long path can push the host
            // off the end of a phone-sized line, and the host is the part that
            // decides who receives the request — so it is stated separately
            // rather than left to be found inside the string. The data note
            // flags the query/fragment, which is where a model would put what
            // it just read off the screen.
            let origin = url_origin(url);
            let data = if url_carries_data(url) {
                " — sends data in the link"
            } else {
                ""
            };
            approval.purpose = format!("Open {origin}{data}: {}", url.trim());
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
            approval.purpose = describe(other);
        }
    }
    approval
}

/// One line saying what an action does, in the person's words — the step
/// feed and the approval card both read it. Built from the resolved action,
/// so it names the control a point lands on rather than the point.
pub fn describe(action: &Action) -> String {
    match action {
        Action::ReadAxTree => "Read the screen (accessibility tree)".into(),
        Action::Screenshot => "Look at the screen".into(),
        Action::ReadScreen => "Look at the screen".into(),
        Action::MoveMouse { to } => format!("Move the pointer to {}", place(to, None)),
        Action::Click {
            target,
            button,
            count,
            modifiers,
            hit,
        } => {
            let verb = match (button, count) {
                (PointerButton::Right, _) => "Right-click",
                (PointerButton::Middle, _) => "Middle-click",
                (_, 2) => "Double-click",
                (_, 3) => "Triple-click",
                _ => "Click",
            };
            format!(
                "{}{verb} {}",
                held_modifiers(modifiers),
                place(target, hit.as_ref())
            )
        }
        Action::Drag {
            from,
            to,
            modifiers,
            hit,
            hit_to,
        } => format!(
            "{}Drag {} to {}",
            held_modifiers(modifiers),
            place(from, hit.as_ref()),
            place(to, hit_to.as_ref())
        ),
        Action::MouseDown { target, hit, .. } => match target {
            Some(t) => format!("Press and hold the mouse on {}", place(t, hit.as_ref())),
            None => "Press and hold the mouse".into(),
        },
        Action::MouseUp { .. } => "Release the mouse".into(),
        Action::Scroll {
            target,
            direction,
            amount,
            hit,
            ..
        } => {
            let dir = match direction {
                ScrollDirection::Up => "up",
                ScrollDirection::Down => "down",
                ScrollDirection::Left => "left",
                ScrollDirection::Right => "right",
            };
            match target {
                Some(t) => format!("Scroll {dir} {amount} over {}", place(t, hit.as_ref())),
                None => format!("Scroll {dir} {amount}"),
            }
        }
        Action::TypeText { text, focus } => {
            let n = text.chars().count();
            let preview = quote_clip(text, 60);
            let into = focus
                .as_ref()
                .map(|f| format!(" in {}", f.app))
                .filter(|s| s.len() > 4)
                .unwrap_or_default();
            if n > 60 {
                format!("Type {preview} ({n} characters){into}")
            } else {
                format!("Type {preview}{into}")
            }
        }
        Action::Key { chords, repeat, .. } => {
            let keys: Vec<String> = chords.iter().map(Chord::display).collect();
            let times = if *repeat > 1 {
                format!(" ×{repeat}")
            } else {
                String::new()
            };
            format!("Press {}{times}", keys.join(" then "))
        }
        Action::HoldKey { chord, ms, .. } => {
            format!("Hold {} for {}", chord.display(), seconds(*ms))
        }
        Action::Wait { ms } => format!("Wait {}", seconds(*ms)),
        Action::Zoom { .. } => "Look closely at part of the screen".into(),
        Action::CursorPosition => "Check where the pointer is".into(),
        Action::AxPress { element_id, target } => match target {
            Some(t) if !t.label.trim().is_empty() => format!("Press \u{201c}{}\u{201d}", t.label),
            _ => format!("Press element [{element_id}]"),
        },
        Action::AxPerform {
            element_id,
            action,
            target,
            ..
        } => {
            let verb = match action.as_str() {
                "AXPress" => "Press",
                "AXShowMenu" => "Open the menu of",
                "AXIncrement" => "Increase",
                "AXDecrement" => "Decrease",
                "AXConfirm" => "Confirm",
                "AXCancel" => "Cancel",
                "AXRaise" => "Bring forward",
                "AXPick" => "Pick",
                other => other,
            };
            format!("{verb} {}", element_name(*element_id, target.as_ref()))
        }
        Action::SetValue {
            element_id,
            text,
            target,
            ..
        } => format!(
            "Set {} to {}",
            element_name(*element_id, target.as_ref()),
            quote_clip(text, 60)
        ),
        Action::OpenApp { name } => format!("Open {name}"),
        Action::OpenUrl { url } => format!("Open {url}"),
        Action::RevealInFinder { path } => format!("Show {path} in Finder"),
        Action::OpenFile { path } => format!("Open {path}"),
        Action::NewFolder { path } => format!("Create folder {path}"),
        Action::RunShortcut { name } => format!("Run the Shortcut {name}"),
        Action::AppleScript { .. } => "Run AppleScript".into(),
        Action::Shell { .. } => "Run a shell command".into(),
        Action::RunScript { language, .. } => match language {
            ScriptLanguage::Shell => "Run a shell script".into(),
            ScriptLanguage::Python => "Run a Python script".into(),
        },
        Action::Done { summary } => summary.clone(),
    }
}

fn held_modifiers(modifiers: &[Modifier]) -> String {
    if modifiers.is_empty() {
        return String::new();
    }
    let chord = Chord {
        modifiers: modifiers.to_vec(),
        key: None,
    };
    format!("{}-", chord.display())
}

fn seconds(ms: u64) -> String {
    if ms % 1000 == 0 {
        format!("{} s", ms / 1000)
    } else {
        format!("{:.1} s", ms as f64 / 1000.0)
    }
}

fn quote_clip(text: &str, max: usize) -> String {
    let one_line = text.replace(['\n', '\r'], " ⏎ ");
    let mut clipped: String = one_line.chars().take(max).collect();
    if one_line.chars().count() > max {
        clipped.push('…');
    }
    format!("\u{201c}{clipped}\u{201d}")
}

/// A role as a person says it: "AXButton" → "button".
fn role_word(role: &str) -> String {
    let bare = role.strip_prefix("AX").unwrap_or(role);
    match bare {
        "TextField" | "TextArea" | "SearchField" | "ComboBox" => "field".into(),
        "StaticText" => "text".into(),
        "PopUpButton" | "MenuButton" => "menu".into(),
        "CheckBox" => "checkbox".into(),
        "RadioButton" => "option".into(),
        "MenuItem" | "MenuBarItem" => "menu item".into(),
        "Link" => "link".into(),
        "Tab" | "TabGroup" => "tab".into(),
        other => other.to_ascii_lowercase(),
    }
}

fn element_name(id: usize, target: Option<&AxTarget>) -> String {
    match target {
        Some(t) if !t.label.trim().is_empty() => {
            format!(
                "\u{201c}{}\u{201d} {}",
                clip_label(&t.label),
                role_word(&t.role)
            )
        }
        Some(t) => format!("an unlabeled {} [{id}]", role_word(&t.role)),
        None => format!("element [{id}]"),
    }
}

fn clip_label(label: &str) -> String {
    let mut out: String = label.chars().take(60).collect();
    if label.chars().count() > 60 {
        out.push('…');
    }
    out
}

/// Where a pointer action lands, in words.
fn place(target: &Target, hit: Option<&Hit>) -> String {
    let app = hit
        .map(|h| h.app.trim())
        .filter(|a| !a.is_empty())
        .map(|a| format!(" in {a}"))
        .unwrap_or_default();
    match (target, hit.and_then(|h| h.element.as_ref())) {
        (_, Some(t)) if !t.label.trim().is_empty() => format!(
            "\u{201c}{}\u{201d} {}{app}",
            clip_label(&t.label),
            role_word(&t.role)
        ),
        (Target::Element(id), t) => format!("{}{app}", element_name(*id, t)),
        (Target::Here, Some(t)) => {
            format!("an unlabeled {} under the pointer{app}", role_word(&t.role))
        }
        (Target::Here, None) => format!("where the pointer is{app}"),
        (Target::Point { x, y }, Some(t)) => format!(
            "an unlabeled {} at {:.0}%, {:.0}%{app}",
            role_word(&t.role),
            x * 100.0,
            y * 100.0
        ),
        (Target::Point { x, y }, None) => {
            format!("the screen at {:.0}%, {:.0}%{app}", x * 100.0, y * 100.0)
        }
    }
}

/// The origin of a URL as plain text: scheme and host, nothing else.
///
/// Deliberately not a URL parser. It answers one question — *who receives
/// this request* — for display, and anything it cannot confidently split it
/// reports as `unknown destination` rather than guessing. A wrong guess here
/// would put a reassuring host on a card for a request going somewhere else,
/// which is worse than saying nothing.
fn url_origin(url: &str) -> String {
    // Use the same URL parsing rules as HTTP clients, not an authority split:
    // backslashes, encoded hosts and IDNs can change the effective host.
    match reqwest::Url::parse(url.trim()) {
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => {
            parsed.origin().ascii_serialization()
        }
        Ok(parsed) => format!("{}:", parsed.scheme()),
        Err(_) => "unknown destination".into(),
    }
}

/// Does this URL carry a payload beyond the page it names — a query string or
/// a fragment? That is where anything the model learned would travel.
fn url_carries_data(url: &str) -> bool {
    let trimmed = url.trim();
    let after_scheme = trimmed.split_once("://").map(|(_, r)| r).unwrap_or(trimmed);
    after_scheme.contains('?') || after_scheme.contains('#')
}

/// Opening a URL is always held (L-253).
///
/// The old rule auto-ran `http(s)`/`mailto` as merely `Sensitive`, on the
/// reading that "open a web page" is a navigation, not an effect. That reading
/// ignores the argument. `open <url>` hands the *default browser* a string the
/// model composed, and the model has just read the screen, the accessibility
/// tree and possibly a file; everything it learned fits in a query string. A
/// GET to an attacker-named host is a complete exfiltration channel, and it
/// runs with the browser's cookies, so it is also a request made *as the user*.
/// Sandbox network denial does not touch it — this never enters the sandbox.
///
/// There is no sub-rule that separates the safe case from the unsafe one:
/// host allow-listing fails on shorteners and open redirects, and stripping the
/// query breaks every legitimate deep link. So the scheme no longer decides.
/// [`approval_for`] puts the whole URL on the card, and an over-long one is
/// refused rather than shortened, so what the person reads is what is opened.
fn classify_url(_url: &str) -> ToolClass {
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
            chords: crate::input::keys::parse_keys(&parts.join("+")).unwrap(),
            repeat: 1,
            focus: None,
        }
    }

    fn click_on(hit: Hit) -> Action {
        Action::Click {
            target: Target::Point { x: 0.5, y: 0.5 },
            button: PointerButton::Left,
            count: 1,
            modifiers: vec![],
            hit: Some(hit),
        }
    }

    fn typing_into(text: &str, focus: Hit) -> Action {
        Action::TypeText {
            text: text.into(),
            focus: Some(focus),
        }
    }

    #[test]
    fn read_only_and_motion_are_safe() {
        assert_eq!(classify(&Action::ReadAxTree), ToolClass::Safe);
        assert_eq!(classify(&Action::Screenshot), ToolClass::Safe);
        assert_eq!(
            classify(&Action::MoveMouse {
                to: Target::Point { x: 0.1, y: 0.2 }
            }),
            ToolClass::Safe
        );
        assert_eq!(
            classify(&Action::Scroll {
                target: Some(Target::Point { x: 0.5, y: 0.5 }),
                direction: ScrollDirection::Down,
                amount: 3,
                modifiers: vec![],
                hit: None,
            }),
            ToolClass::Safe
        );
        assert_eq!(classify(&Action::Wait { ms: 500 }), ToolClass::Safe);
        assert_eq!(
            classify(&Action::Zoom {
                region: [0.0, 0.0, 0.5, 0.5]
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
        // A click was `Sensitive` while no tool could produce one. Once Ask
        // can click anywhere, a point is as meaningless to the gate as an
        // element id was (L-228), so supervision holds it. Flipped rather than
        // deleted so the change of policy is visible here.
        assert_eq!(
            classify(&Action::Click {
                target: Target::Point { x: 0.5, y: 0.5 },
                button: PointerButton::Left,
                count: 1,
                modifiers: vec![],
                hit: None,
            }),
            ToolClass::Consequential
        );
        assert_eq!(
            classify(&Action::TypeText {
                text: "hi".into(),
                focus: None
            }),
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
            ToolClass::Consequential
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
    fn every_url_is_held_because_the_url_itself_is_the_payload() {
        // L-253. `https://` used to auto-run. The scheme says how the string
        // travels, never what is in it: a model that has just read the screen
        // can put everything it saw in the query and the browser will send it,
        // with the user's cookies. Held means the person reads the whole URL
        // on the card before the browser ever sees it.
        for url in [
            "https://example.com",
            "  HTTP://x  ",
            "https://evil.example/collect?note=card%201234",
            "mailto:someone@example.com?body=secret",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "customscheme://do",
        ] {
            assert_eq!(
                classify(&Action::OpenUrl { url: url.into() }),
                ToolClass::Consequential,
                "{url} must be held"
            );
        }
    }

    #[test]
    fn a_held_url_is_disclosed_in_full_on_the_card() {
        // Holding is only a boundary if the card carries the argument; a
        // truncated URL would approve a destination the person never read.
        let action = Action::OpenUrl {
            url: "https://evil.example/collect?note=card%201234".into(),
        };
        let card = approval_for(&action);
        assert!(card.fits_wire());
        assert!(card
            .purpose
            .contains("evil.example/collect?note=card%201234"));
        // The origin is stated on its own, so it cannot be pushed off the end
        // of a phone-sized line by a long path, and the card says data is
        // travelling in the link.
        assert!(card
            .purpose
            .starts_with("Open https://evil.example — sends data in the link:"));
    }

    #[test]
    fn the_origin_shown_is_the_host_that_receives_the_request() {
        // `https://bank.example@evil.test/` goes to evil.test. Reading the
        // string left to right gets this wrong, which is exactly why it is a
        // standard phishing shape and why the card states the host itself.
        assert_eq!(
            url_origin("https://bank.example@evil.test/login"),
            "https://evil.test"
        );
        assert_eq!(
            url_origin("HTTP://Example.com/a/b?c=1"),
            "http://example.com"
        );
        assert_eq!(url_origin("mailto:someone@example.com"), "mailto:");
        assert_eq!(url_origin("javascript:alert(1)"), "javascript:");
        assert_eq!(url_origin("https://"), "unknown destination");
        assert_eq!(url_origin("not a url"), "unknown destination");

        assert!(url_carries_data("https://x.test/a?b=1"));
        assert!(url_carries_data("https://x.test/a#frag"));
        assert!(!url_carries_data("https://x.test/a/b"));
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
                readable_paths: vec![],
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
                readable_paths: vec![],
                needs_network: false,
            }),
            ToolClass::Forbidden
        );
        assert_eq!(
            classify(&Action::RunScript {
                language: ScriptLanguage::Python,
                script: "import os; os.system('sudo rm -rf /')".into(),
                writable_paths: vec![],
                readable_paths: vec![],
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
    fn a_label_alone_cannot_prove_navigation_is_benign() {
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
                ToolClass::Consequential,
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
        assert_eq!(classify(&approved), ToolClass::Consequential);
        assert_eq!(classify(&substituted), ToolClass::Consequential);
    }

    // ── L-229: the approval derived from the action ──

    #[test]
    fn a_script_approval_carries_source_paths_and_network() {
        let a = approval_for(&Action::RunScript {
            language: ScriptLanguage::Python,
            script: "import os".into(),
            writable_paths: vec!["/tmp/work".into()],
            readable_paths: vec![],
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
            readable_paths: vec![],
            needs_network: false,
        });
        let loud = approval_for(&Action::RunScript {
            language: ScriptLanguage::Shell,
            script: "echo hi".into(),
            writable_paths: vec!["/Users/me".into()],
            readable_paths: vec![],
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
    // ── ADR-0018: full control and the floor under it ──

    #[test]
    fn full_control_runs_what_supervision_holds() {
        let held = [
            click_on(Hit {
                app: "Mail".into(),
                element: Some(AxTarget::new("AXButton", "Send")),
                ..Default::default()
            }),
            Action::OpenUrl {
                url: "https://example.com".into(),
            },
            Action::Key {
                chords: crate::input::keys::parse_keys("meta+KeyQ").unwrap(),
                repeat: 1,
                focus: Some(Hit {
                    app: "Safari".into(),
                    ..Default::default()
                }),
            },
            Action::SetValue {
                element_id: 3,
                text: "hello".into(),
                target: Some(AxTarget::new("AXTextField", "Subject")),
                hit: Some(Hit {
                    app: "Mail".into(),
                    ..Default::default()
                }),
            },
        ];
        for action in held {
            assert_eq!(
                gate_class(&action, Autonomy::Supervised),
                ToolClass::Consequential,
                "{action:?}"
            );
            assert_eq!(
                gate_class(&action, Autonomy::Full),
                ToolClass::Sensitive,
                "{action:?}"
            );
        }
    }

    #[test]
    fn full_control_asks_when_it_cannot_see_what_it_would_touch() {
        // Nothing resolved: the point's owner, or the keyboard's, could not
        // be read. It may be Lilypad or a permission prompt, so the floor
        // cannot vouch for it and the person is asked.
        let unknown = [
            Action::Click {
                target: Target::Point { x: 0.5, y: 0.5 },
                button: PointerButton::Left,
                count: 1,
                modifiers: vec![],
                hit: None,
            },
            Action::Drag {
                from: Target::Point { x: 0.1, y: 0.1 },
                to: Target::Point { x: 0.9, y: 0.9 },
                modifiers: vec![],
                hit: Some(Hit::default()),
                hit_to: None,
            },
            key(&["meta", "KeyQ"]),
            Action::SetValue {
                element_id: 3,
                text: "hello".into(),
                target: None,
                hit: None,
            },
        ];
        for action in unknown {
            assert_eq!(
                gate_class(&action, Autonomy::Full),
                ToolClass::Consequential,
                "{action:?}"
            );
        }
        // What lands on no element runs as before.
        assert_eq!(
            gate_class(
                &Action::OpenUrl {
                    url: "https://example.com".into()
                },
                Autonomy::Full
            ),
            ToolClass::Sensitive
        );
    }

    #[test]
    fn the_floor_holds_in_every_mode() {
        let refused = [
            click_on(Hit {
                app: "Lilypad".into(),
                own: true,
                ..Default::default()
            }),
            click_on(Hit {
                app: "SecurityAgent".into(),
                protected: Some("the macOS password prompt".into()),
                ..Default::default()
            }),
            typing_into(
                "hunter2",
                Hit {
                    app: "Safari".into(),
                    secure: true,
                    ..Default::default()
                },
            ),
            typing_into(
                "sudo rm -rf ~",
                Hit {
                    app: "Terminal".into(),
                    terminal: true,
                    ..Default::default()
                },
            ),
            key(&["ctrl", "meta", "q"]),
            key(&["meta", "shift", "q"]),
            Action::OpenApp {
                name: "Lilypad".into(),
            },
        ];
        for action in refused {
            assert!(floor(&action).is_some(), "{action:?}");
            for autonomy in [Autonomy::Supervised, Autonomy::Full] {
                assert_eq!(
                    gate_class(&action, autonomy),
                    ToolClass::Forbidden,
                    "{action:?} in {autonomy:?}"
                );
            }
        }
    }

    #[test]
    fn ordinary_terminal_commands_and_text_elsewhere_are_not_refused() {
        let terminal = Hit {
            app: "Terminal".into(),
            terminal: true,
            ..Default::default()
        };
        assert!(floor(&typing_into("ls -la ~/Downloads", terminal.clone())).is_none());
        // The same words outside a terminal are just text in a document.
        assert!(floor(&typing_into(
            "remember to curl the hair",
            Hit {
                app: "Notes".into(),
                ..Default::default()
            }
        ))
        .is_none());
        assert!(floor(&typing_into("sudo make me a sandwich", terminal.clone())).is_some());
        assert!(floor(&typing_into("rm -rf ~/Documents", terminal.clone())).is_some());
        assert!(floor(&typing_into("sudo shutdown -h now", terminal)).is_some());
    }

    #[test]
    fn a_secure_field_refuses_keys_as_well_as_text() {
        let secure = Hit {
            app: "Safari".into(),
            secure: true,
            ..Default::default()
        };
        let press = Action::Key {
            chords: crate::input::keys::parse_keys("a").unwrap(),
            repeat: 1,
            focus: Some(secure.clone()),
        };
        assert!(floor(&press).is_some());
        // Clicking a password field is fine — it is typing into it that is not.
        assert!(floor(&click_on(secure)).is_none());
    }

    #[test]
    fn dangerous_chords_are_recognised_in_any_spelling() {
        for spec in [
            "cmd+q",
            "⌘Q",
            "Cmd-Q",
            "super+q",
            "meta+KeyQ",
            "cmd+BackSpace",
            "cmd+alt+Escape",
        ] {
            let action = Action::Key {
                chords: crate::input::keys::parse_keys(spec).unwrap(),
                repeat: 1,
                focus: None,
            };
            assert_eq!(classify(&action), ToolClass::Consequential, "{spec}");
        }
        for spec in ["ctrl+cmd+q", "⌃⌘Q", "cmd+shift+q"] {
            let action = Action::Key {
                chords: crate::input::keys::parse_keys(spec).unwrap(),
                repeat: 1,
                focus: None,
            };
            assert_eq!(classify(&action), ToolClass::Forbidden, "{spec}");
        }
    }

    #[test]
    fn a_click_card_names_the_control_and_the_app() {
        let card = approval_for(&click_on(Hit {
            app: "Mail".into(),
            element: Some(AxTarget::new("AXButton", "Send")),
            ..Default::default()
        }));
        assert_eq!(card.purpose, "Click \u{201c}Send\u{201d} button in Mail");
        assert_eq!(card.target.unwrap().label, "Send");
        // Without a hit, the card says where rather than inventing a name.
        let blind = describe(&Action::Click {
            target: Target::Point { x: 0.25, y: 0.5 },
            button: PointerButton::Left,
            count: 2,
            modifiers: vec![Modifier::Meta],
            hit: None,
        });
        assert_eq!(blind, "⌘-Double-click the screen at 25%, 50%");
    }

    #[test]
    fn typed_text_is_quoted_clipped_and_counted() {
        let short = describe(&Action::TypeText {
            text: "hello".into(),
            focus: None,
        });
        assert_eq!(short, "Type \u{201c}hello\u{201d}");
        let long = describe(&Action::TypeText {
            text: "x".repeat(100),
            focus: None,
        });
        assert!(long.contains("(100 characters)"), "{long}");
        assert!(long.contains('…'));
        let keys = describe(&key(&["meta", "shift", "t"]));
        assert_eq!(keys, "Press ⇧⌘T");
    }

    #[test]
    fn navigation_origin_handles_browser_backslashes_and_encoded_hosts() {
        assert_eq!(
            url_origin(r"https://evil.test\@bank.example/"),
            "https://evil.test"
        );
        assert_eq!(url_origin("https://%65vil.test/"), "https://evil.test");
        assert_eq!(
            url_origin("https://example.com:443/"),
            "https://example.com"
        );
    }
}
