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
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::Notify;

use crate::agent::protocol::{
    AgentInbound, AgentOutbound, AgentTier, RunOutcome, StepKind, StepState, ToolClass,
};
use crate::agent::security::{classify, Action};

/// The model's chosen next move.
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
#[derive(Debug, Clone)]
pub struct Observation {
    /// What happened, in words the model can reason over.
    pub summary: String,
    /// Whether the action succeeded (false → the brain should adapt/retry).
    pub ok: bool,
    /// Optional PNG screenshot (base64) the brain folds back as an image block
    /// — the tier-3 vision observation. `None` for every text-only tier.
    pub image_png_base64: Option<String>,
}

impl Observation {
    pub fn ok(summary: impl Into<String>) -> Self {
        Observation {
            summary: summary.into(),
            ok: true,
            image_png_base64: None,
        }
    }
    pub fn fail(summary: impl Into<String>) -> Self {
        Observation {
            summary: summary.into(),
            ok: false,
            image_png_base64: None,
        }
    }
    /// A successful observation carrying a PNG screenshot (base64) for a
    /// vision-capable model to look at.
    pub fn ok_with_image(summary: impl Into<String>, png_base64: String) -> Self {
        Observation {
            summary: summary.into(),
            ok: true,
            image_png_base64: Some(png_base64),
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

/// Map an action to its gating verdict via the security classifier. Pure and
/// total; the loop's entire safety policy lives here.
pub fn gate(action: &Action) -> Gate {
    match classify(action) {
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
}

impl Default for RunnerConfig {
    fn default() -> Self {
        RunnerConfig {
            max_steps: 40,
            max_run_ms: 15 * 60 * 1000,
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
        decisions_rx: &mut UnboundedReceiver<AgentInbound>,
        cancel: &Cancel,
    ) -> RunOutcome {
        let mut history: Vec<Observation> = Vec::new();
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

            let (summary, tier, action) = match decision {
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

            let step_id = self.next_step_id(run_id);

            // ── gate ──
            let class = match gate(&action) {
                Gate::Refuse => {
                    self.emit(
                        run_id,
                        &step_id,
                        StepKind::Action,
                        format!("refused (forbidden): {summary}"),
                        Some(tier),
                        Some(ToolClass::Forbidden),
                        StepState::Failed,
                    );
                    history.push(Observation::fail(format!(
                        "action refused by security policy: {summary}"
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
            let result = tokio::select! {
                biased;
                _ = cancel.wait() => return self.end(run_id, RunOutcome::Stopped),
                _ = tokio::time::sleep_until(deadline) => return self.timed_out(run_id),
                r = self.executor.execute(&action) => r,
            };
            match result {
                Ok(obs) => {
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
        decisions_rx: &mut UnboundedReceiver<AgentInbound>,
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

    #[test]
    fn gate_maps_classes_to_verdicts() {
        assert_eq!(gate(&Action::ReadAxTree), Gate::Run(ToolClass::Safe));
        assert_eq!(
            gate(&Action::Click {
                x: 0.5,
                y: 0.5,
                count: 1
            }),
            Gate::Run(ToolClass::Sensitive)
        );
        assert_eq!(
            gate(&Action::Shell {
                command: "ls".into()
            }),
            Gate::Hold(ToolClass::Consequential)
        );
        assert_eq!(
            gate(&Action::Shell {
                command: "sudo rm -rf /".into()
            }),
            Gate::Refuse
        );
    }

    #[tokio::test]
    async fn runs_a_safe_action_then_finishes_completed() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (_dtx, mut drx) = mpsc::unbounded_channel();
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
        let (_dtx, mut drx) = mpsc::unbounded_channel();
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
        let (dtx, mut drx) = mpsc::unbounded_channel();
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
            dtx.send(AgentInbound::AgentDecision {
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
        let (dtx, mut drx) = mpsc::unbounded_channel();
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
            dtx.send(AgentInbound::AgentDecision {
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
        let (_dtx, mut drx) = mpsc::unbounded_channel();
        // A long script the runner should never finish because we cancel first.
        let script = (0..100)
            .map(|_| {
                act(Action::Click {
                    x: 0.5,
                    y: 0.5,
                    count: 1,
                })
            })
            .collect();
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
        let (_dtx, mut drx) = mpsc::unbounded_channel();
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
        let (_dtx, mut drx) = mpsc::unbounded_channel();
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
        let (_dtx, mut drx) = mpsc::unbounded_channel();
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
        let (_dtx, mut drx) = mpsc::unbounded_channel();
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
            },
        );
        let (_dtx, mut drx) = mpsc::unbounded_channel();
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
            },
        );
        let cancel = Cancel::new();
        cancel.cancel();
        let (_dtx, mut drx) = mpsc::unbounded_channel();
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
            },
        );
        let (_dtx, mut drx) = mpsc::unbounded_channel();
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
                needs_network: false,
            },
        }]);
        let mut runner = AgentRunner::new(brain, RecordingExecutor::default(), tx, || 0);
        let (_dtx, mut drx) = mpsc::unbounded_channel();
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
}
