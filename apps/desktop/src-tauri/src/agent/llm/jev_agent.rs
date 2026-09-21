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
const KIND_MIN: f64 = 0.75;
const CONTROL_MIN: f64 = 0.7;
/// How far ahead of the second-best control the chosen one must be. Two
/// controls that both look right are a screen Ask should not guess at.
const CONTROL_MARGIN: f64 = 0.2;
const TEXT_MIN: f64 = 0.85;
const ARGUMENT_MIN: f64 = 0.9;
const DIRECTION_MIN: f64 = 0.8;

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
    "tap", "choose", "select", "then", "first", "one", "please", "email", "message", "again",
];

fn key_words(text: &str) -> std::collections::HashSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3)
        .map(str::to_lowercase)
        .filter(|w| !FILLER.contains(&w.as_str()))
        .collect()
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
            "controls on the screen": reading
                .elements
                .iter()
                .map(|e| format!("e{}: {} \u{201c}{}\u{201d}", e.id, e.role, e.label))
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
    Done,
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

/// Turn one step's answers into what happens next. Pure: the whole policy.
pub fn decide(
    task: &str,
    reading: &ScreenReading,
    spans: &[String],
    apps: &[String],
    candidates: &[&crate::agent::runner::ReadElement],
    answers: &Value,
) -> Step {
    if answers
        .get("done")
        .and_then(|a| a.get("noul"))
        .and_then(Value::as_f64)
        .is_some_and(|p| p >= DONE_MIN)
    {
        return Step::Done;
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
            match &self.last {
                Some((key, before)) if key == repeat_key && *before == screen => {
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
        let Some(reading) = latest.reading.as_ref() else {
            // The elements ARE this way of running's screen, so a failed
            // reading ends the task — but it ends it saying which failure.
            // "The app may not expose its controls" was told to somebody whose
            // focused window was simply on another display, and to somebody
            // who had not granted Accessibility, neither of whom could act on
            // it (L-369).
            return Self::finish(
                unreadable(latest.reading_error.as_deref()),
                FinishReason::Incomplete,
            );
        };
        if reading.app.eq_ignore_ascii_case("lilypad") {
            return Self::finish(
                "Ask never operates Lilypad itself. Bring the app you mean to the front.",
                FinishReason::Incomplete,
            );
        }

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
        let mut step = decide(task, reading, &self.spans, &apps, &candidates, &answers);
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
                Step::Done => "done".to_string(),
                Step::Act(acting) => acting.summary.clone(),
                Step::Ambiguous(ids) => format!("ambiguous {ids:?}"),
                Step::Stop(why) => format!("stopping — {why}"),
            },
            started.elapsed().as_millis(),
        );
        match step {
            Step::Done => Self::finish(
                self.history
                    .last()
                    .cloned()
                    .unwrap_or_else(|| "Done.".into()),
                FinishReason::Completed,
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
    fn it_types_only_the_persons_own_words() {
        let reading = mail();
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
        assert_eq!(
            decide(
                "archive it",
                &reading,
                &[],
                &[],
                &[],
                &json!({ "done": noul(0.95), "step": chose("press", 0.99) })
            ),
            Step::Done
        );
        // Not sure it is done is not done.
        assert!(matches!(
            decide(
                "archive it",
                &reading,
                &[],
                &[],
                &[],
                &json!({ "done": noul(0.6), "step": chose("impossible", 0.99) })
            ),
            Step::Stop(_)
        ));
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
        assert!(body["questions"]["is_e21"]["type"] == "noul");
        assert!(body["questions"].get("text").is_none(), "nothing to type");
        assert_eq!(
            body["state"]["what is selected"],
            "nothing in a list or table is selected yet"
        );
        // Every candidate gets its own yes/no, the named ones included.
        assert!(body["questions"]["is_e3"]["type"] == "noul");
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
            "press:7" => mail(),
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
        let step = decide(task, screen, spans, &[], &candidates, &answers);
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
                let mut step = decide(task, &screen, &spans, &[], &candidates, answers);
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
                if step == Step::Done {
                    done = true;
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
                    Step::Done => {
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
