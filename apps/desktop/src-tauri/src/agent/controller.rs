//! `AgentController` — the session-side owner of the AI executor.
//!
//! It sits at the DataChannel demux point in the session runner: agent frames
//! (`agent_command`/`agent_stop`/`agent_decision`) are routed here; a live
//! command spawns an [`AgentRunner`] task whose step feed is forwarded back to
//! the phone over the same reliable input channel. Any *human* input frame
//! during a run triggers instant takeover (the run is cancelled).
//!
//! Following the codebase convention for connection-level glue (see
//! `input/worker.rs`: "the thin, deliberately-untested glue; all real logic
//! lives in the unit-tested core"), the spawn/forward plumbing here is thin;
//! the load-bearing decisions are the pure, unit-tested [`authorize_command`]
//! and [`crate::agent::parse_inbound`], and the runner loop + gate they drive.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc::{channel, unbounded_channel, Sender};
use tokio::task::JoinHandle;

use crate::agent::llm::resolver::{ProviderResolver, Readiness};
use crate::agent::llm::{AnyProvider, NOT_CONFIGURED_MESSAGE};
use crate::agent::protocol::{
    AgentHandshakeState, AgentInbound, AgentOutbound, RunOutcome, StepKind, StepState,
    ASK_PROTOCOL_VERSION,
};
use crate::agent::runner::{AgentRunner, Cancel, DECISION_QUEUE_CAPACITY};
use crate::agent::{LlmBrain, SharedDisplay, TieredExecutor};
use crate::rtc::WebRtcPeer;

/// Real epoch millis for wire timestamps.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether a received `agent_command` may start a run, and if not, why. Pure —
/// the whole admission policy in one testable function.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandGate {
    /// Start the run.
    Run,
    /// Refuse: the session is not control-scoped (view-only).
    DenyNoControl,
    /// Refuse: no LLM provider is configured (no API key).
    DenyNoProvider,
}

/// Admission policy for a command. Control scope is required (M5.3 decision),
/// and a provider must be configured.
pub fn authorize_command(control_scoped: bool, provider_configured: bool) -> CommandGate {
    if !control_scoped {
        CommandGate::DenyNoControl
    } else if !provider_configured {
        CommandGate::DenyNoProvider
    } else {
        CommandGate::Run
    }
}

struct ActiveRun {
    run_id: String,
    cancel: Cancel,
    decisions_tx: Sender<AgentInbound>,
    task: JoinHandle<()>,
    _forwarder: JoinHandle<()>,
}

/// A superseded run, handed to its successor so the successor can wait for it
/// to actually stop before touching the Mac (L-252).
struct PriorRun {
    run_id: String,
    task: JoinHandle<()>,
}

/// How long a superseded run may take to stop before the new one refuses to
/// start.
///
/// Cancellation is cooperative and the runner checks it at every await point,
/// so the normal case is milliseconds. It cannot be instant: a synchronous
/// native call — an `AXUIElement` press, a display capture — runs to completion
/// inside the OS, and no async deadline can preempt it. Waiting is therefore
/// the only way to know the old run has stopped clicking.
const PRIOR_RUN_DRAIN_MS: u64 = 20_000;

/// How often a hello's follow-up checks whether the resolution landed, and how
/// many times before it gives up (L-285). Twenty seconds in total: longer than
/// a keychain read that is going to succeed, and short enough that a Mac with
/// a locked keychain is not carrying one task per hello indefinitely.
const HELLO_FOLLOW_UP_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);
const HELLO_FOLLOW_UP_LIMIT: u32 = 80;

pub struct AgentController {
    active: Option<ActiveRun>,
    // Task-owned lease survives replacement and drain timeouts.
    execution_lease: Arc<tokio::sync::Mutex<()>>,
    /// The display the session is sharing, handed to every run's executor so
    /// Ask can only ever look at the screen the phone is watching (L-230).
    /// Held here rather than passed per-run so a mid-run switch reaches the
    /// running executor.
    display: SharedDisplay,
    // Bounded for the lifetime of this session; a repeated command ID never
    // becomes a second execution, even after the original run ended.
    runs: HashMap<String, Arc<Mutex<Option<RunOutcome>>>>,
    /// Publishes the resolved provider from a background task, so the keychain
    /// is never read on this event path (L-271).
    provider: ProviderResolver,
}

