//! The agent runner — the observe → decide → act loop.
//!
//! The loop is generic over two collaborators so the risky orchestration is
//! testable without a live Mac or a real model:
//!   • [`Brain`]    — the reasoning core (an LLM in production, scripted in
//!                    tests) that proposes the next [`Decision`].
//!   • [`Executor`] — the tiered action surface (skills/AX/vision in
//!                    production, a mock in tests) that performs an [`Action`].
//!
//! The **gating decision** — whether a proposed action runs, holds for
//! approval, or is refused — is a pure function ([`gate`]) over the security
//! classifier, table-tested independently of the async loop.
//!
//! Two invariants the loop guarantees, both safety-critical:
//!   1. Every action passes [`gate`] before execution; `Forbidden` never runs,
//!      `Consequential` never runs without an explicit approve.
//!   2. Cancellation (human takeover or an explicit stop) wins at every await
//!      point — mid-think, mid-hold, mid-execute — and ends the run promptly.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc::{Receiver, UnboundedSender};
use tokio::sync::Notify;

use crate::agent::protocol::{
    AgentInbound, AgentOutbound, AgentTier, RunOutcome, StepKind, StepState, ToolClass,
};
use crate::agent::security::{describe, floor, gate_class, Action, Autonomy};

/// The model's chosen next move.
// One of these exists at a time, for the length of one step; boxing the
// action would cost an allocation per step to save stack nobody is short of.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum Decision {
    /// Perform `action`; `summary` is the human-readable one-liner for the feed.
    Act {
        summary: String,
        tier: AgentTier,
        action: Action,
    },
    /// The run is over. `reason` says *how* — a model that declines a task,
    /// asks a question, or answers with prose instead of a tool call is not
    /// the same as one that finished the work (L-235).
    Finish {
        summary: String,
        reason: FinishReason,
    },
}

/// Why a run ended without another action.
///
/// Inferred from what the model actually did — whether it used the supported
/// terminal decision — never from keyword-matching its prose. "I cannot help
/// with that" and "Done!" are the same shape to a string matcher, and the
/// model may be answering in any language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    /// The model called `finish` and declared the task done.
    Completed,
    /// The model stopped without declaring completion — a refusal, a
    /// clarifying question answered as prose, or an empty response.
    Incomplete,
    /// The model explicitly needs something from the person to continue.
    NeedsInput,
}

impl FinishReason {
    /// How this reason is reported on the wire.
    pub fn outcome(self) -> RunOutcome {
        match self {
            FinishReason::Completed => RunOutcome::Completed,
            FinishReason::Incomplete => RunOutcome::Failed,
            FinishReason::NeedsInput => RunOutcome::NeedsInput,
        }
    }
}

/// The outcome of executing one action, fed back to the brain as context for
/// its next decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    /// What happened, in words the model can reason over.
    pub summary: String,
    /// Whether the action succeeded (false → the brain should adapt/retry).
    pub ok: bool,
    /// A screenshot for a vision-capable model to look at. `None` for every
    /// text-only observation.
    pub image: Option<ObservedImage>,
    /// A fingerprint of the screen after the action, when one was taken. Two
    /// equal fingerprints mean nothing visible changed — what the loop guard
    /// reads.
    pub screen: Option<u64>,
    /// What a look found, as structure rather than words: for a step that
    /// chooses among the listed elements instead of reading about them.
    /// `None` for everything but a look whose element reading succeeded.
    pub reading: Option<ScreenReading>,
    /// Why `reading` is absent, when a look tried and failed.
    ///
    /// A model with eyes does not need this: the screenshot still stands and
    /// the same sentence is in `summary` for it to read. A System One run has
    /// no eyes and no prose — the elements ARE its screen — so without this
    /// the one thing that knows why ("no focused application", "the focused
    /// app has no window on the shared display") is thrown away, and the
    /// person is told the app "may not expose its controls" whatever actually
    /// happened.
    pub reading_error: Option<String>,
}

/// The app in front and the elements a look listed, in listing order.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScreenReading {
    pub app: String,
    /// What has keyboard focus, as a person would name it ("text area
    /// \u{201c}Message body\u{201d}") — the difference between "type here"
    /// and "click that field first" (ADR-0020).
    pub focused: Option<String>,
    /// The front window's own element id, when it has a position — the place
    /// a scroll aimed at "the window" lands.
    pub window: Option<usize>,
    pub elements: Vec<ReadElement>,
}

/// One listed element: the id actions name it by, its role in words
/// ("button", "text field"), its label, and roughly where it sits.
///
/// The position is coarse on purpose ("top left", not a coordinate). It is
/// what tells two controls of the same name apart — a Send in the toolbar and
/// a Send in the sheet in front of it — on a screen a text-only model can only
/// read about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadElement {
    pub id: usize,
    pub role: String,
    pub label: String,
    pub at: Option<String>,
}

/// An encoded screenshot and the pixel size the model will see it at. The
/// size is part of the observation because a model's coordinates are only
/// meaningful against the image it was shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedImage {
    pub base64: String,
    /// "image/jpeg" or "image/png".
    pub media_type: &'static str,
    pub width: u32,
    pub height: u32,
    /// The whole shared display, as opposed to a zoomed-in part of it. Only a
    /// whole-screen image defines what the model's coordinates refer to.
    pub is_screen: bool,
}

impl Observation {
    pub fn ok(summary: impl Into<String>) -> Self {
        Observation {
            summary: summary.into(),
            ok: true,
            image: None,
            screen: None,
            reading: None,
            reading_error: None,
        }
    }
    pub fn fail(summary: impl Into<String>) -> Self {
        Observation {
            summary: summary.into(),
            ok: false,
            image: None,
            screen: None,
            reading: None,
            reading_error: None,
        }
    }
    /// A successful observation carrying a screenshot for a vision-capable
    /// model to look at.
    pub fn ok_with_image(summary: impl Into<String>, image: ObservedImage) -> Self {
        Observation {
            summary: summary.into(),
            ok: true,
            image: Some(image),
            screen: None,
            reading: None,
            reading_error: None,
        }
    }
}

