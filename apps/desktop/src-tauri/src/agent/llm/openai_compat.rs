//! OpenAI-compatible chat-completions provider — ONE adapter that covers every
//! service speaking the `/chat/completions` dialect: OpenAI itself, DeepSeek,
//! OpenRouter, Ollama, LM Studio, vLLM, Azure-style gateways, and any custom
//! HTTP endpoint. Base URL + key + model are configuration; nothing else
//! differs at this layer.
//!
//! Mirrors `anthropic.rs`'s structure exactly: the wire mapping is two **pure**
//! functions ([`build_body`] / [`parse_reply`]) unit-tested against fixtures;
//! [`OpenAiCompatProvider::complete`] is the thin HTTP shell.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

use std::sync::atomic::{AtomicBool, Ordering};

use super::{
    AssistantReply, Block, ChatMessage, Grid, Image, LlmProvider, ProviderCaps, Role, ToolCall,
    ToolSpec,
};

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_MODEL: &str = "gpt-4o-mini";
/// Room for a batch of actions with their reasoning. The old 1024 was sized
/// for one call per reply.
const DEFAULT_MAX_TOKENS: u32 = 4096;
/// Reasoning models spend completion tokens on thinking before they answer,
/// so the ceiling that means "about 4096 of answer" is higher.
const REASONING_MAX_TOKENS: u32 = 16384;

/// A stored grid name, as the setup check records it.
pub fn parse_grid(name: Option<&str>) -> Option<Grid> {
    match name {
        Some("pixels") => Some(Grid::Pixels),
        Some("thousand") => Some(Grid::Thousand),
        _ => None,
    }
}

/// The coordinate space a model family points in when asked about a
/// screenshot. Families trained to ground on a fixed 0–1000 grid answer in it
/// whatever the image size; asking them for pixels gets answers in the wrong
/// space. Everything else answers in the pixels it was shown.
pub fn grid_for_model(model: &str) -> Grid {
    // ponytail: a family table, refined per configuration by the setup check
    // (`probe::judge_pointing`); add families here as they are verified.
    let m = model.to_ascii_lowercase();
    let thousand = [
        "gemini",
        "qwen3-vl",
        "qwen3.5",
        "qwen-vl-max",
        "glm-4.5v",
        "glm-4.6v",
        "ui-tars",
    ];
    if thousand.iter().any(|family| m.contains(family)) {
        Grid::Thousand
    } else {
        Grid::Pixels
    }
}

/// Config for any chat-completions endpoint. `base_url` includes the version
/// prefix (e.g. `https://api.openai.com/v1`, `http://localhost:11434/v1`).
#[derive(Debug, Clone)]
pub struct OpenAiCompatConfig {
    pub api_key: String,
    pub model: String,
    pub base_url: String,
    pub max_tokens: u32,
    /// Whether the selected model accepts image input (gates tier-3 vision).
    pub vision: bool,
    /// The coordinate space the setup check saw this model point in, when it
    /// could tell. `None` uses the family's known convention.
    pub grid: Option<Grid>,
}

impl OpenAiCompatConfig {
    pub fn new(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        OpenAiCompatConfig {
            api_key: api_key.into(),
            model: model.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
            max_tokens: DEFAULT_MAX_TOKENS,
            vision: false,
            grid: None,
        }
    }

