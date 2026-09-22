//! The whole task on a System One model (ADR-0020).
//!
//! [`jev::Jev`] answers one short command in one request (ADR-0019). This is
//! the same model carrying a task to the end: one request per step, asking
//! whether the command has been carried out, what kind of step comes next,
//! and which control, words, shortcut, direction or app that step needs.
//! Code decides what to do with the answers, and every action it produces
//! goes through the same resolve, floor, autonomy gate and phone feed as a
//! language model's (ADR-0018).
//!
//! What makes it work is asking about controls the right way. One many-way
//! "which control comes next" spreads its probability across options that are
//! not competing; the right control measured 0.50–0.66. **One yes/no per
//! candidate control**, in the same request, measured 0.79–0.95 on the right
//! control and under 0.1 on the wrong ones.
//!
//! What it cannot do, it says. It never writes a word the person did not:
//! code offers spans of the command itself and the model only chooses among
//! them. A task that needs composed text, a page read back, or an answer to a
//! question ends by naming the limit and pointing at a language model, rather
//! than guessing.
//!
//! No screenshot is taken while this brain is running the task.

use anyhow::Result;
use serde_json::{json, Map, Value};

use super::jev::{self, Jev};
use crate::agent::protocol::AgentTier;
use crate::agent::runner::{Brain, Decision, FinishReason, Observation, ScreenReading};
use crate::agent::security::{ScrollDirection, Target};
use crate::agent::Action;
use crate::input::PointerButton;

/// Steps this brain will take before handing the task back. A System One
/// model is cheap and fast, so the bound is about a task that is not being
/// carried out, not about cost.
pub const MAX_STEPS: usize = 12;

/// How sure the answers must be. Measured against the real API on a scripted
/// Mac (`jev_agent_fixtures.json`): the right control scores 0.79–0.95 and a
/// screen where the next step is genuinely ambiguous scores 0.50–0.56, which
/// is the case that must hand back rather than guess.
const DONE_MIN: f64 = 0.85;
/// With no action history, a high "done" answer alone is not evidence that
/// the current screen satisfies the command. A strong screen-evidence answer
/// may still finish a task that was already complete when it began.
const INITIAL_EVIDENCE_MIN: f64 = 0.75;
const KIND_MIN: f64 = 0.75;
const CONTROL_MIN: f64 = 0.7;
/// How far ahead of the second-best control the chosen one must be. Two
/// controls that both look right are a screen Ask should not guess at.
const CONTROL_MARGIN: f64 = 0.2;
const TEXT_MIN: f64 = 0.85;
const ARGUMENT_MIN: f64 = 0.9;
const DIRECTION_MIN: f64 = 0.8;
/// When the screen actively contradicts "done", rather than merely failing to
/// show it. Measured against the real API (`jev_agent_fixtures.json`): a
/// screen that genuinely cannot show the outcome — an inbox after a reply was
/// sent — answers 0.37–0.41, which is "cannot tell"; a step that plainly has
/// not happened yet answers 0.02–0.06.
///
/// So this is not a completion bar. A list of control names is too thin a
/// description for one: nothing in "button Send, table Inbox" shows whether
/// the mail went. It is a disagreement detector, and a warning that fired on
/// every success would be a warning nobody reads.
const CONTRADICTED_MAX: f64 = 0.15;

/// How long one wait lasts, and how many may run together. A screen that is
/// still not ready after three of these is not loading, it is stuck.
const WAIT_MS: u64 = 1200;
const MAX_WAITS: usize = 3;
const WAIT_KEY: &str = "wait";

fn waits_exhausted(completed: usize) -> bool {
    completed >= MAX_WAITS
}

fn done_reason(contradicted: bool) -> FinishReason {
    if contradicted {
        FinishReason::Incomplete
    } else {
        FinishReason::Completed
    }
}

/// A command can name the application or web address needed to obtain the
/// first usable screen. That decision depends on the command, not on the
/// unreadable/Lilypad window currently in front. In that narrow bootstrap
/// state, keep Jev's job as a typed choice and keep code's job as the safety
/// boundary: only deterministic launch skills may escape without a reading.
fn launch_only_without_screen(step: Step, failure: &str) -> Step {
    match step {
        Step::Act(acting)
            if matches!(
                &acting.action,
                Action::OpenApp { .. } | Action::OpenUrl { .. }
            ) =>
        {
            Step::Act(acting)
        }
        _ => Step::Stop(failure.to_string()),
    }
}

/// Controls asked about in one request. Each costs one yes/no question; the
/// command's own words choose them, so this is a bound, not a budget.
const MAX_CANDIDATES: usize = 8;

/// Wheel clicks for "scroll down", and for "to the bottom" (as ADR-0019).
const SCROLL_STEP: u32 = 10;
const SCROLL_ALL: u32 = 50;

const KINDS: &[(&str, &str)] = &[
    (
        "press",
        "Click, press, tap, choose or open one control on the screen",
    ),
    (
        "type",
        "Type words into whatever has the keyboard, when the words to type are in the command \
         itself",
    ),
    (
        "key",
        "A standard keyboard shortcut such as go back, reload, new tab, copy, paste, select all, \
         save, press Return, press Escape",
    ),
    (
        "scroll",
        "Scroll up, down, left or right, or to the top or bottom",
    ),
    (
        "open_app",
        "Open, launch or switch to an application that is not in front",
    ),
    (
        "open_website",
        "Go to a website address written out in the command",
    ),
    (
        "wait",
        "Nothing can be done yet: the screen is still loading, or what the last step started has \
         not appeared",
    ),
    (
        "impossible",
        "This step needs something this screen cannot give: writing new words that are not in the \
         command, reading the screen back to the person, or answering a question",
    ),
];

/// What the brain is doing between one decision and the next observation.
#[derive(Debug, Clone, PartialEq)]
enum Taken {
    /// The first look, before anything has been decided.
    FirstLook,
    /// An action, with the line it will add to the history when it lands.
    Action { summary: String, repeat_key: String },
}

/// One task, carried by a System One model.
pub struct JevBrain {
    jev: Jev,
    /// One line per step that landed: what the person would say happened.
    history: Vec<String>,
    /// Words from the command that may be typed, in the order code found
    /// them. The model chooses among these; it never adds to them.
    spans: Vec<String>,
    taken: Option<Taken>,
    steps: usize,
    /// The last action's key and the reading it was chosen on, so a step that
    /// changes nothing twice ends the run instead of repeating for ever.
    last: Option<(String, String)>,
    repeats: usize,
    /// Waits taken in a row. A wait is the one step that is meant to change
    /// nothing, so the repeat guard cannot be what bounds it.
    waits: usize,
    /// Installed apps, read once.
    installed: Option<Vec<String>>,
}

impl JevBrain {
    pub fn new(jev: Jev) -> Self {
        JevBrain {
            jev,
            history: Vec::new(),
            spans: Vec::new(),
            taken: None,
            steps: 0,
            last: None,
            repeats: 0,
            waits: 0,
            installed: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn canned(&mut self) -> &mut Option<Value> {
        &mut self.jev.canned
    }

    fn finish(summary: impl Into<String>, reason: FinishReason) -> Result<Decision> {
        Ok(Decision::Finish {
            summary: summary.into(),
            reason,
        })
    }

    fn act(
        &mut self,
        summary: String,
        repeat_key: String,
        tier: AgentTier,
        action: Action,
    ) -> Result<Decision> {
        self.taken = Some(Taken::Action {
            summary: summary.clone(),
            repeat_key,
        });
        self.steps += 1;
        Ok(Decision::Act {
            summary,
            tier,
            action,
        })
    }
}

/// The words of the command that may be typed: what it quotes, and what
/// follows the words people use when they dictate text ("saying", "type",
/// "search for"). Code finds them so that the model can only choose among the
/// person's own words.
pub fn spans_to_type(task: &str) -> Vec<String> {
    /// Keep a span unless the list already says the same thing. "search for
    /// X" and "search" both match "search for X"; the words to type are the
    /// shorter tail, not the one carrying the lead-in word.
    fn push(out: &mut Vec<String>, s: &str) {
        let s = s.trim().trim_end_matches(['.', ',', '!', '?']).trim();
        if s.is_empty() || s.chars().count() > 200 {
            return;
        }
        let lower = s.to_lowercase();
        if out
            .iter()
            .any(|o: &String| lower.ends_with(&o.to_lowercase()))
        {
            return;
        }
        out.retain(|o| !o.to_lowercase().ends_with(&lower));
        out.push(s.to_string());
    }

    let mut out: Vec<String> = Vec::new();
    // Anything in quotes, straight or curly.
    let mut rest = task;
    while let Some(open) = rest.find(['"', '\u{201c}']) {
        let after = &rest[open + rest[open..].chars().next().map_or(1, char::len_utf8)..];
        match after.find(['"', '\u{201d}']) {
            Some(end) => {
                push(&mut out, &after[..end]);
                rest = &after[end..];
            }
            None => break,
        }
    }
    // Quotes are exact: someone who quotes their words means those words and
    // nothing around them.
    if !out.is_empty() {
        out.truncate(5);
        return out;
    }
    // The tail after a dictation word.
    const LEAD: &[&str] = &[
        "saying",
        "say",
        "type",
        "typing",
        "write",
        "writing",
        "search for",
        "search",
        "look up",
        "enter",
        "reply with",
        "send",
    ];
    let lower = task.to_lowercase();
    for lead in LEAD {
        let mut from = 0;
        while let Some(at) = lower[from..].find(lead) {
            let start = from + at;
            let end = start + lead.len();
            let before_ok = start == 0 || !lower.as_bytes()[start - 1].is_ascii_alphanumeric();
            let after_ok = lower.as_bytes().get(end).is_none_or(|b| *b == b' ');
            if before_ok && after_ok && end < task.len() {
                push(&mut out, &task[end..]);
            }
            from = end;
        }
    }
    out.truncate(5);
    out
}

/// Words that say how to act rather than what on.
const FILLER: &[&str] = &[
    "the", "and", "for", "from", "with", "this", "that", "into", "onto", "open", "click", "press",
    "tap", "choose", "select", "then", "first", "one", "please", "email", "message", "folder",
    "file", "page", "tab", "button", "link", "row", "result", "item", "again",
];

fn key_words(text: &str) -> std::collections::HashSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3)
        .map(str::to_lowercase)
        .filter(|w| !FILLER.contains(&w.as_str()))
        .collect()
}

