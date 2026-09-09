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

pub use profile::{is_denied_read, SandboxPolicy};

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

// Seatbelt compares real paths. CI and some Macs install Xcode.app as a
// symlink to Xcode_<version>.app. Accept only that layout directly under
// /Applications, never a symlink into a user's data or an arbitrary app.
fn supported_xcode_bundle(path: &Path) -> bool {
    if path.parent() != Some(Path::new("/Applications")) {
        return false;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    name == "Xcode.app"
        || name
            .strip_prefix("Xcode_")
            .and_then(|name| name.strip_suffix(".app"))
            .is_some_and(|version| {
                !version.is_empty()
                    && version
                        .split('.')
                        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            })
}

fn resolved_xcode_runtime_roots() -> Vec<PathBuf> {
    let Ok(bundle) = std::fs::canonicalize("/Applications/Xcode.app") else {
        return Vec::new();
    };
    if !supported_xcode_bundle(&bundle) {
        return Vec::new();
    }
    [
        "Contents/Developer",
        "Contents/SharedFrameworks",
        "Contents/Frameworks",
    ]
    .into_iter()
    .filter_map(|suffix| {
        let expected = bundle.join(suffix);
        let resolved = std::fs::canonicalize(&expected).ok()?;
        // Do not grant a runtime directory redirected outside its bundle.
        (resolved == expected).then_some(resolved)
    })
    .collect()
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
    // /usr/bin/python3 is an Xcode discovery shim. Running it in the
    // sandbox starts xcodebuild and probes unrelated caches. Use an installed
    // interpreter directly; do not broaden data access to make the shim work.
    let program = if program == "/usr/bin/python3" {
        [
            "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
            "/Library/Developer/CommandLineTools/usr/bin/python3",
        ].into_iter().find(|p| Path::new(p).is_file())
            .ok_or_else(|| anyhow!("Python execution requires a supported Xcode or Command Line Tools interpreter; no script was started"))?
    } else {
        program
    };
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
        readable_paths: policy.readable_paths.clone(),
        allow_network: policy.allow_network,
    };

    let profile_text =
        profile::build_profile_with_runtime_roots(&policy, home, &resolved_xcode_runtime_roots());
    let profile_path: PathBuf = policy.scratch_dir.join("sandbox.sb");
    tokio::fs::write(&profile_path, &profile_text)
        .await
        .context("writing sandbox profile")?;

    // Build via std so we can set a pre_exec hook, then hand to tokio.
    let mut std_cmd = std::process::Command::new("/usr/bin/sandbox-exec");
    std_cmd
        // The desktop may hold API credentials in environment overrides.
        // Filesystem policy cannot protect inherited process memory.
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", home)
        .env("TMPDIR", &policy.scratch_dir)
        .env("LANG", "en_US.UTF-8")
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONSAFEPATH", "1")
        .current_dir(&policy.scratch_dir)
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

    let group = ProcessGroup(pid);
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

    // A child can exit while its descendants retain the pipes. Retire those
    // descendants before waiting for EOF, including on normal completion.
    drop(group);
    let stdout = out_task.await.unwrap_or_default();
    let stderr = err_task.await.unwrap_or_default();

    Ok(SandboxOutcome {
        exit_code: status.code(),
        stdout,
        stderr,
        timed_out,
    })
}

