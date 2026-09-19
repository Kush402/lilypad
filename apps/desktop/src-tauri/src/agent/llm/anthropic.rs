//! Anthropic Messages API provider — the first [`LlmProvider`] impl.
//!
//! The wire mapping is split into two **pure** functions, [`build_body`] and
//! [`parse_reply`], so the request shape and response parsing are unit-tested
//! against fixtures without a network. [`AnthropicProvider::complete`] is the
//! thin HTTP shell around them (exercised live on-device).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

use super::{
    AssistantReply, Block, ChatMessage, Grid, Image, LlmProvider, ProviderCaps, Role, ToolCall,
    ToolSpec,
};

const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
/// Room for a batch of actions with their reasoning. The old 1024 was sized
/// for one call per reply.
const DEFAULT_MAX_TOKENS: u32 = 4096;

/// Which of Anthropic's trained computer-use tools a request declares.
///
/// Claude is trained on these, and uses them more accurately than the same
/// actions declared as ordinary functions — so they are used whenever the
/// model and endpoint accept them, newest first, and each step down happens
/// only when an endpoint says no. `Off` is the universal toolset every other
/// provider gets, and it is always a working fallback: the member names and
/// arguments are the same, so the same decoder reads both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Native {
    /// `computer_toolset_20260801` — current models, no beta header.
    Toolset,
    /// `computer_20251124` behind its beta header — Opus 4.5–4.7, Sonnet 4.6.
    V20251124,
    /// `computer_20250124` behind its beta header — Claude 4 and 3.7.
    V20250124,
    Off,
}

impl Native {
    /// The best guess for a model id, before any endpoint has answered.
    pub fn for_model(model: &str) -> Native {
        let m = model.to_ascii_lowercase();
        let any = |needles: &[&str]| needles.iter().any(|n| m.contains(n));
        if any(&["opus-4-5", "opus-4-6", "opus-4-7", "sonnet-4-6"]) {
            Native::V20251124
        } else if any(&[
            "sonnet-4-5",
            "haiku-4-5",
            "opus-4-1",
            "opus-4-0",
            "opus-4-2025",
            "sonnet-4-0",
            "sonnet-4-2025",
            "3-7-sonnet",
        ]) {
            Native::V20250124
        } else if any(&[
            "claude-3-5",
            "claude-3-haiku",
            "claude-3-opus",
            "claude-3-sonnet",
        ]) {
            Native::Off
        } else {
            Native::Toolset
        }
    }

    /// The next thing to try after an endpoint rejected this one.
    fn fallback(self) -> Native {
        match self {
            Native::Toolset => Native::V20251124,
            Native::V20251124 => Native::V20250124,
            Native::V20250124 | Native::Off => Native::Off,
        }
    }

    fn beta(self) -> Option<&'static str> {
        match self {
            Native::V20251124 => Some("computer-use-2025-11-24"),
            Native::V20250124 => Some("computer-use-2025-01-24"),
            Native::Toolset | Native::Off => None,
        }
    }
}

/// What each model was last found to accept, so a run does not re-learn it on
/// its first request. Process-wide: a new run for the same model starts where
/// the last one ended.
fn learned() -> &'static Mutex<HashMap<String, Native>> {
    static LEARNED: OnceLock<Mutex<HashMap<String, Native>>> = OnceLock::new();
    LEARNED.get_or_init(Default::default)
}

/// The universal tools the native computer tool replaces. Everything else
/// (`read_screen`, `set_value`, `open_url`, `finish`, …) is still declared as
/// an ordinary function next to it.
const COMPUTER_MEMBERS: &[&str] = &[
    "screenshot",
    "zoom",
    "left_click",
    "right_click",
    "middle_click",
    "double_click",
    "triple_click",
    "left_click_drag",
    "mouse_move",
    "left_mouse_down",
    "left_mouse_up",
    "cursor_position",
    "scroll",
    "type",
    "key",
    "hold_key",
    "wait",
];

/// Marks a tool call as one of the native computer tool's members, so it is
/// replayed in whichever form the request that carries it declares.
const COMPUTER_MARK: &str = "computer";

fn is_computer_call(extra: &Option<Value>) -> bool {
    extra
        .as_ref()
        .and_then(|e| e.get(COMPUTER_MARK))
        .and_then(Value::as_bool)
        == Some(true)
}

