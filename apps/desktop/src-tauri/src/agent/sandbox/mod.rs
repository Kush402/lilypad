//! The sandbox subsystem — runs an untrusted command under macOS Seatbelt
//! (`sandbox-exec`) with resource limits, a wall-clock timeout, and bounded
//! output capture. Prerequisite for Priority-2 (model-generated code); this
//! slice is the isolation harness only — nothing yet feeds it model output.
//!
//! Layering mirrors the rest of the agent: the security-critical decision (the
//! Seatbelt profile) is a pure, exhaustively-tested function in [`profile`];
//! this module is the thin, effectful runner around it.

pub mod profile;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::io::AsyncReadExt;

pub use profile::SandboxPolicy;

/// Per-run resource ceilings, enforced via `setrlimit` in the child before it
/// execs (plus a wall-clock timeout the parent enforces).
#[derive(Debug, Clone)]
pub struct SandboxLimits {
    pub cpu_seconds: u64,
    pub max_address_space_bytes: u64,
    pub max_file_bytes: u64,
    pub max_open_files: u64,
    pub wall_timeout: Duration,
}

impl Default for SandboxLimits {
    fn default() -> Self {
        SandboxLimits {
            cpu_seconds: 10,
            max_address_space_bytes: 512 * 1024 * 1024, // 512 MiB
            max_file_bytes: 32 * 1024 * 1024,           // 32 MiB per file
            max_open_files: 256,
            wall_timeout: Duration::from_secs(15),
        }
    }
}

/// Captured result of a sandboxed run.
#[derive(Debug, Clone)]
pub struct SandboxOutcome {
    /// Exit code, or `None` if the process was killed by a signal (timeout).
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// True if the wall-clock timeout fired and we killed the process group.
    pub timed_out: bool,
}

impl SandboxOutcome {
    pub fn succeeded(&self) -> bool {
        !self.timed_out && self.exit_code == Some(0)
    }
}

/// Cap on captured stdout/stderr — a runaway script can't OOM us via pipe
/// output. Bytes past the cap are drained and discarded so the child never
/// blocks on a full pipe.
const OUTPUT_CAP_BYTES: usize = 64 * 1024;

#[cfg(unix)]
fn apply_rlimit(resource: libc::c_int, limit: u64) {
    // SAFETY: `setrlimit` is async-signal-safe and called in the forked child
    // before exec; `rl` is a fully-initialized POD struct.
    let rl = libc::rlimit {
        rlim_cur: limit as libc::rlim_t,
        rlim_max: limit as libc::rlim_t,
    };
    unsafe {
        libc::setrlimit(resource, &rl);
    }
}

/// Run `program args…` inside the Seatbelt sandbox described by `policy`, under
/// `limits`. `home` anchors the profile's sensitive-path denies. The profile is
/// written into the policy's scratch dir (which the caller owns and cleans up).
pub async fn run(
    policy: &SandboxPolicy,
    limits: &SandboxLimits,
    program: &str,
    args: &[String],
    home: &Path,
) -> Result<SandboxOutcome> {
    // Canonicalize the scratch dir: Seatbelt matches on the REAL path, so a
    // symlinked prefix (e.g. /tmp → /private/tmp) would make the write-jail
    // allow a directory the script actually sees under a different path. The
    // dir must exist before canonicalize resolves it.
    tokio::fs::create_dir_all(&policy.scratch_dir)
        .await
        .with_context(|| format!("creating scratch dir {}", policy.scratch_dir.display()))?;
    let real_scratch = tokio::fs::canonicalize(&policy.scratch_dir)
        .await
        .with_context(|| format!("resolving scratch dir {}", policy.scratch_dir.display()))?;
    let policy = SandboxPolicy {
        scratch_dir: real_scratch,
        writable_paths: policy.writable_paths.clone(),
        allow_network: policy.allow_network,
    };

    let profile_text = profile::build_profile(&policy, home);
    let profile_path: PathBuf = policy.scratch_dir.join("sandbox.sb");
    tokio::fs::write(&profile_path, &profile_text)
        .await
        .context("writing sandbox profile")?;

    // Build via std so we can set a pre_exec hook, then hand to tokio.
    let mut std_cmd = std::process::Command::new("/usr/bin/sandbox-exec");
    std_cmd
        .arg("-f")
        .arg(&profile_path)
        .arg(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let cpu = limits.cpu_seconds;
    let as_bytes = limits.max_address_space_bytes;
    let fsize = limits.max_file_bytes;
    let nofile = limits.max_open_files;
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        std_cmd.pre_exec(move || {
            // New session/group so a timeout can kill the whole tree, not just
            // sandbox-exec (the interpreter runs as its child).
            libc::setsid();
            apply_rlimit(libc::RLIMIT_CPU, cpu);
            apply_rlimit(libc::RLIMIT_AS, as_bytes);
            apply_rlimit(libc::RLIMIT_FSIZE, fsize);
            apply_rlimit(libc::RLIMIT_NOFILE, nofile);
            Ok(())
        });
    }

    let mut child = tokio::process::Command::from(std_cmd)
        .kill_on_drop(true)
        .spawn()
        .context("spawning sandbox-exec")?;
    let pid = child
        .id()
        .ok_or_else(|| anyhow!("sandboxed child has no pid"))? as i32;

    let mut stdout_pipe = child.stdout.take().expect("piped");
    let mut stderr_pipe = child.stderr.take().expect("piped");
    let out_task = tokio::spawn(async move { read_capped(&mut stdout_pipe).await });
    let err_task = tokio::spawn(async move { read_capped(&mut stderr_pipe).await });

    let (status, timed_out) = match tokio::time::timeout(limits.wall_timeout, child.wait()).await {
        Ok(status) => (status.context("waiting for sandboxed child")?, false),
        Err(_) => {
            // Timeout: kill the whole process group (pid == group id via setsid).
            #[cfg(unix)]
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
            let status = child.wait().await.context("reaping killed child")?;
            (status, true)
        }
    };

    let stdout = out_task.await.unwrap_or_default();
    let stderr = err_task.await.unwrap_or_default();

    Ok(SandboxOutcome {
        exit_code: status.code(),
        stdout,
        stderr,
        timed_out,
    })
}

