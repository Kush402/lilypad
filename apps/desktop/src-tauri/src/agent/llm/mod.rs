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
pub mod store;

use anyhow::{anyhow, bail, Result};
use serde_json::json;

use crate::agent::runner::{Brain, Decision, Observation};
use crate::agent::security::ScriptLanguage;
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
        /// Opaque provider-specific payload that arrived WITH this tool call
        /// (e.g. a reasoning signature) and must be echoed back verbatim when
        /// the turn is replayed — some endpoints reject the thread without it.
        /// Never inspected here; only the owning adapter reads/writes it.
        extra: Option<serde_json::Value>,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
        /// Optional PNG screenshot (base64) attached to this tool result — the
        /// tier-3 vision observation. Providers that support image input
        /// render it; text-only paths ignore it.
        image_base64: Option<String>,
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
    /// Opaque provider round-trip payload (see [`Block::ToolUse::extra`]).
    pub extra: Option<serde_json::Value>,
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
    /// Env-var config (dev override). First match wins.
    pub fn from_env() -> Option<Self> {
        if let Some(c) = anthropic::AnthropicConfig::from_env() {
            return Some(ProviderChoice::Anthropic(c));
        }
        if let Some(c) = openai_compat::OpenAiCompatConfig::from_env() {
            return Some(ProviderChoice::OpenAiCompat(c));
        }
        None
    }

    /// Settings-file + keychain config (the production path).
    pub fn from_settings() -> Option<Self> {
        let settings = store::load_settings();
        let kind = settings.provider_kind.as_deref()?;
        let api_key = store::keychain_get(kind);
        match kind {
            "anthropic" => {
                let model = settings
                    .model
                    .unwrap_or_else(|| anthropic::DEFAULT_MODEL.to_string());
                let mut c = anthropic::AnthropicConfig::new(api_key?, model);
                if let Some(base) = settings.base_url {
                    c.base_url = base;
                }
                c.vision = settings.vision;
                Some(ProviderChoice::Anthropic(c))
            }
            "openai_compat" => {
                // Keyless is legitimate for local endpoints, but only when an
                // explicit base URL says where to go — the hosted default
                // without a key would just 401.
                if api_key.is_none() && settings.base_url.is_none() {
                    return None;
                }
                let model = settings
                    .model
                    .unwrap_or_else(|| openai_compat::DEFAULT_MODEL.to_string());
                let mut c = openai_compat::OpenAiCompatConfig::new(
                    api_key.unwrap_or_else(|| "none".into()),
                    model,
                );
                if let Some(base) = settings.base_url {
                    c.base_url = base;
                }
                c.vision = settings.vision;
                Some(ProviderChoice::OpenAiCompat(c))
            }
            _ => None,
        }
    }

    /// Full resolution: env (dev override) → settings+keychain → none.
    pub fn resolve() -> Option<Self> {
        Self::from_env().or_else(Self::from_settings)
    }
}

/// User-facing guidance when no provider is configured. Lives here (provider
/// land) so the engine never has to name a vendor.
pub const NOT_CONFIGURED_MESSAGE: &str = "No AI provider is configured on the desktop — \
open Lilypad's Setup window to add one (or set LILYPAD_ANTHROPIC_API_KEY / \
LILYPAD_OPENAI_API_KEY for a dev override).";

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

/// The full agent toolset for a provider with the given capabilities. The
/// vision tool (`take_screenshot`) is advertised ONLY when the model accepts
/// image input — offering it to a text-only model would invite a dead end.
/// Skills, AX, and sandbox tools are always available.
pub fn agent_tools(caps: ProviderCaps) -> Vec<ToolSpec> {
    let mut tools = base_tools();
    if caps.vision {
        tools.push(ToolSpec {
            name: "take_screenshot",
            description: "Capture the screen as an image to see content the accessibility tree \
                          can't expose (canvas, images, custom-drawn UI). Use only when \
                          read_ax_tree isn't enough — it's slower. After looking, act through \
                          the other tools.",
            input_schema: json!({ "type": "object", "properties": {} }),
        });
    }
    tools
}