/// Config for the Anthropic backend. `model` is caller-selected (settings);
/// `base_url` is overridable for tests/proxies.
#[derive(Debug, Clone)]
pub struct AnthropicConfig {
    pub api_key: String,
    pub model: String,
    pub base_url: String,
    pub max_tokens: u32,
    /// Whether the selected model accepts image input (gates tier-3 vision).
    pub vision: bool,
}

/// Default model for the agent when none is configured. A current,
/// computer-use-capable Claude (tier-3 vision lands in a later slice).
pub const DEFAULT_MODEL: &str = "claude-opus-4-8";

impl AnthropicConfig {
    pub fn new(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        AnthropicConfig {
            api_key: api_key.into(),
            model: model.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
            max_tokens: DEFAULT_MAX_TOKENS,
            vision: true,
        }
    }

    /// Interim key source for first-light testing (the proper path is the
    /// settings UI + OS secure store — a later slice). Reads
    /// `LILYPAD_ANTHROPIC_API_KEY` (required), `LILYPAD_AGENT_MODEL`
    /// (optional), and `LILYPAD_AGENT_BASE_URL` (optional). Returns `None`
    /// when no key is set, so the agent stays inert unless explicitly enabled.
    pub fn from_env() -> Option<Self> {
        let api_key = std::env::var("LILYPAD_ANTHROPIC_API_KEY").ok()?;
        if api_key.trim().is_empty() {
            return None;
        }
        let model = std::env::var("LILYPAD_AGENT_MODEL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
        let mut config = AnthropicConfig::new(api_key, model);
        if let Ok(base) = std::env::var("LILYPAD_AGENT_BASE_URL") {
            if !base.trim().is_empty() {
                config.base_url = base;
            }
        }
        Some(config)
    }
}

pub struct AnthropicProvider {
    client: reqwest::Client,
    config: AnthropicConfig,
}

impl AnthropicProvider {
    pub fn new(config: AnthropicConfig) -> Self {
        // Bounded on purpose: an unbounded client lets a stalled provider hold
        // a step open forever (L-236).
        Self::with_client(config, super::provider_client())
    }

    /// Construct with an explicit client — the seam tests use to apply short
    /// deadlines against a stalling endpoint.
    pub fn with_client(config: AnthropicConfig, client: reqwest::Client) -> Self {
        AnthropicProvider { client, config }
    }
}

fn role_str(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

fn image_json(image: &Image) -> Value {
    json!({
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": image.media_type,
            "data": image.data,
        },
    })
}

/// Serialize one block. `computer_ids` are the tool calls that were native
/// computer actions; how they are written depends on which native form this
/// request declares, not on the one they arrived under.
fn block_to_json(block: &Block, native: Native, computer_ids: &HashSet<String>) -> Value {
    match block {
        Block::Text(text) => json!({ "type": "text", "text": text }),
        Block::Image(image) => image_json(image),
        Block::ToolUse {
            id,
            name,
            input,
            extra,
        } => {
            let computer = is_computer_call(extra) || computer_ids.contains(id);
            match native {
                Native::Toolset if computer => json!({
                    "type": "tool_use",
                    "id": id,
                    "name": name,
                    "input": input,
                    "toolset_name": "computer",
                }),
                Native::V20251124 | Native::V20250124 if computer => {
                    // The single `computer` tool with an `action` argument.
                    let mut input = input.clone();
                    if let Some(obj) = input.as_object_mut() {
                        obj.insert("action".into(), json!(name));
                    }
                    json!({ "type": "tool_use", "id": id, "name": "computer", "input": input })
                }
                // `extra` is otherwise another dialect's round-trip payload —
                // not part of this wire format.
                _ => json!({ "type": "tool_use", "id": id, "name": name, "input": input }),
            }
        }
        Block::ToolResult {
            tool_use_id,
            content,
            is_error,
            image,
        } => {
            // With an image, the tool_result content is an array of blocks
            // (text + image); without one, a plain string. Anthropic accepts
            // both, and images inside tool_result are supported natively.
            let content_json = match image {
                Some(image) => json!([
                    { "type": "text", "text": content },
                    image_json(image),
                ]),
                None => json!(content),
            };
            let mut result = json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content_json,
                "is_error": is_error,
            });
            // A toolset member's result must name the toolset, or the request
            // is rejected.
            if native == Native::Toolset && computer_ids.contains(tool_use_id) {
                result["toolset_name"] = json!("computer");
            }
            result
        }
    }
}

