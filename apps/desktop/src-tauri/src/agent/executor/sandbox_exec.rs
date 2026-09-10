//! Tier "sandbox" (Priority 2) — run model-generated code under the Seatbelt
//! sandbox and feed its result back to the brain.
//!
//! This is where the LLM's `run_script` tool lands. The script text is never
//! trusted: the security gate has already classified it (`Consequential` →
//! held for the user's approval, or `Forbidden` → refused) BEFORE the runner
//! calls this executor, and the [`sandbox`](crate::agent::sandbox) harness
//! constrains what a script can do regardless of what it contains — writes
//! jailed, the user's home unreadable except for the paths named on the
//! approval card, network off unless granted, CPU/mem/time bounded. Every
//! run's script + profile + output persist under the run dir for audit.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Result};

use crate::agent::executor::verify::{self, resolve_user_path, FileId};
use crate::agent::runner::{Executor, Observation};
use crate::agent::sandbox::{
    self, is_denied_read, is_protected_write, SandboxLimits, SandboxPolicy,
};
use crate::agent::security::ScriptLanguage;
use crate::agent::Action;

/// How much captured output to fold back to the model (the sandbox already
/// caps raw capture at 64 KiB; the brain needs far less to reason).
const OBSERVATION_OUTPUT_CAP: usize = 2000;

// ── artifact retention (L-259) ───────────────────────────────────────────
//
// Every run leaves its script, its Seatbelt profile and its captured output on
// disk, which is what makes an Ask run auditable after the fact. Nothing ever
// removed them. Per-file `RLIMIT_FSIZE` and the per-run deadline bound one
// run; they say nothing about a thousand runs, and the thing accumulating is
// not neutral — captured stdout is whatever the person granted the script, so
// this is a growing pile of their data with no expiry.
//
// Three bounds, because any one of them alone has an obvious hole: a count cap
// says nothing about size, a size cap keeps a two-year-old transcript if the
// Mac is quiet, and an age cap alone lets a busy hour fill the disk.

/// Newest run directories kept, regardless of size or age.
const MAX_RETAINED_RUNS: usize = 40;
/// Total bytes the whole store may occupy.
const MAX_RETAINED_BYTES: u64 = 128 * 1024 * 1024;
/// Nothing survives this long, even if the store is small and quiet.
const MAX_RETAINED_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Tier-"sandbox" executor. Owns the per-run artifact root and a monotonic
/// counter so concurrent runs never collide on a scratch dir.
pub struct SandboxExecutor {
    runs_root: PathBuf,
    home: PathBuf,
    counter: u64,
    /// What each granted path *was* when the approval card was built (L-247).
    ///
    /// A card names a path; a path is a name, and a name can be made to mean
    /// something else. Between the person reading "can read
    /// ~/Documents/report.md" and the script running, that name can be pointed
    /// at a different file — by the user's own tools, or by an earlier script
    /// of the model's that was granted a writable folder. Recording the
    /// object's identity at approval time and re-checking it at execution time
    /// is what makes the card a promise rather than a description of the past.
    granted: Mutex<HashMap<PathBuf, Option<FileId>>>,
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
            granted: Mutex::new(HashMap::new()),
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

impl SandboxExecutor {
    /// Home-jail one model-named path and, if it exists, record what object it
    /// names right now.
    fn note_grant(&self, raw: &str) -> Result<PathBuf, String> {
        let jailed = resolve_user_path(raw).map_err(|e| e.to_string())?;
        let identity = self.identity_of(&jailed);
        self.granted
            .lock()
            .unwrap()
            .insert(jailed.clone(), identity);
        Ok(jailed)
    }

    /// The object a jailed path names, or `None` if nothing is there yet.
    ///
    /// A path that cannot be walked without crossing a symbolic link has no
    /// identity as far as this jail is concerned, and is reported as absent —
    /// which the check below then treats as a change if it later resolves.
    fn identity_of(&self, jailed: &Path) -> Option<FileId> {
        let real_home = self
            .home
            .canonicalize()
            .unwrap_or_else(|_| self.home.clone());
        let (dir, name) = verify::walk_to_parent(&real_home, jailed).ok()?;
        verify::identify_at(&dir, &name).ok().flatten()
    }

