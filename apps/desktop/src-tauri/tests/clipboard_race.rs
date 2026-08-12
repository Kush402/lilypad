//! Regression test for CRASH-1 — the `NSPasteboard` data race.
//!
//! Two threads used to touch the OS clipboard with no synchronization between
//! them: the session runner's `ClipboardWatcher` polls it every 750ms
//! (`session/clipboard_watcher.rs`) while the `InputWorker` writes it whenever
//! the phone pastes (`input/macos.rs::set_clipboard`). Both constructed a fresh
//! `arboard::Clipboard` per call, off the main thread.
//!
//! `NSPasteboard` is not thread-safe. Concurrent access corrupted AppKit's
//! internal type cache and aborted the process with `EXC_BAD_ACCESS` inside
//! `-[NSPasteboard _updateTypeCacheIfNeeded]` — reproduced live as a SIGSEGV in
//! roughly one run in three of `tests/session_connect_lifecycle.rs`, which
//! drives exactly this pair of threads.
//!
//! This test hammers the read and write paths concurrently. Before the fix it
//! segfaults (killing the whole test binary, not just failing an assertion);
//! after it, `clipboard::read_text`/`write_text` serialize every access through
//! one process-wide lock and it completes cleanly.
//!
//! Note the failure mode: a segfault takes the process down, so this test
//! cannot "fail" politely. A crashed binary IS the failure signal.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use lilypad_desktop_lib::clipboard;

/// Long enough to lose the race many times over if the lock is absent (the
/// original crash reproduced within a handful of interleavings), short enough
/// to stay a normal-speed test.
const DURATION: Duration = Duration::from_secs(3);
const WRITERS: usize = 3;
const READERS: usize = 3;

#[test]
fn concurrent_clipboard_read_and_write_does_not_crash() {
    // A headless/sandboxed CI box may have no usable pasteboard at all. That is
    // not a failure of this test — but a *partially* working clipboard still
    // exercises the race, so only skip when it is entirely unavailable.
    if clipboard::write_text("lilypad-crash1-probe").is_err() && clipboard::read_text().is_err() {
        eprintln!("no usable OS clipboard in this environment — skipping");
        return;
    }

    let stop = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::new();

    for i in 0..WRITERS {
        let stop = Arc::clone(&stop);
        handles.push(thread::spawn(move || {
            let mut n = 0u64;
            while !stop.load(Ordering::Relaxed) {
                // Ignore errors: another app can legitimately hold the
                // pasteboard. We are testing that we do not CRASH, not that
                // every write lands.
                let _ = clipboard::write_text(&format!("writer-{i}-{n}"));
                n += 1;
            }
        }));
    }

    for _ in 0..READERS {
        let stop = Arc::clone(&stop);
        handles.push(thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let _ = clipboard::read_text();
            }
        }));
    }

    let start = Instant::now();
    while start.elapsed() < DURATION {
        thread::sleep(Duration::from_millis(50));
    }
    stop.store(true, Ordering::Relaxed);

    for h in handles {
        h.join().expect("a clipboard thread panicked");
    }
    // Reaching here without the process dying is the assertion.
}