/// The pixel size of the newest image in the thread, which the older native
/// tools must be told as the display size.
fn latest_image_size(messages: &[ChatMessage]) -> Option<(u32, u32)> {
    messages.iter().rev().find_map(|m| {
        m.blocks.iter().rev().find_map(|b| match b {
            Block::Image(i) | Block::ToolResult { image: Some(i), .. }
                if i.width > 0 && i.height > 0 =>
            {
                Some((i.width, i.height))
            }
            _ => None,
        })
    })
}

/// The tool declarations for a request: the universal toolset, with its
/// computer members replaced by the native tool when `native` asks for it.
fn tool_defs(tools: &[ToolSpec], native: Native, screen: Option<(u32, u32)>) -> Vec<Value> {
    let has_computer = tools
        .iter()
        .any(|t| COMPUTER_MEMBERS.contains(&t.name.as_str()));
    let native = if has_computer { native } else { Native::Off };
    let mut defs: Vec<Value> = tools
        .iter()
        .filter(|t| native == Native::Off || !COMPUTER_MEMBERS.contains(&t.name.as_str()))
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.input_schema,
            })
        })
        .collect();
    match (native, screen) {
        (Native::Toolset, _) => defs.push(json!({
            "type": "computer_toolset_20260801",
            "configs": {
                "zoom": { "enabled": true },
                "screenshot": { "enabled": true },
            },
        })),
        (Native::V20251124, Some((w, h))) => defs.push(json!({
            "type": "computer_20251124",
            "name": "computer",
            "display_width_px": w,
            "display_height_px": h,
            "enable_zoom": true,
        })),
        (Native::V20250124, Some((w, h))) => defs.push(json!({
            "type": "computer_20250124",
            "name": "computer",
            "display_width_px": w,
            "display_height_px": h,
        })),
        _ => {}
    }
    defs
}

/// The native form a request can actually use: the older tools need a
/// screen size, so before the first screenshot they fall back to functions.
fn effective_native(native: Native, tools: &[ToolSpec], messages: &[ChatMessage]) -> Native {
    let has_computer = tools
        .iter()
        .any(|t| COMPUTER_MEMBERS.contains(&t.name.as_str()));
    match native {
        _ if !has_computer => Native::Off,
        Native::V20251124 | Native::V20250124 if latest_image_size(messages).is_none() => {
            Native::Off
        }
        other => other,
    }
}

/// Mark the thread so the provider can serve the repeated part from its cache
/// (L-318).
///
/// An agent run sends the whole conversation again on every step: the system
/// prompt, every tool definition, and every prior action and result. Step
/// twenty re-sends nineteen steps' worth of text that has not changed since
/// step nineteen, so the input billed for a run grows with the square of its
/// length. A twenty-step run over a few screen readings is a large number
/// reached entirely by repetition.
///
/// Two breakpoints, which is what the shape of the request wants:
///
///   1. **The system prompt.** Tools are sent before it, so one breakpoint
///      here covers the tool definitions as well. This half never changes for
///      the life of a run — or between runs within the cache's lifetime.
///   2. **The end of the thread.** Rolling: what is marked on this request is
///      the prefix the *next* request reuses, which is every step so far.
///
/// Steps are seconds apart, well inside the cache's lifetime, so the second
/// breakpoint hits on every turn after the first.
fn cache_the_thread(body: &mut Value) {
    body["system"][0]["cache_control"] = json!({ "type": "ephemeral" });
    if let Some(last) = body
        .get_mut("messages")
        .and_then(|m| m.as_array_mut())
        .and_then(|m| m.last_mut())
        .and_then(|m| m.get_mut("content"))
        .and_then(|c| c.as_array_mut())
        .and_then(|c| c.last_mut())
    {
        last["cache_control"] = json!({ "type": "ephemeral" });
    }
}

/// Build the JSON request body with no native computer tool. Pure.
pub fn build_body(
    system: &str,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    model: &str,
    max_tokens: u32,
) -> Value {
    build_body_with(system, messages, tools, model, max_tokens, Native::Off)
}

