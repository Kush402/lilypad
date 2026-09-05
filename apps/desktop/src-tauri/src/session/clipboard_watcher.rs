//! Desktop → phone clipboard sync: watches the OS clipboard for changes so
//! `run_session` can push a `clipboard-update` over encrypted WebRTC. The other
//! direction (phone → desktop) already exists via `InputEvent::Clipboard` on
//! the DataChannel (`input/dispatcher.rs`); this is the reverse leg. See
//! `docs/audit/m3/prior-art.md` Finding 6.
//!
//! Polls rather than subscribes to a change-notification API: macOS has none
//! for `NSPasteboard` (polling `changeCount` is the standard technique), and
//! a human-paced event like a clipboard copy tolerates a poll interval fine.
//!
//! Change detection is behind a `ClipboardReader` trait so it's unit-testable
//! without a real OS clipboard (CI/sandboxed environments have no reliable,
//! deterministic clipboard state) — the same seam `input::dispatcher` already
//! uses (`InputBackend` + a mock) for its own OS-boundary calls.

use anyhow::{Context, Result};
use std::future::Future;
use std::time::Duration;

use crate::signaling::messages::Envelope;

// Bound the serialized UTF-8 message, not just text characters: JSON escaping
// can multiply its size. No chunking or signaling fallback for private data.
const MAX_CLIPBOARD_FRAME_BYTES: usize = 64 * 1024;
const CLIPBOARD_SEND_TIMEOUT: Duration = Duration::from_millis(250);

pub(super) async fn send_clipboard_update<F, Fut>(room_id: &str, text: &str, send: F) -> Result<()>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    anyhow::ensure!(
        text.len() < MAX_CLIPBOARD_FRAME_BYTES,
        "clipboard text exceeds transport limit"
    );
    let frame = serde_json::to_string(&Envelope::clipboard_update(room_id, text))?;
    anyhow::ensure!(
        frame.len() <= MAX_CLIPBOARD_FRAME_BYTES,
        "clipboard frame exceeds transport limit"
    );
    // Clipboard is best-effort. A stalled SCTP write must not keep the session
    // loop from receiving a controller-close/revoke event indefinitely.
    tokio::time::timeout(CLIPBOARD_SEND_TIMEOUT, send(frame))
        .await
        .context("clipboard send timed out")?
}

pub trait ClipboardReader: Send {
    fn read(&mut self) -> Result<String>;
}

/// The real backend. Goes through [`crate::clipboard`], which serializes every
/// OS clipboard access process-wide — this poll runs on the session tick while
/// the `InputWorker` thread may be writing the clipboard for a phone paste, and
/// `NSPasteboard` is not thread-safe (CRASH-1).
pub struct SystemClipboardReader;

impl ClipboardReader for SystemClipboardReader {
    fn read(&mut self) -> Result<String> {
        crate::clipboard::read_text()
    }
}

pub struct ClipboardWatcher<R: ClipboardReader = SystemClipboardReader> {
    reader: R,
    last_text: Option<String>,
}

impl ClipboardWatcher<SystemClipboardReader> {
    pub fn new() -> Self {
        Self::with_reader(SystemClipboardReader)
    }
}

impl Default for ClipboardWatcher<SystemClipboardReader> {
    fn default() -> Self {
        Self::new()
    }
}

impl<R: ClipboardReader> ClipboardWatcher<R> {
    fn with_reader(reader: R) -> Self {
        Self {
            reader,
            last_text: None,
        }
    }

    /// Seed the "last seen" value with whatever's on the clipboard right now,
    /// without reporting it as a change. Call once when the peer first
    /// connects, so content already on the clipboard before the session
    /// started isn't immediately pushed to a freshly-connected phone.
    pub fn seed(&mut self) {
        self.last_text = self
            .reader
            .read()
            .ok()
            .filter(|text| text.len() < MAX_CLIPBOARD_FRAME_BYTES);
    }

