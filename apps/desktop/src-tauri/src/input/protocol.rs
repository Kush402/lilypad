//! Serde mirror of `@lilypad/protocol`'s input schema
//! ([`packages/protocol/src/input.ts`](../../../../../../packages/protocol/src/input.ts)).
//! Field names and defaults match exactly so the wire format never drifts
//! between the mobile sender and this decoder.

use serde::{Deserialize, Deserializer};

// Input events travel peer-to-peer over the DataChannel, never through the
// backend — these bounds are the only validation boundary a malformed or
// hostile payload passes through before this desktop acts on it. Mirrors
// `packages/protocol/src/input.ts`'s `MAX_TEXT_INPUT_LEN`/
// `MAX_CLIPBOARD_TEXT_LEN`. See `docs/audit/m3/backend-security.md` Finding 9.
const MAX_TEXT_INPUT_LEN: usize = 8 * 1024;
const MAX_CLIPBOARD_TEXT_LEN: usize = 64 * 1024;

fn deserialize_bounded_text<'de, D>(deserializer: D, max_len: usize) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    if s.len() > max_len {
        return Err(serde::de::Error::custom(format!(
            "text length {} exceeds max {max_len}",
            s.len()
        )));
    }
    Ok(s)
}

fn deserialize_text_input<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded_text(deserializer, MAX_TEXT_INPUT_LEN)
}

fn deserialize_clipboard_text<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded_text(deserializer, MAX_CLIPBOARD_TEXT_LEN)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerButton {
    Left,
    Right,
    Middle,
}

fn default_button() -> PointerButton {
    PointerButton::Left
}
fn default_count() -> u8 {
    1
}

/// OS-agnostic modifier; each backend maps `Meta` to Cmd (macOS) or the Win
/// key (Windows).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Meta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutAction {
    Copy,
    Paste,
    Cut,
    Undo,
    Redo,
    SelectAll,
    Save,
    Escape,
    Tab,
    Enter,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputEvent {
    PointerMove {
        x: f64,
        y: f64,
        ts: u64,
        #[serde(default)]
        seq: Option<u64>,
    },
    PointerDown {
        x: f64,
        y: f64,
        #[serde(default = "default_button")]
        button: PointerButton,
        #[serde(default)]
        modifiers: Vec<Modifier>,
        ts: u64,
        #[serde(default)]
        seq: Option<u64>,
    },
    PointerUp {
        x: f64,
        y: f64,
        #[serde(default = "default_button")]
        button: PointerButton,
        #[serde(default)]
        modifiers: Vec<Modifier>,
        ts: u64,
        #[serde(default)]
        seq: Option<u64>,
    },
    Click {
        x: f64,
        y: f64,
        #[serde(default = "default_button")]
        button: PointerButton,
        #[serde(default = "default_count")]
        count: u8,
        #[serde(default)]
        modifiers: Vec<Modifier>,
        ts: u64,
        #[serde(default)]
        seq: Option<u64>,
    },
    Scroll {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
        ts: u64,
        #[serde(default)]
        seq: Option<u64>,
    },
    KeyDown {
        code: String,
        #[serde(default)]
        modifiers: Vec<Modifier>,
        #[serde(default)]
        repeat: bool,
        ts: u64,
        #[serde(default)]
        seq: Option<u64>,
    },
    KeyUp {
        code: String,
        #[serde(default)]
        modifiers: Vec<Modifier>,
        ts: u64,
        #[serde(default)]
        seq: Option<u64>,
    },
    TextInput {
        #[serde(deserialize_with = "deserialize_text_input")]
        text: String,
        ts: u64,
        #[serde(default)]
        seq: Option<u64>,
    },
    Shortcut {
        action: ShortcutAction,
        ts: u64,
        #[serde(default)]
        seq: Option<u64>,
    },
    Clipboard {
        #[serde(deserialize_with = "deserialize_clipboard_text")]
        text: String,
        ts: u64,
        #[serde(default)]
        seq: Option<u64>,
    },
}

impl InputEvent {
    pub fn ts(&self) -> u64 {
        match self {
            InputEvent::PointerMove { ts, .. }
            | InputEvent::PointerDown { ts, .. }
            | InputEvent::PointerUp { ts, .. }
            | InputEvent::Click { ts, .. }
            | InputEvent::Scroll { ts, .. }
            | InputEvent::KeyDown { ts, .. }
            | InputEvent::KeyUp { ts, .. }
            | InputEvent::TextInput { ts, .. }
            | InputEvent::Shortcut { ts, .. }
            | InputEvent::Clipboard { ts, .. } => *ts,
        }
    }

    /// Monotonic per-session sequence number, if the sender stamped one.
    /// `None` only for a pre-v2 sender that predates the field — the
    /// dispatcher falls back to `ts()` in that case. See
    /// `docs/audit/m3/input-touch.md` Finding 8.
    pub fn seq(&self) -> Option<u64> {
        match self {
            InputEvent::PointerMove { seq, .. }
            | InputEvent::PointerDown { seq, .. }
            | InputEvent::PointerUp { seq, .. }
            | InputEvent::Click { seq, .. }
            | InputEvent::Scroll { seq, .. }
            | InputEvent::KeyDown { seq, .. }
            | InputEvent::KeyUp { seq, .. }
            | InputEvent::TextInput { seq, .. }
            | InputEvent::Shortcut { seq, .. }
            | InputEvent::Clipboard { seq, .. } => *seq,
        }
    }

    /// The discriminant the dispatcher's stale/duplicate gate compares:
    /// the monotonic `seq` when present, else the wall-clock `ts` (pre-v2
    /// fallback). Within a session the sender is a single version, so this is
    /// consistent for a given stream — never a mix of the two sources.
    pub fn order_key(&self) -> u64 {
        self.seq().unwrap_or_else(|| self.ts())
    }
}

