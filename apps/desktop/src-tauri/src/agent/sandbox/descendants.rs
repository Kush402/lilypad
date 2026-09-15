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
//! records every process whose ancestry reaches this run. Ancestry comes from
//! the kernel, so a recorded process genuinely belongs to the run and killing it
//! is authorized; a process merely *mentioning* the run directory never is. A
//! process stays recorded after it is reparented, which is the whole point.
//!
//! A process is recorded as its pid **and its start time** (L-337). The kernel
//! hands an exited process's pid to a later, unrelated one, and a bare pid then
//! made that stranger look owned: its children were adopted and it was put in
//! line for `SIGKILL`. The start time is re-read immediately before every
//! signal and every liveness check, and a pid whose start time no longer
//! matches is not this run's.
//!
//! The limit that remains, stated plainly: a process that forks, calls
//! `setsid`, and is reparented entirely between two samples is never observed.
//! `Confirmed` therefore means "everything observed to belong to this run has
//! exited" — accurate for an ordinary script, and not proof against one written
//! to evade observation.

use std::collections::HashMap;
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

/// When the process holding `pid` started, in microseconds since the epoch.
///
/// With the pid, this names one process for good: a pid is recycled once its
/// process exits, and the recycled pid comes with a later start time (L-337).
///
/// `Ok(None)` means no live process holds `pid`: it exited, or it is a zombie,
/// which the kernel reports the same way. `Err(())` means a process is there
/// but could not be read (another user's, for instance), which is not gone.
#[cfg(target_os = "macos")]
fn start_time(pid: i32) -> Result<Option<u64>, ()> {
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: a plain C struct the kernel fills in; the buffer is exactly the
    // size passed, and anything but a full write is treated as no answer.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if written == size {
        return Ok(Some(
            info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
        ));
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Ok(None),
        _ => Err(()),
    }
}

/// No identity source is wired up off macOS, so nothing can be proven to be the
/// process that was observed, and nothing is signalled or confirmed.
#[cfg(not(target_os = "macos"))]
fn start_time(_pid: i32) -> Result<Option<u64>, ()> {
    Err(())
}

/// Reads a process's start time; injected so pid reuse can be staged in tests.
type StartTime<'a> = &'a dyn Fn(i32) -> Result<Option<u64>, ()>;

/// Whether `pid` is still the process that started at `started`.
///
/// `None` when a process holds the pid but cannot be read: it is neither
/// provably the one observed nor provably gone.
fn is_same_process(pid: i32, started: u64, start_time: StartTime) -> Option<bool> {
    match start_time(pid) {
        Ok(Some(now)) => Some(now == started),
        Ok(None) => Some(false),
        Err(()) => None,
    }
}

struct State {
    /// Processes whose ancestry was observed to reach this run: pid to start
    /// time. They stay here after reparenting, which is what makes the record
    /// useful, and the start time is what keeps a recycled pid out of it.
    owned: HashMap<i32, u64>,
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
        let mut initial = State {
            owned: HashMap::new(),
            blind: false,
        };
        match start_time(root) {
            Ok(Some(started)) => {
                initial.owned.insert(root, started);
            }
            // Already gone, so there is nothing of it left to own.
            Ok(None) => {}
            Err(()) => initial.blind = true,
        }
        let state = Arc::new(Mutex::new(initial));
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
    /// Only processes with kernel-observed ancestry to this run are signalled.
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