/// Cancellation drops the future before its timeout branch can run. The
/// process group must therefore be owned by a drop guard, not only that branch.
struct ProcessGroup(i32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::killpg(self.0, libc::SIGKILL);
        }
    }
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
    #[test]
    fn xcode_runtime_aliases_only_accept_explicit_versioned_bundles() {
        use super::supported_xcode_bundle;
        use std::path::Path;
        for path in [
            "/Applications/Xcode.app",
            "/Applications/Xcode_26.6.app",
            "/Applications/Xcode_16.app",
        ] {
            assert!(supported_xcode_bundle(Path::new(path)), "{path}");
        }
        for path in [
            "/Users/test/Xcode_26.6.app",
            "/Applications/Other.app",
            "/Applications/Xcode_.app",
            "/Applications/Xcode_26..6.app",
            "/Applications/Xcode_26.6.app/Contents",
            "/Applications/Xcode_secrets.app",
        ] {
            assert!(!supported_xcode_bundle(Path::new(path)), "{path}");
        }
    }

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
        assert!(
            !Path::new(&forbidden).exists(),
            "the file must not have been created"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// L-247. The real boundary, exercised against a real `sandbox-exec`: a
    /// file the person owns is unreadable unless it was granted, and granting
    /// it opens exactly that path and nothing beside it.
    ///
    /// Written as one test because the two halves are one claim — a denial
    /// that also denies the granted case proves only that the sandbox is
    /// broken.
    #[tokio::test]
    async fn a_home_file_is_unreadable_until_it_is_granted() {
        if !sandbox_available() {
            return;
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let home = PathBuf::from(home);
        let dir = scratch("read_grant");
        let doc_dir = home.join(format!("lilypad_read_test_{}", std::process::id()));
        let doc = doc_dir.join("private.txt");
        let neighbour = doc_dir.join("other.txt");
        std::fs::create_dir_all(&doc_dir).unwrap();
        std::fs::write(&doc, "canary-42").unwrap();
        std::fs::write(&neighbour, "canary-99").unwrap();

        let read =
            |target: &std::path::Path| vec!["-c".to_string(), format!("cat {}", target.display())];

        // 1. No grant: denied. This is the case that used to succeed and hand
        //    the contents to the model provider through stdout.
        let denied = run(
            &SandboxPolicy::read_only(dir.clone()),
            &SandboxLimits::default(),
            "/bin/sh",
            &read(&doc),
            &home,
        )
        .await
        .unwrap();
        assert!(!denied.succeeded(), "an ungranted home file was readable");
        assert!(
            !denied.stdout.contains("canary-42"),
            "the file's contents reached stdout: {}",
            denied.stdout
        );

        // 2. Granted: readable.
        let mut policy = SandboxPolicy::read_only(dir.clone());
        policy.readable_paths = vec![doc.clone()];
        let allowed = run(
            &policy,
            &SandboxLimits::default(),
            "/bin/sh",
            &read(&doc),
            &home,
        )
        .await
        .unwrap();
        assert!(
            allowed.succeeded(),
            "a granted read failed: {}",
            allowed.stderr
        );
        assert!(allowed.stdout.contains("canary-42"));

        // 3. The grant is the path, not its folder: the sibling stays denied.
        let sibling = run(
            &policy,
            &SandboxLimits::default(),
            "/bin/sh",
            &read(&neighbour),
            &home,
        )
        .await
        .unwrap();
        assert!(
            !sibling.stdout.contains("canary-99"),
            "the grant widened past its own path: {}",
            sibling.stdout
        );

        std::fs::remove_dir_all(&doc_dir).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A grant can never re-open a secret path: SBPL denies win over allows
    /// regardless of order, so even an approved `~/.ssh` stays unreadable.
    #[tokio::test]
    async fn an_approved_grant_cannot_reopen_a_secret_path() {
        if !sandbox_available() {
            return;
        }
        let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
        let dir = scratch("grant_vs_secret");
        let secret_dir = home.join(".config");
        let secret = secret_dir.join(format!("lilypad_grant_test_{}", std::process::id()));
        std::fs::create_dir_all(&secret_dir).ok();
        if std::fs::write(&secret, "canary-secret").is_err() {
            std::fs::remove_dir_all(&dir).ok();
            return; // cannot stage the fixture on this machine
        }
        let mut policy = SandboxPolicy::read_only(dir.clone());
        policy.readable_paths = vec![secret.clone()];
        let outcome = run(
            &policy,
            &SandboxLimits::default(),
            "/bin/sh",
            &["-c".into(), format!("cat {}", secret.display())],
            &home,
        )
        .await
        .unwrap();
        assert!(
            !outcome.stdout.contains("canary-secret"),
            "an approval card re-opened a secret path: {}",
            outcome.stdout
        );
        std::fs::remove_file(&secret).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The interpreters really do start under the allow-list. A read boundary
    /// that also breaks `python3` would be reported as "the script failed",
    /// not as a security property.
    #[tokio::test]
    async fn the_supported_interpreters_still_start() {
        if !sandbox_available() {
            return;
        }
        let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
        for (program, args) in [
            (
                "/bin/sh",
                vec!["-c".to_string(), "echo started".to_string()],
            ),
            (
                "/usr/bin/python3",
                vec![
                    "-c".to_string(),
                    "import json,os,re;print('started')".to_string(),
                ],
            ),
        ] {
            if !Path::new(program).exists() {
                continue;
            }
            let dir = scratch(&format!("boot_{}", program.replace('/', "_")));
            let outcome = run(
                &SandboxPolicy::read_only(dir.clone()),
                &SandboxLimits::default(),
                program,
                &args,
                &home,
            )
            .await
            .unwrap();
            assert!(
                outcome.stdout.contains("started"),
                "{program} could not start under the read allow-list: {} / {}",
                outcome.stdout,
                outcome.stderr
            );
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[tokio::test]
    async fn wall_clock_timeout_kills_a_hung_script() {
        if !sandbox_available() {
            return;
        }
        let dir = scratch("timeout");
        let policy = SandboxPolicy::read_only(dir.clone());
        let limits = SandboxLimits {
            wall_timeout: Duration::from_millis(600),
            ..Default::default()
        };
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
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "kill was not prompt"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
    #[tokio::test]
    async fn cancelling_a_script_kills_its_background_descendants() {
        if !sandbox_available() {
            return;
        }
        let dir = scratch("cancel_descendants");
        let ready = dir.join("ready");
        let escaped = dir.join("late-write");
        let policy = SandboxPolicy::read_only(dir.clone());
        let script = format!(
            "(sleep 1; echo escaped > '{}') & echo ready > '{}'; wait",
            escaped.display(),
            ready.display()
        );
        let task = tokio::spawn(async move {
            run(
                &policy,
                &SandboxLimits::default(),
                "/bin/sh",
                &["-c".into(), script],
                Path::new("/tmp"),
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !ready.exists() {
                assert!(!task.is_finished(), "script failed before readiness");
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        assert!(!escaped.exists(), "a descendant kept executing after Stop");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn script_environment_does_not_inherit_desktop_variables() {
        if !sandbox_available() {
            return;
        }
        let dir = scratch("clean_env");
        let policy = SandboxPolicy::read_only(dir.clone());
        let result = run(
            &policy,
            &SandboxLimits::default(),
            "/usr/bin/env",
            &[],
            Path::new("/tmp"),
        )
        .await
        .unwrap();
        assert!(result.succeeded(), "{}", result.stderr);
        for line in result.stdout.lines() {
            let key = line.split('=').next().unwrap();
            assert!(
                [
                    "PATH",
                    "HOME",
                    "TMPDIR",
                    "LANG",
                    "PYTHONNOUSERSITE",
                    "PYTHONSAFEPATH"
                ]
                .contains(&key),
                "inherited unexpected environment key {key}"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn ungranted_neighboring_temp_file_is_not_readable() {
        if !sandbox_available() {
            return;
        }
        let dir = scratch("private_neighbor");
        let victim = scratch("ungranted_neighbor");
        let file = victim.join("private.txt");
        std::fs::write(&file, "synthetic-private-marker").unwrap();
        let result = run(
            &SandboxPolicy::read_only(dir.clone()),
            &SandboxLimits::default(),
            "/bin/cat",
            &[file.to_string_lossy().into_owned()],
            Path::new("/Users/test"),
        )
        .await
        .unwrap();
        assert!(!result.succeeded(), "ungranted temp file was readable");
        assert!(!result.stdout.contains("synthetic-private-marker"));
        // /System also contains the writable Data volume on modern macOS.
        // A runtime grant must not reopen the same file through that alias.
        let canonical = file.canonicalize().unwrap();
        let alias = Path::new("/System/Volumes/Data").join(canonical.strip_prefix("/").unwrap());
        if alias.exists() {
            let aliased = run(
                &SandboxPolicy::read_only(dir.clone()),
                &SandboxLimits::default(),
                "/bin/cat",
                &[alias.to_string_lossy().into_owned()],
                Path::new("/Users/test"),
            )
            .await
            .unwrap();
            assert!(
                !aliased.succeeded(),
                "Data-volume alias reopened an ungranted file"
            );
        }

        std::fs::remove_dir_all(dir).ok();
        std::fs::remove_dir_all(victim).ok();
    }
}