// One Mac is the effectful resource. A reconnect can create a new controller
// while an old cancelled task is still draining, so session-local locks are
// insufficient. This is desktop execution ownership, not backend routing state.
static EXECUTION_LEASE: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();

impl Default for AgentController {
    fn default() -> Self {
        Self {
            active: None,
            execution_lease: Arc::clone(
                EXECUTION_LEASE.get_or_init(|| Arc::new(tokio::sync::Mutex::new(()))),
            ),
            display: SharedDisplay::default(),
            runs: HashMap::new(),
            provider: ProviderResolver::new(),
        }
    }
}

impl AgentController {
    pub fn new() -> Self {
        let controller = Self::default();
        // Start resolving now, while nobody is waiting: by the time a command
        // arrives the answer is usually already published.
        controller.provider.warm();
        controller
    }

    /// Point Ask's perception at the display the session now shares. Called
    /// from the same places that retarget input, for the same reason: a
    /// screenshot of an unshared monitor would go to the model provider.
    pub fn set_display(&mut self, display_id: Option<u32>) {
        if self.display.get() != display_id {
            // Retire old observations and approvals, not only the next capture.
            self.cancel_active();
        }
        self.display.set(display_id);
    }

    /// True while a run is in flight.
    pub fn is_running(&self) -> bool {
        self.active.as_ref().is_some_and(|a| !a.task.is_finished())
    }

    /// Route one demuxed agent frame. `control_scoped` reflects the current
    /// session grant; `peer` is used to spawn the run and send its feed back.
    pub fn handle_inbound(
        &mut self,
        inbound: AgentInbound,
        control_scoped: bool,
        peer: Option<Arc<WebRtcPeer>>,
    ) {
        match inbound {
            AgentInbound::AgentHello { run_id, .. } => {
                if let Some(peer) = peer {
                    // Disclosed from the same resolved snapshot execution will
                    // use (L-265). It used to be rebuilt from the settings file
                    // while `ProviderChoice::resolve` preferred an environment
                    // override, so a Mac with `LILYPAD_*` set told the phone one
                    // destination and sent the screen to another.
                    //
                    // The state is stated rather than inferred from whether a
                    // destination is present (L-285): "still checking",
                    // "nothing set up" and "the keychain would not open" are
                    // three different answers, and the phone needs to offer
                    // three different things.
                    let readiness = self.provider.peek();
                    let msg = Self::ready_frame(&run_id, &readiness);
                    let follow_up = matches!(readiness, Readiness::Unknown);
                    let resolver = self.provider.clone();
                    tokio::spawn(async move {
                        if peer.send_input_text(msg.encode()).await.is_err() {
                            return;
                        }
                        if follow_up {
                            // A resolution that had not finished is not an
                            // answer, and closing and reopening Ask was the
                            // undisclosed workaround for it. Publish the real
                            // one to the hello that asked (L-285).
                            Self::follow_up_when_resolved(run_id, resolver, peer).await;
                        }
                    });
                }
            }
            AgentInbound::AgentCommand {
                run_id,
                text,
                protocol_version,
                consent_revision,
                ..
            } => {
                if protocol_version != Some(ASK_PROTOCOL_VERSION) {
                    if let Some(peer) = peer {
                        Self::send_refusal(
                            &peer,
                            &run_id,
                            "Update Lilypad on your phone to use Ask's approval controls.",
                        );
                    }
                    return;
                }
                self.start_command(run_id, text, consent_revision, control_scoped, peer);
            }
            AgentInbound::AgentStop { run_id, .. } => {
                if self.active.as_ref().is_some_and(|a| a.run_id == run_id) {
                    self.cancel_active();
                }
                // A retry after a lost terminal frame receives the same
                // terminal outcome. An in-flight stop waits for actual cleanup.
                if let (Some(outcome), Some(peer)) = (
                    self.runs.get(&run_id).and_then(|r| *r.lock().unwrap()),
                    peer,
                ) {
                    let msg = AgentOutbound::run_end(&run_id, outcome, now_ms());
                    tokio::spawn(async move {
                        let _ = peer.send_input_text(msg.encode()).await;
                    });
                }
            }
            AgentInbound::AgentDecision { .. } => {
                if let Some(active) = &self.active {
                    // The runner filters stale decisions by (run,step); just
                    // forward. A closed channel means the run already ended.
                    //
                    // Bounded (L-248): the receiver is idle during a model call
                    // or a sandboxed script, so an unbounded queue let a phone
                    // that repeats a decision grow this process without limit.
                    // A run has one outstanding question, so a full queue means
                    // the frames are duplicates — dropping one loses nothing and
                    // is visible in the log, unlike buffering it forever.
                    if let Err(e) = active.decisions_tx.try_send(inbound) {
                        log::warn!(
                            target: "lilypad::agent",
                            "dropping agent decision for run {}: {e}", active.run_id
                        );
                    }
                }
            }
        }
    }

