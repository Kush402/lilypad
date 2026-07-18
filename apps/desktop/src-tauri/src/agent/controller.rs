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

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::task::JoinHandle;

use crate::agent::llm::anthropic::{AnthropicConfig, AnthropicProvider};
use crate::agent::protocol::{AgentInbound, AgentOutbound, RunOutcome, StepKind, StepState};
use crate::agent::runner::{AgentRunner, Cancel};
use crate::agent::{LlmBrain, SkillsExecutor};
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
    decisions_tx: UnboundedSender<AgentInbound>,
    _task: JoinHandle<()>,
    _forwarder: JoinHandle<()>,
}

#[derive(Default)]
pub struct AgentController {
    active: Option<ActiveRun>,
}

impl AgentController {
    pub fn new() -> Self {
        Self::default()
    }

    /// True while a run is in flight.
    pub fn is_running(&self) -> bool {
        self.active.is_some()
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
            AgentInbound::AgentCommand { run_id, text, .. } => {
                self.start_command(run_id, text, control_scoped, peer);
            }
            AgentInbound::AgentStop { run_id, .. } => {
                if self.active.as_ref().is_some_and(|a| a.run_id == run_id) {
                    self.cancel_active();
                }
            }
            AgentInbound::AgentDecision { .. } => {
                if let Some(active) = &self.active {
                    // The runner filters stale decisions by (run,step); just
                    // forward. A closed channel means the run already ended.
                    let _ = active.decisions_tx.send(inbound);
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

    /// Cancel and forget the active run (its task drains on its own).
    pub fn cancel_active(&mut self) {
        if let Some(active) = self.active.take() {
            active.cancel.cancel();
        }
    }

    fn cancel_active_if_any(&mut self) {
        if self.active.is_some() {
            self.cancel_active();
        }
    }

    fn start_command(
        &mut self,
        run_id: String,
        text: String,
        control_scoped: bool,
        peer: Option<Arc<WebRtcPeer>>,
    ) {
        // A new command supersedes any in-flight run.
        self.cancel_active_if_any();

        let Some(peer) = peer else {
            // No peer to send a feed back on — nothing we can usefully do.
            return;
        };

        let config = AnthropicConfig::from_env();
        match authorize_command(control_scoped, config.is_some()) {
            CommandGate::DenyNoControl => {
                Self::send_refusal(
                    &peer,
                    &run_id,
                    "This session is view-only — grant control to let the assistant act.",
                );
                return;
            }
            CommandGate::DenyNoProvider => {
                Self::send_refusal(
                    &peer,
                    &run_id,
                    "No AI provider is configured on the desktop (set LILYPAD_ANTHROPIC_API_KEY).",
                );
                return;
            }
            CommandGate::Run => {}
        }
        let config = config.expect("authorize_command guaranteed a provider");

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

        let (decisions_tx, mut decisions_rx) = unbounded_channel::<AgentInbound>();
        let cancel = Cancel::new();
        let run_cancel = cancel.clone();
        let run_id_task = run_id.clone();
        let task = tokio::spawn(async move {
            let brain = LlmBrain::new(AnthropicProvider::new(config));
            let executor = SkillsExecutor;
            let mut runner = AgentRunner::new(brain, executor, steps_tx, now_ms);
            let outcome = runner
                .run(&run_id_task, &text, &mut decisions_rx, &run_cancel)
                .await;
            log::info!(target: "lilypad::agent", "agent run {run_id_task} ended: {outcome:?}");
        });

        self.active = Some(ActiveRun {
            run_id,
            cancel,
            decisions_tx,
            _task: task,
            _forwarder: forwarder,
        });
    }

    /// Emit a single error step + a `Denied` run-end directly (no run spawned).
    /// Best-effort, fire-and-forget: the phone may already be gone.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_requires_control_then_provider() {
        assert_eq!(authorize_command(false, false), CommandGate::DenyNoControl);
        assert_eq!(authorize_command(false, true), CommandGate::DenyNoControl);
        assert_eq!(authorize_command(true, false), CommandGate::DenyNoProvider);
        assert_eq!(authorize_command(true, true), CommandGate::Run);
    }
}
