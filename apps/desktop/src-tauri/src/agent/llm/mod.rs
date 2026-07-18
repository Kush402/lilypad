//! The LLM layer — a **provider-agnostic** reasoning backend for the agent.
//!
//! Per the M5.3 decision "all LLMs supported", the runner never talks to a
//! vendor SDK directly. It talks to [`Brain`](crate::agent::runner::Brain),
//! implemented here by [`LlmBrain`] over a pluggable [`LlmProvider`] trait. A
//! provider owns only the wire mapping for one API; [`LlmBrain`] owns the
//! provider-independent conversation state and the tool ⇄ [`Decision`]
//! translation, so adding a provider is one file, not a re-plumb.
//!
//! Tool-calling is the interface: the model is handed a small set of tools
//! (tier-1 skills + `finish` in this slice; AX/vision tools land in later
//! slices) and MUST act by calling one. Each call maps to exactly one
//! [`Decision`]; the executed action's [`Observation`] is fed back as the
//! tool's result on the next turn.

pub mod anthropic;
pub mod openai_compat;

use anyhow::{anyhow, Result};
use serde_json::json;

use crate::agent::runner::{Brain, Decision, Observation};
use crate::agent::{Action, AgentTier};

/// What a configured provider+model combination can actually do — as
/// implemented by OUR adapter, not as marketed by the vendor. The planner and
/// capability resolver consume these; provider NAMES never leave this module
/// (enforced by the `engine_is_provider_blind` tripwire in `agent/mod.rs`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProviderCaps {
    /// Model accepts image input — gates tier-3 (vision) routing.
    pub vision: bool,
    /// Native tool/function calling (all current adapters require this).
    pub tool_calling: bool,
    /// Enforced JSON output mode, distinct from tool calling.
    pub json_mode: bool,
    /// Adapter streams tokens (none do yet — step feed granularity is the
    /// run loop, not tokens).
    pub streaming: bool,
    /// Comfortable with long observation transcripts (AX trees).
    pub long_context: bool,
    /// Vendor-native computer-use tooling available and wired.
    pub computer_use: bool,
}

/// Who authored a conversation turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

/// One content block within a message — the provider-agnostic superset of what
/// every tool-calling chat API needs.
#[derive(Debug, Clone)]
pub enum Block {
    Text(String),
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: Role,
    pub blocks: Vec<Block>,
}

impl ChatMessage {
    fn user_text(text: impl Into<String>) -> Self {
        ChatMessage {
            role: Role::User,
            blocks: vec![Block::Text(text.into())],
        }
    }
}

/// A tool advertised to the model. `input_schema` is JSON Schema.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: serde_json::Value,
}

/// One tool invocation the model chose.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// A model turn: optional prose plus (usually) one tool call.
#[derive(Debug, Clone, Default)]
pub struct AssistantReply {
    pub text: Option<String>,
    pub tool_call: Option<ToolCall>,
}

