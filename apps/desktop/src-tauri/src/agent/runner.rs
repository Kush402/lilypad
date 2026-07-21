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
    /// The task is complete.
    Finish { summary: String },
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
}

impl Default for RunnerConfig {
    fn default() -> Self {
        RunnerConfig { max_steps: 40 }
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

        for _ in 0..self.config.max_steps {
            if cancel.is_cancelled() {
                return self.end(run_id, RunOutcome::Stopped);
            }

            // ── decide ──
            let decision = tokio::select! {
                biased;
                _ = cancel.wait() => return self.end(run_id, RunOutcome::Stopped),
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
                Decision::Finish { summary } => {
                    let sid = self.next_step_id(run_id);
                    self.emit(
                        run_id,
                        &sid,
                        StepKind::Result,
                        summary,
                        None,
                        None,
                        StepState::Done,
                    );
                    return self.end(run_id, RunOutcome::Completed);
                }
                Decision::Act {
                    summary,
                    tier,
                    action,
                } => (summary, tier, action),
            };

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
                    self.emit(
                        run_id,
                        &step_id,
                        StepKind::Action,
                        summary.clone(),
                        Some(tier),
                        Some(class),
                        StepState::Held,
                    );
                    let approved = tokio::select! {
                        biased;
                        _ = cancel.wait() => {
                            self.emit(run_id, &step_id, StepKind::Action, summary.clone(),
                                Some(tier), Some(class), StepState::Denied);
                            return self.end(run_id, RunOutcome::Stopped);
                        }
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
}