    /// Check the clipboard; returns `Some(text)` only if it changed since the
    /// last `seed`/`poll` call. A read failure (e.g. another app briefly
    /// holds the clipboard) is treated as "no change this tick," not an
    /// error — the next poll tries again.
    pub fn poll(&mut self) -> Option<String> {
        let text = self.reader.read().ok()?;
        if text.len() >= MAX_CLIPBOARD_FRAME_BYTES {
            return None;
        }
        if self.last_text.as_deref() == Some(text.as_str()) {
            return None;
        }
        self.last_text = Some(text.clone());
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn encrypted_transport_uses_the_existing_clipboard_envelope() {
        send_clipboard_update("room-1", "private \"text\" 🪷", |frame| async move {
            let value: serde_json::Value = serde_json::from_str(&frame)?;
            assert_eq!(value["type"], "clipboard-update");
            assert_eq!(value["roomId"], "room-1");
            assert_eq!(value["from"], "desktop");
            assert_eq!(value["payload"]["text"], "private \"text\" 🪷");
            assert!(frame.len() <= MAX_CLIPBOARD_FRAME_BYTES);
            Ok(())
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn oversized_serialized_utf8_never_reaches_the_transport() {
        for text in [
            "x".repeat(MAX_CLIPBOARD_FRAME_BYTES),
            "🪷".repeat(MAX_CLIPBOARD_FRAME_BYTES / 4),
            "\u{0001}".repeat(MAX_CLIPBOARD_FRAME_BYTES / 6),
        ] {
            assert!(send_clipboard_update("room-1", &text, |_| async {
                panic!("oversized private frame reached the transport");
            })
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn closed_or_stalled_transport_is_bounded_and_has_no_fallback() {
        let error = send_clipboard_update("room-1", "text", |_| async {
            anyhow::bail!("channel closed")
        })
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "channel closed");
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            send_clipboard_update("room-1", "text", |_| std::future::pending()),
        )
        .await
        .expect("clipboard stalled session teardown");
        assert_eq!(result.unwrap_err().to_string(), "clipboard send timed out");
    }

    struct FakeReader(std::collections::VecDeque<Result<String>>);

    impl FakeReader {
        fn ok_values(values: &[&str]) -> Self {
            Self(values.iter().map(|v| Ok(v.to_string())).collect())
        }
    }

    impl ClipboardReader for FakeReader {
        fn read(&mut self) -> Result<String> {
            self.0
                .pop_front()
                .unwrap_or_else(|| Err(anyhow::anyhow!("no more fake clipboard values")))
        }
    }

    #[test]
    fn seed_then_poll_with_no_change_reports_none() {
        let mut w =
            ClipboardWatcher::with_reader(FakeReader::ok_values(&["pre-existing", "pre-existing"]));
        w.seed();
        assert_eq!(w.poll(), None);
    }

    #[test]
    fn poll_reports_a_real_change() {
        let mut w = ClipboardWatcher::with_reader(FakeReader::ok_values(&["first", "second"]));
        w.seed();
        assert_eq!(w.poll(), Some("second".to_string()));
    }

    #[test]
    fn a_reported_change_is_not_reported_again_on_the_next_poll() {
        let mut w =
            ClipboardWatcher::with_reader(FakeReader::ok_values(&["first", "second", "second"]));
        w.seed();
        assert_eq!(w.poll(), Some("second".to_string()));
        assert_eq!(w.poll(), None);
    }

    #[test]
    fn a_transient_read_failure_is_not_reported_as_a_change() {
        let mut w = ClipboardWatcher::with_reader(FakeReader::ok_values(&["first"]));
        w.seed();
        // The fake queue is now empty — the next read fails.
        assert_eq!(w.poll(), None);
    }

    #[test]
    fn poll_without_a_prior_seed_reports_whatever_is_currently_there() {
        let mut w = ClipboardWatcher::with_reader(FakeReader::ok_values(&["new"]));
        assert_eq!(w.poll(), Some("new".to_string()));
    }

    #[test]
    fn reseeding_does_not_export_text_copied_while_the_viewer_was_paused() {
        let mut w = ClipboardWatcher::with_reader(FakeReader::ok_values(&[
            "before session",
            "while paused",
            "while paused",
            "after resume",
        ]));
        w.seed();
        w.seed();
        assert_eq!(w.poll(), None);
        assert_eq!(w.poll(), Some("after resume".to_string()));
    }

    #[test]
    fn large_clipboard_values_are_not_retained_and_later_changes_still_work() {
        let large = "x".repeat(MAX_CLIPBOARD_FRAME_BYTES);
        let mut w = ClipboardWatcher::with_reader(FakeReader::ok_values(&[
            &large, &large, "small", "small",
        ]));
        w.seed();
        assert!(w.last_text.is_none());
        assert_eq!(w.poll(), None);
        assert!(w.last_text.is_none());
        assert_eq!(w.poll(), Some("small".to_string()));
        assert_eq!(w.poll(), None);
    }
}