/// Build the JSON request body, declaring `native` for the computer actions
/// when the thread allows it. Pure.
pub fn build_body_with(
    system: &str,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    model: &str,
    max_tokens: u32,
    native: Native,
) -> Value {
    let native = effective_native(native, tools, messages);
    // Every call this thread made to a native computer member, by id.
    let computer_ids: HashSet<String> = messages
        .iter()
        .flat_map(|m| m.blocks.iter())
        .filter_map(|b| match b {
            Block::ToolUse { id, extra, .. } if is_computer_call(extra) => Some(id.clone()),
            _ => None,
        })
        .collect();
    let msgs: Vec<Value> = messages
        .iter()
        .map(|m| {
            json!({
                "role": role_str(m.role),
                "content": m
                    .blocks
                    .iter()
                    .map(|b| block_to_json(b, native, &computer_ids))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    let defs = tool_defs(tools, native, latest_image_size(messages));
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        // An array, not a bare string, so `cache_the_thread` can mark it.
        "system": [{ "type": "text", "text": system }],
        "messages": msgs,
        "tools": defs,
    });
    cache_the_thread(&mut body);
    body
}

/// Parse a Messages API response into an [`AssistantReply`]. Pure.
///
/// Every `tool_use` block is returned, in order: the brain runs them as one
/// batch and answers each (L-269 is kept by answering, not by refusing). A
/// native computer action is normalized to the universal member name, and
/// marked so it can be replayed in native form.
pub fn parse_reply(body: &Value) -> Result<AssistantReply> {
    let content = body
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or_else(|| anyhow!("response has no `content` array"))?;

    if body.get("stop_reason").and_then(Value::as_str) == Some("max_tokens") {
        // Correctable, not terminal (L-343): a cut-off reply can end inside a
        // tool call's arguments, and a half-written action must never run.
        return Err(super::Correctable(
            "your reply was cut off at the length limit before it finished. Say less, and ask \
             for fewer actions at a time."
                .into(),
        )
        .into());
    }

    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    for block in content {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(t.to_string());
                }
            }
            Some("tool_use") => {
                let id = block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("tool_use block missing id"))?;
                let name = block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("tool_use block missing name"))?;
                let mut input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                let toolset = block.get("toolset_name").and_then(Value::as_str);
                let (name, extra) = if toolset == Some("computer") {
                    (name.to_string(), Some(json!({ COMPUTER_MARK: true })))
                } else if name == "computer" {
                    // The older single-tool form: the member is the `action`.
                    let action = input
                        .as_object_mut()
                        .and_then(|o| o.remove("action"))
                        .and_then(|a| a.as_str().map(str::to_string))
                        .ok_or_else(|| {
                            super::Correctable("the computer action is missing `action`".into())
                        })?;
                    (action, Some(json!({ COMPUTER_MARK: true })))
                } else {
                    (name.to_string(), None)
                };
                tool_calls.push(ToolCall {
                    id: id.to_string(),
                    name,
                    input,
                    extra,
                });
            }
            _ => {}
        }
    }

    let text = if text_parts.is_empty() {
        None
    } else {
        Some(text_parts.join("\n"))
    };
    Ok(AssistantReply { text, tool_calls })
}

/// Did the endpoint reject the native computer tool itself (so the next form
/// down may work), rather than something else about the request?
fn rejected_native(failure: &super::http::ProviderFailure) -> bool {
    if failure.status != Some(400) {
        return false;
    }
    let m = failure.message.to_ascii_lowercase();
    [
        "computer",
        "toolset",
        "beta",
        "tool type",
        "does not match any of the expected tags",
    ]
    .iter()
    .any(|needle| m.contains(needle))
}

impl AnthropicProvider {
    /// The native computer tool this model is currently believed to accept.
    fn native(&self) -> Native {
        if !self.config.vision {
            // No screenshots, no coordinates: the native tool has nothing to
            // point at.
            return Native::Off;
        }
        learned()
            .lock()
            .ok()
            .and_then(|l| l.get(&self.config.model).copied())
            .unwrap_or_else(|| Native::for_model(&self.config.model))
    }

    fn learn(&self, native: Native) {
        if let Ok(mut l) = learned().lock() {
            l.insert(self.config.model.clone(), native);
        }
    }
}