/// Whether a control is a code-authorized target for this task. Jev's
/// probability is evidence about the next step, not permission to turn an
/// arbitrary page label into an action. Short commands must name every
/// meaningful word (so "reply all" cannot become "Reply"); longer tasks may
/// name an entity and an operation in separate steps ("reply to Rae" first
/// selects Rae, then presses Reply).
fn control_is_relevant(task: &str, history: &[String], label: &str) -> bool {
    let wanted = key_words(task);
    let label_words = key_words(label);
    let matches = |word: &str| {
        label_words.iter().any(|candidate| {
            word == candidate
                || (word.chars().count() >= 4 && candidate.starts_with(word))
                || (candidate.chars().count() >= 4 && word.starts_with(candidate))
        })
    };
    let overlap = wanted.iter().filter(|word| matches(word)).count();
    if overlap == 0 {
        // Sending is the implied final step of a dictated reply/compose task;
        // it is authorized only after the person's words were actually typed.
        let dictated = history.iter().any(|line| line.starts_with("Type "));
        let implied_submit = dictated
            && wanted
                .iter()
                .any(|word| matches!(word.as_str(), "reply" | "compose" | "write" | "send"))
            && label_words
                .iter()
                .any(|word| matches!(word.as_str(), "send" | "submit" | "post"));
        return implied_submit;
    }
    // A relation or a dictation phrase describes a multi-step task, where one
    // step names the row and another names its action. Otherwise require the
    // complete short command to match the chosen control.
    let lower = task.to_lowercase();
    let multi_step_context = lower.contains(" to ")
        || lower.contains(" from ")
        || lower.contains("search for")
        || lower.contains(" saying ")
        || lower.contains(" type ");
    // A relation can make the operation and the target arrive in separate
    // steps, but it must not erase a qualifier the person said. In
    // particular, "reply to Rae" is not permission to press "Reply All".
    if multi_step_context && label_words.contains("all") && !wanted.contains("all") {
        return false;
    }
    multi_step_context || wanted.len() > 2 || overlap == wanted.len()
}

/// The description that may cross the hosted boundary. Accessibility labels
/// are already covered by the consent wording. OCR is different: on a screen
/// with no accessibility controls there is no reliable local way to tell a
/// short button name from a short line of somebody's message. Keep only OCR
/// labels the person already put in the command, and send the command's own
/// spelling rather than the recognized screen text. Requiring the whole OCR
/// run prevents a private line such as “Meet Bob at eight” from being
/// relabelled as a clickable “Bob” merely because the command names Bob.
fn reading_for_task(task: &str, reading: &ScreenReading) -> ScreenReading {
    let task_words: Vec<(&str, String)> = task
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| (word, word.to_lowercase()))
        .collect();
    let mut safe = reading.clone();
    safe.elements = reading
        .elements
        .iter()
        .filter_map(|element| {
            if element.role != "screen text" {
                return Some(element.clone());
            }
            let words: Vec<String> = element
                .label
                .split(|c: char| !c.is_alphanumeric())
                .filter(|word| !word.is_empty())
                .map(str::to_lowercase)
                .collect();
            let start = (!words.is_empty())
                .then(|| {
                    task_words
                        .windows(words.len())
                        .position(|window| window.iter().map(|(_, word)| word).eq(words.iter()))
                })
                .flatten()?;
            Some(crate::agent::runner::ReadElement {
                label: task_words[start..start + words.len()]
                    .iter()
                    .map(|(word, _)| *word)
                    .collect::<Vec<_>>()
                    .join(" "),
                ..element.clone()
            })
        })
        .collect();
    safe
}

/// The controls worth asking about: the ones the command's own words touch,
/// else what the screen offers first (the reading lists focused and
/// actionable elements first). Narrowing is only about keeping the request
/// small — which control it is, is the yes/no questions' job.
pub fn candidates<'a>(
    task: &str,
    reading: &'a ScreenReading,
) -> Vec<&'a crate::agent::runner::ReadElement> {
    let wanted = key_words(task);
    let (named, rest): (Vec<_>, Vec<_>) = reading
        .elements
        .iter()
        .partition(|e| !key_words(&e.label).is_disjoint(&wanted));
    // The command's own words first, then whatever else the screen offers.
    // A command names the row it means but rarely the Send button beside it,
    // so a list of only the named controls is how a step goes missing.
    named.into_iter().chain(rest).take(MAX_CANDIDATES).collect()
}

/// The request for one step.
pub fn request(
    model: &str,
    task: &str,
    reading: &ScreenReading,
    history: &[String],
    spans: &[String],
    apps: &[String],
    candidates: &[&crate::agent::runner::ReadElement],
) -> Value {
    let mut questions = Map::new();
    questions.insert(
        "done".into(),
        json!({
            "type": "noul",
            "instructions": "Has the command been carried out completely, so that nothing further \
                             is needed?",
        }),
    );
    questions.insert(
        "evidence".into(),
        json!({
            "type": "noul",
            "instructions": "Setting aside what was attempted, does what is on the screen right \
                             now show that the command has been carried out?",
        }),
    );
    questions.insert(
        "step".into(),
        jev::choice(
            "The command has not been carried out yet. What is the very next step a person would \
             take on this screen to carry it out?",
            jev::described(KINDS.iter().copied()),
        ),
    );
    for e in candidates {
        questions.insert(
            format!("is_e{}", e.id),
            json!({
                "type": "noul",
                "instructions": format!(
                    "Is clicking the {} \u{201c}{}\u{201d} the very next step a person would take \
                     on this screen to carry out the command?",
                    e.role, e.label
                ),
            }),
        );
    }
    if !spans.is_empty() {
        let mut options: Vec<(String, Value)> = spans
            .iter()
            .enumerate()
            .map(|(i, s)| (format!("t{i}"), Value::String(s.clone())))
            .collect();
        options.push((
            "none".into(),
            "None of these are the words to type now".into(),
        ));
        questions.insert(
            "text".into(),
            jev::choice(
                "The next step is typing. Which of these words from the command are the words to \
                 type now?",
                options,
            ),
        );
    }
    questions.insert(
        "key".into(),
        jev::choice(
            "Which keyboard shortcut is the next step?",
            jev::described(jev::KEYS.iter().map(|(k, what, _, _)| (*k, *what))),
        ),
    );
    questions.insert(
        "direction".into(),
        jev::choice(
            "Which way does the next step scroll?",
            jev::described(jev::DIRECTIONS.iter().copied()),
        ),
    );
    if !apps.is_empty() {
        let mut options: Vec<(String, Value)> =
            apps.iter().map(|a| (a.clone(), Value::Null)).collect();
        options.push(("none".into(), "None of these applications".into()));
        questions.insert(
            "app".into(),
            jev::choice("Which application does the next step open?", options),
        );
    }
    json!({
        "model": model,
        "state": {
            "command": task,
            "app in front": reading.app,
            "what has the keyboard": reading.focused.clone().unwrap_or_else(|| "nothing".into()),
            "what is selected": selection_of(reading),
            // The hosted protocol bounds list-valued state. The model only
            // gets the same bounded, ordered candidates that its per-control
            // questions describe; sending the whole AX tree made busy apps
            // fail validation before Jev could answer.
            "controls on the screen": candidates
                .iter()
                .map(|e| match &e.at {
                    Some(at) => format!("e{}: {} \u{201c}{}\u{201d} ({at})", e.id, e.role, e.label),
                    None => format!("e{}: {} \u{201c}{}\u{201d}", e.id, e.role, e.label),
                })
                .collect::<Vec<_>>(),
            "what has happened so far": if history.is_empty() {
                vec!["nothing yet".to_string()]
            } else {
                history.to_vec()
            },
        },
        "questions": questions,
    })
}

