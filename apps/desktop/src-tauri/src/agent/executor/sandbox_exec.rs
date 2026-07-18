//! Tier "sandbox" (Priority 2) — run model-generated code under the Seatbelt
//! sandbox and feed its result back to the brain.
//!
//! This is where the LLM's `run_script` tool lands. The script text is never
//! trusted: the security gate has already classified it (`Consequential` →
//! held for the user's approval, or `Forbidden` → refused) BEFORE the runner
//! calls this executor, and the [`sandbox`](crate::agent::sandbox) harness
//! constrains what a script can do regardless of what it contains — writes
//! jailed, secrets unreadable, network off unless granted, CPU/mem/time
//! bounded. Every run's script + profile + output persist under the run dir
//! for audit.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Result};

use crate::agent::executor::verify::resolve_user_path;
use crate::agent::runner::{Executor, Observation};
use crate::agent::sandbox::{self, SandboxLimits, SandboxPolicy};
use crate::agent::security::ScriptLanguage;
use crate::agent::Action;

/// How much captured output to fold back to the model (the sandbox already
/// caps raw capture at 64 KiB; the brain needs far less to reason).
const OBSERVATION_OUTPUT_CAP: usize = 2000;

/// Tier-"sandbox" executor. Owns the per-run artifact root and a monotonic
/// counter so concurrent runs never collide on a scratch dir.
pub struct SandboxExecutor {
    runs_root: PathBuf,
    home: PathBuf,
    counter: u64,
}