    /// Refuse if a granted path no longer names what it named when the person
    /// approved it. A grant that was absent at approval and exists now counts
    /// as a change: the card said "this file", and a file that appeared in the
    /// meantime is not the file they read about.
    fn grant_still_matches(&self, jailed: &Path) -> Result<(), String> {
        let approved = match self.granted.lock().unwrap().get(jailed) {
            Some(id) => *id,
            // No record means this path never went through `resolve`, which is
            // how a test or a future caller could bypass the check. Fail
            // closed rather than assume it is fine.
            None => {
                return Err(format!(
                    "{} was never part of an approval",
                    jailed.display()
                ))
            }
        };
        let now = self.identity_of(jailed);
        if approved == now {
            Ok(())
        } else {
            Err(format!(
                "{} is not the file that was approved — it changed between the approval and now",
                jailed.display()
            ))
        }
    }
}

impl Executor for SandboxExecutor {
    fn resolve(&self, action: Action) -> Action {
        // Runs *before* classification and before the approval card is built,
        // so the card shows the jailed path that will actually be granted —
        // and so the identity recorded here is the one the person approved.
        let Action::RunScript {
            language,
            script,
            writable_paths,
            readable_paths,
            needs_network,
        } = action
        else {
            return action;
        };
        let jail = |paths: Vec<String>| -> Vec<String> {
            paths
                .into_iter()
                .map(|p| match self.note_grant(&p) {
                    Ok(jailed) => jailed.to_string_lossy().into_owned(),
                    // Keep the model's text so the executor can refuse it with
                    // a reason. Silently dropping a path would produce a card
                    // that promises less than the model asked for.
                    Err(_) => p,
                })
                .collect()
        };
        Action::RunScript {
            language,
            script,
            writable_paths: jail(writable_paths),
            readable_paths: jail(readable_paths),
            needs_network,
        }
    }

    async fn execute(&mut self, action: &Action) -> Result<Observation> {
        let Action::RunScript {
            language,
            script,
            writable_paths,
            readable_paths,
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
                Ok(p) => {
                    // Refuse rather than quietly drop, for the same reason the
                    // read side does: the approval card named this path.
                    // A write here is not a smaller version of a read — a
                    // `~/.ssh/config` the script cannot read is one it can
                    // still replace, and the replacement runs as the person
                    // (L-261).
                    if is_protected_write(&p, &self.home) {
                        return Ok(Observation::fail(format!(
                            "writing to {} is never permitted, with or without approval",
                            p.display()
                        )));
                    }
                    if let Err(e) = self.grant_still_matches(&p) {
                        return Ok(Observation::fail(format!("writable path rejected: {e}")));
                    }
                    jailed_writables.push(p);
                }
                Err(e) => return Ok(Observation::fail(format!("writable path rejected: {e}"))),
            }
        }

        // Home-jail every requested read grant, exactly like the writes. The
        // sandbox denies the rest of home, so this list is the whole of what
        // the script can see of the person's files (L-247) — and it is the
        // same list the approval card showed before they approved.
        let mut jailed_readables = Vec::with_capacity(readable_paths.len());
        for r in readable_paths {
            match resolve_user_path(r) {
                Ok(p) => {
                    // Refuse rather than quietly drop it. The approval card
                    // listed this path; running the script anyway would make
                    // the card a description of something that did not happen,
                    // and the script would fail on a read it was told it had.
                    if is_denied_read(&p, &self.home) {
                        return Ok(Observation::fail(format!(
                            "reading {} is never permitted, with or without approval",
                            p.display()
                        )));
                    }
                    if let Err(e) = self.grant_still_matches(&p) {
                        return Ok(Observation::fail(format!("readable path rejected: {e}")));
                    }
                    jailed_readables.push(p);
                }
                Err(e) => return Ok(Observation::fail(format!("readable path rejected: {e}"))),
            }
        }

        // Two directories, not one (L-260). `run_dir` holds the audit record —
        // the script text, the profile it ran under, the captured output — and
        // the sandbox may read it but never write it. `scratch` is the part the
        // script owns. They used to be the same directory, and a reproduction
        // showed what that cost: the script replaced `output.txt` with a
        // symlink and the executor's own unsandboxed write followed it into a
        // file nobody had granted.
        let run_dir = self.next_run_dir();
        let scratch = run_dir.join("scratch");
        tokio::fs::create_dir_all(&scratch).await?;
        // The store holds captured output, which is the person's data. Owner
        // only — the default umask would leave it group- and world-readable on
        // a Mac with more than one account.
        restrict(&self.runs_root);
        restrict(&run_dir);
        restrict(&scratch);
        let script_path = run_dir.join(format!("script.{ext}"));
        write_new_no_follow(&script_path, script.as_bytes())?;