/// The reasoning core. Native `async fn` in trait (no `async-trait` dep) — the
/// runner is generic over a concrete `B: Brain`, never a trait object.
pub trait Brain {
    fn next(
        &mut self,
        task: &str,
        history: &[Observation],
    ) -> impl std::future::Future<Output = Result<Decision>> + Send;

    /// Whether the model will look at the result of the action it just
    /// proposed. False while more actions from the same reply are queued
    /// behind it: the model asked for them as one batch and sees one
    /// screenshot at the end, so capturing after each would be spent on
    /// images nobody reads.
    fn wants_observation(&self) -> bool {
        true
    }
}

/// The action surface. Same native-async-fn shape as [`Brain`].
pub trait Executor {
    fn execute(
        &mut self,
        action: &Action,
    ) -> impl std::future::Future<Output = Result<Observation>> + Send;

    /// Attach the live context an action needs before it can be classified.
    ///
    /// [`classify`] is pure over `Action`, which is what makes the safety
    /// decision reproducible and table-testable. An action whose risk depends
    /// on live state — which accessibility element an `id` currently names —
    /// therefore has to carry that state with it. Resolution happens here,
    /// once, **before** [`gate`]: doing it inside the executor instead would
    /// let the thing approved and the thing performed differ. Executors that
    /// need no context leave the action untouched.
    fn resolve(&self, action: Action) -> Action {
        action
    }

    /// Whether the next `execute` should end with a look at the screen (see
    /// [`Brain::wants_observation`]). Executors with nothing to look at ignore
    /// it.
    fn set_observe(&mut self, _observe: bool) {}

    /// The run is over: let go of anything still held. Called once, whatever
    /// ended the run.
    fn finish(&mut self) -> impl std::future::Future<Output = ()> + Send {
        async {}
    }
}

/// The pure gating verdict for a proposed action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// `Safe`/`Sensitive` — run immediately (recording its class).
    Run(ToolClass),
    /// `Consequential` — hold for an explicit phone approve/deny.
    Hold(ToolClass),
    /// `Forbidden` — refuse outright; never offered for approval.
    Refuse,
}

/// Map an action to its gating verdict via the security classifier, under the
/// run's autonomy. Pure and total; the loop's entire safety policy lives here.
pub fn gate(action: &Action, autonomy: Autonomy) -> Gate {
    match gate_class(action, autonomy) {
        c @ (ToolClass::Safe | ToolClass::Sensitive) => Gate::Run(c),
        c @ ToolClass::Consequential => Gate::Hold(c),
        ToolClass::Forbidden => Gate::Refuse,
    }
}