    /// Instant human takeover — any real input frame during a run cancels it.
    pub fn on_human_input(&mut self) {
        if self.active.is_some() {
            log::info!(target: "lilypad::agent", "human input during agent run — taking over, cancelling");
            self.cancel_active();
        }
    }

    /// Cancel the active run, retaining its identity while the task drains.
    pub fn cancel_active(&mut self) {
        if let Some(active) = &self.active {
            active.cancel.cancel();
        }
    }

    /// Cancel the active run and take ownership of its handles, so the caller
    /// can wait for it to actually stop.
    ///
    /// The old code cancelled and then dropped `ActiveRun`, which drops the
    /// `JoinHandle` — and a dropped tokio `JoinHandle` does not stop the task,
    /// it detaches it. Cancellation is a *request*; between the request and the
    /// task noticing, the superseded run can still be mid-`AXPress` or mid-
    /// script. Replacing `self.active` immediately meant two runners could be
    /// acting on the same Mac at once, each believing it was the only one.
    fn supersede_active(&mut self) -> Option<PriorRun> {
        let active = self.active.take()?;
        active.cancel.cancel();
        // The forwarder handle is deliberately dropped, not aborted: the old
        // run still has terminal frames to send, and dropping a `JoinHandle`
        // detaches rather than stops. It ends by itself when the run's sender
        // is dropped.
        Some(PriorRun {
            run_id: active.run_id,
            task: active.task,
        })
    }