/// A pluggable model backend. Native async-fn-in-trait (no `async-trait`),
/// matching the runner's `Brain`/`Executor`.
pub trait LlmProvider {
    fn complete(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> impl std::future::Future<Output = Result<AssistantReply>> + Send;

    /// What this provider+model combination can do (see [`ProviderCaps`]).
    fn caps(&self) -> ProviderCaps;
}

/// The configured provider, resolved from settings/env. This enum — not any
/// concrete adapter — is the ONLY provider surface the engine (controller/
/// runner/executors) is allowed to touch.
pub enum ProviderChoice {
    Anthropic(anthropic::AnthropicConfig),
    OpenAiCompat(openai_compat::OpenAiCompatConfig),
}

impl ProviderChoice {
    /// Interim config source (settings UI + keychain is a later slice).
    /// First match wins; `None` keeps the agent inert.
    pub fn from_env() -> Option<Self> {
        if let Some(c) = anthropic::AnthropicConfig::from_env() {
            return Some(ProviderChoice::Anthropic(c));
        }
        if let Some(c) = openai_compat::OpenAiCompatConfig::from_env() {
            return Some(ProviderChoice::OpenAiCompat(c));
        }
        None
    }
}

/// User-facing guidance when no provider is configured. Lives here (provider
/// land) so the engine never has to name a vendor.
pub const NOT_CONFIGURED_MESSAGE: &str = "No AI provider is configured on the desktop \
(set LILYPAD_ANTHROPIC_API_KEY, or LILYPAD_OPENAI_API_KEY / LILYPAD_OPENAI_BASE_URL \
for any OpenAI-compatible endpoint).";

/// Dispatch wrapper so the engine can hold "whichever provider is configured"
/// without generics leaking into the controller.
pub enum AnyProvider {
    Anthropic(anthropic::AnthropicProvider),
    OpenAiCompat(openai_compat::OpenAiCompatProvider),
}

impl AnyProvider {
    pub fn new(choice: ProviderChoice) -> Self {
        match choice {
            ProviderChoice::Anthropic(c) => {
                AnyProvider::Anthropic(anthropic::AnthropicProvider::new(c))
            }
            ProviderChoice::OpenAiCompat(c) => {
                AnyProvider::OpenAiCompat(openai_compat::OpenAiCompatProvider::new(c))
            }
        }
    }
}

impl LlmProvider for AnyProvider {
    async fn complete(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<AssistantReply> {
        match self {
            AnyProvider::Anthropic(p) => p.complete(system, messages, tools).await,
            AnyProvider::OpenAiCompat(p) => p.complete(system, messages, tools).await,
        }
    }

    fn caps(&self) -> ProviderCaps {
        match self {
            AnyProvider::Anthropic(p) => p.caps(),
            AnyProvider::OpenAiCompat(p) => p.caps(),
        }
    }
}

/// The system prompt framing the agent's job and its tool-first contract.
pub const SYSTEM_PROMPT: &str = "\
You are Lilypad's on-device Mac operator. You complete the user's task by \
calling the provided tools one at a time. Prefer the most specific, \
lowest-risk tool. After each tool runs you receive its result; decide the \
next single step from there. Never claim a step succeeded before its result \
comes back. When the task is fully done, call `finish` with a short summary. \
Do not ask the user questions — act, and rely on the approval prompts for \
anything consequential.";

/// The tools available in this slice: tier-1 skills + `finish`. Later slices
/// extend this with AX-tree and vision tools.
pub fn tier1_tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "open_app",
            description: "Launch or focus a macOS application by its name, e.g. \"Safari\".",
            input_schema: json!({
                "type": "object",
                "properties": { "name": { "type": "string", "description": "Application name" } },
                "required": ["name"],
            }),
        },
        ToolSpec {
            name: "open_url",
            description: "Open a URL in the default browser.",
            input_schema: json!({
                "type": "object",
                "properties": { "url": { "type": "string", "description": "http(s) URL" } },
                "required": ["url"],
            }),
        },
        ToolSpec {
            name: "finish",
            description: "Call when the task is complete. Provide a one-line summary of what was done.",
            input_schema: json!({
                "type": "object",
                "properties": { "summary": { "type": "string" } },
                "required": ["summary"],
            }),
        },
    ]
}

/// Translate one tool call into a [`Decision`]. Pure — unit-tested against the
/// tool schemas without a model or a network. Unknown tools / missing fields
/// are an error the runner surfaces as a failed step.
pub fn decision_from_tool_call(call: &ToolCall) -> Result<Decision> {
    let field = |k: &str| -> Result<String> {
        call.input
            .get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("tool `{}` missing string field `{}`", call.name, k))
    };
    match call.name.as_str() {
        "open_app" => {
            let name = field("name")?;
            Ok(Decision::Act {
                summary: format!("Open {name}"),
                tier: AgentTier::Skill,
                action: Action::OpenApp { name },
            })
        }
        "open_url" => {
            let url = field("url")?;
            Ok(Decision::Act {
                summary: format!("Open {url}"),
                tier: AgentTier::Skill,
                action: Action::OpenUrl { url },
            })
        }
        "finish" => Ok(Decision::Finish {
            summary: field("summary").unwrap_or_else(|_| "Task complete".to_string()),
        }),
        other => Err(anyhow!("model called unknown tool `{other}`")),
    }
}