/// What the keyboard focus says about selection. Focus on a list rather than
/// on a row inside it means nothing in that list is chosen yet, and that is
/// the difference between "select the message" and "press Reply" — measured:
/// saying it moves the right control from 0.70 to 0.84 and the wrong one
/// from 0.6x to 0.22.
fn selection_of(reading: &ScreenReading) -> String {
    const CHOSEN: &[&str] = &["row", "cell", "item", "link", "button", "text"];
    match reading.focused.as_deref() {
        Some(focused) if CHOSEN.iter().any(|r| focused.starts_with(r)) => {
            format!("{focused} has the keyboard and is the current choice")
        }
        _ => "nothing in a list or table is selected yet".to_string(),
    }
}

/// What one step's answers mean. `None` is "hand the task back", with the
/// sentence the person reads.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// The command has been carried out. `contradicted` is the screen saying
    /// otherwise — not merely failing to show it, which is the ordinary case.
    Done { contradicted: bool },
    /// A summary, a key that identifies a repeat, the tier and the action.
    /// Boxed: an `Action` dwarfs the other variants.
    Act(Box<Acting>),
    /// Two or three controls all look like the next step. Asking which comes
    /// FIRST, as one question about only those, settles it — measured 0.98
    /// where the yes/no answers were 0.70 against 0.6x.
    Ambiguous(Vec<usize>),
    /// Why the task stops here.
    Stop(String),
}

/// One step to take: what the person reads, a key that spots a repeat, the
/// tier it is reported under, and the action itself.
#[derive(Debug, Clone, PartialEq)]
pub struct Acting {
    pub summary: String,
    pub repeat_key: String,
    pub tier: AgentTier,
    pub action: Action,
}

impl Acting {
    fn step(summary: String, repeat_key: String, tier: AgentTier, action: Action) -> Step {
        Step::Act(Box::new(Acting {
            summary,
            repeat_key,
            tier,
            action,
        }))
    }
}

/// The second request, asked only when [`Step::Ambiguous`] comes back.
pub fn tie_request(
    model: &str,
    task: &str,
    reading: &ScreenReading,
    history: &[String],
    tied: &[&crate::agent::runner::ReadElement],
) -> Value {
    json!({
        "model": model,
        "state": {
            "command": task,
            "app in front": reading.app,
            "what has the keyboard": reading.focused.clone().unwrap_or_else(|| "nothing".into()),
            "what is selected": selection_of(reading),
            "what has happened so far": if history.is_empty() {
                vec!["nothing yet".to_string()]
            } else {
                history.to_vec()
            },
        },
        "questions": {
            "first": jev::choice(
                "These steps all look possible. Which one must happen FIRST, before the others, \
                 to carry out the command on this screen?",
                tied.iter().map(|e| {
                    (
                        format!("e{}", e.id),
                        Value::String(format!(
                            "Click the {} \u{201c}{}\u{201d}",
                            e.role, e.label
                        )),
                    )
                }),
            ),
        },
    })
}

/// How sure the tie-break must be. It is a direct comparison between two or
/// three controls, so a real answer is emphatic; anything less is a screen to
/// hand back.
const TIE_MIN: f64 = 0.8;

/// Which of the tied controls to press, from the tie-break's answer.
pub fn decide_tie(
    reading: &ScreenReading,
    tied: &[&crate::agent::runner::ReadElement],
    answers: &Value,
) -> Step {
    let Some((chosen, p)) = jev::pick(answers, "first") else {
        return Step::Stop("Ask could not tell which step comes first.".into());
    };
    let id = chosen
        .strip_prefix('e')
        .and_then(|i| i.parse::<usize>().ok());
    match tied.iter().find(|e| Some(e.id) == id) {
        Some(e) if p >= TIE_MIN => Acting::step(
            format!(
                "Click {} \u{201c}{}\u{201d} in {}",
                e.role, e.label, reading.app
            ),
            format!("press:{}", e.id),
            AgentTier::Ax,
            Action::Click {
                target: Target::Element(e.id),
                button: PointerButton::Left,
                count: 1,
                modifiers: Vec::new(),
                hit: None,
            },
        ),
        _ => Step::Stop(format!(
            "Ask is not sure which control on this {} screen is the next step.",
            reading.app
        )),
    }
}

/// Turn one step's answers into what happens next when there is no prior
/// history available. Kept as the small pure seam used by unit tests.
pub fn decide(
    task: &str,
    reading: &ScreenReading,
    spans: &[String],
    apps: &[String],
    candidates: &[&crate::agent::runner::ReadElement],
    answers: &Value,
) -> Step {
    decide_with_history(task, reading, spans, apps, candidates, &[], answers)
}