impl LlmProvider for AnthropicProvider {
    async fn complete(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<AssistantReply> {
        let mut native = self.native();
        loop {
            match self.send(system, messages, tools, native).await {
                Err(e)
                    if native != Native::Off
                        && e.downcast_ref::<super::http::ProviderFailure>()
                            .is_some_and(rejected_native) =>
                {
                    let next = native.fallback();
                    log::info!(
                        target: "lilypad::agent",
                        "endpoint rejected the {native:?} computer tool ({e}); trying {next:?}"
                    );
                    native = next;
                    self.learn(native);
                }
                other => return other,
            }
        }
    }

    fn caps(&self) -> ProviderCaps {
        ProviderCaps {
            vision: self.config.vision,
            tool_calling: true,
            json_mode: false,
            streaming: false,
            long_context: true,
            computer_use: self.native() != Native::Off,
            // Every Anthropic computer tool, and Claude generally, points in
            // the pixels of the image it was shown.
            grid: Grid::Pixels,
        }
    }
}

impl AnthropicProvider {
    async fn send(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        native: Native,
    ) -> Result<AssistantReply> {
        let body = build_body_with(
            system,
            messages,
            tools,
            &self.config.model,
            self.config.max_tokens,
            native,
        );
        let beta = effective_native(native, tools, messages).beta();
        let url = format!("{}/v1/messages", self.config.base_url.trim_end_matches('/'));
        // Same transient-error policy as the chat-completions adapter: retry
        // rate limits (429) and server errors (5xx, incl. 529 overloaded)
        // with backoff instead of failing the user's run on the first one.
        let mut attempt: u32 = 0;
        loop {
            let mut request = self
                .client
                .post(&url)
                .header("x-api-key", &self.config.api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .header("content-type", "application/json");
            if let Some(beta) = beta {
                request = request.header("anthropic-beta", beta);
            }
            let resp = match request.json(&body).send().await {
                Ok(resp) => resp,
                Err(err) => return Err(super::http::classify_transport(&err).into()),
            };

            // A redirect is refused rather than followed (L-284): the key and
            // the observation in the body would both go to the new origin.
            if resp.status().is_redirection() {
                let location = super::http::location_of(&resp);
                return Err(super::http::refused_redirect(
                    resp.status().as_u16(),
                    location.as_deref(),
                )
                .into());
            }
            // Status and headers first, body second, JSON last (L-275, L-276).
            let status = resp.status();
            let retry_after = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok());
            let raw = super::http::collect_bounded(resp).await?;
            if !status.is_success() {
                if super::is_retryable_status(status.as_u16()) && attempt < super::MAX_RETRIES {
                    let delay = super::retry_delay(attempt, retry_after);
                    attempt += 1;
                    log::warn!(target: "lilypad::agent",
                        "provider returned {status}; retrying in {delay:?} (attempt {attempt}/{})",
                        super::MAX_RETRIES);
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return Err(super::http::classify(status.as_u16(), &raw).into());
            }
            let json = super::http::parse_success(&raw)?;
            if let Some(usage) = super::usage_line(&json) {
                log::info!(target: "lilypad::agent", "model turn: {usage}");
            }
            return parse_reply(&json);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::llm::{agent_tools, base_tools, ProviderCaps, SYSTEM_PROMPT};

    fn user(text: &str) -> ChatMessage {
        ChatMessage {
            role: Role::User,
            blocks: vec![Block::Text(text.into())],
        }
    }

    fn screenshot(w: u32, h: u32) -> Image {
        Image {
            data: "QUJD".into(),
            media_type: "image/jpeg".into(),
            width: w,
            height: h,
        }
    }

    fn computer_tools() -> Vec<ToolSpec> {
        agent_tools(ProviderCaps {
            vision: true,
            tool_calling: true,
            ..Default::default()
        })
    }

    #[test]
    fn every_tool_use_block_is_returned_in_order() {
        // Was `two_tool_use_blocks_are_refused_rather_than_silently_trimmed`
        // (L-269). The brain now runs a reply's actions as a batch and answers
        // every one of them, which keeps L-269's rule — nothing the model
        // asked for goes unanswered — without refusing the reply.
        let body = serde_json::json!({ "content": [
            { "type": "tool_use", "id": "a", "name": "open_app", "input": {"name": "Safari"} },
            { "type": "tool_use", "id": "b", "name": "open_url", "input": {"url": "https://apple.com"} }
        ]});
        let reply = parse_reply(&body).unwrap();
        let names: Vec<&str> = reply.tool_calls.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["open_app", "open_url"]);
    }

    #[test]
    fn a_single_tool_use_block_still_parses() {
        let body = serde_json::json!({ "content": [
            { "type": "text", "text": "opening it" },
            { "type": "tool_use", "id": "a", "name": "open_app", "input": {"name": "Safari"} }
        ]});
        let reply = parse_reply(&body).unwrap();
        assert_eq!(reply.tool_calls[0].name, "open_app");
        assert_eq!(reply.text.as_deref(), Some("opening it"));
    }

    #[test]
    fn a_reply_cut_off_at_the_length_limit_is_never_run() {
        let body = serde_json::json!({
            "stop_reason": "max_tokens",
            "content": [{ "type": "tool_use", "id": "a", "name": "type", "input": {"text": "half a sen"} }]
        });
        let err = parse_reply(&body).unwrap_err();
        assert!(err.is::<crate::agent::llm::Correctable>(), "{err}");
        assert!(err.to_string().contains("cut off"));
    }

    #[test]
    fn the_request_allows_a_batch_of_actions() {
        let body = build_body(SYSTEM_PROMPT, &[user("t")], &base_tools(), "m", 512);
        assert!(body.get("tool_choice").is_none(), "{}", body["tool_choice"]);
    }

    #[test]
    fn current_models_get_the_toolset_older_ones_the_beta_tools() {
        assert_eq!(Native::for_model("claude-opus-4-8"), Native::Toolset);
        assert_eq!(Native::for_model("claude-opus-5"), Native::Toolset);
        assert_eq!(Native::for_model("claude-sonnet-5"), Native::Toolset);
        assert_eq!(Native::for_model("claude-opus-4-7"), Native::V20251124);
        assert_eq!(Native::for_model("claude-sonnet-4-6"), Native::V20251124);
        assert_eq!(
            Native::for_model("claude-sonnet-4-5-20250929"),
            Native::V20250124
        );
        assert_eq!(
            Native::for_model("claude-haiku-4-5-20251001"),
            Native::V20250124
        );
        assert_eq!(Native::for_model("claude-3-5-haiku-latest"), Native::Off);
        // Each rejection steps down one form, and the chain ends at the
        // functions every provider gets.
        assert_eq!(Native::Toolset.fallback(), Native::V20251124);
        assert_eq!(Native::V20251124.fallback(), Native::V20250124);
        assert_eq!(Native::V20250124.fallback(), Native::Off);
        assert_eq!(Native::Off.fallback(), Native::Off);
        assert_eq!(Native::V20251124.beta(), Some("computer-use-2025-11-24"));
        assert_eq!(Native::Toolset.beta(), None);
    }

    #[test]
    fn the_toolset_replaces_the_computer_members_and_keeps_the_rest() {
        let body = build_body_with(
            SYSTEM_PROMPT,
            &[user("t")],
            &computer_tools(),
            "claude-opus-5",
            4096,
            Native::Toolset,
        );
        let tools = body["tools"].as_array().unwrap();
        let toolset = tools
            .iter()
            .find(|t| t["type"] == "computer_toolset_20260801")
            .expect("the toolset is declared");
        assert_eq!(toolset["configs"]["zoom"]["enabled"], true);
        assert!(toolset.get("name").is_none(), "the toolset rejects `name`");
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        for member in COMPUTER_MEMBERS {
            assert!(!names.contains(member), "{member} declared twice");
        }
        for kept in [
            "read_screen",
            "set_value",
            "element_action",
            "open_url",
            "finish",
        ] {
            assert!(names.contains(&kept), "{kept} went missing");
        }
    }

    #[test]
    fn a_toolset_action_round_trips_with_its_toolset_name() {
        let reply = parse_reply(&serde_json::json!({ "content": [{
            "type": "tool_use", "id": "t1", "name": "left_click",
            "toolset_name": "computer", "input": { "coordinate": [10, 20] }
        }]}))
        .unwrap();
        let call = &reply.tool_calls[0];
        assert_eq!(call.name, "left_click");
        assert!(is_computer_call(&call.extra));

        let thread = vec![
            user("t"),
            ChatMessage {
                role: Role::Assistant,
                blocks: vec![Block::ToolUse {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    input: call.input.clone(),
                    extra: call.extra.clone(),
                }],
            },
            ChatMessage {
                role: Role::User,
                blocks: vec![Block::ToolResult {
                    tool_use_id: "t1".into(),
                    content: "OK".into(),
                    is_error: false,
                    image: Some(screenshot(1280, 800)),
                }],
            },
        ];
        let body = build_body_with("s", &thread, &computer_tools(), "m", 10, Native::Toolset);
        assert_eq!(
            body["messages"][1]["content"][0]["toolset_name"],
            "computer"
        );
        let result = &body["messages"][2]["content"][0];
        assert_eq!(result["toolset_name"], "computer");
        assert_eq!(result["content"][1]["source"]["media_type"], "image/jpeg");

        // Stepped down to the beta tool: the same call replays as `computer`
        // with its action, and the display size comes from the screenshot.
        let body = build_body_with("s", &thread, &computer_tools(), "m", 10, Native::V20251124);
        let replayed = &body["messages"][1]["content"][0];
        assert_eq!(replayed["name"], "computer");
        assert_eq!(replayed["input"]["action"], "left_click");
        assert!(body["messages"][2]["content"][0]
            .get("toolset_name")
            .is_none());
        let tool = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["type"] == "computer_20251124")
            .unwrap();
        assert_eq!(tool["display_width_px"], 1280);
        assert_eq!(tool["display_height_px"], 800);

        // Stepped all the way down: a plain function call again.
        let body = build_body_with("s", &thread, &computer_tools(), "m", 10, Native::Off);
        assert_eq!(body["messages"][1]["content"][0]["name"], "left_click");
    }

    #[test]
    fn the_older_computer_tool_is_read_as_its_action() {
        let reply = parse_reply(&serde_json::json!({ "content": [{
            "type": "tool_use", "id": "t1", "name": "computer",
            "input": { "action": "double_click", "coordinate": [5, 6] }
        }]}))
        .unwrap();
        let call = &reply.tool_calls[0];
        assert_eq!(call.name, "double_click");
        assert!(call.input.get("action").is_none());
        assert_eq!(call.input["coordinate"][0], 5);
    }

    #[test]
    fn a_beta_tool_waits_for_a_screen_size() {
        // Before any screenshot there is no display size to declare, so the
        // request uses functions rather than an invalid tool.
        let body = build_body_with(
            "s",
            &[user("t")],
            &computer_tools(),
            "m",
            10,
            Native::V20250124,
        );
        assert!(!body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["type"] == "computer_20250124"));
        assert_eq!(
            effective_native(Native::V20250124, &computer_tools(), &[user("t")]),
            Native::Off
        );
        // A model with no computer tools at all never declares one.
        assert_eq!(
            effective_native(Native::Toolset, &base_tools(), &[user("t")]),
            Native::Off
        );
    }

