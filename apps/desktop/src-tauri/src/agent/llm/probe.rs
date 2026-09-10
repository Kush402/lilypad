//! "Test connection" — does this provider, endpoint, key and model actually do
//! what Ask needs? (L-263, L-264)
//!
//! Saving a key proved nothing. The setup card called a configuration
//! "Configured" from the presence of a stored string, so a wrong key, a
//! retired model, an endpoint that cannot call tools and a service that is
//! simply down all looked identical — and identical to working. Whatever this
//! returns, it returns because a request was made and an answer came back.
//!
//! Two things are checked, because Ask needs both and they fail separately:
//!
//!   1. **One complete tool-call round trip.** Not "the endpoint answered" —
//!      the model was given a tool and had to call it with the right argument.
//!      An endpoint that ignores `tools` returns prose, and prose is a failure
//!      here even though the HTTP status is 200.
//!   2. **Image input, only when asked for.** Model listings do not certify
//!      vision; a listing is a catalogue, not a capability statement. The image
//!      is generated here, in memory, from random shapes — the person's screen
//!      is never captured to test a key, and there is nothing in the request
//!      that came from their Mac.
//!
//! The image is deliberately not a fixed picture: a fixed one could be
//! answered from the prompt's own wording by a text-only model that guesses
//! well. Colour and count are drawn per run, so a correct answer means the
//! bytes were read.

use anyhow::Result;
use serde::Serialize;

use super::http::{FailureKind, ProviderFailure};
use super::{Block, ChatMessage, LlmProvider, Role, ToolSpec};

/// A synthetic image: this many squares of this colour, and nothing else.
struct Shapes {
    count: u32,
    colour: &'static str,
    rgb: [u8; 3],
}

const COLOURS: [(&str, [u8; 3]); 3] = [
    ("red", [220, 38, 38]),
    ("green", [22, 163, 74]),
    ("blue", [37, 99, 235]),
];

impl Shapes {
    /// Drawn from the clock rather than a random-number dependency: this needs
    /// to be unpredictable to a language model, not to a cryptanalyst.
    fn pick() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let (colour, rgb) = COLOURS[(nanos as usize / 7) % COLOURS.len()];
        Shapes {
            count: 2 + (nanos % 4),
            colour,
            rgb,
        }
    }

    /// A white canvas with `count` filled squares in a row. No text, so no
    /// font, and nothing a text-only endpoint could infer from metadata.
    fn png_base64(&self) -> Result<String> {
        use base64::Engine;
        use image::{ImageFormat, RgbaImage};

        const CELL: u32 = 48;
        const PAD: u32 = 12;
        let width = PAD + (CELL + PAD) * 5;
        let height = CELL + PAD * 2;
        let mut img = RgbaImage::from_pixel(width, height, image::Rgba([255, 255, 255, 255]));
        for i in 0..self.count {
            let x0 = PAD + i * (CELL + PAD);
            for y in PAD..PAD + CELL {
                for x in x0..x0 + CELL {
                    img.put_pixel(
                        x,
                        y,
                        image::Rgba([self.rgb[0], self.rgb[1], self.rgb[2], 255]),
                    );
                }
            }
        }
        let mut png: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(png))
    }
}

/// What one capability check concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    /// Verified by a round trip just now.
    Supported,
    /// Asked for and demonstrably absent.
    Unsupported,
    /// Not checked — because it was not requested, or because an earlier step
    /// failed and the answer would be meaningless.
    Untested,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// Did the whole check pass? `tools` supported is the minimum bar; vision
    /// only counts against this when it was requested.
    pub ok: bool,
    pub tools: Capability,
    pub vision: Capability,
    /// Present when something failed, in the person's words.
    pub message: Option<String>,
    /// Present when something failed, for the UI to choose a recovery action.
    pub failure: Option<FailureKind>,
    /// The destination the request actually went to. Non-secret, and shown so
    /// the effective endpoint is never a matter of trust.
    pub origin: String,
    pub model: String,
    /// Whether this result was filed against the saved configuration. `false`
    /// when a draft was tested, or when persistence failed — which the message
    /// then explains (L-282).
    #[serde(default)]
    pub recorded: bool,
}