#[derive(Debug, Deserialize)]
pub struct InputBatch {
    pub kind: String,
    pub events: Vec<InputEvent>,
}

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("malformed input batch: {0}")]
    Json(#[from] serde_json::Error),
    #[error("expected kind \"input_batch\", got \"{0}\"")]
    WrongKind(String),
}

/// Decode one DataChannel frame (raw bytes off `lilypad-input`).
pub fn decode_input_batch(bytes: &[u8]) -> Result<InputBatch, DecodeError> {
    let batch: InputBatch = serde_json::from_slice(bytes)?;
    if batch.kind != "input_batch" {
        return Err(DecodeError::WrongKind(batch.kind));
    }
    Ok(batch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_mixed_batch_matching_the_ts_wire_format() {
        let raw = br#"{"kind":"input_batch","events":[
            {"kind":"pointer_move","x":0.5,"y":0.4,"ts":1},
            {"kind":"click","x":0.5,"y":0.4,"button":"left","count":1,"ts":2},
            {"kind":"key_down","code":"KeyA","modifiers":["meta"],"repeat":false,"ts":3},
            {"kind":"shortcut","action":"copy","ts":4},
            {"kind":"clipboard","text":"hello","ts":5}
        ]}"#;
        let batch = decode_input_batch(raw).expect("decodes");
        assert_eq!(batch.events.len(), 5);
        assert_eq!(batch.events[0].ts(), 1);
        matches!(batch.events[2], InputEvent::KeyDown { .. });
    }

    #[test]
    fn applies_defaults_for_button_and_count() {
        let raw = br#"{"kind":"input_batch","events":[{"kind":"click","x":0.1,"y":0.1,"ts":1}]}"#;
        let batch = decode_input_batch(raw).unwrap();
        match &batch.events[0] {
            InputEvent::Click { button, count, .. } => {
                assert_eq!(*button, PointerButton::Left);
                assert_eq!(*count, 1);
            }
            _ => panic!("expected click"),
        }
    }

    #[test]
    fn rejects_wrong_envelope_kind() {
        let raw = br#"{"kind":"not_input","events":[]}"#;
        assert!(matches!(
            decode_input_batch(raw),
            Err(DecodeError::WrongKind(_))
        ));
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(decode_input_batch(b"{not json").is_err());
    }

    #[test]
    fn rejects_unknown_event_kind() {
        let raw = br#"{"kind":"input_batch","events":[{"kind":"teleport","ts":1}]}"#;
        assert!(decode_input_batch(raw).is_err());
    }

    #[test]
    fn decodes_seq_and_falls_back_to_none_when_absent() {
        let raw = br#"{"kind":"input_batch","events":[
            {"kind":"pointer_move","x":0.5,"y":0.4,"ts":1,"seq":42},
            {"kind":"pointer_move","x":0.6,"y":0.4,"ts":2}
        ]}"#;
        let batch = decode_input_batch(raw).unwrap();
        assert_eq!(batch.events[0].seq(), Some(42));
        assert_eq!(batch.events[0].order_key(), 42);
        // Absent seq → None, and order_key falls back to ts.
        assert_eq!(batch.events[1].seq(), None);
        assert_eq!(batch.events[1].order_key(), 2);
    }

    #[test]
    fn decodes_pointer_modifiers_and_defaults_them_empty() {
        let raw = br#"{"kind":"input_batch","events":[
            {"kind":"pointer_down","x":0.1,"y":0.1,"button":"left","modifiers":["meta","shift"],"ts":1,"seq":1},
            {"kind":"click","x":0.1,"y":0.1,"ts":2,"seq":2}
        ]}"#;
        let batch = decode_input_batch(raw).unwrap();
        match &batch.events[0] {
            InputEvent::PointerDown { modifiers, .. } => {
                assert_eq!(modifiers, &[Modifier::Meta, Modifier::Shift]);
            }
            _ => panic!("expected pointer_down"),
        }
        // Absent modifiers default to empty, matching the zod `.default([])`.
        match &batch.events[1] {
            InputEvent::Click { modifiers, .. } => assert!(modifiers.is_empty()),
            _ => panic!("expected click"),
        }
    }

    // Input events travel peer-to-peer over the DataChannel, never through
    // the backend — this decoder is the only validation boundary an
    // oversized or hostile payload passes through. See
    // docs/audit/m3/backend-security.md Finding 9.
    #[test]
    fn rejects_an_oversized_clipboard_payload() {
        let text = "x".repeat(MAX_CLIPBOARD_TEXT_LEN + 1);
        let raw = format!(
            r#"{{"kind":"input_batch","events":[{{"kind":"clipboard","text":"{text}","ts":1}}]}}"#
        );
        assert!(decode_input_batch(raw.as_bytes()).is_err());
    }

    #[test]
    fn accepts_a_clipboard_payload_at_the_size_ceiling() {
        let text = "x".repeat(MAX_CLIPBOARD_TEXT_LEN);
        let raw = format!(
            r#"{{"kind":"input_batch","events":[{{"kind":"clipboard","text":"{text}","ts":1}}]}}"#
        );
        assert!(decode_input_batch(raw.as_bytes()).is_ok());
    }

    #[test]
    fn rejects_an_oversized_text_input_payload() {
        let text = "x".repeat(MAX_TEXT_INPUT_LEN + 1);
        let raw = format!(
            r#"{{"kind":"input_batch","events":[{{"kind":"text_input","text":"{text}","ts":1}}]}}"#
        );
        assert!(decode_input_batch(raw.as_bytes()).is_err());
    }
}