/// Turn one step's answers into what happens next. History is part of the
/// authorization boundary for an implied submit after dictated text.
pub fn decide_with_history(
    task: &str,
    reading: &ScreenReading,
    spans: &[String],
    apps: &[String],
    candidates: &[&crate::agent::runner::ReadElement],
    history: &[String],
    answers: &Value,
) -> Step {
    let noul = |key: &str| {
        answers
            .get(key)
            .and_then(|a| a.get("noul"))
            .and_then(Value::as_f64)
    };
    if noul("done").is_some_and(|p| p >= DONE_MIN)
        && !history
            .last()
            .is_some_and(|line| line.ends_with(": did not work"))
        && (!history.is_empty()
            || noul("evidence").is_some_and(|evidence| evidence >= INITIAL_EVIDENCE_MIN))
    {
        // Two questions, because they can disagree: one asks whether the
        // command has been carried out, the other asks only what is on the
        // screen. A missing answer is not a contradiction.
        return Step::Done {
            contradicted: noul("evidence").is_some_and(|p| p <= CONTRADICTED_MAX),
        };
    }
    let Some((kind, p)) = jev::pick(answers, "step") else {
        return Step::Stop("Ask could not read the answer about what to do next.".into());
    };
    if p < KIND_MIN {
        return Step::Stop(
            "Ask is not sure enough what the next step on this screen would be. Try a more \
             specific command, or use your own AI key for this one."
                .into(),
        );
    }
    match kind {
        "press" => {
            // One yes/no per control, best first. Both a low best and a close
            // second are "this screen is ambiguous", which is a hand-back.
            let mut yes: Vec<(&crate::agent::runner::ReadElement, f64)> = candidates
                .iter()
                .filter(|e| control_is_relevant(task, history, &e.label))
                .filter_map(|e| {
                    let p = answers
                        .get(format!("is_e{}", e.id))?
                        .get("noul")?
                        .as_f64()?;
                    (0.0..=1.0).contains(&p).then_some((*e, p))
                })
                .collect();
            yes.sort_by(|a, b| b.1.total_cmp(&a.1));
            let Some(&(best, p)) = yes.first() else {
                return Step::Stop("Ask could not tell which control to use next.".into());
            };
            if p < CONTROL_MIN {
                return Step::Stop(format!(
                    "Ask is not sure which control on this {} screen is the next step.",
                    reading.app
                ));
            }
            let runner_up = yes.get(1).map_or(0.0, |(_, p)| *p);
            if p - runner_up < CONTROL_MARGIN {
                // Both look like the next step. Which comes first is its own
                // question, and a much easier one.
                return Step::Ambiguous(
                    yes.iter()
                        .take(3)
                        .filter(|(_, other)| p - other < CONTROL_MARGIN)
                        .map(|(e, _)| e.id)
                        .collect(),
                );
            }
            Acting::step(
                format!(
                    "Click {} \u{201c}{}\u{201d} in {}",
                    best.role, best.label, reading.app
                ),
                format!("press:{}", best.id),
                AgentTier::Ax,
                Action::Click {
                    target: Target::Element(best.id),
                    button: PointerButton::Left,
                    count: 1,
                    modifiers: Vec::new(),
                    hit: None,
                },
            )
        }
        "type" => {
            // Typed words go wherever the keyboard already is. On a list or a
            // button the same keystrokes are shortcuts instead, and in a mail
            // list a few of them delete mail.
            if let Some(why) = nowhere_to_type(reading) {
                return Step::Stop(why);
            }
            let Some((chosen, p)) = jev::pick(answers, "text") else {
                return Step::Stop(NEEDS_WORDS.into());
            };
            let index = chosen
                .strip_prefix('t')
                .and_then(|i| i.parse::<usize>().ok());
            match index.and_then(|i| spans.get(i)) {
                Some(words) if p >= TEXT_MIN => Acting::step(
                    format!("Type \u{201c}{words}\u{201d}"),
                    format!("type:{words}"),
                    AgentTier::Ax,
                    Action::TypeText {
                        text: words.clone(),
                        focus: None,
                    },
                ),
                _ => Step::Stop(NEEDS_WORDS.into()),
            }
        }
        "key" => {
            let Some((chosen, p)) = jev::pick(answers, "key") else {
                return Step::Stop("Ask could not tell which shortcut to press.".into());
            };
            if !jev::names_key(task, chosen) {
                return Step::Stop("Ask could not tie that shortcut to the command.".into());
            }
            let Some((_, _, chord, done)) = jev::KEYS.iter().find(|(k, ..)| *k == chosen) else {
                return Step::Stop("Ask could not tell which shortcut to press.".into());
            };
            if p < ARGUMENT_MIN {
                return Step::Stop("Ask is not sure which shortcut this step needs.".into());
            }
            let Ok(chords) = crate::input::keys::parse_keys(chord) else {
                return Step::Stop("Ask could not press that shortcut.".into());
            };
            let shown = chords
                .iter()
                .map(|c| c.display())
                .collect::<Vec<_>>()
                .join(" ");
            Acting::step(
                format!("Press {shown} ({done})"),
                format!("key:{chosen}"),
                AgentTier::Ax,
                Action::Key {
                    chords,
                    repeat: 1,
                    focus: None,
                },
            )
        }
        "scroll" => {
            let Some((way, p)) = jev::pick(answers, "direction") else {
                return Step::Stop("Ask could not tell which way to scroll.".into());
            };
            if !jev::direction_named(task, way) {
                return Step::Stop(
                    "Ask could not tie that scroll direction to the command.".into(),
                );
            }
            if p < DIRECTION_MIN {
                return Step::Stop("Ask is not sure which way this step scrolls.".into());
            }
            let (direction, amount) = match way {
                "down" => (ScrollDirection::Down, SCROLL_STEP),
                "up" => (ScrollDirection::Up, SCROLL_STEP),
                "bottom" => (ScrollDirection::Down, SCROLL_ALL),
                "top" => (ScrollDirection::Up, SCROLL_ALL),
                "left" => (ScrollDirection::Left, SCROLL_STEP),
                "right" => (ScrollDirection::Right, SCROLL_STEP),
                _ => return Step::Stop("Ask could not tell which way to scroll.".into()),
            };
            let target = reading.window.map(Target::Element);
            Acting::step(
                match way {
                    "bottom" => "Scroll to the bottom".into(),
                    "top" => "Scroll to the top".into(),
                    other => format!("Scroll {other}"),
                },
                format!("scroll:{way}"),
                super::pointer_tier(target.as_ref()),
                Action::Scroll {
                    target,
                    direction,
                    amount,
                    modifiers: Vec::new(),
                    hit: None,
                },
            )
        }
        "open_app" => {
            let Some((name, p)) = jev::pick(answers, "app") else {
                return Step::Stop("Ask could not tell which app to open.".into());
            };
            if p < ARGUMENT_MIN || !apps.iter().any(|a| a == name) {
                return Step::Stop("Ask is not sure which app this step opens.".into());
            }
            Acting::step(
                format!("Open {name}"),
                format!("app:{name}"),
                AgentTier::Skill,
                Action::OpenApp { name: name.into() },
            )
        }
        "wait" => Acting::step(
            "Wait for the screen".into(),
            WAIT_KEY.into(),
            AgentTier::Ax,
            Action::Wait { ms: WAIT_MS },
        ),
        "open_website" => match jev::the_one_address(task) {
            Some(url) => Acting::step(
                format!("Open {url}"),
                format!("url:{url}"),
                AgentTier::Skill,
                Action::OpenUrl { url },
            ),
            None => Step::Stop(
                "Ask can only open a web address that is written out in the command.".into(),
            ),
        },
        _ => Step::Stop(NEEDS_A_MODEL.into()),
    }
}

/// Why the words cannot be typed yet, if they cannot.
///
/// An unfamiliar role fails closed. On macOS, editable web controls are
/// exposed through these same AX roles; treating an unknown canvas or group
/// as a field can turn intended text into application shortcuts.
pub fn nowhere_to_type(reading: &ScreenReading) -> Option<String> {
    const FIELDS: &[&str] = &["text field", "text area", "search field", "combo box"];
    match reading.focused.as_deref() {
        None => Some(
            "Nothing on this screen has the keyboard, so the words have nowhere to go. Click the \
             field you want them in, then say it again."
                .into(),
        ),
        Some(focused) if FIELDS.iter().any(|role| focused.starts_with(role)) => None,
        Some(focused) => Some(format!(
            "The keyboard is on {focused}, which is not a verified editable field — the words \
             could become shortcuts instead. Click the field you want them in, then say it again."
        )),
    }
}

/// Said when the task needs words nobody dictated.
const NEEDS_WORDS: &str = "Ask can only type words that are in your command. Say the words you \
                           want typed, or use your own AI key for this one.";
/// Said when the task needs a model that writes or reads.
const NEEDS_A_MODEL: &str = "This needs an AI model that can write or read the screen back to \
                             you. Add your own AI key on the Mac for tasks like this one.";