impl SandboxExecutor {
    /// Build from the environment: run artifacts under
    /// `~/Library/Caches/Lilypad/ask-runs`. Deliberately NOT under
    /// `Application Support/Lilypad` — that dir is on the sandbox's read
    /// deny-list (it holds the key-store references), so a script placed there
    /// couldn't even be read by its own interpreter. Caches is unprivileged.
    pub fn from_env() -> Result<Self> {
        let home = std::env::var("HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("HOME is not set"))?;
        let home = PathBuf::from(home);
        let runs_root = home.join("Library/Caches/Lilypad").join("ask-runs");
        Ok(SandboxExecutor {
            runs_root,
            home,
            counter: 0,
        })
    }

    fn next_run_dir(&mut self) -> PathBuf {
        self.counter += 1;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        self.runs_root.join(format!("run-{nanos}-{}", self.counter))
    }
}

fn interpreter(language: ScriptLanguage) -> (&'static str, &'static str) {
    // (program, script file extension)
    match language {
        ScriptLanguage::Shell => ("/bin/sh", "sh"),
        ScriptLanguage::Python => ("/usr/bin/python3", "py"),
    }
}

impl Executor for SandboxExecutor {
    async fn execute(&mut self, action: &Action) -> Result<Observation> {
        let Action::RunScript {
            language,
            script,
            writable_paths,
            needs_network,
        } = action
        else {
            bail!("SandboxExecutor only handles RunScript, got {action:?}");
        };

        let (program, ext) = interpreter(*language);
        if !std::path::Path::new(program).exists() {
            return Ok(Observation::fail(format!(
                "interpreter {program} is not installed on this Mac"
            )));
        }

        // Home-jail every requested writable path (approved, but still jailed).
        let mut jailed_writables = Vec::with_capacity(writable_paths.len());
        for w in writable_paths {
            match resolve_user_path(w) {
                Ok(p) => jailed_writables.push(p),
                Err(e) => return Ok(Observation::fail(format!("writable path rejected: {e}"))),
            }
        }

        let scratch = self.next_run_dir();
        tokio::fs::create_dir_all(&scratch).await?;
        let script_path = scratch.join(format!("script.{ext}"));
        tokio::fs::write(&script_path, script).await?;

        let policy = SandboxPolicy {
            scratch_dir: scratch.clone(),
            writable_paths: jailed_writables,
            allow_network: *needs_network,
        };
        let outcome = sandbox::run(
            &policy,
            &SandboxLimits::default(),
            program,
            &[script_path.to_string_lossy().into_owned()],
            &self.home,
        )
        .await?;

        // Persist a summary beside the script + profile for audit.
        let _ = tokio::fs::write(
            scratch.join("output.txt"),
            format!(
                "exit_code={:?}\ntimed_out={}\n--- stdout ---\n{}\n--- stderr ---\n{}\n",
                outcome.exit_code, outcome.timed_out, outcome.stdout, outcome.stderr
            ),
        )
        .await;

        Ok(observation_from(&outcome))
    }
}

fn truncate(s: &str) -> String {
    if s.len() <= OBSERVATION_OUTPUT_CAP {
        s.to_string()
    } else {
        format!("{}… [truncated]", &s[..OBSERVATION_OUTPUT_CAP])
    }
}

/// Turn a sandbox result into an [`Observation`] the brain can reason over.
fn observation_from(outcome: &sandbox::SandboxOutcome) -> Observation {
    if outcome.timed_out {
        return Observation::fail(format!(
            "script exceeded the time limit and was killed. Partial output:\n{}",
            truncate(&outcome.stdout)
        ));
    }
    if outcome.succeeded() {
        let out = truncate(&outcome.stdout);
        Observation::ok(if out.trim().is_empty() {
            "script completed (no output)".to_string()
        } else {
            format!("script output:\n{out}")
        })
    } else {
        Observation::fail(format!(
            "script exited with {:?}. stderr:\n{}",
            outcome.exit_code,
            truncate(&outcome.stderr)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_reports_success_output() {
        let outcome = sandbox::SandboxOutcome {
            exit_code: Some(0),
            stdout: "hello world".into(),
            stderr: String::new(),
            timed_out: false,
        };
        let obs = observation_from(&outcome);
        assert!(obs.ok);
        assert!(obs.summary.contains("hello world"));
    }

    #[test]
    fn observation_reports_failure_with_stderr() {
        let outcome = sandbox::SandboxOutcome {
            exit_code: Some(2),
            stdout: String::new(),
            stderr: "boom".into(),
            timed_out: false,
        };
        let obs = observation_from(&outcome);
        assert!(!obs.ok);
        assert!(obs.summary.contains("boom"));
    }

    #[test]
    fn observation_reports_timeout() {
        let outcome = sandbox::SandboxOutcome {
            exit_code: None,
            stdout: "partial".into(),
            stderr: String::new(),
            timed_out: true,
        };
        let obs = observation_from(&outcome);
        assert!(!obs.ok);
        assert!(obs.summary.contains("time limit"));
    }

    #[test]
    fn truncate_caps_long_output() {
        let big = "x".repeat(OBSERVATION_OUTPUT_CAP + 500);
        let t = truncate(&big);
        assert!(t.len() < big.len());
        assert!(t.ends_with("… [truncated]"));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // current-thread test runtime; guard is fine across .await
    async fn rejects_non_runscript_actions() {
        let _g = crate::agent::executor::verify::HOME_TEST_LOCK.lock().unwrap();
        // from_env may fail in a HOME-less CI; guard.
        if let Ok(mut ex) = SandboxExecutor::from_env() {
            let r = ex.execute(&Action::OpenApp { name: "Safari".into() }).await;
            assert!(r.is_err());
        }
    }

    // Live end-to-end: a real shell script through the sandbox executor.
    // Holds HOME_TEST_LOCK because it reads the ambient $HOME (via from_env),
    // which the skills/verify tests mutate — serialize so it always sees the
    // real home.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // current-thread test runtime; guard is fine across .await
    async fn runs_a_real_shell_script_and_returns_stdout() {
        let _g = crate::agent::executor::verify::HOME_TEST_LOCK.lock().unwrap();
        if !std::path::Path::new("/usr/bin/sandbox-exec").exists()
            || std::env::var("HOME").is_err()
        {
            return;
        }
        let mut ex = SandboxExecutor::from_env().unwrap();
        let obs = ex
            .execute(&Action::RunScript {
                language: ScriptLanguage::Shell,
                script: "echo lilypad-p2-ok".into(),
                writable_paths: vec![],
                needs_network: false,
            })
            .await
            .unwrap();
        assert!(obs.ok, "summary: {}", obs.summary);
        assert!(obs.summary.contains("lilypad-p2-ok"));
    }

    // Live: a script writing outside its scratch (into the home dir) is denied
    // by the sandbox, so the executor reports failure and no file is created.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // current-thread test runtime; guard is fine across .await
    async fn script_writing_outside_scratch_fails_closed() {
        let _g = crate::agent::executor::verify::HOME_TEST_LOCK.lock().unwrap();
        if !std::path::Path::new("/usr/bin/sandbox-exec").exists() {
            return;
        }
        let Ok(home) = std::env::var("HOME") else { return };
        let mut ex = SandboxExecutor::from_env().unwrap();
        let target = format!("{home}/lilypad_p2_should_not_exist_{}", std::process::id());
        let obs = ex
            .execute(&Action::RunScript {
                language: ScriptLanguage::Shell,
                script: format!("echo x > {target}"),
                writable_paths: vec![], // NOT granted write to home
                needs_network: false,
            })
            .await
            .unwrap();
        assert!(!obs.ok, "writing outside scratch must fail");
        assert!(!std::path::Path::new(&target).exists());
        std::fs::remove_file(&target).ok();
    }
}
