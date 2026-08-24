//! A log file on disk, because stderr goes nowhere for a customer.
//!
//! `env_logger` writes to stderr, and a `.app` launched from Finder or by the
//! login-item LaunchAgent has no stderr anyone can read. So every
//! `log::info!`/`warn!` in this crate — ICE restarts, the candidate pair that
//! won, encoder mode switches, permission denials, signaling drops — was
//! written to a stream nobody was listening to.
//!
//! That is only a developer inconvenience until a customer says the session
//! was "wobbly on cellular". Then it is the difference between an answer and a
//! guess: the backend's own log can show that a phone stopped heart-beating,
//! and nothing on the Mac can say whether media was still flowing, whether ICE
//! had restarted, or which path it was on. Reconstructed on 2026-08-24 against
//! a real session, that was exactly the wall.
//!
//! `~/Library/Logs/Lilypad/` is where a Mac app is supposed to put this: it is
//! the directory Console.app lists under "Log Reports", it needs no
//! entitlement, and it is the path a support conversation can name out loud.
//!
//! Deliberately small: two files, a byte cap, no dependency, and stderr still
//! gets everything so `cargo run` is unchanged.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;

/// Roll over at this size. Two files means a customer who reproduces a problem
/// still has the run before it — and 5 MB of `info` lines is many hours of
/// sessions, while staying small enough to attach to an email.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

fn log_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Logs/Lilypad"))
}

/// `~/Library/Logs/Lilypad/lilypad.log`, for the UI to show and support to ask
/// for. `None` only when `HOME` is unset, which no GUI launch does.
pub fn path() -> Option<PathBuf> {
    Some(log_dir()?.join("lilypad.log"))
}

/// Writes to a size-capped file, rolling `lilypad.log` to `lilypad.log.1` when
/// it gets too big.
///
/// The count starts from the file's existing length rather than zero, or an app
/// that is restarted often would never reach the cap and would grow without
/// bound — the failure this type exists to prevent.
struct RotatingFile {
    dir: PathBuf,
    file: File,
    written: u64,
}

impl RotatingFile {
    /// Takes its directory rather than reading `HOME` itself, so the tests
    /// below need no process-global environment mutation — two of them running
    /// in parallel would otherwise race over the same `HOME` and each observe
    /// the other's directory.
    fn open_in(dir: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let path = dir.join("lilypad.log");
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self { dir, file, written })
    }

    fn rotate(&mut self) -> io::Result<()> {
        let path = self.dir.join("lilypad.log");
        // Rename rather than copy: an open descriptor keeps writing to the
        // renamed inode, so the swap has to be followed by a fresh open before
        // anything else is written.
        fs::rename(&path, self.dir.join("lilypad.log.1"))?;
        self.file = OpenOptions::new().create(true).append(true).open(&path)?;
        self.written = 0;
        Ok(())
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written >= MAX_BYTES {
            // A failed rotation must not lose the line or kill the process —
            // keep appending to the file we already hold and try again next
            // write. An oversized log is a far smaller problem than a crash in
            // the logger.
            let _ = self.rotate();
        }
        let n = self.file.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// The file and stderr at once.
///
/// Losing stderr would make `cargo run` and `tail -f` a choice rather than
/// both, and the file must never be the reason a developer stops seeing
/// output.
struct Tee(RotatingFile);

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // stderr first and unconditionally: if the disk is full or the
        // directory is not writable, the developer still sees the line.
        let _ = io::stderr().write_all(buf);
        // A write failure here is reported as success on purpose. The
        // alternative is `log` seeing an error on every line for the rest of
        // the run, and a full disk must not turn logging into a second fault.
        let _ = self.0.write_all(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let _ = io::stderr().flush();
        self.0.flush()
    }
}

/// A target for `env_logger`, or `None` if the file could not be opened — in
/// which case the caller keeps its stderr-only default rather than starting
/// with no logger at all.
pub fn target() -> Option<Box<dyn Write + Send + 'static>> {
    let file = RotatingFile::open_in(log_dir()?).ok()?;
    Some(Box::new(Tee(file)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lilypad-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// The bug this type exists to avoid: counting from zero on every open
    /// means an app restarted more often than it logs `MAX_BYTES` never
    /// rotates, and the file grows for as long as the app is installed.
    #[test]
    fn a_reopened_file_keeps_counting_from_its_existing_length() {
        let dir = scratch("reopen");
        {
            let mut f = RotatingFile::open_in(dir.clone()).unwrap();
            f.write_all(b"first run\n").unwrap();
            assert_eq!(f.written, 10);
        }
        let f = RotatingFile::open_in(dir.clone()).unwrap();
        assert_eq!(f.written, 10, "reopen must not reset the byte count");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Rotation has to leave the NEW file empty and the old lines recoverable,
    /// not truncate the run that is still being diagnosed.
    #[test]
    fn rotating_preserves_the_previous_file_and_starts_the_new_one_empty() {
        let dir = scratch("rotate");
        let mut f = RotatingFile::open_in(dir.clone()).unwrap();
        f.write_all(b"old line\n").unwrap();
        f.rotate().unwrap();
        f.write_all(b"new line\n").unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("lilypad.log.1")).unwrap(),
            "old line\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("lilypad.log")).unwrap(),
            "new line\n"
        );
        assert_eq!(
            f.written, 9,
            "the new file's count restarts at its own size"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The cap has to actually fire. Writing past `MAX_BYTES` must roll the
    /// file rather than let one run grow without limit on a customer's disk.
    #[test]
    fn a_file_past_the_cap_rolls_on_the_next_write() {
        let dir = scratch("cap");
        let mut f = RotatingFile::open_in(dir.clone()).unwrap();
        // Pretend the file is already full rather than writing 5 MB.
        f.written = MAX_BYTES;
        f.write_all(b"the line that triggers it\n").unwrap();
        assert!(dir.join("lilypad.log.1").exists(), "the old file was kept");
        assert!(f.written < MAX_BYTES, "the counter restarted");
        assert_eq!(
            fs::read_to_string(dir.join("lilypad.log")).unwrap(),
            "the line that triggers it\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The logger must never be a second fault. A directory that cannot be
    /// created yields no target, and the caller keeps plain stderr.
    #[test]
    fn an_unwritable_directory_yields_no_target_instead_of_failing() {
        let dir = scratch("unwritable");
        fs::create_dir_all(&dir).unwrap();
        // A regular file where the log directory should be: `create_dir_all`
        // cannot succeed against it.
        let blocked = dir.join("not-a-dir");
        fs::write(&blocked, b"x").unwrap();
        assert!(RotatingFile::open_in(blocked.join("Lilypad")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