    fn start_command(
        &mut self,
        run_id: String,
        text: String,
        consent_revision: Option<String>,
        control_scoped: bool,
        peer: Option<Arc<WebRtcPeer>>,
    ) {
        if let Some(previous) = self.runs.get(&run_id) {
            if let Some(peer) = peer {
                let msg = match *previous.lock().unwrap() {
                    Some(outcome) => AgentOutbound::run_end(&run_id, outcome, now_ms()),
                    None => AgentOutbound::step(
                        &run_id,
                        format!("{run_id}-accepted"),
                        StepKind::Thinking,
                        "Task already accepted",
                        None,
                        None,
                        StepState::Running,
                        now_ms(),
                    ),
                };
                tokio::spawn(async move {
                    let _ = peer.send_input_text(msg.encode()).await;
                });
            }
            return;
        }
        if self.runs.len() >= 128 {
            if let Some(peer) = peer {
                Self::send_refusal(
                    &peer,
                    &run_id,
                    "This session reached its Ask task limit. Start a new session to continue.",
                );
            }
            return;
        }

        let Some(peer) = peer else {
            // No peer to send a feed back on — nothing we can usefully do.
            return;
        };

        // Non-blocking: whatever the last background resolution published.
        // A keychain that is locked or waiting on a dialog now shows up as a
        // sentence rather than as a session that stops answering (L-271).
        let readiness = self.provider.peek();
        let resolved = match &readiness {
            Readiness::Ready(resolved) => Some((**resolved).clone()),
            _ => None,
        };

        // The command has to be for the destination the person was told about
        // (L-265). A settings change between the disclosure and the command
        // would otherwise send the screen somewhere they never agreed to, and
        // nothing on either device would have said so.
        if let Some(resolved) = &resolved {
            let expected = &resolved.config.consent_revision;
            if consent_revision.as_deref() != Some(expected.as_str()) {
                Self::send_refusal(
                    &peer,
                    &run_id,
                    "This Mac's AI setup changed since your phone last checked. Open Ask again \
                     to see where requests would go, then send the task once more.",
                );
                return;
            }
        }

        let choice = resolved.as_ref().map(|r| r.choice.clone());
        match authorize_command(control_scoped, choice.is_some()) {
            CommandGate::DenyNoControl => {
                Self::send_refusal(
                    &peer,
                    &run_id,
                    "This session is view-only. Grant control to let the assistant act.",
                );
                return;
            }
            CommandGate::DenyNoProvider => {
                let reason = match readiness {
                    Readiness::Unavailable(why) => why,
                    // A resolution that has not finished is not "no provider".
                    // Saying so lets the person retry instead of going to
                    // settings that are already correct.
                    Readiness::Unknown => {
                        "Still checking this Mac's AI setup. Try again in a moment.".to_string()
                    }
                    _ => NOT_CONFIGURED_MESSAGE.to_string(),
                };
                Self::send_refusal(&peer, &run_id, &reason);
                return;
            }
            CommandGate::Run => {}
        }
        let choice = choice.expect("authorize_command guaranteed a provider");

        // A configuration this Mac can already say will not work is refused
        // here rather than at the provider (L-316). The person gets the same
        // sentence the setup screen would have shown, before anything on their
        // screen moves.
        if let Some(reason) = choice.refusal() {
            Self::send_refusal(&peer, &run_id, &reason);
            return;
        }

        // A new command supersedes any in-flight run — but only once this
        // command is admitted. Cancelling before the gate would let a refused
        // command (view-only session, no provider) kill a legitimate run.
        // The new run waits below for the old one to actually stop.
        let prior = self.supersede_active();
        let execution_lease = Arc::clone(&self.execution_lease);

        // Feed forwarder: runner step events → phone, over the reliable input
        // channel.
        let (steps_tx, mut steps_rx) = unbounded_channel::<AgentOutbound>();
        let peer_fwd = Arc::clone(&peer);
        let forwarder = tokio::spawn(async move {
            while let Some(msg) = steps_rx.recv().await {
                if let Err(e) = peer_fwd.send_input_text(msg.encode()).await {
                    log::warn!(target: "lilypad::agent", "failed to send agent step to phone: {e}");
                }
            }
        });

        let outcome_record = Arc::new(Mutex::new(None));
        self.runs
            .insert(run_id.clone(), Arc::clone(&outcome_record));
        let display = self.display.clone();
        let (decisions_tx, mut decisions_rx) = channel::<AgentInbound>(DECISION_QUEUE_CAPACITY);
        let cancel = Cancel::new();
        let run_cancel = cancel.clone();
        let run_id_task = run_id.clone();
        let task = tokio::spawn(async move {
            // Admission acknowledgment does not wait on the model, and does not
            // wait on the previous run either — the phone learns the task was
            // accepted immediately. This uses an existing step shape so older
            // mobile clients can also read it.
            let _ = steps_tx.send(AgentOutbound::step(
                &run_id_task,
                format!("{run_id_task}-accepted"),
                StepKind::Thinking,
                "Task accepted. Planning the next step…",
                None,
                None,
                StepState::Running,
                now_ms(),
            ));

            // The predecessor handle is insufficient: a timed-out successor
            // can finish while its detached predecessor still acts. All
            // generations must acquire the same task-owned lease.
            let _execution_guard = tokio::select! {
                biased;
                _ = run_cancel.wait() => {
                    let _ = steps_tx.send(AgentOutbound::run_end(&run_id_task, RunOutcome::Stopped, now_ms()));
                    *outcome_record.lock().unwrap() = Some(RunOutcome::Stopped);
                    return;
                }
                acquired = tokio::time::timeout(
                    std::time::Duration::from_millis(PRIOR_RUN_DRAIN_MS),
                    execution_lease.lock_owned(),
                ) => match acquired {
                    Ok(guard) => guard,
                    Err(_) => {
                        let _ = steps_tx.send(AgentOutbound::step(
                            &run_id_task, format!("{run_id_task}-busy"), StepKind::Error,
                            "A previous task is still stopping. No new work has started.",
                            None, None, StepState::Failed, now_ms(),
                        ));
                        let _ = steps_tx.send(AgentOutbound::run_end(&run_id_task, RunOutcome::Failed, now_ms()));
                        *outcome_record.lock().unwrap() = Some(RunOutcome::Failed);
                        return;
                    }
                },
            };

            // Exclusive ownership (L-252). The superseded run was *asked* to
            // stop; until its task ends it may still be inside a synchronous
            // native call. Starting now would put two runners on one Mac.
            if let Some(prior) = prior {
                let waited = tokio::time::timeout(
                    std::time::Duration::from_millis(PRIOR_RUN_DRAIN_MS),
                    prior.task,
                )
                .await;
                if waited.is_err() {
                    // Refuse rather than share the Mac. The old run is still
                    // cancelled and will end on its own; this one never starts,
                    // so no two runners ever act at the same time.
                    log::error!(
                        target: "lilypad::agent",
                        "previous agent run {} did not stop within {PRIOR_RUN_DRAIN_MS}ms — refusing to start {run_id_task}",
                        prior.run_id
                    );
                    let _ = steps_tx.send(AgentOutbound::step(
                        &run_id_task,
                        format!("{run_id_task}-0"),
                        StepKind::Error,
                        "The previous task is still stopping. Try again in a moment.",
                        None,
                        None,
                        StepState::Failed,
                        now_ms(),
                    ));
                    let _ = steps_tx.send(AgentOutbound::run_end(
                        &run_id_task,
                        RunOutcome::Failed,
                        now_ms(),
                    ));
                    *outcome_record.lock().unwrap() = Some(RunOutcome::Failed);
                    return;
                }
            }

            let brain = LlmBrain::new(AnyProvider::new(choice));
            let executor = match TieredExecutor::from_env(display) {
                Ok(e) => e,
                Err(e) => {
                    // Can only fail if HOME is unset — the sandbox tier needs a
                    // run-artifact root. End the run with a clear reason rather
                    // than acting with a half-built executor.
                    let _ = steps_tx.send(AgentOutbound::run_end(
                        &run_id_task,
                        RunOutcome::Failed,
                        now_ms(),
                    ));
                    *outcome_record.lock().unwrap() = Some(RunOutcome::Failed);
                    log::error!(target: "lilypad::agent", "agent executor init failed: {e}");
                    return;
                }
            };
            let mut runner = AgentRunner::new(brain, executor, steps_tx, now_ms);
            let outcome = runner
                .run(&run_id_task, &text, &mut decisions_rx, &run_cancel)
                .await;
            *outcome_record.lock().unwrap() = Some(outcome);
            log::info!(target: "lilypad::agent", "agent run {run_id_task} ended: {outcome:?}");
        });

        self.active = Some(ActiveRun {
            run_id,
            cancel,
            decisions_tx,
            task,
            _forwarder: forwarder,
        });
    }