/// Tools available to every provider (vision-independent). `finish` last.
fn base_tools() -> Vec<ToolSpec> {
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
            name: "open_file",
            description: "Open a file in its default application. The path must be inside the \
                          user's home folder (use ~/ or a path under it).",
            input_schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "File path under the home folder" } },
                "required": ["path"],
            }),
        },
        ToolSpec {
            name: "new_folder",
            description: "Create a folder (and any missing parents). The path must be inside the \
                          user's home folder.",
            input_schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Folder path under the home folder" } },
                "required": ["path"],
            }),
        },
        ToolSpec {
            name: "read_ax_tree",
            description: "Read the focused app's accessibility tree — the fast, reliable way to \
                          see what's on screen and what can be acted on. Each element is listed \
                          as [id] Role \"label\" = value, and actionable ones are marked \
                          {pressable}. Prefer this over vision. Read again after an action to \
                          see the updated state.",
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolSpec {
            name: "ax_press",
            description: "Press a pressable element by the [id] shown in the most recent \
                          read_ax_tree (a button, menu item, link, checkbox). Read the tree \
                          first to get ids.",
            input_schema: json!({
                "type": "object",
                "properties": { "id": { "type": "integer", "minimum": 0, "description": "Element id from read_ax_tree" } },
                "required": ["id"],
            }),
        },
        ToolSpec {
            name: "run_script",
            description: "Run a small script under a secure sandbox for computation or file \
                          work that no specific tool covers (e.g. compressing a folder, \
                          transforming files). The script runs with writes restricted to a \
                          scratch area, no network, and secrets unreadable, and ALWAYS \
                          requires the user's approval first. Prefer a specific tool when one \
                          fits. Print any result the user should see to stdout.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "language": { "type": "string", "enum": ["shell", "python"] },
                    "script": { "type": "string", "description": "The script source." },
                    "writable_paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Folders under the home directory the script must write \
                                        to besides the scratch area (e.g. an output folder). \
                                        Omit if the script only needs the scratch area."
                    },
                    "needs_network": {
                        "type": "boolean",
                        "description": "Set true only if the script must reach the network."
                    }
                },
                "required": ["language", "script"],
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
        "open_file" => {
            let path = field("path")?;
            Ok(Decision::Act {
                summary: format!("Open file {path}"),
                tier: AgentTier::Skill,
                action: Action::OpenFile { path },
            })
        }
        "new_folder" => {
            let path = field("path")?;
            Ok(Decision::Act {
                summary: format!("Create folder {path}"),
                tier: AgentTier::Skill,
                action: Action::NewFolder { path },
            })
        }
        "read_ax_tree" => Ok(Decision::Act {
            summary: "Read the screen (accessibility tree)".to_string(),
            tier: AgentTier::Ax,
            action: Action::ReadAxTree,
        }),
        "take_screenshot" => Ok(Decision::Act {
            summary: "Look at the screen (screenshot)".to_string(),
            tier: AgentTier::Vision,
            action: Action::Screenshot,
        }),
        "ax_press" => {
            let id = call
                .input
                .get("id")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| anyhow!("ax_press missing integer field `id`"))?;
            Ok(Decision::Act {
                summary: format!("Press element [{id}]"),
                tier: AgentTier::Ax,
                action: Action::AxPress {
                    element_id: id as usize,
                },
            })
        }
        "run_script" => {
            let language = match call.input.get("language").and_then(|v| v.as_str()) {
                Some("shell") => ScriptLanguage::Shell,
                Some("python") => ScriptLanguage::Python,
                other => bail!("run_script: unknown or missing language {other:?}"),
            };
            let script = field("script")?;
            let writable_paths = call
                .input
                .get("writable_paths")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let needs_network = call
                .input
                .get("needs_network")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            Ok(Decision::Act {
                summary: format!("Run {} script", lang_label(language)),
                tier: AgentTier::Sandbox,
                action: Action::RunScript {
                    language,
                    script,
                    writable_paths,
                    needs_network,
                },
            })
        }
        "finish" => Ok(Decision::Finish {
            summary: field("summary").unwrap_or_else(|_| "Task complete".to_string()),
        }),
        other => Err(anyhow!("model called unknown tool `{other}`")),
    }
}

fn lang_label(language: ScriptLanguage) -> &'static str {
    match language {
        ScriptLanguage::Shell => "shell",
        ScriptLanguage::Python => "python",
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
        // Build the toolset from what THIS provider can do — vision tools only
        // for a vision-capable model (capability-based planning, no vendor
        // names).
        let tools = agent_tools(provider.caps());
        LlmBrain {
            provider,
            tools,
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
                        image_base64: obs.image_png_base64.clone(),
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
                extra: call.extra.clone(),
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
            extra: None,
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
    fn vision_tool_is_gated_on_capability() {
        let with_vision = agent_tools(ProviderCaps { vision: true, ..Default::default() });
        assert!(with_vision.iter().any(|t| t.name == "take_screenshot"));
        // AX/skill tools are always present, vision-independent.
        assert!(with_vision.iter().any(|t| t.name == "read_ax_tree"));

        let no_vision = agent_tools(ProviderCaps::default());
        assert!(!no_vision.iter().any(|t| t.name == "take_screenshot"));
        assert!(no_vision.iter().any(|t| t.name == "read_ax_tree"));
    }

    #[test]
    fn maps_take_screenshot_to_vision_tier() {
        let d = decision_from_tool_call(&ToolCall {
            id: "1".into(),
            name: "take_screenshot".into(),
            input: json!({}),
            extra: None,
        })
        .unwrap();
        assert!(matches!(
            d,
            Decision::Act { action: Action::Screenshot, tier: AgentTier::Vision, .. }
        ));
    }

    #[test]
    fn maps_run_script_to_sandbox_tier() {
        let d = decision_from_tool_call(&ToolCall {
            id: "1".into(),
            name: "run_script".into(),
            input: json!({
                "language": "python",
                "script": "print(1+1)",
                "writable_paths": ["~/Downloads"],
                "needs_network": true,
            }),
            extra: None,
        })
        .unwrap();
        match d {
            Decision::Act {
                action: Action::RunScript { language, writable_paths, needs_network, .. },
                tier: AgentTier::Sandbox,
                ..
            } => {
                assert_eq!(language, ScriptLanguage::Python);
                assert_eq!(writable_paths, vec!["~/Downloads".to_string()]);
                assert!(needs_network);
            }
            _ => panic!("wrong decision"),
        }
        // Unknown language is rejected, not guessed.
        assert!(decision_from_tool_call(&ToolCall {
            id: "1".into(),
            name: "run_script".into(),
            input: json!({ "language": "ruby", "script": "puts 1" }),
            extra: None,
        })
        .is_err());
    }

    #[test]
    fn maps_finish_and_rejects_unknown_and_missing_fields() {
        assert!(matches!(
            decision_from_tool_call(&ToolCall {
                id: "1".into(),
                name: "finish".into(),
                input: json!({ "summary": "done" }),
            extra: None,
            })
            .unwrap(),
            Decision::Finish { .. }
        ));
        assert!(decision_from_tool_call(&ToolCall {
            id: "1".into(),
            name: "frobnicate".into(),
            input: json!({}),
            extra: None,
        })
        .is_err());
        assert!(decision_from_tool_call(&ToolCall {
            id: "1".into(),
            name: "open_app".into(),
            input: json!({}), // missing `name`
            extra: None,
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
                extra: None,
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
