//! Serde mirror of `@lilypad/protocol`'s agent schema
//! ([`packages/protocol/src/agent.ts`](../../../../../../packages/protocol/src/agent.ts)).
//! Agent messages ride the same peer-to-peer DataChannel as input, so — like
//! [`crate::input::protocol`] — these bounds are the only validation boundary a
//! malformed or hostile payload passes before this desktop acts on it. Field
//! names, enum variants (snake_case), and length caps match the zod schema
//! exactly so the wire format never drifts between the mobile app and here.

use serde::{Deserialize, Deserializer, Serialize};

const MAX_COMMAND_LEN: usize = 4 * 1024;
const MAX_SUMMARY_LEN: usize = 512;
const MAX_ID_LEN: usize = 128;

fn deserialize_bounded<'de, D>(deserializer: D, max_len: usize) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    if s.is_empty() {
        return Err(serde::de::Error::custom("string must not be empty"));
    }
    if s.len() > max_len {
        return Err(serde::de::Error::custom(format!(
            "string length {} exceeds max {max_len}",
            s.len()
        )));
    }
    Ok(s)
}

fn de_command<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded(d, MAX_COMMAND_LEN)
}
fn de_id<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded(d, MAX_ID_LEN)
}

/// Which executor tier backs a step. Ordered cheap → expensive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTier {
    Skill,
    Ax,
    Vision,
}

/// The deterministic security gate's verdict for a proposed action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolClass {
    Safe,
    Sensitive,
    Consequential,
    Forbidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Thinking,
    Action,
    Result,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Proposed,
    Held,
    Running,
    Done,
    Denied,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Completed,
    Stopped,
    Denied,
    Failed,
}

/// Messages the phone sends to the desktop agent (phone → desktop).
// Variant names intentionally carry the `Agent` prefix to mirror the wire
// message kinds (`agent_command`, …) one-for-one.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentInbound {
    AgentCommand {
        #[serde(rename = "runId", deserialize_with = "de_id")]
        run_id: String,
        #[serde(deserialize_with = "de_command")]
        text: String,
        ts: u64,
    },
    AgentStop {
        #[serde(rename = "runId", deserialize_with = "de_id")]
        run_id: String,
        ts: u64,
    },
    AgentDecision {
        #[serde(rename = "runId", deserialize_with = "de_id")]
        run_id: String,
        #[serde(rename = "stepId", deserialize_with = "de_id")]
        step_id: String,
        approve: bool,
        ts: u64,
    },
}

impl AgentInbound {
    pub fn run_id(&self) -> &str {
        match self {
            AgentInbound::AgentCommand { run_id, .. }
            | AgentInbound::AgentStop { run_id, .. }
            | AgentInbound::AgentDecision { run_id, .. } => run_id,
        }
    }
}

/// Messages the desktop agent sends to the phone (desktop → phone). Built on
/// this side, so summaries are truncated at construction rather than rejected.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentOutbound {
    AgentStep {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "stepId")]
        step_id: String,
        step: StepKind,
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tier: Option<AgentTier>,
        #[serde(skip_serializing_if = "Option::is_none")]
        class: Option<ToolClass>,
        state: StepState,
        ts: u64,
    },
    AgentRunEnd {
        #[serde(rename = "runId")]
        run_id: String,
        outcome: RunOutcome,
        ts: u64,
    },
}

impl AgentOutbound {
    /// Build a step message, truncating the summary to the wire cap so an
    /// over-long model utterance can never produce an oversized frame.
    #[allow(clippy::too_many_arguments)]
    pub fn step(
        run_id: impl Into<String>,
        step_id: impl Into<String>,
        step: StepKind,
        summary: impl Into<String>,
        tier: Option<AgentTier>,
        class: Option<ToolClass>,
        state: StepState,
        ts: u64,
    ) -> Self {
        let mut summary = summary.into();
        if summary.len() > MAX_SUMMARY_LEN {
            summary.truncate(MAX_SUMMARY_LEN);
        }
        AgentOutbound::AgentStep {
            run_id: run_id.into(),
            step_id: step_id.into(),
            step,
            summary,
            tier,
            class,
            state,
            ts,
        }
    }

    pub fn run_end(run_id: impl Into<String>, outcome: RunOutcome, ts: u64) -> Self {
        AgentOutbound::AgentRunEnd {
            run_id: run_id.into(),
            outcome,
            ts,
        }
    }

    /// JSON for the DataChannel. Serialization of these owned types is
    /// infallible in practice; on the impossible error we emit an empty object
    /// rather than panic on the media path.
    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_command_with_camelcase_wire_fields() {
        let json = r#"{"kind":"agent_command","runId":"run-1","text":"open Safari","ts":5}"#;
        let msg: AgentInbound = serde_json::from_str(json).unwrap();
        match msg {
            AgentInbound::AgentCommand { run_id, text, ts } => {
                assert_eq!(run_id, "run-1");
                assert_eq!(text, "open Safari");
                assert_eq!(ts, 5);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn decodes_a_decision_with_camelcase_step_id() {
        let json = r#"{"kind":"agent_decision","runId":"r","stepId":"s-9","approve":false,"ts":1}"#;
        let msg: AgentInbound = serde_json::from_str(json).unwrap();
        assert_eq!(msg.run_id(), "r");
        match msg {
            AgentInbound::AgentDecision {
                step_id, approve, ..
            } => {
                assert_eq!(step_id, "s-9");
                assert!(!approve);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn rejects_empty_command_text() {
        let json = r#"{"kind":"agent_command","runId":"r","text":"","ts":1}"#;
        assert!(serde_json::from_str::<AgentInbound>(json).is_err());
    }

    #[test]
    fn rejects_oversized_command() {
        let big = "x".repeat(MAX_COMMAND_LEN + 1);
        let json = format!(r#"{{"kind":"agent_command","runId":"r","text":"{big}","ts":1}}"#);
        assert!(serde_json::from_str::<AgentInbound>(&json).is_err());
    }

    #[test]
    fn outbound_step_truncates_summary_to_cap() {
        let long = "y".repeat(MAX_SUMMARY_LEN + 50);
        let msg = AgentOutbound::step(
            "r",
            "s",
            StepKind::Action,
            long,
            Some(AgentTier::Ax),
            Some(ToolClass::Sensitive),
            StepState::Running,
            9,
        );
        let json = msg.encode();
        // The serialized summary is capped.
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["summary"].as_str().unwrap().len(), MAX_SUMMARY_LEN);
        assert_eq!(v["kind"], "agent_step");
        assert_eq!(v["tier"], "ax");
        assert_eq!(v["class"], "sensitive");
    }

    #[test]
    fn run_end_serializes_snake_case_outcome() {
        let json = AgentOutbound::run_end("r", RunOutcome::Completed, 1).encode();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["kind"], "agent_run_end");
        assert_eq!(v["outcome"], "completed");
    }
}