    #[test]
    fn only_a_rejection_of_the_tool_steps_down() {
        let fail = |status: u16, message: &str| super::super::http::ProviderFailure {
            kind: super::super::http::FailureKind::BadRequest,
            status: Some(status),
            message: message.into(),
        };
        assert!(rejected_native(&fail(
            400,
            "tools.9: Input tag 'computer_toolset_20260801' found using 'type' does not match any of the expected tags"
        )));
        assert!(rejected_native(&fail(
            400,
            "Unexpected value(s) `computer-use-2025-11-24` for the `anthropic-beta` header"
        )));
        assert!(!rejected_native(&fail(
            400,
            "messages: text content blocks must be non-empty"
        )));
        assert!(!rejected_native(&fail(401, "invalid x-api-key")));
    }

    /// L-318. An agent run re-sends the whole conversation on every step, so
    /// the input billed for a run grows with the square of its length unless
    /// the repeated part is cached.
    #[test]
    fn the_repeated_prefix_carries_cache_breakpoints() {
        let messages = vec![
            ChatMessage::user_text("Task: open a window"),
            ChatMessage {
                role: Role::Assistant,
                blocks: vec![Block::Text("thinking".into())],
            },
            ChatMessage {
                role: Role::User,
                blocks: vec![Block::ToolResult {
                    tool_use_id: "1".into(),
                    content: "ok".into(),
                    is_error: false,
                    image: None,
                }],
            },
        ];
        let body = build_body("be useful", &messages, &base_tools(), "claude-x", 512);

        // Tools are sent before the system prompt, so one breakpoint here
        // covers both halves of the static prefix.
        assert_eq!(
            body["system"][0]["cache_control"]["type"], "ephemeral",
            "the static prefix is not cached: {}",
            body["system"]
        );
        assert_eq!(body["system"][0]["text"], "be useful");

        // Rolling: what is marked now is the prefix the next step reuses.
        let last = body["messages"].as_array().unwrap().last().unwrap();
        let last_block = last["content"].as_array().unwrap().last().unwrap();
        assert_eq!(
            last_block["cache_control"]["type"], "ephemeral",
            "the conversation so far is not cached: {last}"
        );
        // Nothing else is marked — Anthropic allows only a few breakpoints.
        let marked = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|m| m["content"].as_array().unwrap())
            .filter(|b| !b["cache_control"].is_null())
            .count();
        assert_eq!(marked, 1, "more breakpoints than intended");
    }