impl Brain for JevBrain {
    async fn next(&mut self, task: &str, history: &[Observation]) -> Result<Decision> {
        // Look first, as every run does (ADR-0018).
        let Some(taken) = self.taken.clone() else {
            self.taken = Some(Taken::FirstLook);
            self.spans = spans_to_type(task);
            return Ok(Decision::Act {
                summary: "Look at the screen".into(),
                tier: AgentTier::Ax,
                action: Action::ReadScreen,
            });
        };
        let Some(latest) = history.last() else {
            return Self::finish("Ask never saw the screen.", FinishReason::Incomplete);
        };
        // Record what the last action did, in the words the person saw.
        if let Taken::Action {
            summary,
            repeat_key,
        } = &taken
        {
            let line = if latest.ok {
                format!("{summary}: done")
            } else {
                format!("{summary}: did not work")
            };
            self.history.push(line);
            let screen = latest
                .reading
                .as_ref()
                .map(fingerprint_of)
                .unwrap_or_default();
            if repeat_key == WAIT_KEY {
                self.waits += 1;
                if waits_exhausted(self.waits) {
                    return Self::finish(
                        "The screen never became ready, so Ask stopped waiting for it.",
                        FinishReason::Incomplete,
                    );
                }
            } else {
                self.waits = 0;
            }
            match &self.last {
                // A wait changes nothing on purpose, so it is bounded by the
                // count above rather than by this.
                Some((key, before))
                    if key == repeat_key && *before == screen && key != WAIT_KEY =>
                {
                    self.repeats += 1;
                }
                _ => self.repeats = 0,
            }
            self.last = Some((repeat_key.clone(), screen));
            if self.repeats >= 1 {
                return Self::finish(
                    "That step changed nothing twice, so Ask stopped. Try telling it the next \
                     step directly.",
                    FinishReason::Incomplete,
                );
            }
        }
        if self.steps >= MAX_STEPS {
            return Self::finish(
                format!("Ask took {MAX_STEPS} steps without finishing, so it stopped."),
                FinishReason::Incomplete,
            );
        }
        // A missing focused app — or Lilypad itself in front after the person
        // sent the command from the phone — is not enough screen context for
        // clicks or keys. It is enough context for one narrower decision:
        // whether the command names an installed app or a literal web address
        // that should be opened to obtain the first usable screen. Jev sees an
        // explicit empty state, and `launch_only_without_screen` below rejects
        // every other kind of answer. This is not an AX/focus bypass.
        let unavailable = match latest.reading.as_ref() {
            None => Some(unreadable(latest.reading_error.as_deref())),
            Some(reading) if reading.app.eq_ignore_ascii_case("lilypad") => Some(
                "Ask never operates Lilypad itself. Bring the app you mean to the front."
                    .to_string(),
            ),
            Some(_) => None,
        };
        let empty_reading = ScreenReading {
            app: "no readable application".into(),
            ..ScreenReading::default()
        };
        let reading = latest
            .reading
            .as_ref()
            .filter(|reading| !reading.app.eq_ignore_ascii_case("lilypad"))
            .unwrap_or(&empty_reading);

        // Raw OCR text never crosses the hosted boundary. Only OCR words the
        // person already used in the command survive, and their labels are
        // rebuilt from that command rather than from the screen.
        let outbound_reading = reading_for_task(task, reading);
        let reading = &outbound_reading;

        if self.installed.is_none() {
            self.installed = Some(
                tokio::task::spawn_blocking(jev::installed_apps)
                    .await
                    .unwrap_or_default(),
            );
        }
        let apps = jev::app_candidates(task, self.installed.as_deref().unwrap_or_default());
        let candidates = candidates(task, reading);
        let body = request(
            self.jev.model(),
            task,
            reading,
            &self.history,
            &self.spans,
            &apps,
            &candidates,
        );
        let started = std::time::Instant::now();
        let answers = match self.jev.ask_step(&body).await {
            Ok(answers) => answers,
            Err(e) => {
                log::warn!(target: "lilypad::agent", "step could not be decided: {e}");
                return Self::finish(
                    "Ask could not reach the service that decides its next step.",
                    FinishReason::Incomplete,
                );
            }
        };
        let mut step = decide_with_history(
            task,
            reading,
            &self.spans,
            &apps,
            &candidates,
            &self.history,
            &answers,
        );
        if let Some(failure) = unavailable.as_deref() {
            step = launch_only_without_screen(step, failure);
        }
        // Two controls that both look like the next step: ask which comes
        // first, about those alone. One more request, only when it is needed.
        if let Step::Ambiguous(ids) = &step {
            let tied: Vec<_> = candidates
                .iter()
                .copied()
                .filter(|e| ids.contains(&e.id))
                .collect();
            let tie = tie_request(self.jev.model(), task, reading, &self.history, &tied);
            step = match self.jev.ask_step(&tie).await {
                Ok(answers) => decide_tie(reading, &tied, &answers),
                Err(e) => {
                    log::warn!(target: "lilypad::agent", "tie-break failed: {e}");
                    Step::Stop(format!(
                        "Ask is not sure which control on this {} screen is the next step.",
                        reading.app
                    ))
                }
            };
        }
        log::info!(
            target: "lilypad::agent",
            "jev step {}: {} ({} ms)",
            self.steps + 1,
            match &step {
                Step::Done { contradicted } => {
                    format!("done (screen disagrees: {contradicted})")
                }
                Step::Act(acting) => acting.summary.clone(),
                Step::Ambiguous(ids) => format!("ambiguous {ids:?}"),
                Step::Stop(why) => format!("stopping — {why}"),
            },
            started.elapsed().as_millis(),
        );
        match step {
            Step::Done { contradicted } => Self::finish(
                match (contradicted, self.history.last()) {
                    (false, Some(last)) => last.clone(),
                    (false, None) => "Done.".into(),
                    // Said, not hidden. The model has answered two questions
                    // that disagree with each other, and the person is the
                    // one who can look.
                    (true, Some(last)) => {
                        format!("{last}. The screen still shows it undone, so check it yourself.")
                    }
                    (true, None) => "Ask believes that is done, but the screen still shows it \
                                     undone. Check it yourself."
                        .into(),
                },
                done_reason(contradicted),
            ),
            Step::Stop(why) => Self::finish(why, FinishReason::Incomplete),
            // The tie-break above is the only producer, and it never returns
            // one of these.
            Step::Ambiguous(_) => Self::finish(
                format!(
                    "Ask is not sure which control on this {} screen is the next step.",
                    reading.app
                ),
                FinishReason::Incomplete,
            ),
            Step::Act(acting) => {
                let Acting {
                    summary,
                    repeat_key,
                    tier,
                    action,
                } = *acting;
                self.act(summary, repeat_key, tier, action)
            }
        }
    }
}

/// Enough of a reading to tell "the screen did not change" from "it did".
/// What to say when this way of running has no screen to work from.
///
/// It ends the task either way — the elements are the whole input — but the
/// reason decides whether the person can do anything about it. "Grant
/// Accessibility" and "that window is on another display" are both fixable in
/// seconds; "the app may not expose its controls" is a dead end, and was being
/// said to everyone (L-369).
pub fn unreadable(reason: Option<&str>) -> String {
    match reason.map(str::trim).filter(|r| !r.is_empty()) {
        Some(reason) => format!("Ask could not read this screen: {reason}."),
        None => "Ask could not read this screen. The app may not expose its controls.".to_string(),
    }
}