        let policy = SandboxPolicy {
            run_dir: run_dir.clone(),
            scratch_dir: scratch.clone(),
            writable_paths: jailed_writables,
            readable_paths: jailed_readables,
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

        // Persist a summary beside the script + profile for audit. In the run
        // dir, created exclusively and without following a link: this write
        // carries host authority, so it must land on a file this process made,
        // never on a name something else chose.
        let _ = write_new_no_follow(
            &run_dir.join("output.txt"),
            format!(
                "exit_code={:?}\ntimed_out={}\ncleanup_confirmed={}\n--- stdout ---\n{}\n--- stderr ---\n{}\n",
                outcome.exit_code, outcome.timed_out, outcome.cleanup_confirmed,
                outcome.stdout, outcome.stderr
            )
            .as_bytes(),
        );

        // Retention runs after the audit record is written, and is told which
        // directory is live so it can never delete the run that just finished
        // (or, with concurrent runs, one still going).
        prune_run_store(&self.runs_root, &run_dir, SystemTime::now());

        Ok(observation_from(&outcome))
    }
}

/// Write a file that must not already exist and must not be a symbolic link.
///
/// `create_new` is `O_CREAT|O_EXCL`, which already refuses to follow a link at
/// the final component; `O_NOFOLLOW` says so explicitly so the intent survives
/// a future edit. Together they are what stops a host-authority write from
/// being aimed at a file the script picked (L-260).
pub(crate) fn write_new_no_follow(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)
}

/// Make a path readable only by its owner. Best-effort: a store that could not
/// be tightened is still better than no store, and the run itself is unaffected.
fn restrict(path: &Path) {
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}

/// One run directory as retention sees it.
struct StoredRun {
    path: PathBuf,
    /// When the run started, taken from the directory name rather than from
    /// mtime — touching a file must not buy a run more time in the store.
    started_nanos: u128,
    bytes: u64,
}

/// Bring the run store back inside its bounds, newest first.
///
/// `active` is never removed. Entries that are not plain directories — a
/// symbolic link someone dropped in the store, say — are unlinked rather than
/// followed: `remove_dir_all` on a link would delete whatever it points at.
pub(crate) fn prune_run_store(root: &Path, active: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return; // no store yet, or unreadable — nothing to bound
    };
    let mut runs: Vec<StoredRun> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path == active {
            continue;
        }
        // `symlink_metadata` does not follow the last component, which is the
        // whole point: a link here must be removed, never walked.
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        runs.push(StoredRun {
            started_nanos: started_nanos(&path),
            bytes: dir_bytes(&path),
            path,
        });
    }
    // Newest first, so the survivors are the ones worth keeping.
    runs.sort_by_key(|r| std::cmp::Reverse(r.started_nanos));

    let mut kept_bytes = 0u64;
    for (index, run) in runs.iter().enumerate() {
        let too_many = index >= MAX_RETAINED_RUNS.saturating_sub(1);
        let too_big = kept_bytes.saturating_add(run.bytes) > MAX_RETAINED_BYTES;
        let too_old = now
            .duration_since(UNIX_EPOCH)
            .map(|since| {
                since.as_nanos().saturating_sub(run.started_nanos) > MAX_RETAINED_AGE.as_nanos()
            })
            .unwrap_or(false);
        if too_many || too_big || too_old {
            let _ = std::fs::remove_dir_all(&run.path);
        } else {
            kept_bytes = kept_bytes.saturating_add(run.bytes);
        }
    }
}

/// The nanosecond stamp `next_run_dir` put in the name, or 0 if the name is
/// not one of ours (which sorts it oldest, so a stray directory is removed
/// first rather than kept forever).
fn started_nanos(path: &Path) -> u128 {
    path.file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("run-"))
        .and_then(|rest| rest.split('-').next())
        .and_then(|nanos| nanos.parse().ok())
        .unwrap_or(0)
}