    #[test]
    fn build_body_shapes_model_messages_and_tools() {
        let body = build_body(
            SYSTEM_PROMPT,
            &[user("Task: open safari")],
            &base_tools(),
            "claude-opus-4-8",
            512,
        );
        assert_eq!(body["model"], "claude-opus-4-8");
        assert_eq!(body["max_tokens"], 512);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"][0]["type"], "text");
        // Tools carry through with their JSON Schema.
        let names: Vec<&str> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"open_app"));
        assert!(names.contains(&"finish"));
    }

    #[test]
    fn build_body_serializes_tool_result_blocks() {
        let msg = ChatMessage {
            role: Role::User,
            blocks: vec![Block::ToolResult {
                tool_use_id: "t1".into(),
                content: "launched Safari".into(),
                is_error: false,
                image: None,
            }],
        };
        let body = build_body(SYSTEM_PROMPT, &[msg], &[], "m", 10);
        let block = &body["messages"][0]["content"][0];
        assert_eq!(block["type"], "tool_result");
        assert_eq!(block["tool_use_id"], "t1");
        assert_eq!(block["is_error"], false);
    }

    #[test]
    fn images_carry_their_own_media_type() {
        let msg = ChatMessage {
            role: Role::User,
            blocks: vec![
                Block::ToolResult {
                    tool_use_id: "t1".into(),
                    content: "screenshot".into(),
                    is_error: false,
                    image: Some(screenshot(10, 10)),
                },
                Block::Image(Image {
                    media_type: "image/png".into(),
                    ..screenshot(10, 10)
                }),
            ],
        };
        let body = build_body(SYSTEM_PROMPT, &[msg], &[], "m", 10);
        let content = &body["messages"][0]["content"][0]["content"];
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["media_type"], "image/jpeg");
        assert_eq!(content[1]["source"]["data"], "QUJD");
        let loose = &body["messages"][0]["content"][1];
        assert_eq!(loose["type"], "image");
        assert_eq!(loose["source"]["media_type"], "image/png");
    }

    #[test]
    fn parse_reply_extracts_the_tool_use_and_text() {
        let body = json!({
            "content": [
                { "type": "text", "text": "Opening Safari." },
                { "type": "tool_use", "id": "tu_1", "name": "open_app", "input": { "name": "Safari" } }
            ],
            "stop_reason": "tool_use"
        });
        let reply = parse_reply(&body).unwrap();
        assert_eq!(reply.text.as_deref(), Some("Opening Safari."));
        let call = &reply.tool_calls[0];
        assert_eq!(call.id, "tu_1");
        assert_eq!(call.name, "open_app");
        assert_eq!(call.input["name"], "Safari");
        assert!(call.extra.is_none());
    }

    #[test]
    fn parse_reply_handles_prose_only() {
        let body = json!({ "content": [ { "type": "text", "text": "All done." } ] });
        let reply = parse_reply(&body).unwrap();
        assert_eq!(reply.text.as_deref(), Some("All done."));
        assert!(reply.tool_calls.is_empty());
    }

    #[test]
    fn parse_reply_errors_on_malformed_content() {
        assert!(parse_reply(&json!({ "stop_reason": "end_turn" })).is_err());
    }
}