impl ProbeReport {
    fn failed(origin: String, model: String, failure: &ProviderFailure) -> Self {
        ProbeReport {
            ok: false,
            tools: Capability::Untested,
            vision: Capability::Untested,
            message: Some(failure.message.clone()),
            failure: Some(failure.kind),
            origin,
            model,
            recorded: false,
        }
    }
}

fn probe_tool() -> ToolSpec {
    ToolSpec {
        name: "probe_report",
        description: "Report the answer to the question you were asked. \
                      Always answer by calling this tool, never in prose.",
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "count": { "type": "integer", "description": "How many squares are in the image." },
                "colour": { "type": "string", "description": "The colour of the squares." },
                "ready": { "type": "boolean", "description": "Set to true." },
                "echo": { "type": "string", "description": "Copy the exact value you were asked to echo." }
            },
            "required": []
        }),
    }
}

const PROBE_SYSTEM: &str = "You are being checked for connectivity. \
    Answer only by calling the `probe_report` tool. Do not write prose.";

/// Run the check against an already-built provider.
///
/// Takes the provider rather than the settings so the caller decides what is
/// being tested — an unsaved draft on the setup screen, most of the time, which
/// is the whole point: nobody should have to commit a configuration to find out
/// whether it works.
///
/// ### Why there are always two turns (L-283)
///
/// The first version returned "tools supported" as soon as a call named
/// `probe_report` came back, and did not look at its arguments. That tests less
/// than it appears to. Ask does not merely *send* tools; every step feeds the
/// previous action's result back as a tool result and expects the model to keep
/// going. An endpoint that emits a tool call and then rejects tool-result input
/// on the next turn — a real failure mode for gateways with partial
/// compatibility — passed setup and failed on the person's first real task.
///
/// So the probe always completes a round trip: it validates the arguments of
/// the first call, sends a tool result carrying a nonce (or the test image),
/// and requires a correct follow-up call before it will say tools work.
pub async fn run<P: LlmProvider>(
    provider: &P,
    origin: String,
    model: String,
    want_vision: bool,
) -> ProbeReport {
    let tools = [probe_tool()];

    // ── turn 1: does it call the tool it was given, correctly? ───────────
    let ask = ChatMessage {
        role: Role::User,
        blocks: vec![Block::Text(
            "Call `probe_report` with ready set to true.".to_string(),
        )],
    };
    let reply = match provider
        .complete(PROBE_SYSTEM, &[ask.clone()], &tools)
        .await
    {
        Ok(reply) => reply,
        Err(err) => return ProbeReport::failed(origin, model, &downcast(&err)),
    };
    let Some(call) = reply.tool_call.filter(|c| c.name == "probe_report") else {
        return no_tools(
            origin,
            model,
            "The endpoint answered, but this model did not call the tool it was given. \
             Ask needs tool calling — choose a model that supports it.",
        );
    };
    // The arguments are the answer. A call with the right name and the wrong
    // contents is a model that is not really following the schema.
    if call.input.get("ready").and_then(|v| v.as_bool()) != Some(true) {
        return no_tools(
            origin,
            model,
            "This model called the tool but did not fill in what it was asked for, so Ask \
             cannot rely on it to follow a tool's schema.",
        );
    }

    // ── turn 2: does it accept a tool result and keep going? ─────────────
    let shapes = want_vision.then(Shapes::pick);
    let image = match shapes.as_ref().map(|s| s.png_base64()) {
        Some(Ok(image)) => Some(image),
        None => None,
        Some(Err(err)) => {
            // The image could not be built here, which says nothing about the
            // provider. Fall back to the text round trip and say so.
            log::warn!(target: "lilypad::agent", "probe image could not be built: {err}");
            None
        }
    };
    // A nonce the model cannot know without reading the tool result we send.
    let nonce = format!("{:04x}", std::process::id() ^ (call.id.len() as u32) << 3);
    let instruction = match &shapes {
        Some(_) if image.is_some() => format!(
            "Here is an image. Call `probe_report` again with the number of squares as \
             `count`, their colour as `colour`, and `echo` set to \"{nonce}\"."
        ),
        _ => format!("Call `probe_report` again with `echo` set to \"{nonce}\"."),
    };
    let assistant = ChatMessage {
        role: Role::Assistant,
        blocks: vec![Block::ToolUse {
            id: call.id.clone(),
            name: call.name.clone(),
            input: call.input.clone(),
            extra: call.extra.clone(),
        }],
    };
    let result_turn = ChatMessage {
        role: Role::User,
        blocks: vec![Block::ToolResult {
            tool_use_id: call.id.clone(),
            content: instruction,
            is_error: false,
            image_base64: image.clone(),
        }],
    };
    let second = provider
        .complete(PROBE_SYSTEM, &[ask, assistant, result_turn], &tools)
        .await;

    let second = match second {
        Ok(reply) => reply,
        Err(err) => {
            let failure = downcast(&err);
            // This is the failure mode the second turn exists to catch: the
            // endpoint took the tools but will not take a tool result back.
            return ProbeReport {
                ok: false,
                tools: Capability::Unsupported,
                vision: Capability::Untested,
                message: Some(format!(
                    "This endpoint accepted a tool call but rejected the tool result Ask sends \
                     back on the next step: {}",
                    failure.message
                )),
                failure: Some(failure.kind),
                origin,
                model,
                recorded: false,
            };
        }
    };
    let Some(follow_up) = second.tool_call.filter(|c| c.name == "probe_report") else {
        return no_tools(
            origin,
            model,
            "This model stopped calling tools after the first result was sent back, so Ask \
             could not carry a task past its first step.",
        );
    };
    let echoed = follow_up
        .input
        .get("echo")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if echoed != nonce {
        return no_tools(
            origin,
            model,
            "This model did not read the result Ask sent back to it, so it cannot follow what \
             happens between steps.",
        );
    }

    // Tools are proven. Vision is a separate question, and only asked when the
    // person asked for it.
    let vision = match (&shapes, &image) {
        (Some(shapes), Some(_)) => {
            let count = follow_up.input.get("count").and_then(|v| v.as_u64());
            let colour = follow_up
                .input
                .get("colour")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if count == Some(shapes.count as u64) && colour.contains(shapes.colour) {
                Capability::Supported
            } else {
                Capability::Unsupported
            }
        }
        _ => Capability::Untested,
    };
    ProbeReport {
        ok: true,
        tools: Capability::Supported,
        vision,
        message: match vision {
            Capability::Unsupported => Some(
                "Text works, but this model did not read the test image correctly. Ask will \
                 use it without screenshots."
                    .to_string(),
            ),
            _ => None,
        },
        failure: None,
        origin,
        model,
        recorded: false,
    }
}