/// Read a pipe to EOF but keep only the first [`OUTPUT_CAP_BYTES`]; drain the
/// rest so the child never blocks writing. Lossy UTF-8 (script output isn't
/// guaranteed valid UTF-8).
async fn read_capped<R: AsyncReadExt + Unpin>(reader: &mut R) -> String {
    let mut kept: Vec<u8> = Vec::new();
    let mut scratch = [0u8; 8192];
    loop {
        match reader.read(&mut scratch).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if kept.len() < OUTPUT_CAP_BYTES {
                    let room = OUTPUT_CAP_BYTES - kept.len();
                    kept.extend_from_slice(&scratch[..n.min(room)]);
                }
                // else: discard, but keep draining until EOF.
            }
        }
    }
    String::from_utf8_lossy(&kept).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lilypad_sbx_{}_{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // These run a REAL sandbox-exec; skip if it's unavailable (non-macOS CI).
    fn sandbox_available() -> bool {
        Path::new("/usr/bin/sandbox-exec").exists()
    }

    #[tokio::test]
    async fn benign_write_into_scratch_succeeds() {
        if !sandbox_available() {
            return;
        }
        let dir = scratch("write_ok");
        let policy = SandboxPolicy::read_only(dir.clone());
        let target = dir.join("out.txt");
        let outcome = run(
            &policy,
            &SandboxLimits::default(),
            "/bin/sh",
            &["-c".into(), format!("echo hello > {}", target.display())],
            Path::new(&std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())),
        )
        .await
        .unwrap();
        assert!(outcome.succeeded(), "stderr: {}", outcome.stderr);
        assert_eq!(std::fs::read_to_string(&target).unwrap().trim(), "hello");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn write_outside_scratch_is_denied() {
        if !sandbox_available() {
            return;
        }
        let dir = scratch("write_denied");
        let policy = SandboxPolicy::read_only(dir.clone());
        // Attempt to write into the home dir — not in the writable set.
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let forbidden = format!("{home}/lilypad_should_not_exist_{}", std::process::id());
        let outcome = run(
            &policy,
            &SandboxLimits::default(),
            "/bin/sh",
            &["-c".into(), format!("echo x > {forbidden}")],
            Path::new(&home),
        )
        .await
        .unwrap();
        assert!(!outcome.succeeded(), "write outside scratch should fail");
        assert!(!Path::new(&forbidden).exists(), "the file must not have been created");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn wall_clock_timeout_kills_a_hung_script() {
        if !sandbox_available() {
            return;
        }
        let dir = scratch("timeout");
        let policy = SandboxPolicy::read_only(dir.clone());
        let mut limits = SandboxLimits::default();
        limits.wall_timeout = Duration::from_millis(600);
        let start = std::time::Instant::now();
        let outcome = run(
            &policy,
            &limits,
            "/bin/sh",
            &["-c".into(), "sleep 30".into()],
            Path::new("/tmp"),
        )
        .await
        .unwrap();
        assert!(outcome.timed_out);
        assert!(!outcome.succeeded());
        assert!(start.elapsed() < Duration::from_secs(5), "kill was not prompt");
        std::fs::remove_dir_all(&dir).ok();
    }
}