/// A [`Brain`] backed by any [`LlmProvider`]. Owns the conversation thread and
/// the tool ⇄ decision mapping; the provider owns only the wire call.
pub struct LlmBrain<P: LlmProvider> {
    provider: P,
    tools: Vec<ToolSpec>,
    system: String,
    messages: Vec<ChatMessage>,
    /// The tool_use id of the last proposed action, awaiting its result.
    pending_tool_use: Option<String>,
    /// How many `Observation`s from the runner's history we've already folded
    /// back as tool results — exactly one per prior action decision.
    consumed_observations: usize,
}

impl<P: LlmProvider> LlmBrain<P> {
    pub fn new(provider: P) -> Self {
        LlmBrain {
            provider,
            tools: tier1_tools(),
            system: SYSTEM_PROMPT.to_string(),
            messages: Vec::new(),
            pending_tool_use: None,
            consumed_observations: 0,
        }
    }
}

impl<P: LlmProvider + Send> Brain for LlmBrain<P> {
    async fn next(&mut self, task: &str, history: &[Observation]) -> Result<Decision> {
        // Seed the thread on the first turn.
        if self.messages.is_empty() {
            self.messages
                .push(ChatMessage::user_text(format!("Task: {task}")));
        }

        // Fold the result of our previously proposed action (if any) back into
        // the thread as the tool_result the model is waiting on. Exactly one
        // new observation appears per prior action decision.
        if let Some(id) = self.pending_tool_use.take() {
            if let Some(obs) = history.get(self.consumed_observations) {
                self.consumed_observations += 1;
                self.messages.push(ChatMessage {
                    role: Role::User,
                    blocks: vec![Block::ToolResult {
                        tool_use_id: id,
                        content: obs.summary.clone(),
                        is_error: !obs.ok,
                    }],
                });
            }
        }

        let reply = self
            .provider
            .complete(&self.system, &self.messages, &self.tools)
            .await?;

        // Record the assistant turn so the thread stays coherent across calls.
        let mut assistant_blocks = Vec::new();
        if let Some(text) = &reply.text {
            if !text.is_empty() {
                assistant_blocks.push(Block::Text(text.clone()));
            }
        }
        if let Some(call) = &reply.tool_call {
            assistant_blocks.push(Block::ToolUse {
                id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
            });
        }
        self.messages.push(ChatMessage {
            role: Role::Assistant,
            blocks: assistant_blocks,
        });

        match &reply.tool_call {
            Some(call) => {
                let decision = decision_from_tool_call(call)?;
                // Only actions produce an observation to await; `finish` ends.
                if matches!(decision, Decision::Act { .. }) {
                    self.pending_tool_use = Some(call.id.clone());
                }
                Ok(decision)
            }
            // A model that answers with prose instead of a tool call is treated
            // as finished — better than looping forever.
            None => Ok(Decision::Finish {
                summary: reply
                    .text
                    .unwrap_or_else(|| "Task complete".to_string()),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    #[test]
    fn maps_skill_tool_calls_to_actions() {
        let d = decision_from_tool_call(&ToolCall {
            id: "1".into(),
            name: "open_app".into(),
            input: json!({ "name": "Safari" }),
        })
        .unwrap();
        match d {
            Decision::Act {
                action: Action::OpenApp { name },
                tier: AgentTier::Skill,
                ..
            } => assert_eq!(name, "Safari"),
            _ => panic!("wrong decision"),
        }
    }

    #[test]
    fn maps_finish_and_rejects_unknown_and_missing_fields() {
        assert!(matches!(
            decision_from_tool_call(&ToolCall {
                id: "1".into(),
                name: "finish".into(),
                input: json!({ "summary": "done" }),
            })
            .unwrap(),
            Decision::Finish { .. }
        ));
        assert!(decision_from_tool_call(&ToolCall {
            id: "1".into(),
            name: "frobnicate".into(),
            input: json!({}),
        })
        .is_err());
        assert!(decision_from_tool_call(&ToolCall {
            id: "1".into(),
            name: "open_app".into(),
            input: json!({}), // missing `name`
        })
        .is_err());
    }

    /// A provider that replays scripted replies and records the message thread
    /// it was handed on each call (to assert tool_result plumbing).
    struct MockProvider {
        replies: Mutex<VecDeque<AssistantReply>>,
        seen_last_blocks: Mutex<Vec<Vec<String>>>,
    }
    impl MockProvider {
        fn new(replies: Vec<AssistantReply>) -> Self {
            MockProvider {
                replies: Mutex::new(replies.into()),
                seen_last_blocks: Mutex::new(Vec::new()),
            }
        }
    }
    impl LlmProvider for MockProvider {
        async fn complete(
            &self,
            _system: &str,
            messages: &[ChatMessage],
            _tools: &[ToolSpec],
        ) -> Result<AssistantReply> {
            // Record a compact description of the last message's blocks.
            let last = messages
                .last()
                .map(|m| {
                    m.blocks
                        .iter()
                        .map(|b| match b {
                            Block::Text(_) => "text".to_string(),
                            Block::ToolUse { name, .. } => format!("tool_use:{name}"),
                            Block::ToolResult { is_error, .. } => {
                                format!("tool_result:{}", if *is_error { "err" } else { "ok" })
                            }
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            self.seen_last_blocks.lock().unwrap().push(last);
            Ok(self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_default())
        }
        fn caps(&self) -> ProviderCaps {
            ProviderCaps {
                tool_calling: true,
                ..ProviderCaps::default()
            }
        }
    }

    fn tool_reply(id: &str, name: &str, input: serde_json::Value) -> AssistantReply {
        AssistantReply {
            text: None,
            tool_call: Some(ToolCall {
                id: id.into(),
                name: name.into(),
                input,
            }),
        }
    }

    #[tokio::test]
    async fn brain_proposes_action_then_finish_across_turns() {
        let provider = MockProvider::new(vec![
            tool_reply("t1", "open_app", json!({ "name": "Safari" })),
            tool_reply("t2", "finish", json!({ "summary": "opened Safari" })),
        ]);
        let mut brain = LlmBrain::new(provider);

        // Turn 1: no history yet → open_app.
        let d1 = brain.next("open safari", &[]).await.unwrap();
        assert!(matches!(
            d1,
            Decision::Act {
                action: Action::OpenApp { .. },
                ..
            }
        ));

        // Runner executed it and appended one observation; turn 2 → finish.
        let history = vec![Observation::ok("launched Safari")];
        let d2 = brain.next("open safari", &history).await.unwrap();
        assert!(matches!(d2, Decision::Finish { .. }));
    }

    #[tokio::test]
    async fn brain_feeds_prior_observation_back_as_tool_result() {
        let provider = MockProvider::new(vec![
            tool_reply("t1", "open_app", json!({ "name": "Nope" })),
            tool_reply("t2", "finish", json!({ "summary": "gave up" })),
        ]);
        let mut brain = LlmBrain::new(provider);

        brain.next("do it", &[]).await.unwrap();
        // The action failed; the runner appends a failing observation.
        let history = vec![Observation::fail("no such app: Nope")];
        brain.next("do it", &history).await.unwrap();

        // On the second complete() call, the last message handed to the
        // provider must be the error tool_result for t1.
        let seen = {
            let provider = &brain.provider;
            provider.seen_last_blocks.lock().unwrap().clone()
        };
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[1], vec!["tool_result:err".to_string()]);
    }

    #[tokio::test]
    async fn prose_only_reply_is_treated_as_finished() {
        let provider = MockProvider::new(vec![AssistantReply {
            text: Some("I think we're done here.".into()),
            tool_call: None,
        }]);
        let mut brain = LlmBrain::new(provider);
        let d = brain.next("task", &[]).await.unwrap();
        assert!(matches!(d, Decision::Finish { .. }));
    }
}