/// Bytes under `path`, not following symbolic links. Bounded by the store's
/// own shape; a run directory is a handful of files.
fn dir_bytes(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.is_dir() {
            total = total.saturating_add(dir_bytes(&entry.path()));
        } else {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

fn truncate(s: &str) -> String {
    if s.len() <= OBSERVATION_OUTPUT_CAP {
        s.to_string()
    } else {
        let mut end = OBSERVATION_OUTPUT_CAP;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}… [truncated]", &s[..end])
    }
}

/// Turn a sandbox result into an [`Observation`] the brain can reason over.
fn observation_from(outcome: &sandbox::SandboxOutcome) -> Observation {
    // Report this before anything else, including before success. A run whose
    // descendants could not be confirmed stopped is not a run that finished —
    // something of it may still be executing, and saying "completed" would be
    // the specific lie L-277 is about.
    if !outcome.cleanup_confirmed {
        return Observation::fail(format!(
            "the script was stopped but its cleanup could not be confirmed — a process \
             it started may still be running. Output captured before the stop:\n{}",
            truncate(&outcome.stdout)
        ));
    }
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

    /// A store laid out like the real one, cleaned up on drop.
    struct Store {
        root: PathBuf,
    }
    impl Drop for Store {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }
    fn store(name: &str) -> Store {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("lilypad_runs_{}_{name}_{n}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        // `/var` is a symlink to `/private/var` on macOS, so the temp dir has
        // two spellings. The jail canonicalises; a test that does not would be
        // comparing one spelling against the other and reading the mismatch as
        // a security refusal.
        let root = root.canonicalize().unwrap_or(root);
        Store { root }
    }
    /// One run directory, stamped as if it started `nanos` since the epoch.
    fn run_dir(store: &Store, nanos: u128, bytes: usize) -> PathBuf {
        let dir = store.root.join(format!("run-{nanos}-1"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("output.txt"), "x".repeat(bytes)).unwrap();
        dir
    }
    fn now_at(nanos: u128) -> SystemTime {
        UNIX_EPOCH + Duration::from_nanos(nanos as u64)
    }

    #[test]
    fn retention_keeps_the_newest_runs_and_never_the_live_one() {
        // L-259. Nothing used to remove these, and what accumulates is the
        // person's own data: captured stdout is whatever they granted the
        // script to read.
        let s = store("count");
        let now: u128 = 1_000_000_000_000_000_000;
        let mut dirs = Vec::new();
        for i in 0..(MAX_RETAINED_RUNS + 5) {
            dirs.push(run_dir(&s, now - (i as u128) * 1_000_000, 16));
        }
        let active = &dirs[0];
        prune_run_store(&s.root, active, now_at(now));

        let left: Vec<_> = std::fs::read_dir(&s.root)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        assert!(
            left.len() <= MAX_RETAINED_RUNS,
            "{} runs survived a cap of {MAX_RETAINED_RUNS}",
            left.len()
        );
        assert!(left.contains(active), "retention deleted the running task");
        // The survivors are the newest, not an arbitrary subset.
        assert!(left.contains(&dirs[1]));
        assert!(!left.contains(dirs.last().unwrap()));
    }

    #[test]
    fn retention_bounds_bytes_even_when_the_run_count_is_small() {
        // A count cap says nothing about size: three runs can be a gigabyte.
        let s = store("bytes");
        let now: u128 = 2_000_000_000_000_000_000;
        let big = (MAX_RETAINED_BYTES / 2) as usize + 1;
        let newest = run_dir(&s, now, big);
        let older = run_dir(&s, now - 1_000_000, big);
        let oldest = run_dir(&s, now - 2_000_000, big);
        prune_run_store(&s.root, Path::new("/nonexistent"), now_at(now));

        assert!(newest.exists(), "the newest run should survive");
        assert!(
            !older.exists() || !oldest.exists(),
            "two oversized runs both survived a byte cap"
        );
    }

    #[test]
    fn retention_expires_an_old_run_even_in_a_small_quiet_store() {
        // A size cap alone keeps a two-year-old transcript on a quiet Mac.
        let s = store("age");
        let now: u128 = 3_000_000_000_000_000_000;
        let fresh = run_dir(&s, now - 1_000_000, 8);
        let ancient = run_dir(&s, now - MAX_RETAINED_AGE.as_nanos() - 1, 8);
        prune_run_store(&s.root, Path::new("/nonexistent"), now_at(now));
        assert!(fresh.exists());
        assert!(!ancient.exists(), "an expired run survived");
    }

    #[test]
    fn retention_unlinks_a_symlink_in_the_store_rather_than_following_it() {
        // The dangerous case: `remove_dir_all` on a link deletes what it points
        // at. Cleanup must never turn into a delete of the user's own folder.
        let s = store("symlink");
        let outside = std::env::temp_dir().join(format!("lilypad_precious_{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), "precious").unwrap();
        let link = s.root.join("run-1-1");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        prune_run_store(
            &s.root,
            Path::new("/nonexistent"),
            now_at(9_000_000_000_000_000_000),
        );

        assert!(!link.exists(), "the link itself should be gone");
        assert!(
            outside.join("keep.txt").exists(),
            "cleanup followed a symlink and deleted the target"
        );
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn a_directory_that_is_not_ours_sorts_oldest_rather_than_living_forever() {
        let s = store("stray");
        let now: u128 = 4_000_000_000_000_000_000;
        assert_eq!(started_nanos(&s.root.join("not-a-run")), 0);
        assert_eq!(started_nanos(&s.root.join("run-123-7")), 123);
        let _ = now;
    }

    /// Run `body` with `$HOME` pointed at a throwaway directory.
    ///
    /// `resolve_user_path` reads `$HOME` at call time while the executor
    /// caches it at construction; in production both come from the same
    /// process environment, so a test that fakes one has to fake the other.
    /// The runtime is built inside the guard because the guard is not `Send`.
    fn with_home<T>(home: &Path, body: impl std::future::Future<Output = T>) -> T {
        let _g = crate::agent::executor::verify::HOME_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", home);
        let out = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(body);
        match prev {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        out
    }

    /// An executor rooted in a throwaway home, so a grant test can create and
    /// swap real files without touching the developer's own.
    fn executor_in(home: &Path) -> SandboxExecutor {
        SandboxExecutor {
            runs_root: home.join("Library/Caches/Lilypad/ask-runs"),
            home: home.to_path_buf(),
            counter: 0,
            granted: Mutex::new(HashMap::new()),
        }
    }

    fn script_with(readable: &[&str]) -> Action {
        Action::RunScript {
            language: ScriptLanguage::Shell,
            script: "true".into(),
            writable_paths: vec![],
            readable_paths: readable.iter().map(|s| s.to_string()).collect(),
            needs_network: false,
        }
    }

    #[test]
    fn a_grant_is_bound_to_the_file_that_was_approved_not_to_its_name() {
        // L-247. The card names a path, and a path is a name. Between the
        // person reading "can read ~/Docs/report.md" and the script running,
        // that name can point somewhere else — the model's own earlier script,
        // granted a writable folder, is enough to do it. Identity is recorded
        // when the card is built and re-checked before the sandbox starts.
        let s = store("grant_identity");
        let home = s.root.clone();
        let docs = home.join("Docs");
        std::fs::create_dir_all(&docs).unwrap();
        let target = docs.join("report.md");
        std::fs::write(&target, "the approved file").unwrap();

        let mut exec = executor_in(&home);
        let raw = target.to_string_lossy().into_owned();

        let obs = with_home(&home, async {
            // Approval time: resolve records what the name means now.
            let approved = exec.resolve(script_with(&[&raw]));

            // …and then the name is pointed at a different file.
            std::fs::remove_file(&target).unwrap();
            std::fs::write(&target, "something else entirely").unwrap();

            exec.execute(&approved).await.unwrap()
        });
        assert!(!obs.ok, "a swapped grant was accepted");
        assert!(
            obs.summary.contains("not the file that was approved"),
            "unhelpful refusal: {}",
            obs.summary
        );
    }

    #[test]
    fn an_unchanged_grant_is_not_refused() {
        // The other half: a check that refuses everything proves nothing.
        let s = store("grant_stable");
        let home = s.root.clone();
        std::fs::create_dir_all(home.join("Docs")).unwrap();
        let target = home.join("Docs/report.md");
        std::fs::write(&target, "stable").unwrap();

        let mut exec = executor_in(&home);
        let obs = with_home(&home, async {
            let approved = exec.resolve(script_with(&[&target.to_string_lossy()]));
            exec.execute(&approved).await.unwrap()
        });
        // It may still fail for want of an interpreter or a sandbox on a
        // stripped machine — but never for the grant having changed.
        assert!(
            !obs.summary.contains("not the file that was approved"),
            "an unchanged grant was refused: {}",
            obs.summary
        );
    }

    #[test]
    fn a_path_that_never_went_through_approval_is_refused() {
        // Fail closed: a grant with no recorded identity is a grant no card
        // ever showed.
        let s = store("grant_unknown");
        let home = s.root.clone();
        std::fs::create_dir_all(home.join("Docs")).unwrap();
        std::fs::write(home.join("Docs/report.md"), "x").unwrap();
        let mut exec = executor_in(&home);
        let never_resolved = script_with(&[&home.join("Docs/report.md").to_string_lossy()]);
        let obs = with_home(&home, async {
            exec.execute(&never_resolved).await.unwrap()
        });
        assert!(!obs.ok);
        assert!(
            obs.summary.contains("never part of an approval"),
            "unexpected refusal: {}",
            obs.summary
        );
    }

    #[test]
    fn observation_reports_success_output() {
        let outcome = sandbox::SandboxOutcome {
            exit_code: Some(0),
            stdout: "hello world".into(),
            stderr: String::new(),
            timed_out: false,
            cleanup_confirmed: true,
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
            cleanup_confirmed: true,
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
            cleanup_confirmed: true,
        };
        let obs = observation_from(&outcome);
        assert!(!obs.ok);
        assert!(obs.summary.contains("time limit"));
    }

    #[test]
    fn an_unconfirmed_cleanup_is_never_reported_as_success() {
        // L-277. Exit code 0 with a descendant possibly still running is not a
        // completed run, and saying so is the whole defect.
        let outcome = sandbox::SandboxOutcome {
            exit_code: Some(0),
            stdout: "partial".into(),
            stderr: String::new(),
            timed_out: false,
            cleanup_confirmed: false,
        };
        let obs = observation_from(&outcome);
        assert!(!obs.ok);
        assert!(
            obs.summary.contains("could not be confirmed"),
            "{}",
            obs.summary
        );
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
        let _g = crate::agent::executor::verify::HOME_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // from_env may fail in a HOME-less CI; guard.
        if let Ok(mut ex) = SandboxExecutor::from_env() {
            let r = ex
                .execute(&Action::OpenApp {
                    name: "Safari".into(),
                })
                .await;
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
        let _g = crate::agent::executor::verify::HOME_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !std::path::Path::new("/usr/bin/sandbox-exec").exists() || std::env::var("HOME").is_err()
        {
            return;
        }
        let mut ex = SandboxExecutor::from_env().unwrap();
        let obs = ex
            .execute(&Action::RunScript {
                language: ScriptLanguage::Shell,
                script: "echo lilypad-p2-ok".into(),
                writable_paths: vec![], // NOT granted write to home
                readable_paths: vec![],
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
        let _g = crate::agent::executor::verify::HOME_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !std::path::Path::new("/usr/bin/sandbox-exec").exists() {
            return;
        }
        let Ok(home) = std::env::var("HOME") else {
            return;
        };
        let mut ex = SandboxExecutor::from_env().unwrap();
        let target = format!("{home}/lilypad_p2_should_not_exist_{}", std::process::id());
        let obs = ex
            .execute(&Action::RunScript {
                language: ScriptLanguage::Shell,
                script: format!("echo x > {target}"),
                writable_paths: vec![], // NOT granted write to home
                readable_paths: vec![],
                needs_network: false,
            })
            .await
            .unwrap();
        assert!(!obs.ok, "writing outside scratch must fail");
        assert!(!std::path::Path::new(&target).exists());
        std::fs::remove_file(&target).ok();
    }
    #[test]
    fn output_truncation_preserves_utf8_boundaries() {
        let text = format!("{}界", "a".repeat(1999));
        assert_eq!(
            truncate(&text),
            format!("{}… [truncated]", "a".repeat(1999))
        );
        assert_eq!(truncate("hello界"), "hello界");
    }
}