    /// Interim env config (settings UI + keychain is a later slice). Two ways
    /// in, so key-less local endpoints (Ollama, LM Studio) work too:
    ///   - `LILYPAD_OPENAI_API_KEY` set → hosted endpoint (base defaults to
    ///     OpenAI, override with `LILYPAD_OPENAI_BASE_URL`)
    ///   - only `LILYPAD_OPENAI_BASE_URL` set → local/keyless endpoint
    ///
    /// `LILYPAD_AGENT_MODEL` selects the model either way.
    pub fn from_env() -> Option<Self> {
        let api_key = std::env::var("LILYPAD_OPENAI_API_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let base_url = std::env::var("LILYPAD_OPENAI_BASE_URL")
            .ok()
            .filter(|s| !s.trim().is_empty());
        if api_key.is_none() && base_url.is_none() {
            return None;
        }
        let model = std::env::var("LILYPAD_AGENT_MODEL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
        // Keyless is only sensible against an explicitly-configured (local)
        // endpoint; hosted default + no key would just 401.
        let mut config = OpenAiCompatConfig::new(api_key.unwrap_or_else(|| "none".into()), model);
        if let Some(base) = base_url {
            config.base_url = base;
        }
        // Opt in to the vision tier for a vision-capable model (e.g. Gemini,
        // GPT-4o). Off by default — the endpoint zoo includes text-only models.
        config.vision = std::env::var("LILYPAD_AGENT_VISION")
            .map(|v| matches!(v.trim(), "1" | "true" | "yes"))
            .unwrap_or(false);
        Some(config)
    }
}

pub struct OpenAiCompatProvider {
    client: reqwest::Client,
    config: OpenAiCompatConfig,
    /// The endpoint refused `max_tokens` and asked for `max_completion_tokens`
    /// (newer OpenAI reasoning models do). Learned once per provider.
    completion_tokens: AtomicBool,
}

impl OpenAiCompatProvider {
    pub fn new(config: OpenAiCompatConfig) -> Self {
        // Bounded on purpose: an unbounded client lets a stalled provider hold
        // a step open forever (L-236).
        Self::with_client(config, super::provider_client())
    }

    /// Construct with an explicit client — the seam tests use to apply short
    /// deadlines against a stalling endpoint.
    pub fn with_client(config: OpenAiCompatConfig, client: reqwest::Client) -> Self {
        OpenAiCompatProvider {
            client,
            config,
            completion_tokens: AtomicBool::new(false),
        }
    }
}

/// Serialize the provider-agnostic thread into chat-completions messages.
/// Structural differences from the Anthropic dialect, handled here:
///   - tool calls ride ON the assistant message (`tool_calls`), with the
///     arguments as a JSON **string**;
///   - tool results are their own `role: "tool"` message keyed by
///     `tool_call_id`, with no error flag — errors are prefixed into the
///     content so the model still sees them.
fn message_to_json(msg: &ChatMessage) -> Vec<Value> {
    match msg.role {
        Role::Assistant => {
            let mut text_parts = Vec::new();
            let mut tool_calls = Vec::new();
            for block in &msg.blocks {
                match block {
                    Block::Text(t) => text_parts.push(t.clone()),
                    Block::ToolUse {
                        id,
                        name,
                        input,
                        extra,
                    } => {
                        let mut call = json!({
                            "id": id,
                            "type": "function",
                            "function": { "name": name, "arguments": input.to_string() },
                        });
                        // Echo back any opaque payload the endpoint attached to
                        // this call (e.g. a reasoning signature) — some
                        // endpoints hard-reject a replayed thread without it.
                        if let Some(e) = extra {
                            call["extra_content"] = e.clone();
                        }
                        tool_calls.push(call);
                    }
                    Block::ToolResult { .. } | Block::Image(_) => {} // never authored by the assistant
                }
            }
            let mut m = json!({ "role": "assistant" });
            m["content"] = if text_parts.is_empty() {
                Value::Null
            } else {
                Value::String(text_parts.join("\n"))
            };
            if !tool_calls.is_empty() {
                m["tool_calls"] = Value::Array(tool_calls);
            }
            vec![m]
        }
        Role::User => {
            // A user turn may mix tool results, text and images. Every tool
            // result must be its own `role: "tool"` message, and all of them
            // must come straight after the assistant message that made the
            // calls — a user message in between is rejected. So the tool
            // messages go first, and everything else follows in one user
            // message.
            let mut out = Vec::new();
            let mut parts: Vec<Value> = Vec::new();
            for block in &msg.blocks {
                match block {
                    Block::Text(t) => parts.push(json!({ "type": "text", "text": t })),
                    Block::Image(image) => parts.push(image_part(image)),
                    Block::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                        image,
                    } => {
                        let text = if *is_error {
                            format!("ERROR: {content}")
                        } else {
                            content.clone()
                        };
                        out.push(json!({
                            "role": "tool",
                            "tool_call_id": tool_use_id,
                            "content": text,
                        }));
                        // The chat-completions `tool` role can't carry an
                        // image, so a screenshot rides in the user message
                        // that follows — the standard way to feed a vision
                        // model an image mid-conversation.
                        if let Some(image) = image {
                            parts.push(image_part(image));
                        }
                    }
                    Block::ToolUse { .. } => {} // never authored by the user
                }
            }
            match parts.as_slice() {
                [] => {}
                // Text alone stays a plain string: some local servers accept
                // nothing else.
                _ if parts.iter().all(|p| p["type"] == "text") => {
                    let joined: Vec<&str> =
                        parts.iter().filter_map(|p| p["text"].as_str()).collect();
                    out.push(json!({ "role": "user", "content": joined.join("\n") }));
                }
                _ => out.push(json!({ "role": "user", "content": parts })),
            }
            out
        }
    }
}

fn image_part(image: &Image) -> Value {
    json!({
        "type": "image_url",
        "image_url": { "url": format!("data:{};base64,{}", image.media_type, image.data) },
    })
}

/// Build the JSON request body. Pure.
pub fn build_body(
    system: &str,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    model: &str,
    max_tokens: u32,
) -> Value {
    build_body_with(system, messages, tools, model, max_tokens, false)
}

/// Build the JSON request body, naming the output limit the way the endpoint
/// wants it. Pure.
pub fn build_body_with(
    system: &str,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    model: &str,
    max_tokens: u32,
    completion_tokens: bool,
) -> Value {
    let mut msgs: Vec<Value> = vec![json!({ "role": "system", "content": system })];
    for m in messages {
        msgs.extend(message_to_json(m));
    }
    let tool_defs: Vec<Value> = tools
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                },
            })
        })
        .collect();
    let mut body = json!({
        "model": model,
        "messages": msgs,
        "tools": tool_defs,
    });
    if completion_tokens {
        body["max_completion_tokens"] = json!(max_tokens.max(REASONING_MAX_TOKENS));
    } else {
        body["max_tokens"] = json!(max_tokens);
    }
    // No `parallel_tool_calls: false` any more: several calls in one reply
    // run as a batch and each is answered (see `LlmBrain`). Leaving the field
    // out is also what every local server understands.
    body
}

