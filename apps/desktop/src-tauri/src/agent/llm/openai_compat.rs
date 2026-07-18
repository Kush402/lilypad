//! OpenAI-compatible chat-completions provider — ONE adapter that covers every
//! service speaking the `/chat/completions` dialect: OpenAI itself, DeepSeek,
//! OpenRouter, Ollama, LM Studio, vLLM, Azure-style gateways, and any custom
//! HTTP endpoint. Base URL + key + model are configuration; nothing else
//! differs at this layer.
//!
//! Mirrors `anthropic.rs`'s structure exactly: the wire mapping is two **pure**
//! functions ([`build_body`] / [`parse_reply`]) unit-tested against fixtures;
//! [`OpenAiCompatProvider::complete`] is the thin HTTP shell.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

use super::{AssistantReply, Block, ChatMessage, LlmProvider, ProviderCaps, Role, ToolCall, ToolSpec};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_MODEL: &str = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS: u32 = 1024;

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
}

impl OpenAiCompatConfig {
    pub fn new(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        OpenAiCompatConfig {
            api_key: api_key.into(),
            model: model.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
            max_tokens: DEFAULT_MAX_TOKENS,
            vision: false,
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
}

impl OpenAiCompatProvider {
    pub fn new(config: OpenAiCompatConfig) -> Self {
        OpenAiCompatProvider {
            client: reqwest::Client::new(),
            config,
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
                    Block::ToolUse { id, name, input } => tool_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": input.to_string() },
                    })),
                    Block::ToolResult { .. } => {} // never authored by the assistant
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
            // A user turn may mix tool results and text; each tool result must
            // be its own `role: "tool"` message in this dialect.
            let mut out = Vec::new();
            let mut text_parts = Vec::new();
            for block in &msg.blocks {
                match block {
                    Block::Text(t) => text_parts.push(t.clone()),
                    Block::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                        image_base64,
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
                        // image, so a screenshot rides in a following user
                        // message (image_url data URL) — the standard way to
                        // feed a vision model an image mid-conversation.
                        if let Some(png) = image_base64 {
                            out.push(json!({
                                "role": "user",
                                "content": [{
                                    "type": "image_url",
                                    "image_url": { "url": format!("data:image/png;base64,{png}") },
                                }],
                            }));
                        }
                    }
                    Block::ToolUse { .. } => {} // never authored by the user
                }
            }
            if !text_parts.is_empty() {
                out.push(json!({ "role": "user", "content": text_parts.join("\n") }));
            }
            out
        }
    }
}

/// Build the JSON request body. Pure.
pub fn build_body(
    system: &str,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    model: &str,
    max_tokens: u32,
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
    json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": msgs,
        "tools": tool_defs,
    })
}

/// Parse a chat-completions response into an [`AssistantReply`]. Pure. Takes
/// the first tool call (the agent acts one step at a time); `arguments`
/// arrives as a JSON string and malformed JSON is an error (never guessed at).
pub fn parse_reply(body: &Value) -> Result<AssistantReply> {
    let message = body
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"))
        .ok_or_else(|| anyhow!("response has no choices[0].message"))?;

    let text = message
        .get("content")
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let tool_call = match message
        .get("tool_calls")
        .and_then(|t| t.as_array())
        .and_then(|t| t.first())
    {
        Some(call) => {
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
            let args_raw = function
                .get("arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("{}");
            let input: Value = serde_json::from_str(args_raw)
                .with_context(|| format!("tool `{name}` arguments are not valid JSON"))?;
            Some(ToolCall {
                id: id.to_string(),
                name: name.to_string(),
                input,
            })
        }
        None => None,
    };

    Ok(AssistantReply { text, tool_call })
}

impl LlmProvider for OpenAiCompatProvider {
    async fn complete(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<AssistantReply> {
        let body = build_body(
            system,
            messages,
            tools,
            &self.config.model,
            self.config.max_tokens,
        );
        let url = format!(
            "{}/chat/completions",
            self.config.base_url.trim_end_matches('/')
        );
        let resp = self
            .client
            .post(url)
            .header("authorization", format!("Bearer {}", self.config.api_key))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("chat-completions request failed")?;

        let status = resp.status();
        let json: Value = resp
            .json()
            .await
            .context("chat-completions response was not JSON")?;
        if !status.is_success() {
            let msg = json
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
            return Err(anyhow!("provider API error ({status}): {msg}"));
        }
        parse_reply(&json)
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
    fn tool_results_become_role_tool_messages_with_error_prefix() {
        let msg = ChatMessage {
            role: Role::User,
            blocks: vec![Block::ToolResult {
                tool_use_id: "c1".into(),
                content: "no such app".into(),
                is_error: true,
                image_base64: None,
            }],
        };
        let body = build_body("s", &[msg], &[], "m", 10);
        let m = &body["messages"][1];
        assert_eq!(m["role"], "tool");
        assert_eq!(m["tool_call_id"], "c1");
        assert_eq!(m["content"], "ERROR: no such app");
    }

    #[test]
    fn tool_result_image_rides_in_a_following_user_message() {
        let msg = ChatMessage {
            role: Role::User,
            blocks: vec![Block::ToolResult {
                tool_use_id: "c1".into(),
                content: "screenshot".into(),
                is_error: false,
                image_base64: Some("QUJD".into()),
            }],
        };
        let body = build_body("s", &[msg], &[], "m", 10);
        // messages[0] is the system prompt; then the tool message; then the
        // image as a user message (the chat API can't put images in `tool`).
        assert_eq!(body["messages"][1]["role"], "tool");
        assert_eq!(body["messages"][2]["role"], "user");
        let img = &body["messages"][2]["content"][0];
        assert_eq!(img["type"], "image_url");
        assert_eq!(img["image_url"]["url"], "data:image/png;base64,QUJD");
    }

    #[test]
    fn parse_reply_extracts_first_tool_call_and_parses_arguments() {
        let body = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "Opening Safari.",
                    "tool_calls": [
                        { "id": "c1", "type": "function",
                          "function": { "name": "open_app", "arguments": "{\"name\":\"Safari\"}" } },
                        { "id": "c2", "type": "function",
                          "function": { "name": "finish", "arguments": "{}" } }
                    ]
                }
            }]
        });
        let reply = parse_reply(&body).unwrap();
        assert_eq!(reply.text.as_deref(), Some("Opening Safari."));
        let call = reply.tool_call.unwrap();
        assert_eq!(call.id, "c1"); // first call only
        assert_eq!(call.input["name"], "Safari");
    }

    #[test]
    fn parse_reply_handles_prose_only_and_rejects_bad_arguments() {
        let prose = json!({ "choices": [{ "message": { "content": "All done." } }] });
        let reply = parse_reply(&prose).unwrap();
        assert_eq!(reply.text.as_deref(), Some("All done."));
        assert!(reply.tool_call.is_none());

        let bad = json!({
            "choices": [{ "message": { "tool_calls": [
                { "id": "c1", "function": { "name": "open_app", "arguments": "{not json" } }
            ]}}]
        });
        assert!(parse_reply(&bad).is_err());

        assert!(parse_reply(&json!({})).is_err());
    }
}
