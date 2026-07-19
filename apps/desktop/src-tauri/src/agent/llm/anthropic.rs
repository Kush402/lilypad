//! Anthropic Messages API provider — the first [`LlmProvider`] impl.
//!
//! The wire mapping is split into two **pure** functions, [`build_body`] and
//! [`parse_reply`], so the request shape and response parsing are unit-tested
//! against fixtures without a network. [`AnthropicProvider::complete`] is the
//! thin HTTP shell around them (exercised live on-device).

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

use super::{AssistantReply, Block, ChatMessage, LlmProvider, ProviderCaps, Role, ToolCall, ToolSpec};

const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const DEFAULT_MAX_TOKENS: u32 = 1024;

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
        AnthropicProvider {
            client: reqwest::Client::new(),
            config,
        }
    }
}

fn role_str(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

fn block_to_json(block: &Block) -> Value {
    match block {
        Block::Text(text) => json!({ "type": "text", "text": text }),
        Block::ToolUse {
            id, name, input, ..
        } => {
            // `extra` is another dialect's round-trip payload — not part of
            // this wire format.
            json!({ "type": "tool_use", "id": id, "name": name, "input": input })
        }
        Block::ToolResult {
            tool_use_id,
            content,
            is_error,
            image_base64,
        } => {
            // With an image, the tool_result content is an array of blocks
            // (text + image); without one, a plain string. Anthropic accepts
            // both, and images inside tool_result are supported natively.
            let content_json = match image_base64 {
                Some(png) => json!([
                    { "type": "text", "text": content },
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": png,
                        },
                    },
                ]),
                None => json!(content),
            };
            json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content_json,
                "is_error": is_error,
            })
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
    let msgs: Vec<Value> = messages
        .iter()
        .map(|m| {
            json!({
                "role": role_str(m.role),
                "content": m.blocks.iter().map(block_to_json).collect::<Vec<_>>(),
            })
        })
        .collect();
    let tool_defs: Vec<Value> = tools
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.input_schema,
            })
        })
        .collect();
    json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": msgs,
        "tools": tool_defs,
    })
}

/// Parse a Messages API response into an [`AssistantReply`]. Pure. Takes the
/// first `tool_use` block (the agent acts one step at a time) and concatenates
/// any `text` blocks as the prose.
pub fn parse_reply(body: &Value) -> Result<AssistantReply> {
    let content = body
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or_else(|| anyhow!("response has no `content` array"))?;

    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_call: Option<ToolCall> = None;

    for block in content {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(t.to_string());
                }
            }
            Some("tool_use") if tool_call.is_none() => {
                let id = block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("tool_use block missing id"))?;
                let name = block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("tool_use block missing name"))?;
                let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                tool_call = Some(ToolCall {
                    id: id.to_string(),
                    name: name.to_string(),
                    input,
                    extra: None,
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
    Ok(AssistantReply { text, tool_call })
}

impl LlmProvider for AnthropicProvider {
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
        let url = format!("{}/v1/messages", self.config.base_url.trim_end_matches('/'));
        let resp = self
            .client
            .post(url)
            .header("x-api-key", &self.config.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("Anthropic request failed")?;

        let status = resp.status();
        let json: Value = resp
            .json()
            .await
            .context("Anthropic response was not JSON")?;
        if !status.is_success() {
            let msg = json
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
            return Err(anyhow!("Anthropic API error ({status}): {msg}"));
        }
        parse_reply(&json)
    }

    fn caps(&self) -> ProviderCaps {
        ProviderCaps {
            vision: self.config.vision,
            tool_calling: true,
            json_mode: false,
            streaming: false,
            long_context: true,
            // The vendor tool exists but this adapter hasn't wired it (tier-3
            // slice); advertising it before then would misroute the planner.
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
                image_base64: None,
            }],
        };
        let body = build_body(SYSTEM_PROMPT, &[msg], &[], "m", 10);
        let block = &body["messages"][0]["content"][0];
        assert_eq!(block["type"], "tool_result");
        assert_eq!(block["tool_use_id"], "t1");
        assert_eq!(block["is_error"], false);
    }

    #[test]
    fn tool_result_with_image_becomes_a_content_array_with_an_image_block() {
        let msg = ChatMessage {
            role: Role::User,
            blocks: vec![Block::ToolResult {
                tool_use_id: "t1".into(),
                content: "screenshot".into(),
                is_error: false,
                image_base64: Some("QUJD".into()),
            }],
        };
        let body = build_body(SYSTEM_PROMPT, &[msg], &[], "m", 10);
        let content = &body["messages"][0]["content"][0]["content"];
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "QUJD");
    }

    #[test]
    fn parse_reply_extracts_first_tool_use_and_text() {
        let body = json!({
            "content": [
                { "type": "text", "text": "Opening Safari." },
                { "type": "tool_use", "id": "tu_1", "name": "open_app", "input": { "name": "Safari" } },
                { "type": "tool_use", "id": "tu_2", "name": "finish", "input": {} }
            ],
            "stop_reason": "tool_use"
        });
        let reply = parse_reply(&body).unwrap();
        assert_eq!(reply.text.as_deref(), Some("Opening Safari."));
        let call = reply.tool_call.unwrap();
        assert_eq!(call.id, "tu_1"); // first tool_use only
        assert_eq!(call.name, "open_app");
        assert_eq!(call.input["name"], "Safari");
    }

    #[test]
    fn parse_reply_handles_prose_only() {
        let body = json!({ "content": [ { "type": "text", "text": "All done." } ] });
        let reply = parse_reply(&body).unwrap();
        assert_eq!(reply.text.as_deref(), Some("All done."));
        assert!(reply.tool_call.is_none());
    }

    #[test]
    fn parse_reply_errors_on_malformed_content() {
        assert!(parse_reply(&json!({ "stop_reason": "end_turn" })).is_err());
    }
}