fn fingerprint_of(reading: &ScreenReading) -> String {
    let mut out = String::from(&reading.app);
    out.push('|');
    out.push_str(reading.focused.as_deref().unwrap_or(""));
    for e in &reading.elements {
        out.push('|');
        out.push_str(&e.label);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::runner::ReadElement;

    fn el(id: usize, role: &str, label: &str) -> ReadElement {
        ReadElement {
            id,
            role: role.into(),
            label: label.into(),
            at: None,
        }
    }

    fn mail() -> ScreenReading {
        ScreenReading {
            app: "Mail".into(),
            window: Some(0),
            focused: Some("table \u{201c}Inbox\u{201d}".into()),
            elements: vec![
                el(3, "button", "Compose"),
                el(4, "button", "Reply"),
                el(5, "button", "Reply All"),
                el(7, "button", "Archive"),
                el(8, "button", "Delete"),
                el(20, "row", "Rae Chen, Lunch Thursday?, 9:41 AM"),
                el(21, "row", "GitHub, CI failed on main, Yesterday"),
            ],
        }
    }

    fn noul(p: f64) -> Value {
        json!({ "type": "noul", "noul": p })
    }

    fn chose(option: &str, p: f64) -> Value {
        json!({ "type": "choice", "choice": option, "confidence": p, "probabilities": { option: p } })
    }

    /// The owner's v0.1.48 run: Ask ended with "the app may not expose its
    /// controls" when the reading had failed for a reason the code already
    /// knew and threw away. Nothing in the log said which failure it was.
    #[test]
    fn an_unreadable_screen_says_which_failure_it_was() {
        assert_eq!(
            unreadable(Some(
                "no focused application (grant Accessibility, focus an app)"
            )),
            "Ask could not read this screen: no focused application (grant Accessibility, focus \
             an app)."
        );
        assert!(
            unreadable(Some("the focused app has no window on the shared display"))
                .contains("no window on the shared display")
        );
        // No reason is the only case that may fall back to the old sentence.
        assert_eq!(
            unreadable(None),
            "Ask could not read this screen. The app may not expose its controls."
        );
        assert_eq!(unreadable(Some("   ")), unreadable(None));
    }

    /// v0.1.54 failed before Jev was ever asked: the first look had no
    /// focused AX app, and later attempts saw Lilypad in front. A command
    /// that names another app still has enough bounded state to launch it and
    /// obtain the real first screen. Nothing screen-dependent gets the same
    /// exception.
    #[tokio::test]
    async fn a_missing_or_lilypad_first_screen_can_only_bootstrap_a_launch() {
        let no_focus = Observation {
            summary: "Look at the screen".into(),
            ok: true,
            image: None,
            screen: None,
            reading: None,
            reading_error: Some(
                "no focused application (grant Accessibility, focus an app)".into(),
            ),
        };
        let lilypad = Observation {
            reading: Some(ScreenReading {
                app: "Lilypad".into(),
                ..ScreenReading::default()
            }),
            reading_error: None,
            ..no_focus.clone()
        };

        for first_look in [no_focus, lilypad] {
            let mut brain = JevBrain::new(Jev::new(jev::InstantConfig::new("not-used")));
            *brain.canned() = Some(json!({
                "done": noul(0.01),
                "evidence": noul(0.01),
                "step": chose("open_app", 0.99),
                "app": chose("Finder", 0.99),
            }));
            assert!(matches!(
                brain.next("open Finder", &[]).await.unwrap(),
                Decision::Act {
                    action: Action::ReadScreen,
                    ..
                }
            ));
            assert!(matches!(
                brain
                    .next("open Finder", &[first_look])
                    .await
                    .unwrap(),
                Decision::Act {
                    action: Action::OpenApp { ref name },
                    ..
                } if name == "Finder"
            ));
        }

        let blocked = launch_only_without_screen(
            Acting::step(
                "Press Return".into(),
                "key:return".into(),
                AgentTier::Ax,
                Action::Key {
                    chords: crate::input::keys::parse_keys("RETURN").unwrap(),
                    repeat: 1,
                    focus: None,
                },
            ),
            "no screen",
        );
        assert_eq!(blocked, Step::Stop("no screen".into()));
    }

    #[test]
    fn the_words_to_type_come_from_the_command() {
        assert_eq!(
            spans_to_type("reply to Rae saying I'll be there"),
            ["I'll be there"]
        );
        assert_eq!(
            spans_to_type("search for cheap flights to Tokyo"),
            ["cheap flights to Tokyo"]
        );
        assert_eq!(
            spans_to_type("type \u{201c}hello world\u{201d} in the box"),
            ["hello world"]
        );
        assert!(spans_to_type("archive the email from GitHub").is_empty());
    }

    #[test]
    fn a_control_is_pressed_only_when_one_stands_out() {
        let reading = mail();
        let task = "archive the email from GitHub";
        let candidates = candidates(task, &reading);
        let decide_with = |github: f64, archive: f64| {
            let answers = json!({
                "done": noul(0.02),
                "step": chose("press", 0.99),
                "is_e21": noul(github),
                "is_e7": noul(archive),
            });
            decide(task, &reading, &[], &[], &candidates, &answers)
        };
        match decide_with(0.83, 0.39) {
            Step::Act(a) => {
                assert!(matches!(
                    a.action,
                    Action::Click {
                        target: Target::Element(21),
                        ..
                    }
                ));
                assert_eq!(a.repeat_key, "press:21");
                assert!(a.summary.contains("GitHub"), "{}", a.summary);
            }
            other => panic!("{other:?}"),
        }
        // Two controls that both look right are asked about again, not
        // guessed between.
        match decide_with(0.78, 0.72) {
            Step::Ambiguous(ids) => assert_eq!(ids, [21, 7]),
            other => panic!("{other:?}"),
        }
        // A best answer that is not an answer stops the run.
        assert!(matches!(decide_with(0.55, 0.10), Step::Stop(_)));
    }

    #[test]
    fn a_high_probability_page_label_is_not_permission_to_click_it() {
        let reading = mail();
        let archive_candidates = candidates("archive the email from GitHub", &reading);
        let unrelated = json!({
            "done": noul(0.02),
            "step": chose("press", 0.99),
            "is_e3": noul(0.99),
            "is_e7": noul(0.01),
            "is_e21": noul(0.01),
        });
        assert!(matches!(
            decide(
                "archive the email from GitHub",
                &reading,
                &[],
                &[],
                &archive_candidates,
                &unrelated,
            ),
            Step::Stop(_)
        ));

        // A short command must include all its meaningful words: Reply must
        // not be accepted for "reply all".
        let reply = json!({
            "done": noul(0.02),
            "step": chose("press", 0.99),
            "is_e4": noul(0.99),
            "is_e5": noul(0.01),
        });
        let reply_candidates = super::candidates("reply all", &reading);
        assert!(matches!(
            decide("reply all", &reading, &[], &[], &reply_candidates, &reply),
            Step::Stop(_)
        ));

        // A multi-step relation still preserves a qualifier: "reply to Rae"
        // cannot silently become "Reply All".
        let reply_to = super::candidates("reply to Rae", &reading);
        let reply_to_answers = json!({
            "done": noul(0.02),
            "step": chose("press", 0.99),
            "is_e4": noul(0.99),
            "is_e5": noul(0.01),
        });
        assert!(matches!(
            decide(
                "reply to Rae",
                &reading,
                &[],
                &[],
                &reply_to,
                &reply_to_answers,
            ),
            Step::Act(_)
        ));

        // The implied Send is authorized only after a successful dictated
        // text step, never merely because the task says "reply".
        let send_screen = reply_screen();
        let send_candidates = super::candidates("reply to Rae saying I'll be there", &send_screen);
        let send = json!({
            "done": noul(0.02),
            "step": chose("press", 0.99),
            "is_e30": noul(0.99),
        });
        assert!(matches!(
            decide(
                "reply to Rae saying I'll be there",
                &send_screen,
                &[],
                &[],
                &send_candidates,
                &send,
            ),
            Step::Stop(_)
        ));
        assert!(matches!(
            decide_with_history(
                "reply to Rae saying I'll be there",
                &send_screen,
                &["I'll be there".into()],
                &[],
                &send_candidates,
                &["Type \u{201c}I'll be there\u{201d}: done".into()],
                &send,
            ),
            Step::Act(_)
        ));
    }

    #[test]
    fn shortcut_and_scroll_answers_must_be_named_by_the_command() {
        let reading = mail();
        let key = |chosen: &str| {
            decide(
                "new tab",
                &reading,
                &[],
                &[],
                &[],
                &json!({
                    "done": noul(0.01),
                    "step": chose("key", 0.99),
                    "key": chose(chosen, 0.99),
                }),
            )
        };
        assert!(matches!(key("close_tab"), Step::Stop(_)));
        assert!(matches!(key("new_tab"), Step::Act(_)));

        let scroll = |chosen: &str| {
            decide(
                "scroll down",
                &reading,
                &[],
                &[],
                &[],
                &json!({
                    "done": noul(0.01),
                    "step": chose("scroll", 0.99),
                    "direction": chose(chosen, 0.99),
                }),
            )
        };
        assert!(matches!(scroll("up"), Step::Stop(_)));
        assert!(matches!(scroll("down"), Step::Act(_)));
    }

    /// The words go wherever the keyboard already is, so a screen whose
    /// keyboard is on a mail list is not a screen to type into: the same
    /// keystrokes there are shortcuts.
    #[test]
    fn words_are_not_typed_at_a_list_or_a_button() {
        let task = "reply to Rae saying I'll be there";
        let spans = spans_to_type(task);
        let typing = json!({
            "done": noul(0.05),
            "step": chose("type", 0.99),
            "text": chose("t0", 0.99),
        });
        let refused =
            |reading: &ScreenReading| match decide(task, reading, &spans, &[], &[], &typing) {
                Step::Stop(why) => why,
                other => panic!("{other:?}"),
            };
        // mail()'s keyboard is on the Inbox table.
        assert!(refused(&mail()).contains("Click the field"));
        let mut nothing = mail();
        nothing.focused = None;
        assert!(refused(&nothing).contains("nowhere to go"));
        // A text area is where words go, and is not refused.
        assert!(nowhere_to_type(&reply_screen()).is_none());
        // Unknown roles fail closed too. A canvas or web area can turn text
        // into shortcuts, and has not proved that it is editable.
        let mut unknown = mail();
        unknown.focused = Some("group \u{201c}Canvas\u{201d}".into());
        assert!(refused(&unknown).contains("verified editable field"));
        let mut password = mail();
        password.focused = Some("secure text field \u{201c}Password\u{201d}".into());
        assert!(refused(&password).contains("verified editable field"));
    }

    /// OCR can see a short line of private text that looks exactly like a
    /// control name. Only a complete label already present in the person's
    /// command may cross the hosted boundary, and it comes from the command
    /// itself. One matching word cannot turn somebody's sentence into a
    /// clickable target.
    #[test]
    fn screen_text_sent_to_jev_is_limited_to_the_command() {
        let reading = ScreenReading {
            app: "Canvas".into(),
            focused: Some("group \u{201c}Canvas\u{201d}".into()),
            window: Some(0),
            elements: vec![
                el(100_000, "screen text", "Meet Bob at eight"),
                el(100_001, "screen text", "Send"),
                el(100_002, "screen text", "Open"),
                el(100_003, "screen text", "Cancel"),
            ],
        };
        let safe = reading_for_task("message Bob, then click Send and Open", &reading);
        assert_eq!(safe.elements.len(), 2);
        assert_eq!(safe.elements[0].label, "Send");
        // Action words are valid labels when the whole label was named; the
        // candidate-ranking filler list must not erase this button.
        assert_eq!(safe.elements[1].label, "Open");
        let candidates = candidates("message Bob, then click Send and Open", &safe);
        let body = request(
            jev::MODEL,
            "message Bob, then click Send and Open",
            &safe,
            &[],
            &[],
            &[],
            &candidates,
        );
        let encoded = serde_json::to_string(&body).unwrap();
        assert!(!encoded.contains("Meet Bob at eight"), "{encoded}");
        assert!(!encoded.contains("Cancel"), "{encoded}");
        assert!(encoded.contains("Send") && encoded.contains("Open"));
    }

    #[test]
    fn it_types_only_the_persons_own_words() {
        let reading = reply_screen();
        let task = "reply to Rae saying I'll be there";
        let spans = spans_to_type(task);
        let candidates = candidates(task, &reading);
        let typed = |option: &str, p: f64| {
            decide(
                task,
                &reading,
                &spans,
                &[],
                &candidates,
                &json!({ "done": noul(0.05), "step": chose("type", 0.99), "text": chose(option, p) }),
            )
        };
        match typed("t0", 0.99) {
            Step::Act(a) => match a.action {
                Action::TypeText { text, .. } => assert_eq!(text, "I'll be there"),
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
        // Nothing offered, nothing typed.
        assert!(matches!(typed("none", 0.99), Step::Stop(_)));
        assert!(matches!(typed("t9", 0.99), Step::Stop(_)));
        assert!(matches!(typed("t0", 0.5), Step::Stop(_)));
    }

    #[test]
    fn what_it_cannot_do_it_says() {
        let reading = mail();
        let candidates = candidates("what does this email say", &reading);
        let step = decide(
            "what does this email say",
            &reading,
            &[],
            &[],
            &candidates,
            &json!({ "done": noul(0.02), "step": chose("impossible", 0.95) }),
        );
        match step {
            Step::Stop(why) => assert!(why.contains("your own AI key"), "{why}"),
            other => panic!("{other:?}"),
        }
        // An unsure kind is also a hand-back, not a guess.
        assert!(matches!(
            decide(
                "do the thing",
                &reading,
                &[],
                &[],
                &candidates,
                &json!({ "done": noul(0.02), "step": chose("press", 0.4) })
            ),
            Step::Stop(_)
        ));
    }

    #[test]
    fn a_tie_is_settled_by_asking_which_comes_first() {
        let reading = mail();
        let candidates = candidates("reply to Rae saying I'll be there", &reading);
        let tied: Vec<_> = candidates
            .iter()
            .copied()
            .filter(|e| e.id == 20 || e.id == 4)
            .collect();
        let body = tie_request(jev::MODEL, "reply to Rae", &reading, &[], &tied);
        assert!(body["questions"]["first"]["criteria"]["e20"]
            .as_str()
            .is_some_and(|s| s.contains("Rae Chen")));
        match decide_tie(&reading, &tied, &json!({ "first": chose("e20", 0.98) })) {
            Step::Act(a) => {
                assert_eq!(a.repeat_key, "press:20");
                assert!(matches!(
                    a.action,
                    Action::Click {
                        target: Target::Element(20),
                        ..
                    }
                ));
            }
            other => panic!("{other:?}"),
        }
        // An unsure tie-break is still a hand-back, and a control that was
        // never tied cannot arrive through it.
        assert!(matches!(
            decide_tie(&reading, &tied, &json!({ "first": chose("e20", 0.6) })),
            Step::Stop(_)
        ));
        assert!(matches!(
            decide_tie(&reading, &tied, &json!({ "first": chose("e8", 0.99) })),
            Step::Stop(_)
        ));
    }

    #[test]
    fn a_selected_row_is_reported_as_the_current_choice() {
        let mut reading = mail();
        reading.focused = Some("row \u{201c}GitHub, CI failed on main\u{201d}".into());
        assert!(selection_of(&reading).contains("GitHub"));
        reading.focused = Some("table \u{201c}Inbox\u{201d}".into());
        assert_eq!(
            selection_of(&reading),
            "nothing in a list or table is selected yet"
        );
        reading.focused = None;
        assert_eq!(
            selection_of(&reading),
            "nothing in a list or table is selected yet"
        );
    }

    #[test]
    fn done_ends_the_task() {
        let reading = mail();
        let ended = |done: f64, evidence: f64| {
            decide(
                "archive it",
                &reading,
                &[],
                &[],
                &[],
                &json!({
                    "done": noul(done),
                    "evidence": noul(evidence),
                    "step": chose("press", 0.99),
                }),
            )
        };
        assert_eq!(
            ended(0.95, 0.93),
            Step::Done {
                contradicted: false
            }
        );
        // Not sure it is done is not done.
        assert!(matches!(ended(0.6, 0.1), Step::Stop(_)));
        // "Cannot tell" is not enough when no action has succeeded yet.
        assert!(matches!(ended(0.95, 0.4), Step::Stop(_)));
        assert!(matches!(ended(0.95, 0.04), Step::Stop(_)));
        assert!(matches!(
            decide(
                "archive it",
                &reading,
                &[],
                &[],
                &[],
                &json!({ "done": noul(0.95), "step": chose("press", 0.99) })
            ),
            Step::Stop(_)
        ));
        // After a successful action, a completion answer may rely on the
        // action history even when the text-only screen cannot prove it.
        assert_eq!(
            decide_with_history(
                "archive it",
                &reading,
                &[],
                &[],
                &[],
                &["Click button \u{201c}Archive\u{201d}: done".into()],
                &json!({
                    "done": noul(0.95),
                    "evidence": noul(0.4),
                    "step": chose("press", 0.99),
                }),
            ),
            Step::Done {
                contradicted: false
            }
        );
        // A failed action cannot be turned into success by a confident noun.
        assert!(matches!(
            decide_with_history(
                "archive it",
                &reading,
                &[],
                &[],
                &[],
                &["Click button \u{201c}Archive\u{201d}: did not work".into()],
                &json!({ "done": noul(0.95), "evidence": noul(0.9) }),
            ),
            Step::Stop(_)
        ));
    }

    /// A screen that is still loading is a step of its own. Without it the
    /// next-step answer is about a screen that is not finished, and the run
    /// either guesses or hands back.
    #[test]
    fn a_loading_screen_is_waited_for_a_few_times_and_no_more() {
        let reading = mail();
        let step = decide(
            "archive it",
            &reading,
            &[],
            &[],
            &[],
            &json!({ "done": noul(0.01), "step": chose("wait", 0.96) }),
        );
        match step {
            Step::Act(a) => {
                assert_eq!(a.action, Action::Wait { ms: WAIT_MS });
                assert_eq!(a.repeat_key, WAIT_KEY);
            }
            other => panic!("{other:?}"),
        }
        // The bound is the count, not the repeat guard: a wait is the one
        // step that is supposed to change nothing.
        assert!(MAX_WAITS >= 2 && WAIT_MS * MAX_WAITS as u64 <= 5_000);
        assert!(!waits_exhausted(MAX_WAITS - 1));
        assert!(waits_exhausted(MAX_WAITS));
    }

    #[test]
    fn a_screen_that_disagrees_is_not_reported_as_success() {
        assert_eq!(done_reason(false), FinishReason::Completed);
        assert_eq!(done_reason(true), FinishReason::Incomplete);
    }

    #[test]
    fn the_request_carries_the_screen_and_the_story_so_far() {
        let reading = mail();
        let task = "archive the email from GitHub";
        let candidates = candidates(task, &reading);
        let body = request(
            jev::MODEL,
            task,
            &reading,
            &["Click row \u{201c}GitHub…\u{201d}: done".to_string()],
            &[],
            &[],
            &candidates,
        );
        assert_eq!(body["model"], jev::MODEL);
        assert_eq!(body["state"]["app in front"], "Mail");
        assert_eq!(
            body["state"]["what has the keyboard"],
            "table \u{201c}Inbox\u{201d}"
        );
        assert_eq!(
            body["state"]["what has happened so far"][0],
            "Click row \u{201c}GitHub…\u{201d}: done"
        );
        assert!(body["questions"]["done"]["type"] == "noul");
        assert!(body["questions"]["evidence"]["type"] == "noul");
        assert!(body["questions"]["is_e21"]["type"] == "noul");
        assert!(body["questions"].get("text").is_none(), "nothing to type");
        assert_eq!(
            body["state"]["what is selected"],
            "nothing in a list or table is selected yet"
        );
        // Every candidate gets its own yes/no, the named ones included.
        assert!(body["questions"]["is_e3"]["type"] == "noul");

        // Where a control sits reaches the model as words. Two Sends on one
        // screen are told apart by this and nothing else.
        let mut placed = mail();
        placed.elements[0].at = Some("top left".into());
        let placed_candidates = crate::agent::llm::jev_agent::candidates(task, &placed);
        let body = request(jev::MODEL, task, &placed, &[], &[], &[], &placed_candidates);
        assert!(
            body["state"]["controls on the screen"]
                .as_array()
                .is_some_and(|c| {
                    c.iter()
                        .filter_map(Value::as_str)
                        .any(|s| s.ends_with("(top left)"))
                }),
            "{}",
            body["state"]["controls on the screen"]
        );
    }

    #[test]
    fn the_hosted_state_uses_only_the_bounded_candidate_list() {
        let reading = ScreenReading {
            app: "Busy app".into(),
            elements: (0..400).map(|id| el(id, "button", "Control")).collect(),
            ..ScreenReading::default()
        };
        let candidates = candidates("do something", &reading);
        let body = request(
            jev::MODEL,
            "do something",
            &reading,
            &[],
            &[],
            &[],
            &candidates,
        );
        let controls = body["state"]["controls on the screen"]
            .as_array()
            .expect("state controls");
        assert_eq!(controls.len(), candidates.len());
        assert!(controls.len() <= MAX_CANDIDATES);
    }

    // ── a scripted Mac, and the real answers it drew ──
    //
    // Three screens per task, moved by whatever the decision was, so a
    // fixture replay is the whole loop rather than one answer at a time.

    fn reply_screen() -> ScreenReading {
        ScreenReading {
            app: "Mail".into(),
            window: Some(0),
            focused: Some("text area \u{201c}Message body\u{201d}".into()),
            elements: vec![
                el(30, "button", "Send"),
                el(31, "text field", "To: Rae Chen"),
                el(32, "text field", "Subject: Re: Lunch Thursday?"),
                el(33, "text area", "Message body"),
            ],
        }
    }

    /// The inbox after the GitHub mail was archived: one row fewer.
    fn archived() -> ScreenReading {
        let mut out = mail();
        out.elements.retain(|e| e.id != 21);
        out.focused = Some("table \u{201c}Inbox\u{201d}".into());
        out
    }

    fn selected(row: &str) -> ScreenReading {
        ScreenReading {
            focused: Some(format!("row \u{201c}{row}\u{201d}")),
            ..mail()
        }
    }

    /// The scripted Mac: what each step does to the screen.
    fn moved(screen: &ScreenReading, step: &Step) -> (ScreenReading, String) {
        let Step::Act(acting) = step else {
            return (screen.clone(), String::new());
        };
        let next = match acting.repeat_key.as_str() {
            "press:20" => selected("Rae Chen, Lunch Thursday?, 9:41 AM"),
            "press:21" => selected("GitHub, CI failed on main, Yesterday"),
            "press:4" | "press:5" => reply_screen(),
            // Archiving takes the mail out of the list. A scripted Mac that
            // leaves it there is asking the model whether a row that is still
            // in front of it has been archived, and the honest answer to that
            // is no.
            "press:7" => archived(),
            "press:30" => mail(),
            _ => screen.clone(),
        };
        (next, format!("{}: done", acting.summary))
    }

    /// A task, and a word that must appear in what the run did.
    const TASKS: &[(&str, &str)] = &[
        ("reply to Rae saying I'll be there", "send"),
        ("archive the email from GitHub", "archive"),
    ];

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("jev_agent_fixtures.json")).expect("fixture JSON")
    }

    /// One step the way `JevBrain` takes it: the step request, and the
    /// tie-break when two controls both look like the next step.
    async fn one_step(
        jev: &Jev,
        task: &str,
        screen: &ScreenReading,
        history: &[String],
        spans: &[String],
    ) -> (Step, Value, Option<Value>) {
        let candidates = candidates(task, screen);
        let body = request(jev.model(), task, screen, history, spans, &[], &candidates);
        let answers = jev.ask_step(&body).await.expect("a reply");
        let step = decide_with_history(task, screen, spans, &[], &candidates, history, &answers);
        if let Step::Ambiguous(ids) = &step {
            let tied: Vec<_> = candidates
                .iter()
                .copied()
                .filter(|e| ids.contains(&e.id))
                .collect();
            let tie = tie_request(jev.model(), task, screen, history, &tied);
            let first = jev.ask_step(&tie).await.expect("a reply");
            return (decide_tie(screen, &tied, &first), answers, Some(first));
        }
        (step, answers, None)
    }

    /// Replay the real answers through the loop's own policy. Every step is
    /// the answer TypeSafe actually gave for that screen.
    #[test]
    fn real_answers_carry_a_task_to_the_end() {
        let fixtures = fixtures();
        for (task, _) in TASKS {
            let mut screen = mail();
            let spans = spans_to_type(task);
            let mut history: Vec<String> = Vec::new();
            let mut done = false;
            for step_no in 1..=MAX_STEPS {
                let answers = &fixtures[*task][format!("step{step_no}")];
                if answers.is_null() {
                    break;
                }
                let candidates = candidates(task, &screen);
                let mut step =
                    decide_with_history(task, &screen, &spans, &[], &candidates, &history, answers);
                if let Step::Ambiguous(ids) = &step {
                    let tied: Vec<_> = candidates
                        .iter()
                        .copied()
                        .filter(|e| ids.contains(&e.id))
                        .collect();
                    let first = &fixtures[*task][format!("step{step_no}_first")];
                    assert!(
                        first.is_object(),
                        "{task}, step {step_no}: no tie-break captured"
                    );
                    step = decide_tie(&screen, &tied, first);
                }
                if let Step::Done { contradicted } = step {
                    done = true;
                    assert!(!contradicted, "{task}: the screen disagreed at the end");
                    break;
                }
                assert!(
                    matches!(step, Step::Act(..)),
                    "{task}, step {step_no}: {step:?}"
                );
                let (next, line) = moved(&screen, &step);
                screen = next;
                history.push(line);
            }
            assert!(done, "{task} never finished; history {history:?}");
            assert!(
                history.len() >= 2,
                "{task} finished without doing anything: {history:?}"
            );
            println!("{task}: {history:?}");
        }
    }

    /// The whole loop against the real API, on the scripted Mac above.
    ///
    /// `TYPESAFE_API_KEY=… cargo test --lib live_jev_agent -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "calls the real TypeSafe API"]
    async fn live_jev_agent_carries_a_task_to_the_end() {
        let config = jev::InstantConfig::from_env().expect("TYPESAFE_API_KEY");
        let jev = Jev::new(config);
        for (task, want) in TASKS {
            let mut screen = mail();
            let spans = spans_to_type(task);
            let mut history: Vec<String> = Vec::new();
            let mut done = false;
            for _ in 1..=MAX_STEPS {
                let started = std::time::Instant::now();
                let (step, ..) = one_step(&jev, task, &screen, &history, &spans).await;
                println!("  {:?} in {} ms", step, started.elapsed().as_millis());
                match &step {
                    Step::Done { .. } => {
                        done = true;
                        break;
                    }
                    Step::Stop(why) => panic!("{task}: stopped — {why}; history {history:?}"),
                    Step::Ambiguous(ids) => panic!("{task}: still unsure between {ids:?}"),
                    Step::Act(..) => {}
                }
                let (next, line) = moved(&screen, &step);
                screen = next;
                history.push(line);
            }
            assert!(done, "{task} never finished; history {history:?}");
            assert!(
                history.iter().any(|h| h.to_lowercase().contains(want)),
                "{task} never {want}: {history:?}"
            );
        }
    }

    /// Captures `jev_agent_fixtures.json` from the real API, one entry per
    /// step of each scripted task. Run by hand, with a key, whenever the
    /// questions or the screens change:
    ///
    /// `TYPESAFE_API_KEY=… cargo test --lib capture_real_jev_agent -- --ignored`,
    /// then run prettier on the file.
    #[tokio::test]
    #[ignore = "calls the real TypeSafe API"]
    async fn capture_real_jev_agent_answers() {
        let jev = Jev::new(jev::InstantConfig::from_env().expect("TYPESAFE_API_KEY"));
        let mut out = serde_json::Map::new();
        for (task, _) in TASKS {
            let mut screen = mail();
            let spans = spans_to_type(task);
            let mut history: Vec<String> = Vec::new();
            let mut steps = serde_json::Map::new();
            for step_no in 1..=MAX_STEPS {
                let (step, answers, first) = one_step(&jev, task, &screen, &history, &spans).await;
                steps.insert(format!("step{step_no}"), answers);
                if let Some(first) = first {
                    steps.insert(format!("step{step_no}_first"), first);
                }
                if !matches!(step, Step::Act(..)) {
                    steps.insert(
                        format!("step{step_no}_ended"),
                        Value::String(format!("{step:?}")),
                    );
                    break;
                }
                let (next, line) = moved(&screen, &step);
                screen = next;
                history.push(line);
            }
            out.insert((*task).to_string(), Value::Object(steps));
        }
        std::fs::write(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/agent/llm/jev_agent_fixtures.json"
            ),
            serde_json::to_string_pretty(&Value::Object(out)).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn candidates_are_the_controls_the_command_names() {
        let reading = mail();
        let named: Vec<usize> = candidates("archive the email from GitHub", &reading)
            .iter()
            .map(|e| e.id)
            .collect();
        // The controls the command names come first; the rest of the screen
        // follows, because the step after this one is often unnamed.
        assert_eq!(named[..2], [7, 21]);
        assert_eq!(named.len(), reading.elements.len().min(MAX_CANDIDATES));
        // A command that names nothing on screen still gets a short list.
        assert_eq!(candidates("do something", &reading).len(), 7);
        // A busy screen stays a short request.
        let busy = ScreenReading {
            elements: (0..40).map(|i| el(i, "button", "x")).collect(),
            ..mail()
        };
        assert_eq!(candidates("press x", &busy).len(), MAX_CANDIDATES);
    }
}