    /// Emit a single error step + a `Denied` run-end directly (no run spawned).
    /// Best-effort, fire-and-forget: the phone may already be gone.
    /// One `agent_ready` describing exactly what the resolver knows (L-285).
    fn ready_frame(run_id: &str, readiness: &Readiness) -> AgentOutbound {
        let (state, destination) = match readiness {
            Readiness::Ready(resolved) => (
                AgentHandshakeState::Ready,
                Some(resolved.config.destination()),
            ),
            Readiness::Unknown => (AgentHandshakeState::Checking, None),
            Readiness::NotConfigured => (AgentHandshakeState::Unconfigured, None),
            Readiness::Unavailable(_) => (AgentHandshakeState::Unavailable, None),
        };
        AgentOutbound::AgentReady {
            run_id: run_id.to_string(),
            protocol_version: ASK_PROTOCOL_VERSION,
            state,
            destination,
            ts: now_ms(),
        }
    }

    /// Wait for the in-flight resolution and send its answer to the hello that
    /// asked for it.
    ///
    /// Bounded and cancellable: it gives up after `HELLO_FOLLOW_UP_LIMIT`
    /// polls and stops the moment the channel will not take a frame, so a
    /// keychain that never answers costs one sleeping task per hello and not a
    /// task that lives as long as the process. Giving up is safe because the
    /// phone keeps a Recheck action on screen for exactly this state — the
    /// follow-up saves a tap, it is not the only way out.
    async fn follow_up_when_resolved(
        run_id: String,
        resolver: ProviderResolver,
        peer: Arc<WebRtcPeer>,
    ) {
        for _ in 0..HELLO_FOLLOW_UP_LIMIT {
            tokio::time::sleep(HELLO_FOLLOW_UP_INTERVAL).await;
            let readiness = resolver.peek();
            if matches!(readiness, Readiness::Unknown) {
                continue;
            }
            let _ = peer
                .send_input_text(Self::ready_frame(&run_id, &readiness).encode())
                .await;
            return;
        }
    }