/// A provider that answered but cannot drive Ask.
fn no_tools(origin: String, model: String, message: &str) -> ProbeReport {
    ProbeReport {
        ok: false,
        tools: Capability::Unsupported,
        vision: Capability::Untested,
        message: Some(message.to_string()),
        failure: Some(FailureKind::BadRequest),
        origin,
        model,
        recorded: false,
    }
}

/// Recover the typed failure an adapter raised, or describe an untyped one.
fn downcast(err: &anyhow::Error) -> ProviderFailure {
    err.downcast_ref::<ProviderFailure>()
        .cloned()
        .unwrap_or_else(|| ProviderFailure {
            kind: FailureKind::Transport,
            status: None,
            message: format!("{err:#}"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::llm::{AssistantReply, ProviderCaps, ToolCall};

    /// How the scripted provider behaves on the second turn — the one that
    /// carries a tool result back.
    #[derive(Clone, Copy)]
    enum SecondTurn {
        /// Echo the nonce it was sent, like a working model.
        EchoNonce,
        /// Echo the nonce and answer the image question with these values.
        EchoWithImage(u32, &'static str),
        /// Answer without reading the result it was sent.
        IgnoreResult,
        /// Reject tool-result input entirely — the gateway failure L-283 is
        /// about, invisible to a one-turn probe.
        RejectToolResult,
        /// Stop calling tools.
        Prose,
    }

    struct Scripted {
        first: AssistantReply,
        second: SecondTurn,
    }

    /// Pull the nonce back out of the instruction, the way a model that
    /// actually read the tool result would.
    fn nonce_from(messages: &[ChatMessage]) -> String {
        for message in messages {
            for block in &message.blocks {
                if let Block::ToolResult { content, .. } = block {
                    if let Some(start) = content.find('"') {
                        if let Some(end) = content[start + 1..].find('"') {
                            return content[start + 1..start + 1 + end].to_string();
                        }
                    }
                }
            }
        }
        String::new()
    }

    fn has_tool_result(messages: &[ChatMessage]) -> bool {
        messages.iter().any(|m| {
            m.blocks
                .iter()
                .any(|b| matches!(b, Block::ToolResult { .. }))
        })
    }

    impl LlmProvider for Scripted {
        async fn complete(
            &self,
            _system: &str,
            messages: &[ChatMessage],
            _tools: &[ToolSpec],
        ) -> Result<AssistantReply> {
            if !has_tool_result(messages) {
                return Ok(self.first.clone());
            }
            match self.second {
                SecondTurn::RejectToolResult => Err(anyhow::Error::new(ProviderFailure {
                    kind: FailureKind::BadRequest,
                    status: Some(400),
                    message: "messages: tool result blocks are not supported".into(),
                })),
                SecondTurn::Prose => Ok(AssistantReply {
                    text: Some("All done!".into()),
                    tool_call: None,
                }),
                SecondTurn::IgnoreResult => {
                    Ok(call(serde_json::json!({ "echo": "not-the-nonce" })))
                }
                SecondTurn::EchoNonce => {
                    Ok(call(serde_json::json!({ "echo": nonce_from(messages) })))
                }
                SecondTurn::EchoWithImage(count, colour) => Ok(call(serde_json::json!({
                    "echo": nonce_from(messages),
                    "count": count,
                    "colour": colour,
                }))),
            }
        }
        fn caps(&self) -> ProviderCaps {
            ProviderCaps::default()
        }
    }

    fn call(input: serde_json::Value) -> AssistantReply {
        AssistantReply {
            text: None,
            tool_call: Some(ToolCall {
                id: "1".into(),
                name: "probe_report".into(),
                input,
                extra: None,
            }),
        }
    }

    fn ready_first() -> AssistantReply {
        call(serde_json::json!({ "ready": true }))
    }

    fn probe(first: AssistantReply, second: SecondTurn, vision: bool) -> Scripted {
        let _ = vision;
        Scripted { first, second }
    }

    #[tokio::test]
    async fn a_rejected_key_is_reported_as_a_key_problem() {
        struct Failing;
        impl LlmProvider for Failing {
            async fn complete(
                &self,
                _s: &str,
                _m: &[ChatMessage],
                _t: &[ToolSpec],
            ) -> Result<AssistantReply> {
                Err(anyhow::Error::new(ProviderFailure {
                    kind: FailureKind::Auth,
                    status: Some(401),
                    message: "Incorrect API key provided".into(),
                }))
            }
            fn caps(&self) -> ProviderCaps {
                ProviderCaps::default()
            }
        }
        let report = run(&Failing, "https://api.openai.com".into(), "m".into(), false).await;
        assert!(!report.ok);
        assert_eq!(report.failure, Some(FailureKind::Auth));
        assert_eq!(report.tools, Capability::Untested);
    }

    /// HTTP 200, and no tool call. A status code cannot catch this.
    #[tokio::test]
    async fn prose_instead_of_a_tool_call_is_a_failure() {
        let p = probe(
            AssistantReply {
                text: Some("Sure! I am ready.".into()),
                tool_call: None,
            },
            SecondTurn::EchoNonce,
            false,
        );
        let report = run(&p, "https://x".into(), "m".into(), false).await;
        assert!(!report.ok);
        assert_eq!(report.tools, Capability::Unsupported);
        assert!(report.message.unwrap().contains("tool calling"));
    }

    /// L-283. The call arrives with the right name and the wrong contents.
    #[tokio::test]
    async fn a_tool_call_with_wrong_arguments_is_not_a_pass() {
        for bad in [
            serde_json::json!({}),
            serde_json::json!({ "ready": false }),
            serde_json::json!({ "ready": "yes" }),
        ] {
            let p = probe(call(bad.clone()), SecondTurn::EchoNonce, false);
            let report = run(&p, "https://x".into(), "m".into(), false).await;
            assert!(!report.ok, "accepted {bad}");
            assert_eq!(report.tools, Capability::Unsupported, "accepted {bad}");
        }
    }

    /// L-283, the case the old one-turn probe could not see: the endpoint
    /// emits a tool call and then refuses the tool result Ask sends back.
    #[tokio::test]
    async fn an_endpoint_that_rejects_tool_results_does_not_pass_setup() {
        let p = probe(ready_first(), SecondTurn::RejectToolResult, false);
        let report = run(&p, "https://gw.example".into(), "m".into(), false).await;
        assert!(!report.ok);
        assert_eq!(report.tools, Capability::Unsupported);
        assert!(
            report.message.unwrap().contains("rejected the tool result"),
            "the failure should name the step that failed"
        );
    }

    #[tokio::test]
    async fn a_model_that_stops_calling_tools_after_a_result_does_not_pass() {
        let p = probe(ready_first(), SecondTurn::Prose, false);
        let report = run(&p, "https://x".into(), "m".into(), false).await;
        assert!(!report.ok);
        assert_eq!(report.tools, Capability::Unsupported);
    }

    #[tokio::test]
    async fn a_model_that_does_not_read_the_result_does_not_pass() {
        let p = probe(ready_first(), SecondTurn::IgnoreResult, false);
        let report = run(&p, "https://x".into(), "m".into(), false).await;
        assert!(!report.ok);
        assert_eq!(report.tools, Capability::Unsupported);
    }

    #[tokio::test]
    async fn a_full_round_trip_passes_without_touching_vision_unless_asked() {
        let p = probe(ready_first(), SecondTurn::EchoNonce, false);
        let report = run(&p, "https://x".into(), "m".into(), false).await;
        assert!(report.ok, "{:?}", report.message);
        assert_eq!(report.tools, Capability::Supported);
        assert_eq!(
            report.vision,
            Capability::Untested,
            "vision was never asked about"
        );
        assert!(!report.recorded, "the caller decides what is recorded");
    }

    /// A model that answers the image question wrongly is not a model that can
    /// see. Vision is downgraded; text still works, and the report says both.
    #[tokio::test]
    async fn a_wrong_image_answer_downgrades_vision_without_failing_the_setup() {
        let p = probe(ready_first(), SecondTurn::EchoWithImage(99, "purple"), true);
        let report = run(&p, "https://x".into(), "m".into(), true).await;
        assert!(report.ok, "text still works");
        assert_eq!(report.tools, Capability::Supported);
        assert_eq!(report.vision, Capability::Unsupported);
    }

    #[test]
    fn the_test_image_is_a_real_png_of_the_shapes_it_claims() {
        let shapes = Shapes::pick();
        assert!((2..=5).contains(&shapes.count));
        let encoded = shapes.png_base64().unwrap();
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .unwrap();
        assert_eq!(&bytes[1..4], b"PNG", "not a PNG");
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgba8();
        // Count the squares back out of the pixels: a row through the middle
        // alternates white and colour exactly `count` times.
        let y = decoded.height() / 2;
        let mut runs = 0;
        let mut inside = false;
        for x in 0..decoded.width() {
            let px = decoded.get_pixel(x, y);
            let coloured =
                px[0] == shapes.rgb[0] && px[1] == shapes.rgb[1] && px[2] == shapes.rgb[2];
            if coloured && !inside {
                runs += 1;
            }
            inside = coloured;
        }
        assert_eq!(runs, shapes.count, "the image does not show what it says");
    }
}
