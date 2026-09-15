//! Single-instance guard.
//!
//! Two Lilypad desktops running at once is not hypothetical: the launch-at-login
//! LaunchAgent (`autostart.rs`, `RunAtLoad`) starts one at login, and the user
//! (or a dev rebuild) can start another by hand. Both share the same persisted
//! device id, so both register the SAME backend presence room — and the hub
//! keeps only the newest socket, evicting the other, which immediately
//! reconnects and evicts it back. The result is a ~1 Hz `presence online →
//! socket closed` war (observed live 2026-07-20) that reads to the phone as the
//! desktop constantly dropping and returning: the "connection keeps
//! reconnecting/recovering" churn, entirely separate from the media path.
//!
//! The fix is what every well-behaved background macOS app does: hold an
//! advisory lock on a fixed per-user file for the process lifetime. The first
//! instance takes it; any later instance finds it held and exits quietly,
//! leaving exactly one owner of the presence room, the tray, and the bubble.
//!
//! `flock` is the right primitive here (not a pidfile): the lock is released
//! automatically when the holder's fd closes — i.e. on exit OR crash — so there
//! is never a stale lock to clean up, and no race between checking a pid and
//! writing one.

use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Tauri restarts by spawning the successor immediately before the old process
/// exits. The predecessor still owns this process-lifetime lock in that small
/// window, so a purely non-blocking acquisition can reject the one successor
/// the updater just launched. Wait briefly for an orderly handoff; a genuine
/// second manual launch still exits after this bounded delay.
const INSTANCE_HANDOFF_WAIT: Duration = Duration::from_secs(2);
const INSTANCE_HANDOFF_POLL: Duration = Duration::from_millis(20);

/// Held for the whole process lifetime — dropping it (closing the fd) releases
/// the advisory lock, so we deliberately keep it alive by storing it in a
/// leaked `static` from `acquire_or_exit`. Never closed explicitly.
pub struct InstanceLock {
    _file: std::fs::File,
}

/// The lock file path: a fixed, per-user location that does not depend on
/// anything we have to load first (unlike the app config dir, which the device
/// id itself is read from). `TMPDIR` is per-user on macOS and survives for the
/// login session, which is exactly the scope we want the lock to cover.
fn lock_path() -> PathBuf {
    std::env::temp_dir().join("com.takedia.lilypad.desktop.instance.lock")
}

/// Try to become the single instance. Returns `Some(lock)` for the first
/// instance (caller must keep it alive), `None` if another instance already
/// holds the lock — the caller should then exit without touching presence, the
/// tray, or any other shared resource.
///
/// A filesystem error (can't create the lock file at all) fails OPEN — better
/// to run than to refuse to start over a lock we couldn't even create. That
/// only reintroduces the two-instance case in the rare event the temp dir is
/// unwritable, which is strictly better than never launching.
pub fn try_acquire() -> Option<InstanceLock> {
    try_acquire_path(&lock_path(), INSTANCE_HANDOFF_WAIT)
}

fn try_acquire_path(path: &std::path::Path, wait: Duration) -> Option<InstanceLock> {
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
    {
        Ok(f) => f,
        Err(e) => {
            log::warn!(
                target: "lilypad::instance",
                "could not open instance lock {}: {e} — proceeding without single-instance guard",
                path.display()
            );
            // Fail open: return a lock backed by a throwaway handle isn't
            // possible, so signal "we're the instance" by opening /dev/null.
            return std::fs::File::open("/dev/null")
                .ok()
                .map(|_file| InstanceLock { _file });
        }
    };

    // Non-blocking per attempt so a genuinely live predecessor cannot hang
    // launch. EWOULDBLOCK means either a second manual instance OR the updater
    // successor arriving a few milliseconds before its parent exits; only the
    // bounded handoff wait can distinguish those outcomes safely.
    let deadline = Instant::now() + wait;
    loop {
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            return Some(InstanceLock { _file: file });
        }
        let error = std::io::Error::last_os_error();
        let error_code = error.raw_os_error();
        if error_code != Some(libc::EWOULDBLOCK) && error_code != Some(libc::EAGAIN) {
            // Same fail-open posture as an unopenable lock file: an advisory
            // guard malfunction must not make the app impossible to launch.
            log::warn!(
                target: "lilypad::instance",
                "could not lock instance file {}: {error} — proceeding without single-instance guard",
                path.display()
            );
            return Some(InstanceLock { _file: file });
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(
            INSTANCE_HANDOFF_POLL.min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "lilypad-instance-{name}-{}-{:?}.lock",
            std::process::id(),
            std::thread::current().id()
        ))
    }

    /// The updater's process order is successor starts → predecessor exits.
    /// A zero-wait lock rejects that successor; the production wait must let it
    /// take ownership once the predecessor releases the descriptor.
    #[test]
    fn a_relaunch_successor_waits_for_the_predecessors_lock_handoff() {
        let path = scratch("handoff");
        let first = try_acquire_path(&path, Duration::ZERO).expect("first instance");
        let contender_path = path.clone();
        let contender = std::thread::spawn(move || {
            try_acquire_path(&contender_path, Duration::from_millis(500))
        });
        std::thread::sleep(Duration::from_millis(60));
        drop(first);

        let second = contender.join().unwrap();
        assert!(second.is_some(), "the updater successor was discarded");
        drop(second);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_real_second_instance_still_gives_up_after_the_bound() {
        let path = scratch("occupied");
        let first = try_acquire_path(&path, Duration::ZERO).expect("first instance");
        let started = Instant::now();
        let second = try_acquire_path(&path, Duration::from_millis(60));

        assert!(second.is_none());
        assert!(started.elapsed() >= Duration::from_millis(40));
        drop(first);
        let _ = std::fs::remove_file(path);
    }
}
