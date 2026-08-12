//! The single owner of OS clipboard access (CRASH-1).
//!
//! Two subsystems touch the clipboard from different threads:
//!   - [`crate::session::clipboard_watcher`] READS it on the session tick
//!     (every 750ms) to push desktop→phone clipboard updates.
//!   - [`crate::input`] backends WRITE it when the phone pastes, from the
//!     `InputWorker`'s own thread.
//!
//! Neither is the main thread, and `NSPasteboard` is **not thread-safe**.
//! Concurrent access corrupted AppKit's internal type cache and killed the
//! process with `EXC_BAD_ACCESS` inside `-[NSPasteboard _updateTypeCacheIfNeeded]`
//! — observed as a SIGSEGV in roughly one run in three of
//! `tests/session_connect_lifecycle.rs`, which drives exactly this pair of
//! threads. In production it would crash the desktop app mid-session whenever a
//! poll happened to race a paste.
//!
//! The fix is to funnel every access through one process-wide lock. This module
//! deliberately exposes **functions, not the lock**: handing callers a mutex
//! they must remember to take would leave the same bug one forgotten line away,
//! and forgetting it is precisely how this happened. `arboard` is not
//! referenced anywhere else in the crate — that is the invariant to preserve.
//!
//! ponytail: a lock, not main-thread dispatch. It removes the concurrent access
//! the crash log actually points at, and keeps these paths usable from the
//! headless integration tests, which construct them without a Tauri app handle.
//! If a pasteboard crash ever recurs *without* concurrency, the next step is
//! `AppHandle::run_on_main_thread` — that is the stricter AppKit posture.

use std::sync::{Mutex, MutexGuard};

use anyhow::Result;

/// Serializes every OS clipboard operation in this process.
static CLIPBOARD_LOCK: Mutex<()> = Mutex::new(());

/// Take the lock, recovering from poisoning.
///
/// A panic in another clipboard caller says nothing about the OS pasteboard's
/// integrity, and refusing to sync the clipboard forever afterwards would be a
/// worse outcome than proceeding — the same stance the app takes for its other
/// long-lived locks (see `commands::lock_state`).
fn lock() -> MutexGuard<'static, ()> {
    CLIPBOARD_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Read the clipboard's text content.
pub fn read_text() -> Result<String> {
    let _guard = lock();
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| anyhow::anyhow!("clipboard unavailable: {e}"))?;
    clipboard
        .get_text()
        .map_err(|e| anyhow::anyhow!("clipboard read failed: {e}"))
}

/// Replace the clipboard's text content.
pub fn write_text(text: &str) -> Result<()> {
    let _guard = lock();
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| anyhow::anyhow!("clipboard unavailable: {e}"))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| anyhow::anyhow!("failed to set clipboard: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lock must be re-entrant across sequential calls (i.e. actually
    /// released), or the first clipboard read would deadlock the session tick
    /// forever. Cheap, but this is the failure that would be catastrophic and
    /// silent.
    #[test]
    fn the_lock_is_released_between_calls() {
        let _ = read_text();
        let _ = read_text();
        let _ = write_text("lilypad-lock-release-check");
    }

    /// A poisoned lock must not permanently disable clipboard sync.
    #[test]
    fn a_poisoned_lock_is_recovered() {
        let result = std::panic::catch_unwind(|| {
            let _guard = lock();
            panic!("poison the clipboard lock");
        });
        assert!(result.is_err(), "the panic should have been caught");
        // Poisoned now — this would return Err from `.lock()` without recovery.
        let _guard = lock();
    }
}