/// A cheap, cloneable cancellation signal, safe to await from the loop and to
/// fire from another task (the takeover watcher / an explicit stop).
#[derive(Clone, Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }
    /// Request cancellation and wake any waiter.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    /// The raw flag, for code that polls rather than awaits — the input
    /// thread checks it between the steps of a gesture.
    pub fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.flag)
    }
    /// Resolve as soon as cancellation is requested (immediately if already).
    /// Registers with `Notify` before re-checking the flag, so a `cancel()`
    /// racing this call can't be missed.
    pub async fn wait(&self) {
        while !self.is_cancelled() {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// How many approve/deny frames may be queued for a run at once (L-248).
///
/// The queue used to be unbounded. The receiver is only drained while the
/// runner is *waiting on a held step*; during a model call or a sandboxed
/// script nothing reads it, so a phone that repeats a decision — a retry loop,
/// a stuck finger, a hostile client — grows desktop memory without limit and
/// nothing upstream notices. A run has at most one outstanding question, so a
/// handful of frames is every legitimate case (a retry, a race with a stale
/// step id); beyond that the frames are duplicates by construction.
///
/// Bound: `DECISION_QUEUE_CAPACITY` frames per active run, one active run per
/// session — the desktop's decision backlog is O(sessions), not O(taps).
/// Overflow is dropped at the sender with a warning, never silently buffered.
pub const DECISION_QUEUE_CAPACITY: usize = 16;

/// How many screenshots the run history keeps in full (L-249).
///
/// `llm::retain_recent_images` prunes the *provider* copy, which is what goes
/// over the network. It does not touch this history, which owns the original
/// base64 and lives for the whole run: forty vision steps is forty full-screen
/// PNGs held at once, tens of megabytes per run, all but the last two of which
/// no longer reach the model. Prune at the source instead, so the bound is on
/// the memory as well as on the request.
///
/// The text of every observation is kept — the model still knows a screenshot
/// was taken and what it showed; only the pixels of the older ones go.
const RETAINED_HISTORY_IMAGES: usize = 2;

/// The byte ceiling those retained images share.
///
/// A count is not a bound. Two screenshots of a 6K display are an order of
/// magnitude larger than two of a laptop panel, and the count-based rule
/// reports the same "2" for both. This is what actually caps the memory: even
/// the newest image is dropped rather than exceed it. 24 MiB of base64 is
/// roughly two full-resolution 6K PNGs with room to spare, and comfortably
/// more than any provider will accept in one request anyway.
const RETAINED_HISTORY_IMAGE_BYTES: usize = 24 * 1024 * 1024;

/// Drop the image payload of every observation older than the newest
/// [`RETAINED_HISTORY_IMAGES`] image-bearing ones, and of any image that would
/// push the retained total past [`RETAINED_HISTORY_IMAGE_BYTES`]. Idempotent.
fn retain_recent_images(history: &mut [Observation]) {
    let mut kept = 0;
    let mut bytes = 0usize;
    for obs in history.iter_mut().rev() {
        let Some(image) = obs.image.as_ref() else {
            continue;
        };
        kept += 1;
        let size = image.base64.len();
        let over_count = kept > RETAINED_HISTORY_IMAGES;
        let over_bytes = bytes + size > RETAINED_HISTORY_IMAGE_BYTES;
        if over_count || over_bytes {
            obs.image = None;
            obs.summary.push_str(" [screenshot no longer retained]");
        } else {
            bytes += size;
        }
    }
}

/// How many times in a row the same action may leave the screen unchanged
/// before the model is told so, and before the run is ended.
const LOOP_NOTE_AT: usize = 3;
const LOOP_END_AT: usize = 6;

/// Notices a model pressing the same thing over and over while nothing on
/// screen changes — the commonest way a computer-use run burns its budget.
#[derive(Default)]
struct LoopGuard {
    last: Option<(String, String)>,
    count: usize,
}

impl LoopGuard {
    /// Record one executed action and what it left behind; returns how many
    /// times in a row this exact action has now changed nothing.
    fn record(&mut self, action: &Action, obs: &Observation) -> usize {
        // Waiting is supposed to repeat while something loads.
        if matches!(action, Action::Wait { .. }) {
            self.last = None;
            self.count = 0;
            return 0;
        }
        let what = format!("{action:?}");
        let screen = match obs.screen {
            Some(fingerprint) => fingerprint.to_string(),
            // No screenshot (a text-only model): what the action reported is
            // the only view of the screen there is.
            None => obs.summary.clone(),
        };
        let now = (what, screen);
        if self.last.as_ref() == Some(&now) {
            self.count += 1;
        } else {
            self.last = Some(now);
            self.count = 1;
        }
        self.count
    }
}

/// Tuning for one run.
#[derive(Debug, Clone)]
pub struct RunnerConfig {
    /// Hard cap on decision iterations — a runaway-loop backstop. A real task
    /// finishes well under this; hitting it ends the run `Failed`.
    pub max_steps: usize,
    /// Wall-clock budget for the whole run, in milliseconds.
    ///
    /// A step cap is not a time cap: forty steps that each wait near the
    /// provider's request deadline is over an hour with the phone showing
    /// "running". Bounds the run itself, on top of the per-request deadlines
    /// in `llm` (L-236).
    pub max_run_ms: u64,
    /// What the person handed over for this run (ADR-0018).
    pub autonomy: Autonomy,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        // A computer-use task is many small steps — a form is a dozen clicks
        // and keystrokes — so the budget is sized for that, not for the
        // handful of skill calls Ask used to make. Still a backstop, not a
        // target: the loop guard ends a stuck run long before this.
        RunnerConfig {
            max_steps: 150,
            max_run_ms: 45 * 60 * 1000,
            autonomy: Autonomy::Supervised,
        }
    }
}

/// Drives one agent run. `now_ms` is injected so tests are deterministic and
/// the wire `ts` uses real epoch millis in production.
pub struct AgentRunner<B, E, F>
where
    F: Fn() -> u64,
{
    brain: B,
    executor: E,
    steps_tx: UnboundedSender<AgentOutbound>,
    now_ms: F,
    config: RunnerConfig,
    step_counter: u64,
}

impl<B, E, F> AgentRunner<B, E, F>
where
    B: Brain,
    E: Executor,
    F: Fn() -> u64,
{
    pub fn new(brain: B, executor: E, steps_tx: UnboundedSender<AgentOutbound>, now_ms: F) -> Self {
        Self::with_config(brain, executor, steps_tx, now_ms, RunnerConfig::default())
    }

    pub fn with_config(
        brain: B,
        executor: E,
        steps_tx: UnboundedSender<AgentOutbound>,
        now_ms: F,
        config: RunnerConfig,
    ) -> Self {
        AgentRunner {
            brain,
            executor,
            steps_tx,
            now_ms,
            config,
            step_counter: 0,
        }
    }

    fn next_step_id(&mut self, run_id: &str) -> String {
        self.step_counter += 1;
        format!("{run_id}-{}", self.step_counter)
    }

    #[allow(clippy::too_many_arguments)]
    fn emit(
        &self,
        run_id: &str,
        step_id: &str,
        kind: StepKind,
        summary: impl Into<String>,
        tier: Option<AgentTier>,
        class: Option<ToolClass>,
        state: StepState,
    ) {
        let summary: String = summary.into();
        // The step feed dies with the phone connection, and it was the only
        // record a run ever left (L-320). A whole session of actions — what
        // was proposed, what was held, what the person decided — vanished the
        // moment the DataChannel closed, which is exactly when somebody wants
        // to know what happened. The same line the phone gets now also goes to
        // this Mac's log.
        log::info!(
            target: "lilypad::agent",
            "run {run_id} step {step_id}: {kind:?} {state:?}{} — {summary}",
            class.map(|c| format!(" [{c:?}]")).unwrap_or_default(),
        );
        // A closed receiver just means the phone went away; the caller will
        // observe the run ending. Dropping the message is correct here.
        let _ = self.steps_tx.send(AgentOutbound::step(
            run_id,
            step_id,
            kind,
            summary,
            tier,
            class,
            state,
            (self.now_ms)(),
        ));
    }

    fn end(&self, run_id: &str, outcome: RunOutcome) -> RunOutcome {
        let _ = self
            .steps_tx
            .send(AgentOutbound::run_end(run_id, outcome, (self.now_ms)()));
        outcome
    }

    fn timed_out(&mut self, run_id: &str) -> RunOutcome {
        let sid = self.next_step_id(run_id);
        self.emit(
            run_id,
            &sid,
            StepKind::Error,
            "The task ran out of time before finishing",
            None,
            None,
            StepState::Failed,
        );
        self.end(run_id, RunOutcome::Failed)
    }

    /// Run one task to completion, cancellation, or failure. Returns the
    /// terminal outcome (also emitted as an `agent_run_end` on the feed).
    pub async fn run(
        &mut self,
        run_id: &str,
        task: &str,
        decisions_rx: &mut Receiver<AgentInbound>,
        cancel: &Cancel,
    ) -> RunOutcome {
        let outcome = self.run_steps(run_id, task, decisions_rx, cancel).await;
        // Whatever ended the run, nothing it pressed stays pressed.
        self.executor.finish().await;
        outcome
    }

    /// The brain, handed back once the run is over — so a run that ended
    /// asking the person something can carry on from the same thread.
    pub fn into_brain(self) -> B {
        self.brain
    }

    async fn run_steps(
        &mut self,
        run_id: &str,
        task: &str,
        decisions_rx: &mut Receiver<AgentInbound>,
        cancel: &Cancel,
    ) -> RunOutcome {
        let mut history: Vec<Observation> = Vec::new();
        let mut loop_guard = LoopGuard::default();
        let started_ms = (self.now_ms)();
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_millis(self.config.max_run_ms);

        for _ in 0..self.config.max_steps {
            if cancel.is_cancelled() {
                return self.end(run_id, RunOutcome::Stopped);
            }
            // Cancellation is checked first on purpose: a stopped run reports
            // Stopped, never a timeout.
            if (self.now_ms)().saturating_sub(started_ms) >= self.config.max_run_ms {
                let sid = self.next_step_id(run_id);
                self.emit(
                    run_id,
                    &sid,
                    StepKind::Error,
                    "the task ran out of time before finishing",
                    None,
                    None,
                    StepState::Failed,
                );
                return self.end(run_id, RunOutcome::Failed);
            }

            // ── decide ──
            let decision = tokio::select! {
                biased;
                _ = cancel.wait() => return self.end(run_id, RunOutcome::Stopped),
                _ = tokio::time::sleep_until(deadline) => return self.timed_out(run_id),
                d = self.brain.next(task, &history) => d,
            };
            let decision = match decision {
                Ok(d) => d,
                Err(err) => {
                    // Also land the reason in the desktop log — the step feed
                    // alone dies with the phone connection.
                    log::warn!(target: "lilypad::agent", "run {run_id}: reasoning failed: {err}");
                    let sid = self.next_step_id(run_id);
                    self.emit(
                        run_id,
                        &sid,
                        StepKind::Error,
                        format!("agent reasoning failed: {err}"),
                        None,
                        None,
                        StepState::Failed,
                    );
                    return self.end(run_id, RunOutcome::Failed);
                }
            };

            let observe = self.brain.wants_observation();
            let (_proposed, tier, action) = match decision {
                Decision::Finish { summary, reason } => {
                    let sid = self.next_step_id(run_id);
                    // Only a declared completion is rendered as a result; the
                    // other reasons are not successes and must not wear a
                    // success badge.
                    let (kind, state) = match reason {
                        FinishReason::Completed => (StepKind::Result, StepState::Done),
                        _ => (StepKind::Result, StepState::Failed),
                    };
                    self.emit(run_id, &sid, kind, summary, None, None, state);
                    return self.end(run_id, reason.outcome());
                }
                Decision::Act {
                    summary,
                    tier,
                    action,
                } => (summary, tier, action),
            };

            // ── resolve ──
            // Give the gate the context it needs to judge this action. Must
            // precede classification: an `ax_press` carries only an index
            // until the executor says what that index currently points at.
            let action = self.executor.resolve(action);
            // Described from the resolved action, so the feed and the card
            // name the control a point lands on rather than the point.
            let summary = describe(&action);

            let step_id = self.next_step_id(run_id);

            // ── gate ──
            let class = match gate(&action, self.config.autonomy) {
                Gate::Refuse => {
                    let why = floor(&action)
                        .unwrap_or_else(|| "it touches a security-critical surface.".into());
                    self.emit(
                        run_id,
                        &step_id,
                        StepKind::Action,
                        format!("Refused: {summary} — {why}"),
                        Some(tier),
                        Some(ToolClass::Forbidden),
                        StepState::Failed,
                    );
                    history.push(Observation::fail(format!(
                        "Not run — refused by this Mac's safety rules: {why} Choose another way, \
                         or finish and say what the person needs to do themselves."
                    )));
                    continue;
                }
                Gate::Hold(class) => {
                    let approval = crate::agent::security::approval_for(&action);
                    if !approval.fits_wire() {
                        let message = "Action exceeds approval limits; shorten it without hiding any code or permissions";
                        self.emit(
                            run_id,
                            &step_id,
                            StepKind::Error,
                            message,
                            Some(tier),
                            Some(class),
                            StepState::Failed,
                        );
                        history.push(Observation::fail(message));
                        continue;
                    }
                    // The card must show what is actually being granted, not a
                    // generic label: "Run shell script" is the same sentence
                    // for a script that lists a directory and one that uploads
                    // it. Derived from the very action that will run.
                    log::info!(
                        target: "lilypad::agent",
                        "run {run_id} step {step_id}: waiting for approval [{class:?}] — {}",
                        approval.purpose,
                    );
                    let _ = self.steps_tx.send(AgentOutbound::held_step(
                        run_id,
                        &step_id,
                        summary.clone(),
                        Some(tier),
                        Some(class),
                        approval,
                        (self.now_ms)(),
                    ));
                    let approved = tokio::select! {
                        biased;
                        _ = cancel.wait() => {
                            self.emit(run_id, &step_id, StepKind::Action, summary.clone(),
                                Some(tier), Some(class), StepState::Denied);
                            return self.end(run_id, RunOutcome::Stopped);
                        }
                        _ = tokio::time::sleep_until(deadline) => return self.timed_out(run_id),
                        a = Self::await_decision(decisions_rx, run_id, &step_id) => a,
                    };
                    if !approved {
                        self.emit(
                            run_id,
                            &step_id,
                            StepKind::Action,
                            format!("denied: {summary}"),
                            Some(tier),
                            Some(class),
                            StepState::Denied,
                        );
                        history.push(Observation::fail(format!("user denied: {summary}")));
                        continue;
                    }
                    class
                }
                Gate::Run(class) => class,
            };

            // ── act ──
            self.emit(
                run_id,
                &step_id,
                StepKind::Action,
                summary.clone(),
                Some(tier),
                Some(class),
                StepState::Running,
            );
            self.executor.set_observe(observe);
            let result = tokio::select! {
                biased;
                _ = cancel.wait() => return self.end(run_id, RunOutcome::Stopped),
                _ = tokio::time::sleep_until(deadline) => return self.timed_out(run_id),
                r = self.executor.execute(&action) => r,
            };
            match result {
                Ok(mut obs) => {
                    let repeats = loop_guard.record(&action, &obs);
                    if repeats >= LOOP_END_AT {
                        let sid = self.next_step_id(run_id);
                        self.emit(
                            run_id,
                            &sid,
                            StepKind::Error,
                            format!(
                                "Stopped: the same action ran {repeats} times in a row without \
                                 changing anything on the screen"
                            ),
                            None,
                            None,
                            StepState::Failed,
                        );
                        return self.end(run_id, RunOutcome::Failed);
                    }
                    if repeats >= LOOP_NOTE_AT {
                        obs.summary.push_str(&format!(
                            " [Note: this exact action has now run {repeats} times in a row and \
                             the screen did not change. Repeating it will not help. Try something \
                             different — another element, a keyboard shortcut, scrolling, or \
                             ask_user if you are stuck.]"
                        ));
                    }
                    self.emit(
                        run_id,
                        &step_id,
                        StepKind::Action,
                        summary.clone(),
                        Some(tier),
                        Some(class),
                        if obs.ok {
                            StepState::Done
                        } else {
                            StepState::Failed
                        },
                    );
                    history.push(obs);
                    retain_recent_images(&mut history);
                }
                Err(err) => {
                    self.emit(
                        run_id,
                        &step_id,
                        StepKind::Action,
                        format!("{summary} — error: {err}"),
                        Some(tier),
                        Some(class),
                        StepState::Failed,
                    );
                    history.push(Observation::fail(format!("{summary}: {err}")));
                }
            }
        }

        // Fell out of the loop → hit the step cap.
        let sid = self.next_step_id(run_id);
        self.emit(
            run_id,
            &sid,
            StepKind::Error,
            "reached the maximum number of steps without finishing",
            None,
            None,
            StepState::Failed,
        );
        self.end(run_id, RunOutcome::Failed)
    }

    /// Await the phone's decision for a specific held step, skipping stale
    /// decisions (wrong run/step) and any non-decision inbound. A closed
    /// channel (phone gone) resolves as a deny — fail safe.
    async fn await_decision(
        decisions_rx: &mut Receiver<AgentInbound>,
        run_id: &str,
        step_id: &str,
    ) -> bool {
        loop {
            match decisions_rx.recv().await {
                Some(AgentInbound::AgentDecision {
                    run_id: r,
                    step_id: s,
                    approve,
                    ..
                }) if r == run_id && s == step_id => return approve,
                // Stale or unrelated inbound (a decision for another step, or a
                // stray command/stop) — ignore and keep waiting. An explicit
                // stop is delivered via `Cancel`, not here.
                Some(_) => continue,
                None => return false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use tokio::sync::mpsc;

    fn image(data: &str) -> ObservedImage {
        ObservedImage {
            base64: data.into(),
            media_type: "image/jpeg",
            width: 10,
            height: 10,
            is_screen: true,
        }
    }

    fn act(action: Action) -> Decision {
        Decision::Act {
            summary: format!("{action:?}"),
            tier: AgentTier::Skill,
            action,
        }
    }

    /// A brain that replays a scripted list of decisions, then `Finish`es.
    struct ScriptedBrain {
        script: VecDeque<Decision>,
        seen_history_lens: Vec<usize>,
    }
    impl ScriptedBrain {
        fn new(decisions: Vec<Decision>) -> Self {
            ScriptedBrain {
                script: decisions.into(),
                seen_history_lens: Vec::new(),
            }
        }
    }
    impl Brain for ScriptedBrain {
        async fn next(&mut self, _task: &str, history: &[Observation]) -> Result<Decision> {
            self.seen_history_lens.push(history.len());
            Ok(self.script.pop_front().unwrap_or(Decision::Finish {
                summary: "done".into(),
                reason: FinishReason::Completed,
            }))
        }
    }

    /// Records every action it's asked to execute; returns success.
    #[derive(Default, Clone)]
    struct RecordingExecutor {
        executed: Arc<std::sync::Mutex<Vec<Action>>>,
    }
    impl Executor for RecordingExecutor {
        async fn execute(&mut self, action: &Action) -> Result<Observation> {
            self.executed.lock().unwrap().push(action.clone());
            Ok(Observation::ok("ok"))
        }
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<AgentOutbound>) -> Vec<AgentOutbound> {
        let mut out = Vec::new();
        while let Ok(m) = rx.try_recv() {
            out.push(m);
        }
        out
    }

    fn states(msgs: &[AgentOutbound]) -> Vec<StepState> {
        msgs.iter()
            .filter_map(|m| match m {
                AgentOutbound::AgentStep { state, .. } => Some(*state),
                _ => None,
            })
            .collect()
    }

    fn outcome(msgs: &[AgentOutbound]) -> Option<RunOutcome> {
        msgs.iter().find_map(|m| match m {
            AgentOutbound::AgentRunEnd { outcome, .. } => Some(*outcome),
            _ => None,
        })
    }

    /// A click whose target `resolve` identified, as it does on a working
    /// Mac. (One it could not identify is asked in every mode.)
    fn click() -> Action {
        Action::Click {
            target: crate::agent::security::Target::Point { x: 0.5, y: 0.5 },
            button: crate::input::PointerButton::Left,
            count: 1,
            modifiers: vec![],
            hit: Some(crate::agent::security::Hit {
                app: "Mail".into(),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn gate_maps_classes_to_verdicts() {
        let s = Autonomy::Supervised;
        assert_eq!(gate(&Action::ReadAxTree, s), Gate::Run(ToolClass::Safe));
        assert_eq!(gate(&click(), s), Gate::Hold(ToolClass::Consequential));
        assert_eq!(
            gate(
                &Action::Shell {
                    command: "ls".into()
                },
                s
            ),
            Gate::Hold(ToolClass::Consequential)
        );
        assert_eq!(
            gate(
                &Action::Shell {
                    command: "sudo rm -rf /".into()
                },
                s
            ),
            Gate::Refuse
        );
        // Full control runs what supervision holds, and still refuses the
        // forbidden.
        let f = Autonomy::Full;
        assert_eq!(gate(&click(), f), Gate::Run(ToolClass::Sensitive));
        assert_eq!(
            gate(
                &Action::Shell {
                    command: "sudo rm -rf /".into()
                },
                f
            ),
            Gate::Refuse
        );
    }

    #[test]
    fn only_the_two_newest_screenshots_keep_their_pixels() {
        // L-249. `llm::retain_recent_images` prunes the provider copy — the
        // bytes that go over the network. The run's own history kept every
        // original for the whole run: forty vision steps is forty full-screen
        // PNGs resident at once, none of which the model can still see. Prune
        // at the source, and say so in the text so the model is not told a
        // screenshot exists that it cannot look at.
        let mut history = vec![
            Observation::ok_with_image("first", image("AAA")),
            Observation::ok("no image here"),
            Observation::ok_with_image("second", image("BBB")),
            Observation::ok_with_image("third", image("CCC")),
        ];
        retain_recent_images(&mut history);
        let data = |o: &Observation| o.image.as_ref().map(|i| i.base64.clone());
        assert_eq!(data(&history[0]), None);
        assert!(history[0].summary.contains("no longer retained"));
        assert_eq!(data(&history[1]), None); // never had one
        assert!(!history[1].summary.contains("no longer retained"));
        assert_eq!(data(&history[2]).as_deref(), Some("BBB"));
        assert_eq!(data(&history[3]).as_deref(), Some("CCC"));

        // Idempotent: running again neither drops more nor re-annotates.
        let before = history.clone();
        retain_recent_images(&mut history);
        assert_eq!(history, before);
    }

    #[test]
    fn the_retained_screenshots_are_bounded_in_bytes_not_only_in_count() {
        // A count is not a bound: two screenshots of a 6K display are an order
        // of magnitude bigger than two of a laptop panel, and "2" describes
        // both. Forty large steps must leave a bounded number of bytes behind.
        let big = "z".repeat(RETAINED_HISTORY_IMAGE_BYTES / 2 + 1);
        let mut history: Vec<Observation> = (0..40)
            .map(|i| Observation::ok_with_image(format!("step {i}"), image(&big)))
            .collect();
        retain_recent_images(&mut history);

        let retained: usize = history
            .iter()
            .filter_map(|o| o.image.as_ref().map(|i| i.base64.len()))
            .sum();
        assert!(
            retained <= RETAINED_HISTORY_IMAGE_BYTES,
            "retained {retained} bytes, over the {RETAINED_HISTORY_IMAGE_BYTES} cap"
        );
        // Two of these do not fit, so only the newest survives — the cap wins
        // over the count, which is the whole point.
        assert_eq!(history.iter().filter(|o| o.image.is_some()).count(), 1);
        assert!(history[39].image.is_some(), "the newest is kept");
    }

    #[tokio::test]
    async fn runs_a_safe_action_then_finishes_completed() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        let exec = RecordingExecutor::default();
        let executed = exec.executed.clone();
        let mut runner = AgentRunner::new(
            ScriptedBrain::new(vec![act(Action::OpenApp {
                name: "Safari".into(),
            })]),
            exec,
            tx,
            || 0,
        );
        let cancel = Cancel::new();

        let out = runner.run("run-1", "open safari", &mut drx, &cancel).await;

        assert_eq!(out, RunOutcome::Completed);
        assert_eq!(executed.lock().unwrap().len(), 1);
        let msgs = drain(&mut rx);
        // running → done (the action), then result done (finish).
        assert!(states(&msgs).contains(&StepState::Running));
        assert!(states(&msgs).contains(&StepState::Done));
        assert_eq!(outcome(&msgs), Some(RunOutcome::Completed));
    }

    #[tokio::test]
    async fn forbidden_action_is_refused_and_never_executed() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        let exec = RecordingExecutor::default();
        let executed = exec.executed.clone();
        let mut runner = AgentRunner::new(
            ScriptedBrain::new(vec![act(Action::Shell {
                command: "sudo rm -rf /".into(),
            })]),
            exec,
            tx,
            || 0,
        );
        let out = runner.run("r", "wipe disk", &mut drx, &Cancel::new()).await;
        assert_eq!(out, RunOutcome::Completed); // refusal is not fatal; agent finishes
        assert_eq!(executed.lock().unwrap().len(), 0); // never ran
        let msgs = drain(&mut rx);
        // A forbidden action reports as failed with the Forbidden class.
        assert!(msgs.iter().any(|m| matches!(
            m,
            AgentOutbound::AgentStep {
                class: Some(ToolClass::Forbidden),
                state: StepState::Failed,
                ..
            }
        )));
    }

    #[tokio::test]
    async fn consequential_action_holds_then_runs_on_approve() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        let exec = RecordingExecutor::default();
        let executed = exec.executed.clone();
        let mut runner = AgentRunner::new(
            ScriptedBrain::new(vec![act(Action::Shell {
                command: "rm ~/Downloads/old.pdf".into(),
            })]),
            exec,
            tx,
            || 0,
        );
        let cancel = Cancel::new();

        // Approve the first held step (id "r-1") shortly after the run starts.
        let approver = tokio::spawn(async move {
            tokio::task::yield_now().await;
            dtx.try_send(AgentInbound::AgentDecision {
                run_id: "r".into(),
                step_id: "r-1".into(),
                approve: true,
                ts: 0,
            })
            .unwrap();
        });

        let out = runner.run("r", "delete old pdf", &mut drx, &cancel).await;
        approver.await.unwrap();

        assert_eq!(out, RunOutcome::Completed);
        assert_eq!(executed.lock().unwrap().len(), 1); // ran after approval
        let msgs = drain(&mut rx);
        assert!(states(&msgs).contains(&StepState::Held));
        assert!(states(&msgs).contains(&StepState::Running));
    }

    #[tokio::test]
    async fn consequential_action_is_skipped_on_deny() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        let exec = RecordingExecutor::default();
        let executed = exec.executed.clone();
        let mut runner = AgentRunner::new(
            ScriptedBrain::new(vec![act(Action::Shell {
                command: "rm ~/Downloads/old.pdf".into(),
            })]),
            exec,
            tx,
            || 0,
        );

        let denier = tokio::spawn(async move {
            tokio::task::yield_now().await;
            dtx.try_send(AgentInbound::AgentDecision {
                run_id: "r".into(),
                step_id: "r-1".into(),
                approve: false,
                ts: 0,
            })
            .unwrap();
        });

        let out = runner
            .run("r", "delete old pdf", &mut drx, &Cancel::new())
            .await;
        denier.await.unwrap();

        assert_eq!(out, RunOutcome::Completed);
        assert_eq!(executed.lock().unwrap().len(), 0); // never ran
        let msgs = drain(&mut rx);
        assert!(states(&msgs).contains(&StepState::Denied));
    }

    #[tokio::test]
    async fn cancellation_stops_the_run_promptly() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        // A long script the runner should never finish because we cancel first.
        let script = (0..100).map(|_| act(click())).collect();
        let mut runner = AgentRunner::new(
            ScriptedBrain::new(script),
            RecordingExecutor::default(),
            tx,
            || 0,
        );
        let cancel = Cancel::new();
        cancel.cancel(); // already cancelled before we start

        let out = runner.run("r", "click forever", &mut drx, &cancel).await;
        assert_eq!(out, RunOutcome::Stopped);
        assert_eq!(outcome(&drain(&mut rx)), Some(RunOutcome::Stopped));
    }

    #[tokio::test]
    async fn cancel_while_holding_denies_and_stops() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        let exec = RecordingExecutor::default();
        let executed = exec.executed.clone();
        let mut runner = AgentRunner::new(
            ScriptedBrain::new(vec![act(Action::Shell {
                command: "rm x".into(),
            })]),
            exec,
            tx,
            || 0,
        );
        let cancel = Cancel::new();
        let c2 = cancel.clone();
        // Never send a decision; instead cancel while the run is holding.
        let canceller = tokio::spawn(async move {
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
            c2.cancel();
        });

        let out = runner.run("r", "delete", &mut drx, &cancel).await;
        canceller.await.unwrap();

        assert_eq!(out, RunOutcome::Stopped);
        assert_eq!(executed.lock().unwrap().len(), 0);
        let msgs = drain(&mut rx);
        assert!(states(&msgs).contains(&StepState::Held));
        assert!(states(&msgs).contains(&StepState::Denied));
    }

    // ── L-235: a run that did not finish must not report success ──

    #[tokio::test]
    async fn an_incomplete_finish_ends_the_run_failed_not_completed() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let brain = ScriptedBrain::new(vec![Decision::Finish {
            summary: "I cannot do that".into(),
            reason: FinishReason::Incomplete,
        }]);
        let mut runner = AgentRunner::new(brain, RecordingExecutor::default(), tx, || 1);
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        let outcome = runner.run("r1", "task", &mut drx, &Cancel::new()).await;
        assert_eq!(outcome, RunOutcome::Failed);

        // …and the step itself must not wear a success state.
        let mut states = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            if let AgentOutbound::AgentStep { state, .. } = msg {
                states.push(state);
            }
        }
        assert_eq!(states, vec![StepState::Failed]);
    }

    #[tokio::test]
    async fn a_needs_input_finish_is_reported_as_needing_input() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let brain = ScriptedBrain::new(vec![Decision::Finish {
            summary: "Which file did you mean?".into(),
            reason: FinishReason::NeedsInput,
        }]);
        let mut runner = AgentRunner::new(brain, RecordingExecutor::default(), tx, || 1);
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        assert_eq!(
            runner.run("r1", "task", &mut drx, &Cancel::new()).await,
            RunOutcome::NeedsInput
        );
    }

    #[tokio::test]
    async fn a_completed_finish_still_completes() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let brain = ScriptedBrain::new(vec![Decision::Finish {
            summary: "done".into(),
            reason: FinishReason::Completed,
        }]);
        let mut runner = AgentRunner::new(brain, RecordingExecutor::default(), tx, || 1);
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        assert_eq!(
            runner.run("r1", "task", &mut drx, &Cancel::new()).await,
            RunOutcome::Completed
        );
    }

    // ── L-236: a run is bounded in time, not only in steps ──

    #[tokio::test]
    async fn a_run_that_outlives_its_time_budget_ends_failed() {
        let (tx, _rx) = mpsc::unbounded_channel();
        // A brain that keeps proposing work; without a time bound, forty steps
        // of it run for however long each one happens to take.
        let brain = ScriptedBrain::new(
            (0..40)
                .map(|_| Decision::Act {
                    summary: "look".into(),
                    tier: AgentTier::Ax,
                    action: Action::ReadAxTree,
                })
                .collect(),
        );
        let clock = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let c = clock.clone();
        let mut runner = AgentRunner::with_config(
            brain,
            RecordingExecutor::default(),
            tx,
            move || c.fetch_add(1_000, std::sync::atomic::Ordering::SeqCst),
            RunnerConfig {
                max_steps: 40,
                max_run_ms: 2_000,
                ..Default::default()
            },
        );
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        assert_eq!(
            runner.run("r1", "task", &mut drx, &Cancel::new()).await,
            RunOutcome::Failed
        );
    }

    #[tokio::test]
    async fn cancellation_beats_the_time_budget_so_stop_still_reports_stopped() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let brain = ScriptedBrain::new(vec![]);
        let clock = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let c = clock.clone();
        let mut runner = AgentRunner::with_config(
            brain,
            RecordingExecutor::default(),
            tx,
            move || c.fetch_add(1_000_000, std::sync::atomic::Ordering::SeqCst),
            RunnerConfig {
                max_steps: 40,
                max_run_ms: 1,
                ..Default::default()
            },
        );
        let cancel = Cancel::new();
        cancel.cancel();
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        assert_eq!(
            runner.run("r1", "task", &mut drx, &cancel).await,
            RunOutcome::Stopped
        );
    }
    #[tokio::test]
    async fn run_budget_interrupts_a_held_approval() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let brain = ScriptedBrain::new(vec![Decision::Act {
            summary: "held".into(),
            tier: AgentTier::Sandbox,
            action: Action::RunScript {
                language: crate::agent::security::ScriptLanguage::Shell,
                script: "true".into(),
                writable_paths: vec![],
                readable_paths: vec![],
                needs_network: false,
            },
        }]);
        let mut runner = AgentRunner::with_config(
            brain,
            RecordingExecutor::default(),
            tx,
            || 0,
            RunnerConfig {
                max_steps: 40,
                max_run_ms: 20,
                ..Default::default()
            },
        );
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            runner.run("r", "task", &mut drx, &Cancel::new()),
        )
        .await;
        assert_eq!(
            outcome.expect("approval wait exceeded whole-run budget"),
            RunOutcome::Failed
        );
    }

    #[tokio::test]
    async fn approval_limits_reject_full_actions_instead_of_hiding_the_tail() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let brain = ScriptedBrain::new(vec![Decision::Act {
            summary: "oversized".into(),
            tier: AgentTier::Sandbox,
            action: Action::RunScript {
                language: crate::agent::security::ScriptLanguage::Shell,
                script: "#".repeat(9000),
                writable_paths: vec![],
                readable_paths: vec![],
                needs_network: false,
            },
        }]);
        let mut runner = AgentRunner::new(brain, RecordingExecutor::default(), tx, || 0);
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            runner.run("r", "task", &mut drx, &Cancel::new()),
        )
        .await
        .unwrap();
        assert!(runner.executor.executed.lock().unwrap().is_empty());
        while let Ok(message) = rx.try_recv() {
            if let AgentOutbound::AgentStep { state, .. } = message {
                assert_ne!(
                    state,
                    StepState::Held,
                    "a partial approval must never be offered"
                );
            }
        }
    }

    // ── ADR-0018 in the loop ──

    #[tokio::test]
    async fn full_control_runs_a_click_without_asking_and_supervision_holds_it() {
        for (autonomy, held) in [(Autonomy::Full, false), (Autonomy::Supervised, true)] {
            let (tx, mut rx) = mpsc::unbounded_channel();
            let (dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
            let exec = RecordingExecutor::default();
            let executed = exec.executed.clone();
            let mut runner = AgentRunner::with_config(
                ScriptedBrain::new(vec![act(click())]),
                exec,
                tx,
                || 0,
                RunnerConfig {
                    autonomy,
                    ..Default::default()
                },
            );
            if held {
                tokio::spawn(async move {
                    tokio::task::yield_now().await;
                    let _ = dtx.try_send(AgentInbound::AgentDecision {
                        run_id: "r".into(),
                        step_id: "r-1".into(),
                        approve: true,
                        ts: 0,
                    });
                });
            }
            let out = runner.run("r", "click", &mut drx, &Cancel::new()).await;
            assert_eq!(out, RunOutcome::Completed);
            assert_eq!(executed.lock().unwrap().len(), 1);
            assert_eq!(
                states(&drain(&mut rx)).contains(&StepState::Held),
                held,
                "{autonomy:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_floor_refusal_tells_the_model_why_and_never_runs() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        let exec = RecordingExecutor::default();
        let executed = exec.executed.clone();
        let mut runner = AgentRunner::with_config(
            ScriptedBrain::new(vec![act(Action::OpenApp {
                name: "Lilypad".into(),
            })]),
            exec,
            tx,
            || 0,
            RunnerConfig {
                autonomy: Autonomy::Full,
                ..Default::default()
            },
        );
        runner
            .run("r", "quit lilypad", &mut drx, &Cancel::new())
            .await;
        assert!(executed.lock().unwrap().is_empty());
        let refused = drain(&mut rx).into_iter().any(|m| {
            matches!(m,
            AgentOutbound::AgentStep { summary, class: Some(ToolClass::Forbidden), .. }
                if summary.contains("never operates Lilypad"))
        });
        assert!(refused);
        assert!(runner.brain.seen_history_lens.len() >= 2);
    }

    /// The same click, the same unchanged screen, over and over: noted on the
    /// third, ended on the sixth.
    #[tokio::test]
    async fn a_run_that_repeats_itself_without_effect_is_stopped() {
        struct SameScreen;
        impl Executor for SameScreen {
            async fn execute(&mut self, _: &Action) -> Result<Observation> {
                let mut o = Observation::ok("clicked");
                o.screen = Some(42);
                Ok(o)
            }
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (_dtx, mut drx) = mpsc::channel(DECISION_QUEUE_CAPACITY);
        let mut runner = AgentRunner::with_config(
            ScriptedBrain::new((0..20).map(|_| act(click())).collect()),
            SameScreen,
            tx,
            || 0,
            RunnerConfig {
                autonomy: Autonomy::Full,
                ..Default::default()
            },
        );
        let out = runner.run("r", "click", &mut drx, &Cancel::new()).await;
        assert_eq!(out, RunOutcome::Failed);
        // Six decisions before the end: the guard, not the script, stopped it.
        assert_eq!(runner.brain.seen_history_lens.len(), LOOP_END_AT);
        assert!(drain(&mut rx).iter().any(|m| matches!(m,
            AgentOutbound::AgentStep { summary, .. } if summary.contains("without changing anything"))));
    }

    #[test]
    fn the_loop_guard_resets_on_change_and_ignores_waiting() {
        let mut g = LoopGuard::default();
        let mut o = Observation::ok("x");
        o.screen = Some(1);
        assert_eq!(g.record(&click(), &o), 1);
        assert_eq!(g.record(&click(), &o), 2);
        o.screen = Some(2);
        assert_eq!(g.record(&click(), &o), 1, "a changed screen starts over");
        let wait = Action::Wait { ms: 1000 };
        for _ in 0..10 {
            assert_eq!(g.record(&wait, &o), 0);
        }
    }
}
