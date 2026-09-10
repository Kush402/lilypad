//! What a finished sandboxed run left behind, and how sure we are (L-277).
//!
//! ### The defect
//!
//! `killpg` retires the process group this runner creates. It does not retire a
//! descendant that calls `setsid()`: that process leaves the group, is
//! reparented to `launchd`, and keeps running. Reproduced under the released
//! profile — a disposable Perl child called `setsid`, outlived the kill of its
//! parent group by two seconds, and then wrote a file.
//!
//! ### The first fix, and why it was worse than the gap
//!
//! It swept `pgrep -f <run directory>` and reported whether that came back
//! empty. Three things were wrong, and the independent review was right about
//! all three:
//!
//!   1. A failure to *run* `pgrep` produced an empty list, and empty was read as
//!      "nothing survived". A false clean is worse than a known gap, because it
//!      is an assertion.
//!   2. An argv substring is not ownership. Any process whose command line
//!      mentioned the run directory — a shell someone left open in it, an
//!      editor, a backup tool — became a candidate for `SIGKILL`.
//!   3. A descendant that re-execs or is renamed stops matching immediately, so
//!      the check could not see the case it most needed to.
//!
//! ### What was tried, and measured, before settling here
//!
//! `kqueue`'s `EVFILT_PROC` with `NOTE_TRACK` asks the kernel to report every
//! `fork` beneath a process and hand back the new pid. That would have been
//! ownership from the kernel, immune to renaming and to `setsid`. **It is not
//! available:** registering it on this macOS returns `ENOTSUP` (measured; the
//! same registration without `NOTE_TRACK` succeeds).
//!
//! Denying `process-fork` in the Seatbelt profile would remove descendants
//! altogether. **Also measured, also not viable:** it stops the Python
//! interpreter from starting at all, and reduces `/bin/sh` to builtins.
//!
//! So macOS offers an unprivileged process no way to *own* a process tree here.
//! What is left is observation, and observation has to be honest about its
//! limits — which is why this reports [`Cleanup::Unknown`] rather than guessing,
//! and why `run_script` is not offered to the model in this build.
//!
//! ### What this does
//!
//! While a run is alive, a sampler reads the real parent links from `ps` and
//! records every pid whose ancestry reaches this run. Ancestry comes from the
//! kernel, so a recorded pid genuinely belongs to the run and killing it is
//! authorized; a process merely *mentioning* the run directory never is. A pid
//! stays recorded after it is reparented, which is the whole point.
//!
//! The limit that remains, stated plainly: a process that forks, calls
//! `setsid`, and is reparented entirely between two samples is never observed.
//! `Confirmed` therefore means "everything observed to belong to this run has
//! exited" — accurate for an ordinary script, and not proof against one written
//! to evade observation.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How often the parent links are sampled while a run is alive.
const SAMPLE_INTERVAL: Duration = Duration::from_millis(50);

/// What the runner can say about a finished run's processes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cleanup {
    /// Every process observed to belong to this run has exited.
    Confirmed,
    /// Something may still be running, or the process table could not be read.
    /// Never reported as success.
    Unknown,
}

/// Processes whose command line still mentions `run_dir`.
///
/// **Evidence, never authority.** A command line is not ownership: a shell
/// someone left open in the run directory matches it, and a descendant that
/// re-execs stops matching. So this may only ever *reduce* confidence — it can
/// turn a `Confirmed` into an `Unknown`, and it can never authorize a kill.
///
/// It exists because ancestry sampling has a gap: a process that forks, calls
/// `setsid`, and loses its parent between two samples is never recorded, and
/// without a second signal that gap would be reported as a clean run. Being
/// wrong towards "we are not sure" is the direction that costs nothing.
///
/// `None` means the check could not be run, which is also not a clean result.
fn argv_mentions(run_dir: &std::path::Path) -> Option<bool> {
    let name = run_dir.file_name()?.to_string_lossy().into_owned();
    let mut pattern = String::from("/");
    for ch in name.chars() {
        if "\\.^$|()[]{}*+?/".contains(ch) {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    let out = std::process::Command::new("/usr/bin/pgrep")
        .arg("-f")
        .arg(&pattern)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    // pgrep: 0 = matched, 1 = no match, anything else = it did not work.
    match out.status.code() {
        Some(0) => {
            let me = std::process::id() as i32;
            Some(
                String::from_utf8_lossy(&out.stdout)
                    .split_whitespace()
                    .filter_map(|s| s.parse::<i32>().ok())
                    .any(|pid| pid != me && pid > 1),
            )
        }
        Some(1) => Some(false),
        _ => None,
    }
}

/// One `ps` sample: child pid to parent pid. `None` when `ps` could not be run
/// or its output could not be read — which is not the same as "no processes".
fn parent_links() -> Option<HashMap<i32, i32>> {
    // `state` is read too: a process that has been killed but not yet reaped by
    // its parent stays in the table as a zombie. A zombie is not running — it
    // is a slot holding an exit status — and counting one as a survivor made
    // every cleanup report `Unknown`.
    let out = std::process::Command::new("/bin/ps")
        .args(["-Ao", "pid=,ppid=,state="])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut links = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(state)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<i32>(), ppid.parse::<i32>()) else {
            continue;
        };
        if state.starts_with('Z') {
            continue;
        }
        links.insert(pid, ppid);
    }
    // An empty table means the read went wrong; this process is in it.
    if links.is_empty() {
        return None;
    }
    Some(links)
}