    fn send_refusal(peer: &Arc<WebRtcPeer>, run_id: &str, message: &str) {
        let step = AgentOutbound::step(
            run_id,
            format!("{run_id}-0"),
            StepKind::Error,
            message,
            None,
            None,
            StepState::Failed,
            now_ms(),
        );
        let end = AgentOutbound::run_end(run_id, RunOutcome::Denied, now_ms());
        let peer = Arc::clone(peer);
        tokio::spawn(async move {
            let _ = peer.send_input_text(step.encode()).await;
            let _ = peer.send_input_text(end.encode()).await;
        });
    }
}

impl Drop for AgentController {
    fn drop(&mut self) {
        // Dropping a Tokio JoinHandle detaches its task. Session cancellation
        // and error unwinding must revoke the run's authority as well.
        self.cancel_active();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L-285. Four situations, four answers. They used to arrive as one absent
    /// `destination`, and the phone could not tell a Mac that was still
    /// checking from one with nothing set up — so it offered neither a wait
    /// nor a way to fix it.
    #[test]
    fn every_resolver_state_is_disclosed_as_its_own_answer() {
        let cases = [
            (Readiness::Unknown, "checking"),
            (Readiness::NotConfigured, "unconfigured"),
            (Readiness::Unavailable("locked".into()), "unavailable"),
        ];
        for (readiness, want) in cases {
            let frame = AgentController::ready_frame("run-1", &readiness);
            let json: serde_json::Value = serde_json::from_str(&frame.encode()).unwrap();
            assert_eq!(json["state"], want, "for {readiness:?}");
            assert!(
                json.get("destination").is_none(),
                "{want} disclosed a destination it does not have"
            );
            assert_eq!(json["protocolVersion"], ASK_PROTOCOL_VERSION);
            assert_eq!(json["runId"], "run-1");
        }
    }

    #[test]
    fn authorize_requires_control_then_provider() {
        assert_eq!(authorize_command(false, false), CommandGate::DenyNoControl);
        assert_eq!(authorize_command(false, true), CommandGate::DenyNoControl);
        assert_eq!(authorize_command(true, false), CommandGate::DenyNoProvider);
        assert_eq!(authorize_command(true, true), CommandGate::Run);
    }

    #[tokio::test]
    async fn dropping_the_controller_cancels_its_detached_run() {
        let cancel = Cancel::new();
        let observer = cancel.clone();
        let (decisions_tx, _decisions_rx) = channel(DECISION_QUEUE_CAPACITY);
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move { task_cancel.wait().await });
        let mut controller = AgentController::new();
        controller.active = Some(ActiveRun {
            run_id: "drop-test".into(),
            cancel,
            decisions_tx,
            task,
            _forwarder: tokio::spawn(async {}),
        });
        drop(controller);
        assert!(
            observer.is_cancelled(),
            "the session's Ask run was detached alive"
        );
    }
    #[tokio::test]
    async fn superseding_a_run_hands_over_a_join_point_not_just_a_cancel_flag() {
        // L-252. The old code cancelled the previous run and dropped its
        // `ActiveRun`, which drops the `JoinHandle` — and dropping a tokio
        // handle detaches the task rather than stopping it. Cancellation is a
        // request; a run that is inside a synchronous `AXPress` has not seen it
        // yet. So the successor must receive something it can *wait on*, and
        // the moment that wait returns is the moment the Mac has one owner.
        let mut controller = AgentController::new();
        let cancel = Cancel::new();
        let (tx, _rx) = channel(DECISION_QUEUE_CAPACITY);
        let still_acting = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let flag = Arc::clone(&still_acting);
        let observed = cancel.clone();
        controller.active = Some(ActiveRun {
            run_id: "first".into(),
            cancel,
            decisions_tx: tx,
            task: tokio::spawn(async move {
                observed.wait().await;
                // Stands in for the tail of a real step: the run has been told
                // to stop but has not finished stopping.
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                flag.store(false, std::sync::atomic::Ordering::SeqCst);
            }),
            _forwarder: tokio::spawn(async {}),
        });

        let prior = controller.supersede_active().expect("a run was active");
        assert_eq!(prior.run_id, "first");
        assert!(controller.active.is_none());
        assert!(
            still_acting.load(std::sync::atomic::Ordering::SeqCst),
            "cancelling is not the same as having stopped"
        );

        prior.task.await.unwrap();
        assert!(
            !still_acting.load(std::sync::atomic::Ordering::SeqCst),
            "awaiting the prior run must mean it has actually stopped"
        );
    }

