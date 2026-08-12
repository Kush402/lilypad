//! Desktop → phone clipboard sync: watches the OS clipboard for changes so
//! `run_session` can push a `clipboard-update` signaling message. The other
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

use anyhow::Result;

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
        self.last_text = self.reader.read().ok();
    }

    /// Check the clipboard; returns `Some(text)` only if it changed since the
    /// last `seed`/`poll` call. A read failure (e.g. another app briefly
    /// holds the clipboard) is treated as "no change this tick," not an
    /// error — the next poll tries again.
    pub fn poll(&mut self) -> Option<String> {
        let text = self.reader.read().ok()?;
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
}