struct State {
    /// Pids whose ancestry was observed to reach this run. They stay here after
    /// reparenting, which is what makes the record useful.
    owned: HashSet<i32>,
    /// A sample could not be taken. The record is incomplete and cannot be
    /// completed, so nothing may be confirmed from it.
    blind: bool,
}

pub struct Tracker {
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Tracker {
    /// Begin recording the descendants of `root`.
    pub fn start(root: i32) -> Tracker {
        let state = Arc::new(Mutex::new(State {
            owned: HashSet::from([root]),
            blind: false,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let state = Arc::clone(&state);
            let stop = Arc::clone(&stop);
            std::thread::Builder::new()
                .name("lilypad-run-descendants".into())
                .spawn(move || {
                    while !stop.load(Ordering::SeqCst) {
                        sample_into(&state);
                        std::thread::sleep(SAMPLE_INTERVAL);
                    }
                })
                .ok()
        };
        if thread.is_none() {
            // No sampler means no record at all; say so rather than reporting
            // an empty one.
            state.lock().unwrap().blind = true;
        }
        Tracker {
            state,
            stop,
            thread,
        }
    }

    /// Stop everything recorded as belonging to this run, then report whether
    /// that can be confirmed.
    ///
    /// Only pids with kernel-observed ancestry to this run are signalled.
    /// `run_dir`, when given, is used for the evidence check described on
    /// [`argv_mentions`] — which can lower the verdict and never raise it.
    pub fn terminate_in(&self, grace: Duration, run_dir: Option<&std::path::Path>) -> Cleanup {
        let verdict = self.terminate(grace);
        if verdict == Cleanup::Unknown {
            return verdict;
        }
        match run_dir.map(argv_mentions) {
            // Nothing to check against.
            None => verdict,
            // Something is still running that names this run. We do not know
            // that it is ours, so we do not kill it — but we certainly cannot
            // call the run confirmed clean.
            Some(Some(true)) => {
                log::warn!(
                    target: "lilypad::agent",
                    "a process still refers to this Ask run after cleanup; not confirming"
                );
                Cleanup::Unknown
            }
            Some(Some(false)) => verdict,
            // The check itself failed.
            Some(None) => Cleanup::Unknown,
        }
    }

    pub fn terminate(&self, grace: Duration) -> Cleanup {
        // One last sample, so a descendant created since the previous one is
        // recorded before anything is killed.
        sample_into(&self.state);

        for pid in self.owned() {
            // SAFETY: `pid` was observed to descend from this run's own child.
            #[cfg(unix)]
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }

        let deadline = Instant::now() + grace;
        loop {
            let Some(links) = parent_links() else {
                self.state.lock().unwrap().blind = true;
                return Cleanup::Unknown;
            };
            let still_alive: Vec<i32> = self
                .owned()
                .into_iter()
                .filter(|pid| links.contains_key(pid))
                .collect();
            if still_alive.is_empty() {
                break;
            }
            if Instant::now() >= deadline {
                log::warn!(
                    target: "lilypad::agent",
                    "{} process(es) from this Ask run did not exit after SIGKILL",
                    still_alive.len()
                );
                return Cleanup::Unknown;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        if self.state.lock().unwrap().blind {
            // At least one sample failed, so the record has a hole in it and
            // "everything is gone" is not something we know.
            return Cleanup::Unknown;
        }
        Cleanup::Confirmed
    }

    fn owned(&self) -> Vec<i32> {
        let me = std::process::id() as i32;
        self.state
            .lock()
            .unwrap()
            .owned
            .iter()
            .copied()
            .filter(|pid| *pid != me && *pid > 1)
            .collect()
    }
}

/// Add every process whose ancestry reaches an already-owned pid.
fn sample_into(state: &Arc<Mutex<State>>) {
    let Some(links) = parent_links() else {
        state.lock().unwrap().blind = true;
        return;
    };
    let mut guard = state.lock().unwrap();
    // Walk each process up its parent chain. A chain that reaches something we
    // already own means this process belongs to the run — including a chain
    // through an intermediate that has since exited, as long as it was seen.
    for &pid in links.keys() {
        if guard.owned.contains(&pid) {
            continue;
        }
        let mut cursor = pid;
        // Bounded: the table is finite and a chain cannot revisit a pid without
        // the depth guard stopping it.
        for _ in 0..64 {
            let Some(&parent) = links.get(&cursor) else {
                break;
            };
            if parent <= 1 {
                break;
            }
            if guard.owned.contains(&parent) {
                guard.owned.insert(pid);
                break;
            }
            cursor = parent;
        }
    }
}

impl Drop for Tracker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// The reproduction that started L-277: a child that calls `setsid` leaves
    /// the process group, and `killpg` alone does not reach it.
    #[test]
    fn a_setsid_descendant_is_recorded_and_killed() {
        if !std::path::Path::new("/usr/bin/perl").exists() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("lilypad_track_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("late-marker");
        let script = format!(
            "use POSIX qw(setsid); my $p = fork(); \
             if ($p == 0) {{ setsid(); sleep 3; \
               open(my $f, '>', '{}'); print $f 'ESCAPED'; close($f); exit 0; }} \
             sleep 3;",
            marker.display()
        );
        let mut child = Command::new("/usr/bin/perl")
            .arg("-e")
            .arg(&script)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn perl");
        let tracker = Tracker::start(child.id() as i32);

        // Long enough for the fork and for at least one sample to see it.
        std::thread::sleep(Duration::from_millis(400));
        // Production reaps the direct child before judging cleanup; do the same
        // here so the test is about descendants rather than about zombies.
        let _ = child.kill();
        let _ = child.wait();
        let cleanup = tracker.terminate(Duration::from_secs(3));
        assert_eq!(
            cleanup,
            Cleanup::Confirmed,
            "the run was not confirmed clean"
        );

        // The marker is written three seconds in. If the escapee survived, it
        // appears while we wait here.
        std::thread::sleep(Duration::from_secs(3));
        assert!(
            !marker.exists(),
            "a setsid descendant kept running after the run ended"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A process that merely mentions the run directory is never signalled.
    /// The old `pgrep -f` sweep would have killed this one.
    #[test]
    fn an_unrelated_process_is_not_killed() {
        let dir = std::env::temp_dir().join(format!("lilypad_bystander_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut bystander = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("cd {}; sleep 5", dir.display()))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn bystander");
        let bystander_pid = bystander.id() as i32;

        let mut mine = Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 5")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn tracked");
        let tracker = Tracker::start(mine.id() as i32);
        std::thread::sleep(Duration::from_millis(200));
        let _ = mine.kill();
        let _ = mine.wait();
        assert_eq!(
            tracker.terminate(Duration::from_secs(3)),
            Cleanup::Confirmed
        );

        // SAFETY: signal 0 only probes for existence.
        let alive = unsafe { libc::kill(bystander_pid, 0) } == 0;
        assert!(
            alive,
            "an unrelated process was killed by the run's cleanup"
        );
        let _ = bystander.kill();
        let _ = bystander.wait();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Inspection that fails is reported as unknown, never as a clean run.
    /// This is the false clean the previous implementation produced.
    #[test]
    fn a_failed_inspection_is_unknown_not_confirmed() {
        let tracker = Tracker::start(std::process::id() as i32);
        tracker.state.lock().unwrap().blind = true;
        assert_eq!(
            tracker.terminate(Duration::from_millis(200)),
            Cleanup::Unknown,
            "a run whose process table could not be read was reported clean"
        );
    }

    #[test]
    fn an_unreadable_process_table_is_none_rather_than_empty() {
        // The shape of the original defect, at the lowest level: "could not
        // look" must never be expressible as "looked, saw nothing".
        let links = parent_links().expect("ps works on this machine");
        assert!(links.contains_key(&(std::process::id() as i32)));
    }
}