        for (pid, started) in self.owned() {
            // Re-read identity immediately before the signal: this pid may
            // have exited since it was recorded and been handed to an
            // unrelated process. An unreadable one is not signalled either.
            if is_same_process(pid, started, &start_time) != Some(true) {
                continue;
            }
            // SAFETY: `pid` was observed to descend from this run's own child
            // and still names the process that was observed.
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
            // A pid now held by a stranger is not a survivor of this run; one
            // that cannot be read might be, so it counts until it is gone.
            let still_alive = self
                .owned()
                .into_iter()
                .filter(|&(pid, started)| {
                    links.contains_key(&pid)
                        && is_same_process(pid, started, &start_time) != Some(false)
                })
                .count();
            if still_alive == 0 {
                break;
            }
            if Instant::now() >= deadline {
                log::warn!(
                    target: "lilypad::agent",
                    "{still_alive} process(es) from this Ask run did not exit after SIGKILL"
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

    fn owned(&self) -> Vec<(i32, u64)> {
        let me = std::process::id() as i32;
        self.state
            .lock()
            .unwrap()
            .owned
            .iter()
            .map(|(&pid, &started)| (pid, started))
            .filter(|&(pid, _)| pid != me && pid > 1)
            .collect()
    }
}

fn sample_into(state: &Arc<Mutex<State>>) {
    let Some(links) = parent_links() else {
        state.lock().unwrap().blind = true;
        return;
    };
    record_descendants(&mut state.lock().unwrap(), &links, &start_time);
}

/// Add every process whose ancestry reaches a process this run still owns.
///
/// A parent counts as owned by identity, not by pid: a recycled pid in the
/// chain belongs to a stranger, and so do that stranger's children.
fn record_descendants(state: &mut State, links: &HashMap<i32, i32>, start_time: StartTime) {
    // Walk each process up its parent chain. A chain that reaches something we
    // still own means this process belongs to the run — including a chain
    // through an intermediate that has since exited, as long as it was seen.
    for &pid in links.keys() {
        if let Some(&started) = state.owned.get(&pid) {
            if is_same_process(pid, started, start_time) == Some(true) {
                continue;
            }
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
            if let Some(&parent_started) = state.owned.get(&parent) {
                match is_same_process(parent, parent_started, start_time) {
                    Some(true) => {
                        match start_time(pid) {
                            Ok(Some(started)) => {
                                state.owned.insert(pid, started);
                            }
                            // Exited since the sample: nothing left to own.
                            Ok(None) => {}
                            // Ours, and unreadable: it can be neither signalled
                            // nor confirmed gone.
                            Err(()) => state.blind = true,
                        }
                        break;
                    }
                    // A stranger holds that pid now. Its own ancestry decides,
                    // so keep walking.
                    Some(false) => {}
                    // Something this run owned can no longer be read, so the
                    // record cannot be trusted to be complete.
                    None => {
                        state.blind = true;
                        break;
                    }
                }
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
        // Never root this fixture at the test runner itself: under Rust's normal
        // parallel test execution that makes every process spawned by a sibling
        // test our descendant, and terminate() is then correctly authorized to
        // kill them. A nonexistent root exercises the blind verdict without
        // granting this fixture ownership of unrelated test processes.
        let tracker = Tracker::start(i32::MAX);
        tracker.state.lock().unwrap().blind = true;
        assert_eq!(
            tracker.terminate(Duration::from_millis(200)),
            Cleanup::Unknown,
            "a run whose process table could not be read was reported clean"
        );
    }

    /// The second signal, tested without a race.
    ///
    /// The `setsid` escapee in `sandbox::tests` can only be *observed* by
    /// luck — that is the documented gap — so the thing that catches it when
    /// ancestry does not must be provable on its own: a process still naming
    /// this run after cleanup lowers `Confirmed` to `Unknown`, and is never
    /// killed for it.
    #[test]
    fn a_process_still_naming_the_run_lowers_the_verdict() {
        let dir = std::env::temp_dir().join(format!("lilypad_named_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Not a descendant of the tracked run: it only mentions the
        // directory. `tail -f` rather than a shell, because `/bin/sh -c` on
        // macOS `exec`s its last command and the mention disappears from the
        // argv with it — which is the same reason the doc comment above says
        // an argv check may only ever lower confidence.
        std::fs::write(dir.join("held"), b"").unwrap();
        let mut namer = Command::new("/usr/bin/tail")
            .arg("-f")
            .arg(dir.join("held"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn namer");
        let namer_pid = namer.id() as i32;
        // `spawn` returns once the fork is issued, not once the child has
        // exec’d — until it does, its argv is not yet the one this test is
        // about, and the scan below truthfully reports a clean run (L-314).
        // A fixed sleep is the wrong instrument: the window is as wide as the
        // machine is busy, which is why this only ever failed inside the full
        // suite and never alone. Wait for the evidence itself to exist.
        let visible = std::time::Instant::now();
        while argv_mentions(&dir) != Some(true) {
            assert!(
                visible.elapsed() < Duration::from_secs(10),
                "the process that names the run never became visible to the scan"
            );
            std::thread::sleep(Duration::from_millis(20));
        }

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

        // Ancestry alone is satisfied — everything owned has exited — and the
        // argv evidence is what refuses to call that a clean run.
        assert_eq!(
            tracker.terminate_in(Duration::from_secs(3), Some(&dir)),
            Cleanup::Unknown,
            "a process still naming the run was reported as a clean run"
        );
        // SAFETY: signal 0 only probes for existence.
        assert!(
            unsafe { libc::kill(namer_pid, 0) } == 0,
            "evidence was treated as authority and the process was killed"
        );

        let _ = namer.kill();
        let _ = namer.wait();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The same tracker, with nothing naming the run, still confirms — so the
    /// test above is about the evidence and not about `terminate_in` always
    /// answering `Unknown`.
    #[test]
    fn an_unnamed_run_still_confirms() {
        let dir = std::env::temp_dir().join(format!("lilypad_unnamed_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
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
            tracker.terminate_in(Duration::from_secs(3), Some(&dir)),
            Cleanup::Confirmed
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_process_table_is_none_rather_than_empty() {
        // The shape of the original defect, at the lowest level: "could not
        // look" must never be expressible as "looked, saw nothing".
        let links = parent_links().expect("ps works on this machine");
        assert!(links.contains_key(&(std::process::id() as i32)));
    }

    /// A staged process table, so pid reuse happens exactly when a test says.
    /// Nothing here reaches a real process: these pids are only map keys, and
    /// no test below calls `terminate`, which is what signals.
    fn table(
        entries: &[(i32, Result<Option<u64>, ()>)],
    ) -> impl Fn(i32) -> Result<Option<u64>, ()> {
        let entries: HashMap<_, _> = entries.iter().cloned().collect();
        move |pid| entries.get(&pid).cloned().unwrap_or(Ok(None))
    }

    /// L-337. The run owned pid 4100, which started at t=1000 and exited. The
    /// kernel gave 4100 to an unrelated process started at t=9000, which has a
    /// child of its own. A bare pid made both of them the run's.
    #[test]
    fn a_recycled_pid_is_not_owned_and_neither_are_its_children() {
        let mut state = State {
            owned: HashMap::from([(4100, 1_000)]),
            blind: false,
        };
        let links = HashMap::from([(4100, 77), (4200, 4100)]);
        let now = table(&[(4100, Ok(Some(9_000))), (4200, Ok(Some(9_500)))]);

        record_descendants(&mut state, &links, &now);

        assert!(
            !state.owned.contains_key(&4200),
            "a stranger's child was adopted through a recycled pid"
        );
        // `terminate` signals only on `Some(true)`, and counts a survivor on
        // anything but `Some(false)`.
        assert_eq!(
            is_same_process(4100, state.owned[&4100], &now),
            Some(false),
            "the stranger now holding a recycled pid would be signalled"
        );
        assert!(!state.blind);
    }

    /// The control for the test above: the same table with the original
    /// process still under its pid adopts the child, so the refusal there is
    /// about identity and not about adoption being broken.
    #[test]
    fn the_same_process_under_its_pid_still_owns_its_children() {
        let mut state = State {
            owned: HashMap::from([(4100, 1_000)]),
            blind: false,
        };
        let links = HashMap::from([(4100, 77), (4200, 4100)]);
        let now = table(&[(4100, Ok(Some(1_000))), (4200, Ok(Some(1_500)))]);

        record_descendants(&mut state, &links, &now);

        assert_eq!(state.owned.get(&4200), Some(&1_500));
        assert_eq!(is_same_process(4100, 1_000, &now), Some(true));
        assert!(!state.blind);
    }

    /// A recycled pid can also be the run's own new process. Then it is owned
    /// again, under its new start time.
    #[test]
    fn a_recycled_pid_that_descends_from_the_run_is_owned_afresh() {
        let mut state = State {
            owned: HashMap::from([(4000, 500), (4100, 1_000)]),
            blind: false,
        };
        let links = HashMap::from([(4000, 77), (4100, 4000)]);
        let now = table(&[(4000, Ok(Some(500))), (4100, Ok(Some(9_000)))]);

        record_descendants(&mut state, &links, &now);

        assert_eq!(state.owned.get(&4100), Some(&9_000));
    }

    /// Unreadable is never gone: it is not signalled, it still counts as a
    /// survivor, and a descendant that cannot be read makes the record blind.
    #[test]
    fn a_process_that_cannot_be_read_is_never_treated_as_gone() {
        assert_eq!(
            is_same_process(4100, 1_000, &table(&[(4100, Err(()))])),
            None
        );

        let mut state = State {
            owned: HashMap::from([(4100, 1_000)]),
            blind: false,
        };
        let links = HashMap::from([(4100, 77), (4200, 4100)]);
        let now = table(&[(4100, Ok(Some(1_000))), (4200, Err(()))]);
        record_descendants(&mut state, &links, &now);
        assert!(
            state.blind,
            "an unreadable descendant left the record looking complete"
        );
    }

    /// The kernel side of identity: stable for a live process, absent once the
    /// process has been reaped.
    #[test]
    fn a_reaped_process_has_no_identity_left() {
        let me = std::process::id() as i32;
        let started = start_time(me)
            .expect("this process can read itself")
            .expect("this process is alive");
        assert_eq!(start_time(me), Ok(Some(started)));

        let mut child = Command::new("/usr/bin/true").spawn().expect("spawn true");
        let pid = child.id() as i32;
        child.wait().unwrap();
        assert_eq!(start_time(pid), Ok(None));
    }
}