/// Did the endpoint refuse `max_tokens` and ask for `max_completion_tokens`?
fn wants_completion_tokens(failure: &super::http::ProviderFailure) -> bool {
    failure.status == Some(400) && failure.message.contains("max_completion_tokens")
}

/// Parse a chat-completions response into an [`AssistantReply`]. Pure.
///
/// Every tool call is returned, in order; the brain runs them as a batch and
/// answers each (L-269's rule, kept by answering rather than refusing).
/// `arguments` arrives as a JSON string; malformed JSON is an error the model
/// is told about, never guessed at.
pub fn parse_reply(body: &Value) -> Result<AssistantReply> {
    let choice = body
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .ok_or_else(|| anyhow!("response has no choices[0].message"))?;
    let message = choice
        .get("message")
        .ok_or_else(|| anyhow!("response has no choices[0].message"))?;

    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        // A reply cut off at the limit can end inside a call's arguments, and
        // a half-written action must never run (L-343: told, not fatal).
        return Err(super::Correctable(
            "your reply was cut off at the length limit before it finished. Say less, and ask \
             for fewer actions at a time."
                .into(),
        )
        .into());
    }

    let text = message
        .get("content")
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let mut tool_calls = Vec::new();
    for call in message
        .get("tool_calls")
        .and_then(|t| t.as_array())
        .into_iter()
        .flatten()
    {
        let id = call
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("tool call missing id"))?;
        let function = call
            .get("function")
            .ok_or_else(|| anyhow!("tool call missing function"))?;
        let name = function
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("tool call missing function.name"))?;
        let input: Value = match function.get("arguments") {
            // Some servers send the arguments as an object rather than a
            // string of JSON.
            Some(Value::Object(o)) => Value::Object(o.clone()),
            Some(Value::String(raw)) if raw.trim().is_empty() => json!({}),
            Some(Value::String(raw)) => serde_json::from_str(raw).map_err(|e| {
                super::Correctable(format!("tool `{name}` arguments are not valid JSON ({e})."))
            })?,
            _ => json!({}),
        };
        tool_calls.push(ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            input,
            // Preserve any provider-specific payload riding on the call
            // (e.g. `extra_content` carrying a reasoning signature) so
            // message_to_json can echo it back on the next turn.
            extra: call.get("extra_content").cloned(),
        });
    }

    Ok(AssistantReply { text, tool_calls })
}