    #[tokio::test]
    async fn a_refused_command_does_not_kill_the_run_already_in_flight() {
        // Superseding happens after admission, not before: a view-only session
        // sending a command must not take down a legitimate run.
        let mut controller = AgentController::new();
        let cancel = Cancel::new();
        let (tx, _rx) = channel(DECISION_QUEUE_CAPACITY);
        controller.active = Some(ActiveRun {
            run_id: "live".into(),
            cancel: cancel.clone(),
            decisions_tx: tx,
            task: tokio::spawn(async {}),
            _forwarder: tokio::spawn(async {}),
        });
        controller.start_command("new".into(), "do a thing".into(), None, false, None);
        assert!(
            !cancel.is_cancelled(),
            "a command that was never admitted cancelled the live run"
        );
    }

    #[tokio::test]
    async fn the_decision_queue_is_bounded_and_drops_rather_than_growing() {
        // L-248. The receiver is idle during a model call, so an unbounded
        // queue turned a phone stuck in a retry loop into unbounded desktop
        // memory. A run has one outstanding question; past the cap the frames
        // are duplicates.
        let mut controller = AgentController::new();
        let (tx, _rx) = channel(DECISION_QUEUE_CAPACITY);
        controller.active = Some(ActiveRun {
            run_id: "r".into(),
            cancel: Cancel::new(),
            decisions_tx: tx,
            task: tokio::spawn(async {}),
            _forwarder: tokio::spawn(async {}),
        });
        for _ in 0..(DECISION_QUEUE_CAPACITY * 10) {
            controller.handle_inbound(
                AgentInbound::AgentDecision {
                    run_id: "r".into(),
                    step_id: "r-1".into(),
                    approve: true,
                    ts: 0,
                },
                true,
                None,
            );
        }
        let queued = controller.active.as_ref().unwrap().decisions_tx.capacity();
        assert_eq!(
            queued, 0,
            "the queue should be full, not grown: {queued} slots free"
        );
    }

    #[tokio::test]
    async fn a_replayed_run_id_does_not_cancel_the_current_run_or_restart_work() {
        let mut controller = AgentController::new();
        let cancel = Cancel::new();
        let (tx, _rx) = channel(DECISION_QUEUE_CAPACITY);
        controller.active = Some(ActiveRun {
            run_id: "current".into(),
            cancel: cancel.clone(),
            decisions_tx: tx,
            task: tokio::spawn(async {}),
            _forwarder: tokio::spawn(async {}),
        });
        controller.runs.insert(
            "old".into(),
            Arc::new(Mutex::new(Some(RunOutcome::Completed))),
        );
        controller.start_command("old".into(), "execute again".into(), None, true, None);
        assert!(
            !cancel.is_cancelled(),
            "a replay must not supersede the live task"
        );
        assert_eq!(controller.runs.len(), 1);
    }

    #[tokio::test]
    async fn switching_the_shared_display_cancels_the_old_observation_context() {
        let mut controller = AgentController::new();
        let cancel = Cancel::new();
        let (tx, _rx) = channel(DECISION_QUEUE_CAPACITY);
        controller.active = Some(ActiveRun {
            run_id: "current".into(),
            cancel: cancel.clone(),
            decisions_tx: tx,
            task: tokio::spawn(async {}),
            _forwarder: tokio::spawn(async {}),
        });
        controller.set_display(Some(7));
        assert!(cancel.is_cancelled());
        assert_eq!(controller.display.get(), Some(7));
    }
    #[tokio::test]
    async fn a_timed_out_successor_cannot_forget_the_original_execution_owner() {
        let controller = AgentController::default();
        let owner = controller.execution_lease.clone().lock_owned().await;
        let second = tokio::time::timeout(
            std::time::Duration::from_millis(10),
            controller.execution_lease.clone().lock_owned(),
        )
        .await;
        assert!(second.is_err());
        // Reconnecting cannot create a second execution owner either.
        let reconnected = AgentController::default();
        assert!(reconnected.execution_lease.try_lock().is_err());
        // A third generation still cannot enter after the second has ended.
        assert!(controller.execution_lease.try_lock().is_err());
        drop(owner);
        assert!(controller.execution_lease.try_lock().is_ok());
    }
}
