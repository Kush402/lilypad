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
                    img.put_pixel(x, y, image::Rgba([self.rgb[0], self.rgb[1], self.rgb[2], 255]));
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
                "ready": { "type": "boolean", "description": "Set to true." }
            },
            "required": ["ready"]
        }),
    }
}

const PROBE_SYSTEM: &str = "You are being checked for connectivity. \
    Answer only by calling the `probe_report` tool. Do not write prose.";

/// Run the check against an already-built provider.
///
/// Takes the provider rather than the settings so the caller decides what is
/// being tested — an unsaved draft on the setup screen, most of the time,
/// which is the whole point: nobody should have to commit a configuration to
/// find out whether it works.
pub async fn run<P: LlmProvider>(
    provider: &P,
    origin: String,
    model: String,
    want_vision: bool,
) -> ProbeReport {
    let tools = [probe_tool()];

    // 1. Tool round trip.
    let ask = ChatMessage {
        role: Role::User,
        blocks: vec![Block::Text(
            "Call `probe_report` with ready set to true.".to_string(),
        )],
    };
    let reply = match provider.complete(PROBE_SYSTEM, &[ask.clone()], &tools).await {
        Ok(reply) => reply,
        Err(err) => {
            let failure = downcast(&err);
            return ProbeReport::failed(origin, model, &failure);
        }
    };
    let Some(call) = reply.tool_call.filter(|c| c.name == "probe_report") else {
        return ProbeReport {
            ok: false,
            tools: Capability::Unsupported,
            vision: Capability::Untested,
            message: Some(
                "The endpoint answered, but this model did not call the tool it was given. \
                 Ask needs tool calling — choose a model that supports it."
                    .to_string(),
            ),
            failure: Some(FailureKind::BadRequest),
            origin,
            model,
        };
    };

    if !want_vision {
        return ProbeReport {
            ok: true,
            tools: Capability::Supported,
            vision: Capability::Untested,
            message: None,
            failure: None,
            origin,
            model,
        };
    }

    // 2. Image round trip, on the same conversation: the image travels as the
    // result of the tool call the model just made, which is exactly how a real
    // Ask observation reaches it.
    let shapes = Shapes::pick();
    let image = match shapes.png_base64() {
        Ok(image) => image,
        Err(err) => {
            return ProbeReport {
                ok: true,
                tools: Capability::Supported,
                vision: Capability::Untested,
                message: Some(format!("Could not build the test image: {err}")),
                failure: None,
                origin,
                model,
            }
        }
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
    let with_image = ChatMessage {
        role: Role::User,
        blocks: vec![
            Block::ToolResult {
                tool_use_id: call.id.clone(),
                content: "Here is an image. Call `probe_report` again with the number of \
                          squares as `count` and their colour as `colour`."
                    .to_string(),
                is_error: false,
                image_base64: Some(image),
            },
        ],
    };
    let reply = match provider
        .complete(PROBE_SYSTEM, &[ask, assistant, with_image], &tools)
        .await
    {
        Ok(reply) => reply,
        Err(err) => {
            let failure = downcast(&err);
            return ProbeReport {
                ok: true,
                tools: Capability::Supported,
                vision: Capability::Unsupported,
                message: Some(format!(
                    "Text works, but this model rejected an image: {}",
                    failure.message
                )),
                failure: Some(failure.kind),
                origin,
                model,
            };
        }
    };
    let saw = reply
        .tool_call
        .as_ref()
        .map(|c| {
            let count = c.input.get("count").and_then(|v| v.as_u64());
            let colour = c
                .input
                .get("colour")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            count == Some(shapes.count as u64) && colour.contains(shapes.colour)
        })
        .unwrap_or(false);
    ProbeReport {
        ok: true,
        tools: Capability::Supported,
        vision: if saw {
            Capability::Supported
        } else {
            Capability::Unsupported
        },
        message: (!saw).then(|| {
            "Text works, but this model did not read the test image correctly. \
             Ask will use it without screenshots."
                .to_string()
        }),
        failure: None,
        origin,
        model,
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

    /// A provider that answers from a script, so the probe's own logic is what
    /// is under test rather than any network.
    struct Scripted {
        replies: std::sync::Mutex<Vec<Result<AssistantReply, String>>>,
    }
    impl Scripted {
        fn new(replies: Vec<Result<AssistantReply, String>>) -> Self {
            Scripted {
                replies: std::sync::Mutex::new(replies),
            }
        }
    }
    impl LlmProvider for Scripted {
        async fn complete(
            &self,
            _system: &str,
            _messages: &[ChatMessage],
            _tools: &[ToolSpec],
        ) -> Result<AssistantReply> {
            let next = self.replies.lock().unwrap().remove(0);
            next.map_err(|e| {
                anyhow::Error::new(ProviderFailure {
                    kind: FailureKind::Auth,
                    status: Some(401),
                    message: e,
                })
            })
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

    #[tokio::test]
    async fn a_rejected_key_is_reported_as_a_key_problem() {
        let p = Scripted::new(vec![Err("Incorrect API key provided".into())]);
        let report = run(&p, "https://api.openai.com".into(), "m".into(), false).await;
        assert!(!report.ok);
        assert_eq!(report.failure, Some(FailureKind::Auth));
        assert_eq!(report.tools, Capability::Untested);
    }

    /// The case a status code cannot catch: HTTP 200, and no tool call.
    #[tokio::test]
    async fn prose_instead_of_a_tool_call_is_a_failure() {
        let p = Scripted::new(vec![Ok(AssistantReply {
            text: Some("Sure! I am ready.".into()),
            tool_call: None,
        })]);
        let report = run(&p, "https://x".into(), "m".into(), false).await;
        assert!(!report.ok);
        assert_eq!(report.tools, Capability::Unsupported);
        assert!(report.message.unwrap().contains("tool calling"));
    }

    #[tokio::test]
    async fn tools_pass_without_touching_vision_unless_it_was_asked_for() {
        let p = Scripted::new(vec![Ok(call(serde_json::json!({"ready": true})))]);
        let report = run(&p, "https://x".into(), "m".into(), false).await;
        assert!(report.ok);
        assert_eq!(report.tools, Capability::Supported);
        assert_eq!(report.vision, Capability::Untested, "vision was never asked about");
    }

    /// A model that answers the image question wrongly is not a model that can
    /// see. Vision is downgraded; text still works, and the report says both.
    #[tokio::test]
    async fn a_wrong_image_answer_downgrades_vision_without_failing_the_setup() {
        let p = Scripted::new(vec![
            Ok(call(serde_json::json!({"ready": true}))),
            Ok(call(serde_json::json!({"count": 99, "colour": "purple"}))),
        ]);
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
            let coloured = px[0] == shapes.rgb[0] && px[1] == shapes.rgb[1] && px[2] == shapes.rgb[2];
            if coloured && !inside {
                runs += 1;
            }
            inside = coloured;
        }
        assert_eq!(runs, shapes.count, "the image does not show what it says");
    }
}