impl LlmProvider for OpenAiCompatProvider {
    async fn complete(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<AssistantReply> {
        match self.send(system, messages, tools).await {
            Err(e)
                if !self.completion_tokens.load(Ordering::Relaxed)
                    && e.downcast_ref::<super::http::ProviderFailure>()
                        .is_some_and(wants_completion_tokens) =>
            {
                log::info!(
                    target: "lilypad::agent",
                    "endpoint wants max_completion_tokens; retrying with it"
                );
                self.completion_tokens.store(true, Ordering::Relaxed);
                self.send(system, messages, tools).await
            }
            other => other,
        }
    }

    fn caps(&self) -> ProviderCaps {
        ProviderCaps {
            vision: self.config.vision,
            tool_calling: true,
            json_mode: false,
            streaming: false,
            // Unknown endpoint zoo (local models included) — don't assume.
            long_context: false,
            computer_use: false,
            grid: self
                .config
                .grid
                .unwrap_or_else(|| grid_for_model(&self.config.model)),
        }
    }
}

impl OpenAiCompatProvider {
    async fn send(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<AssistantReply> {
        let body = build_body_with(
            system,
            messages,
            tools,
            &self.config.model,
            self.config.max_tokens,
            self.completion_tokens.load(Ordering::Relaxed),
        );
        let url = format!(
            "{}/chat/completions",
            self.config.base_url.trim_end_matches('/')
        );
        // Rate limits (429) and server errors (5xx) are transient — free-tier
        // rate windows clear within a minute, and failing the user's whole run
        // on the first one is far worse than a short wait. Retry with backoff;
        // request errors (other 4xx) fail immediately.
        let mut attempt: u32 = 0;
        loop {
            let resp = match self
                .client
                .post(&url)
                .header("authorization", format!("Bearer {}", self.config.api_key))
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
            {
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
    use crate::agent::llm::{base_tools, SYSTEM_PROMPT};

    fn user(text: &str) -> ChatMessage {
        ChatMessage {
            role: Role::User,
            blocks: vec![Block::Text(text.into())],
        }
    }

    fn png() -> Image {
        Image {
            data: "QUJD".into(),
            media_type: "image/png".into(),
            width: 4,
            height: 4,
        }
    }

    #[test]
    fn every_tool_call_is_returned_in_order() {
        // Was `two_tool_calls_are_refused_rather_than_silently_trimmed`
        // (L-269), then L-343 made the refusal correctable. Batches are now
        // run and every call answered, so nothing is trimmed and nothing is
        // refused.
        let body = serde_json::json!({
            "choices": [{ "message": { "tool_calls": [
                { "id": "a", "function": { "name": "open_app", "arguments": "{\"name\":\"Safari\"}" } },
                { "id": "b", "function": { "name": "open_url", "arguments": "{\"url\":\"https://apple.com\"}" } }
            ]}}]
        });
        let reply = parse_reply(&body).unwrap();
        let ids: Vec<&str> = reply.tool_calls.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
    }

    #[test]
    fn a_single_tool_call_still_parses() {
        let body = serde_json::json!({
            "choices": [{ "message": { "tool_calls": [
                { "id": "a", "function": { "name": "open_app", "arguments": "{\"name\":\"Safari\"}" } }
            ]}}]
        });
        let reply = parse_reply(&body).unwrap();
        assert_eq!(reply.tool_calls[0].name, "open_app");
    }

    #[test]
    fn arguments_sent_as_an_object_or_empty_are_accepted() {
        let body = serde_json::json!({
            "choices": [{ "message": { "tool_calls": [
                { "id": "a", "function": { "name": "open_app", "arguments": {"name": "Safari"} } },
                { "id": "b", "function": { "name": "screenshot", "arguments": "" } }
            ]}}]
        });
        let reply = parse_reply(&body).unwrap();
        assert_eq!(reply.tool_calls[0].input["name"], "Safari");
        assert_eq!(reply.tool_calls[1].input, json!({}));
    }

    #[test]
    fn a_reply_cut_off_at_the_length_limit_is_never_run() {
        let body = serde_json::json!({
            "choices": [{ "finish_reason": "length", "message": { "tool_calls": [
                { "id": "a", "function": { "name": "type", "arguments": "{\"text\":\"half" } }
            ]}}]
        });
        let err = parse_reply(&body).unwrap_err();
        assert!(err.is::<super::super::Correctable>(), "{err}");
    }

    #[test]
    fn the_request_allows_a_batch_and_names_the_limit_the_endpoint_wants() {
        let body = build_body(SYSTEM_PROMPT, &[user("t")], &base_tools(), "m", 512);
        assert!(body.get("parallel_tool_calls").is_none());
        assert_eq!(body["max_tokens"], 512);
        let body = build_body_with(SYSTEM_PROMPT, &[user("t")], &base_tools(), "m", 512, true);
        assert!(body.get("max_tokens").is_none());
        assert_eq!(body["max_completion_tokens"], REASONING_MAX_TOKENS);

        let asks = |msg: &str| {
            wants_completion_tokens(&super::super::http::ProviderFailure {
                kind: super::super::http::FailureKind::BadRequest,
                status: Some(400),
                message: msg.into(),
            })
        };
        assert!(asks("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."));
        assert!(!asks("Invalid model"));
    }

    #[test]
    fn grounding_families_point_on_the_thousand_grid() {
        assert_eq!(grid_for_model("google/gemini-3-flash"), Grid::Thousand);
        assert_eq!(grid_for_model("gemini-2.5-pro"), Grid::Thousand);
        assert_eq!(
            grid_for_model("qwen/qwen3-vl-235b-a22b-instruct"),
            Grid::Thousand
        );
        assert_eq!(grid_for_model("gpt-5.2"), Grid::Pixels);
        assert_eq!(grid_for_model("openai/gpt-4o-mini"), Grid::Pixels);
        assert_eq!(grid_for_model("llama3.2-vision"), Grid::Pixels);
    }

    #[test]
    fn build_body_prepends_system_and_shapes_tools_as_functions() {
        let body = build_body(
            SYSTEM_PROMPT,
            &[user("Task: open safari")],
            &base_tools(),
            "some-model",
            512,
        );
        assert_eq!(body["model"], "some-model");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        let first_tool = &body["tools"][0];
        assert_eq!(first_tool["type"], "function");
        assert!(first_tool["function"]["parameters"].is_object());
    }

    #[test]
    fn assistant_tool_use_becomes_tool_calls_with_string_arguments() {
        let msg = ChatMessage {
            role: Role::Assistant,
            blocks: vec![
                Block::Text("Opening.".into()),
                Block::ToolUse {
                    id: "c1".into(),
                    name: "open_app".into(),
                    input: json!({ "name": "Safari" }),
                    extra: None,
                },
            ],
        };
        let body = build_body("s", &[msg], &[], "m", 10);
        let m = &body["messages"][1];
        assert_eq!(m["role"], "assistant");
        assert_eq!(m["content"], "Opening.");
        let call = &m["tool_calls"][0];
        assert_eq!(call["id"], "c1");
        assert_eq!(call["function"]["name"], "open_app");
        // arguments must be a STRING of JSON in this dialect
        let args: Value =
            serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["name"], "Safari");
    }

    #[test]
    fn provider_extra_payload_round_trips_on_tool_calls() {
        // Parse: an opaque `extra_content` riding on the tool call is captured…
        let resp = json!({
            "choices": [{ "message": { "role": "assistant", "tool_calls": [{
                "id": "c1", "type": "function",
                "extra_content": { "signature": "abc123" },
                "function": { "name": "open_app", "arguments": "{\"name\":\"Safari\"}" },
            }]}}]
        });
        let call = parse_reply(&resp).unwrap().tool_calls.remove(0);
        assert_eq!(call.extra, Some(json!({ "signature": "abc123" })));

        // …and build: it is echoed back verbatim when the turn is replayed
        // (some endpoints reject the thread without it).
        let msg = ChatMessage {
            role: Role::Assistant,
            blocks: vec![Block::ToolUse {
                id: call.id,
                name: call.name,
                input: call.input,
                extra: call.extra,
            }],
        };
        let body = build_body("s", &[msg], &[], "m", 10);
        let replayed = &body["messages"][1]["tool_calls"][0];
        assert_eq!(replayed["extra_content"], json!({ "signature": "abc123" }));
        // A call with no extra payload must not grow the key.
        let bare = ChatMessage {
            role: Role::Assistant,
            blocks: vec![Block::ToolUse {
                id: "c2".into(),
                name: "finish".into(),
                input: json!({}),
                extra: None,
            }],
        };
        let body = build_body("s", &[bare], &[], "m", 10);
        assert!(body["messages"][1]["tool_calls"][0]
            .get("extra_content")
            .is_none());
    }

    #[test]
    fn tool_results_become_role_tool_messages_with_error_prefix() {
        let msg = ChatMessage {
            role: Role::User,
            blocks: vec![Block::ToolResult {
                tool_use_id: "c1".into(),
                content: "no such app".into(),
                is_error: true,
                image: None,
            }],
        };
        let body = build_body("s", &[msg], &[], "m", 10);
        let m = &body["messages"][1];
        assert_eq!(m["role"], "tool");
        assert_eq!(m["tool_call_id"], "c1");
        assert_eq!(m["content"], "ERROR: no such app");
    }

    #[test]
    fn a_batch_answers_every_call_before_the_screenshot_follows() {
        // The dialect rejects a user message between the tool messages that
        // answer one assistant turn — so a screenshot on the second of three
        // results still goes after all three.
        let result = |id: &str, image: Option<Image>| Block::ToolResult {
            tool_use_id: id.into(),
            content: format!("result {id}"),
            is_error: image.is_none() && id == "c3",
            image,
        };
        let msg = ChatMessage {
            role: Role::User,
            blocks: vec![
                result("c1", None),
                result("c2", Some(png())),
                result("c3", None),
            ],
        };
        let body = build_body("s", &[msg], &[], "m", 10);
        let roles: Vec<&str> = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["system", "tool", "tool", "tool", "user"]);
        let img = &body["messages"][4]["content"][0];
        assert_eq!(img["type"], "image_url");
        assert_eq!(img["image_url"]["url"], "data:image/png;base64,QUJD");
    }

    #[test]
    fn a_first_look_carries_text_and_image_in_one_user_message() {
        let msg = ChatMessage {
            role: Role::User,
            blocks: vec![
                Block::Text("Task: x".into()),
                Block::Text("The screen now: …".into()),
                Block::Image(Image {
                    media_type: "image/jpeg".into(),
                    ..png()
                }),
            ],
        };
        let body = build_body("s", &[msg], &[], "m", 10);
        let content = &body["messages"][1]["content"];
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[2]["type"], "image_url");
        assert!(content[2]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn parse_reply_extracts_the_tool_call_and_parses_arguments() {
        let body = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "Opening Safari.",
                    "tool_calls": [
                        { "id": "c1", "type": "function",
                          "function": { "name": "open_app", "arguments": "{\"name\":\"Safari\"}" } }
                    ]
                }
            }]
        });
        let reply = parse_reply(&body).unwrap();
        assert_eq!(reply.text.as_deref(), Some("Opening Safari."));
        let call = &reply.tool_calls[0];
        assert_eq!(call.id, "c1");
        assert_eq!(call.input["name"], "Safari");
    }

    #[test]
    fn parse_reply_handles_prose_only_and_rejects_bad_arguments() {
        let prose = json!({ "choices": [{ "message": { "content": "All done." } }] });
        let reply = parse_reply(&prose).unwrap();
        assert_eq!(reply.text.as_deref(), Some("All done."));
        assert!(reply.tool_calls.is_empty());

        let bad = json!({
            "choices": [{ "message": { "tool_calls": [
                { "id": "c1", "function": { "name": "open_app", "arguments": "{not json" } }
            ]}}]
        });
        assert!(parse_reply(&bad).is_err());

        assert!(parse_reply(&json!({})).is_err());
    }
}
