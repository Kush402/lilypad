//! Verification (Verifier v1) and path jailing for tier-1 skills.
//!
//! Two responsibilities, both pure where they can be:
//!
//!   1. **Path jailing** ([`resolve_user_path`]) — the model may only name
//!      paths inside the user's home directory. Traversal (`..`) that escapes
//!      home is rejected lexically, before any filesystem call, so a crafted
//!      path can never reach `/etc`, another user, or system locations.
//!
//!   2. **Postconditions** ([`postcondition`] / [`check`]) — never trust that
//!      an action succeeded because its command exited 0. Each tier-1 action
//!      declares a cheap, deterministic postcondition; the executor checks it
//!      and downgrades the observation to a failure if reality disagrees. v1
//!      covers filesystem-checkable outcomes (folder created, file present);
//!      app/URL launch verification is exit-code-only until the tier-2 AX
//!      executor can read the running-app / window state (documented gap).

use std::ffi::{CString, OsStr, OsString};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::agent::Action;

/// The user's home directory, from `$HOME`. All jailed paths must live under it.
fn home_dir() -> Result<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        bail!("HOME is not set — cannot resolve a user path");
    }
    Ok(PathBuf::from(home))
}

/// Lexically normalize a path (resolve `.`/`..` without touching the
/// filesystem, so it works for not-yet-created folders). Returns `None` if the
/// path tries to ascend above its own root via `..`.
fn lexical_normalize(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // Only pop a real named segment; popping past the root (or the
                // jail root once joined) is an escape attempt.
                if !out.pop() {
                    return None;
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

/// Resolve a model-supplied path into a concrete, home-jailed absolute path.
///
///   - `~/…` expands to `$HOME`.
///   - A relative path is taken relative to `$HOME`.
///   - `..` may not escape `$HOME` (checked after normalization).
///   - Control characters are rejected.
///
/// Pure except for reading `$HOME`; does no filesystem access, so it is safe
/// for paths that don't exist yet (e.g. a folder about to be created).
pub fn resolve_user_path(raw: &str) -> Result<PathBuf> {
    resolve_in(&home_dir()?, raw)
}

/// The pure core of [`resolve_user_path`] with the home directory injected —
/// no `$HOME` read, so tests are deterministic and can't race each other on a
/// process-global env var.
fn resolve_in(home: &Path, raw: &str) -> Result<PathBuf> {
    if raw.contains('\0') || raw.contains('\n') || raw.contains('\r') {
        bail!("path contains a control character");
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!("path is empty");
    }

    let joined = if let Some(rest) = trimmed.strip_prefix("~/") {
        home.join(rest)
    } else if trimmed == "~" {
        home.to_path_buf()
    } else {
        let p = Path::new(trimmed);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            home.join(p)
        }
    };

    let normalized =
        lexical_normalize(&joined).ok_or_else(|| anyhow::anyhow!("path escapes above root"))?;

    // First gate: the text must be inside home. Cheap, and it rejects `..`
    // traversal before any filesystem call — including for paths that do not
    // exist yet.
    let home_norm = lexical_normalize(home).unwrap_or_else(|| home.to_path_buf());
    if !contains(&home_norm, &normalized) {
        bail!(
            "path is outside the home directory: {}",
            normalized.display()
        );
    }

    // Second gate: the *real* location must be inside home too.
    //
    // The lexical check believes the path text, and `~/escape/x` is textually
    // innocent when `~/escape` is a symlink to `/tmp`. `open` and `mkdir -p`
    // follow it, so the promised boundary was decorative for anyone who could
    // create a link under home. Canonicalize the deepest ancestor that exists
    // (canonicalize resolves symlinks, and only works on real paths), then
    // re-attach the components that do not exist yet and check the whole thing
    // again — that is what makes `new_folder` on a missing child of a symlink
    // fail rather than create outside home.
    let real_home = home.canonicalize().unwrap_or_else(|_| home_norm.clone());
    //
    // Only the reconstructed whole path is checked. The deepest existing
    // ancestor is often *above* home (when home itself has yet to be created,
    // as in tests and a fresh account), and rejecting on that would refuse
    // every legitimate path — it is not an escape, it is a prefix.
    let (existing, missing) = deepest_existing(&normalized);
    let mut resolved = existing.canonicalize().map_err(|e| {
        anyhow::anyhow!(
            "cannot resolve existing ancestor {}: {e}",
            existing.display()
        )
    })?;
    for segment in missing {
        resolved.push(segment);
    }
    if !contains(&real_home, &resolved) {
        bail!(
            "path resolves outside the home directory: {}",
            resolved.display()
        );
    }

    // Execute against the resolved location; returning the alias would follow
    // it a second time if another process replaced that symlink after checking.
    Ok(resolved)
}

/// Is `p` the root itself, or inside it?
fn contains(root: &Path, p: &Path) -> bool {
    p == root || p.starts_with(root)
}

/// Split `path` into its deepest ancestor that exists on disk and the trailing
/// components that do not exist yet (in order).
///
/// `canonicalize` only works on paths that exist, and the whole point of this
/// jail is that it must also hold for a folder about to be created.
fn deepest_existing(path: &Path) -> (PathBuf, Vec<OsString>) {
    let mut missing: Vec<OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        if std::fs::symlink_metadata(&cur).is_ok() {
            missing.reverse();
            return (cur, missing);
        }
        match cur.file_name() {
            Some(name) => {
                missing.push(name.to_os_string());
                if !cur.pop() {
                    missing.reverse();
                    return (cur, missing);
                }
            }
            // Reached a root (or an empty path) that does not exist.
            None => {
                missing.reverse();
                return (cur, missing);
            }
        }
    }
}

// ── the anchored jail (L-243) ────────────────────────────────────────────
//
// `resolve_user_path` decides where a path *points*; `open`/`mkdir` then
// resolve the same text again, and between those two resolutions the meaning
// of a component can change. Re-checking afterwards ([`check`]) reports the
// escape, which is better than silence, but it cannot un-create a directory or
// un-launch a file.
//
// The fix for anything we perform ourselves is to stop naming the target by
// text at all: walk the path one component at a time, refusing to traverse a
// symbolic link at any step, and keep the *descriptor* of the directory we
// arrived at. A descriptor refers to the directory object, not to its name, so
// renaming or replacing that name afterwards cannot redirect the operation.
// `mkdirat` on that descriptor either creates the folder in the directory we
// verified or fails; there is no window in between.
//
// This only works for operations that take a descriptor. `open(1)` takes a
// path, so `open_file` cannot be anchored and is refused instead — see
// `skills::plan_command`.

/// A directory this module opened itself, component by component, without
/// following a symbolic link.
#[derive(Debug)]
pub struct JailedDir {
    fd: OwnedFd,
    path: PathBuf,
}

impl JailedDir {
    /// The path walked to get here — for messages only. The *operation* uses
    /// the descriptor; this text is never re-resolved.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Identity of a filesystem object: the same object under any name.
///
/// A path can be made to mean something else between two calls; a `(dev, ino)`
/// pair cannot. Used to bind a grant to the object the person approved, so a
/// target swapped after approval is refused rather than acted on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId {
    dev: i64,
    ino: u64,
}

fn cstr(name: &OsStr) -> Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| anyhow::anyhow!("path component contains a NUL"))
}

/// Is `name` inside `dirfd` a symbolic link? Used only to explain a failure,
/// so an unanswerable question is "no" rather than an error.
fn is_symlink_at(dirfd: i32, name: &CString) -> bool {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: valid descriptor and C string; `st` is ours to fill.
    let rc = unsafe { libc::fstatat(dirfd, name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) };
    rc == 0 && st.st_mode & libc::S_IFMT == libc::S_IFLNK
}

/// Open `name` inside `parent` as a directory, refusing a symbolic link.
fn open_dir_at(parent: Option<&OwnedFd>, name: &OsStr, nofollow: bool) -> Result<OwnedFd> {
    let c = cstr(name)?;
    let mut flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
    if nofollow {
        flags |= libc::O_NOFOLLOW;
    }
    let dirfd = parent.map(|p| p.as_raw_fd()).unwrap_or(libc::AT_FDCWD);
    // SAFETY: `c` is a valid NUL-terminated C string that outlives the call,
    // and `dirfd` is either AT_FDCWD or a descriptor we own.
    let fd = unsafe { libc::openat(dirfd, c.as_ptr(), flags) };
    if fd < 0 {
        let err = std::io::Error::last_os_error();
        // Which errno means "that was a symlink" depends on the flags and the
        // platform: `O_NOFOLLOW` alone gives ELOOP, but combined with
        // `O_DIRECTORY` macOS gives ENOTDIR, which is also what a plain file
        // gives. Guessing from errno gets one of those two cases wrong, so ask
        // the filesystem what the name actually is.
        if nofollow && is_symlink_at(dirfd, &c) {
            bail!(
                "{} is a symbolic link — the jail will not follow one",
                name.to_string_lossy()
            );
        }
        return Err(
            anyhow::Error::new(err).context(format!("cannot open {}", name.to_string_lossy()))
        );
    }
    // SAFETY: `openat` returned a fresh, owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Walk `target` from `home`, component by component, following no symbolic
/// link, and return the descriptor of its **parent** directory plus the final
/// component's name.
///
/// `target` must already have passed [`resolve_in`], so it is lexically inside
/// home; this walk is what makes that true of the real objects as well.
pub fn walk_to_parent(home: &Path, target: &Path) -> Result<(JailedDir, OsString)> {
    walk(home, target, false)
}

/// How many path components below home one `new_folder` may create.
///
/// `mkdir -p` has no limit, and a model that has misread a task can ask for
/// one. This is deep enough for anything a person would type and shallow
/// enough that a runaway request is refused rather than acted on.
pub const MAX_NEW_FOLDER_DEPTH: usize = 32;

/// As [`walk_to_parent`], but creating the intermediate directories that do
/// not exist yet (L-268).
///
/// The tool has always told the model it creates "any missing parents". It did
/// not: the walk only ever *opened* components, so a nested path failed at the
/// first one that was not already there — and the tests all created the parent
/// in advance, so nothing said so.
///
/// Each level is created and then descended into by descriptor, never by path,
/// so the jail is the same one the plain walk enforces. A component that is
/// already a real directory is reused; one that is a symbolic link or a
/// regular file is refused rather than replaced, and a link swapped in between
/// the create and the open fails the `O_NOFOLLOW` open.
pub fn walk_creating_parents(home: &Path, target: &Path) -> Result<(JailedDir, OsString)> {
    walk(home, target, true)
}

fn walk(home: &Path, target: &Path, create: bool) -> Result<(JailedDir, OsString)> {
    let rest = target
        .strip_prefix(home)
        .map_err(|_| anyhow::anyhow!("{} is not under the home directory", target.display()))?;
    let mut components: Vec<&OsStr> = rest.iter().collect();
    let Some(last) = components.pop() else {
        bail!("cannot operate on the home directory itself");
    };
    if create && components.len() + 1 > MAX_NEW_FOLDER_DEPTH {
        bail!(
            "{} is more than {MAX_NEW_FOLDER_DEPTH} folders deep",
            target.display()
        );
    }

    // Home is opened *following* links: the user may legitimately have their
    // home directory behind one, and it is the root of the jail rather than
    // something inside it. Everything below it is walked no-follow.
    let mut dir = JailedDir {
        fd: open_dir_at(None, home.as_os_str(), false)
            .with_context(|| format!("cannot open the home directory {}", home.display()))?,
        path: home.to_path_buf(),
    };
    for comp in components {
        if create {
            // Succeeds when the component is already a real directory, and
            // refuses a link or a file in its place — the same rule the final
            // component gets, applied at every level.
            create_dir_at(&dir, comp)?;
        }
        let fd = open_dir_at(Some(&dir.fd), comp, true)?;
        let path = dir.path.join(comp);
        dir = JailedDir { fd, path };
    }
    Ok((dir, last.to_os_string()))
}

/// The identity of `name` inside `dir`, or `None` if it does not exist.
/// A symbolic link is an error, not an identity — the jail never resolves one.
pub fn identify_at(dir: &JailedDir, name: &OsStr) -> Result<Option<FileId>> {
    let c = cstr(name)?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: valid descriptor, valid C string, and `st` is ours to fill.
    let rc = unsafe {
        libc::fstatat(
            dir.fd.as_raw_fd(),
            c.as_ptr(),
            &mut st,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc < 0 {
        let err = std::io::Error::last_os_error();
        if err.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(anyhow::Error::new(err)
            .context(format!("cannot inspect {}", dir.path.join(name).display())));
    }
    if st.st_mode & libc::S_IFMT == libc::S_IFLNK {
        bail!(
            "{} is a symbolic link — the jail will not follow one",
            dir.path.join(name).display()
        );
    }
    Ok(Some(FileId {
        dev: st.st_dev as i64,
        ino: st.st_ino,
    }))
}

/// Create a directory named `name` inside the already-verified `dir`.
///
/// Race-free where the old `mkdir -p` was not: the directory is created
/// *relative to a descriptor* we walked ourselves, so replacing any name along
/// the way afterwards cannot redirect it. Idempotent, like `mkdir -p`, but an
/// existing symbolic link is a failure rather than a silent success.
pub fn create_dir_at(dir: &JailedDir, name: &OsStr) -> Result<()> {
    let c = cstr(name)?;
    // SAFETY: valid descriptor and C string; 0o755 is a plain mode.
    let rc = unsafe { libc::mkdirat(dir.fd.as_raw_fd(), c.as_ptr(), 0o755) };
    if rc == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    if err.kind() != std::io::ErrorKind::AlreadyExists {
        return Err(anyhow::Error::new(err)
            .context(format!("cannot create {}", dir.path.join(name).display())));
    }
    // Already there. `mkdir -p` treats that as success; so do we, but only for
    // a real directory. A symlink sitting in the target's place is exactly the
    // case this whole walk exists to refuse.
    match identify_at(dir, name)? {
        Some(_) => {
            let c2 = cstr(name)?;
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            // SAFETY: as in `identify_at`.
            let rc = unsafe {
                libc::fstatat(
                    dir.fd.as_raw_fd(),
                    c2.as_ptr(),
                    &mut st,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if rc == 0 && st.st_mode & libc::S_IFMT == libc::S_IFDIR {
                Ok(())
            } else {
                bail!(
                    "{} already exists and is not a directory",
                    dir.path.join(name).display()
                )
            }
        }
        None => bail!(
            "{} vanished while it was being created",
            dir.path.join(name).display()
        ),
    }
}

/// Create a home-jailed folder, anchored to a descriptor rather than to text.
/// The whole of `new_folder`'s effect, so the tier-1 executor spawns nothing.
pub fn new_folder(raw: &str) -> Result<PathBuf> {
    let home = home_dir()?;
    let jailed = resolve_in(&home, raw)?;
    // `resolve_in` already returns the canonicalised location, so this is the
    // same root it checked against — walking from anywhere else would be
    // checking one thing and creating in another.
    let real_home = home.canonicalize().unwrap_or(home);
    // "and any missing parents", as the tool has always claimed (L-268).
    let (dir, name) = walk_creating_parents(&real_home, &jailed)?;
    create_dir_at(&dir, &name)?;
    Ok(dir.path().join(&name))
}

/// What must be true after an action for it to count as succeeded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Postcondition {
    /// The path must exist (file or dir).
    PathExists(PathBuf),
    /// The path must exist and be a directory.
    PathIsDir(PathBuf),
    /// No cheap deterministic check available at this tier (exit code only).
    None,
    InvalidPath(String),
}

/// The postcondition for a tier-1 action. Resolves the path exactly as
/// `plan_command` does (so the checked path is the jailed one that was acted
/// on); an unresolvable path yields `None` here because `plan_command` would
/// already have refused to run it.
pub fn postcondition(action: &Action) -> Postcondition {
    let resolved = |path: &str| resolve_user_path(path).ok();
    match action {
        Action::NewFolder { path } => resolved(path)
            .map(Postcondition::PathIsDir)
            .unwrap_or_else(|| Postcondition::InvalidPath(path.clone())),
        Action::OpenFile { path } | Action::RevealInFinder { path } => resolved(path)
            .map(Postcondition::PathExists)
            .unwrap_or_else(|| Postcondition::InvalidPath(path.clone())),
        // OpenApp/OpenUrl/RunShortcut: launch verification needs the tier-2 AX
        // executor (running-app / window / URL-bar read); exit code only in v1.
        _ => Postcondition::None,
    }
}

/// Check a postcondition against the real filesystem. `Ok(())` = verified;
/// `Err` describes what was expected but not found. `None` verifies trivially.
///
/// This is also the second half of the path jail (L-243). [`resolve_in`]
/// checks where a path points and then hands the result to `open`/`mkdir`,
/// which resolve it *again*; between those two resolutions the final component
/// can become a symlink pointing anywhere. Nothing can make that window zero
/// while the action is an external command taking a path — but the window can
/// be made *loud*: re-resolve here, and refuse to report success for a path
/// that is now a symlink, or that now lands outside home. A silent escape
/// becomes a failed step the model and the person both see.
pub fn check(pc: &Postcondition) -> Result<()> {
    match pc {
        Postcondition::None => Ok(()),
        Postcondition::InvalidPath(path) => bail!("cannot verify rejected path: {path}"),
        Postcondition::PathExists(p) => {
            if !p.exists() {
                bail!("expected {} to exist", p.display());
            }
            still_jailed(p)
        }
        Postcondition::PathIsDir(p) => {
            if !p.is_dir() {
                bail!("expected {} to be a directory", p.display());
            }
            still_jailed(p)
        }
    }
}

/// Is the path the action just acted on still the jailed path it was checked
/// as — not a symlink, and still inside home?
fn still_jailed(p: &Path) -> Result<()> {
    // `symlink_metadata` does not follow the last component, so this catches a
    // link swapped in after `resolve_in` returned.
    let meta = std::fs::symlink_metadata(p)
        .with_context(|| format!("cannot inspect {} after acting on it", p.display()))?;
    if meta.file_type().is_symlink() {
        bail!(
            "{} became a symbolic link after it was checked — refusing to report success",
            p.display()
        );
    }
    let home = home_dir()?;
    let real_home = home.canonicalize().unwrap_or(home);
    let real = p
        .canonicalize()
        .with_context(|| format!("cannot resolve {} after acting on it", p.display()))?;
    if !contains(&real_home, &real) {
        bail!(
            "{} now resolves outside the home directory ({})",
            p.display(),
            real.display()
        );
    }
    Ok(())
}

/// Serializes the handful of tests that must mutate the process-global `$HOME`
/// (those exercising `resolve_user_path`/`postcondition` end-to-end). The pure
/// jailing logic is tested via `resolve_in` without any env at all.
#[cfg(test)]
pub(crate) static HOME_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/kush";
    fn home() -> &'static Path {
        Path::new(HOME)
    }

    #[test]
    fn expands_tilde_and_relative_under_home() {
        assert_eq!(
            resolve_in(home(), "~/Downloads/a.pdf").unwrap(),
            PathBuf::from("/Users/kush/Downloads/a.pdf")
        );
        assert_eq!(
            resolve_in(home(), "Research").unwrap(),
            PathBuf::from("/Users/kush/Research")
        );
        assert_eq!(
            resolve_in(home(), "~").unwrap(),
            PathBuf::from("/Users/kush")
        );
    }

    #[test]
    fn rejects_traversal_and_absolute_escapes() {
        assert!(resolve_in(home(), "~/../../etc/passwd").is_err());
        assert!(resolve_in(home(), "/etc/passwd").is_err());
        assert!(resolve_in(home(), "../otheruser/secrets").is_err());
        assert!(resolve_in(home(), "~/a/../../..").is_err());
    }

    #[test]
    fn allows_interior_dotdot_that_stays_within_home() {
        assert_eq!(
            resolve_in(home(), "~/a/b/../c").unwrap(),
            PathBuf::from("/Users/kush/a/c")
        );
    }

    #[test]
    fn rejects_control_chars_and_empty() {
        assert!(resolve_in(home(), "~/a\nb").is_err());
        assert!(resolve_in(home(), "   ").is_err());
    }

    #[test]
    fn postcondition_selects_by_action_and_resolves_path() {
        let _g = HOME_TEST_LOCK.lock().unwrap();
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", HOME);
        assert_eq!(
            postcondition(&Action::NewFolder { path: "~/R".into() }),
            Postcondition::PathIsDir(PathBuf::from("/Users/kush/R"))
        );
        assert_eq!(
            postcondition(&Action::OpenFile {
                path: "Downloads/a.pdf".into()
            }),
            Postcondition::PathExists(PathBuf::from("/Users/kush/Downloads/a.pdf"))
        );
        assert_eq!(
            postcondition(&Action::OpenApp {
                name: "Safari".into()
            }),
            Postcondition::None
        );
        // Verification must also fail closed if planning is bypassed.
        assert_eq!(
            postcondition(&Action::NewFolder {
                path: "/etc/evil".into()
            }),
            Postcondition::InvalidPath("/etc/evil".into())
        );
        match prev {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    /// Run `body` with `$HOME` pointed at an isolated jail, restoring the
    /// previous value afterwards. `check` re-resolves against the real home
    /// (L-243), so any test of it has to own that variable.
    fn with_home<T>(j: &Jail, body: impl FnOnce() -> T) -> T {
        // Not `unwrap()`: one test failing inside this closure poisons the
        // lock, and a poisoned lock turns a single readable failure into four
        // `PoisonError` panics that say nothing about what broke.
        let _g = HOME_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", &j.home);
        let out = body();
        match prev {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        out
    }

    #[test]
    fn check_verifies_real_filesystem() {
        let j = jail();
        let dir = j.home.join("verify");
        std::fs::create_dir_all(&dir).unwrap();
        with_home(&j, || {
            assert!(check(&Postcondition::PathIsDir(dir.clone())).is_ok());
            assert!(check(&Postcondition::PathExists(dir.clone())).is_ok());
            let missing = dir.join("nope");
            assert!(check(&Postcondition::PathExists(missing.clone())).is_err());
            assert!(check(&Postcondition::PathIsDir(missing)).is_err());
            assert!(check(&Postcondition::None).is_ok());
        });
    }

    #[test]
    fn creating_a_folder_refuses_to_traverse_a_symlink_instead_of_following_it() {
        // L-243, the prevention half. `mkdir -p ~/Reports/Q3` with `~/Reports`
        // a link to somewhere outside home used to create `Q3` out there and
        // exit 0. The walk refuses the link itself, so nothing is created —
        // and the outside directory must still be empty afterwards, which is
        // the only assertion that distinguishes "prevented" from "detected".
        let j = jail();
        std::os::unix::fs::symlink(&j.outside, j.home.join("Reports")).unwrap();
        with_home(&j, || {
            new_folder("~/Reports/Q3").expect_err("a symlinked parent must be refused")
        });
        // Two layers refuse this — `resolve_in` canonicalises and sees the
        // destination is outside home, and the walk refuses the link itself —
        // so the message depends on which fires first. The assertion is about
        // the *effect*: with `mkdir -p` this directory used to be created out
        // here and the command exited 0.
        assert!(
            !j.outside.join("Q3").exists(),
            "the folder was created outside the jail — this is detection, not prevention"
        );
    }

    #[test]
    fn creating_a_folder_works_for_an_ordinary_nested_path_and_is_idempotent() {
        let j = jail();
        std::fs::create_dir_all(j.home.join("Research")).unwrap();
        let made = with_home(&j, || new_folder("~/Research/2026").unwrap());
        assert!(made.is_dir());
        // `mkdir -p` semantics: asking twice is not an error.
        let again = with_home(&j, || new_folder("~/Research/2026").unwrap());
        assert_eq!(made, again);
    }

    /// L-268. The tool description has always promised "and any missing
    /// parents", and the walk only ever opened what was already there — so a
    /// nested path failed at the first missing level. Every existing test
    /// created the parent in advance, which is why nothing caught it.
    #[test]
    fn creating_a_folder_creates_the_parents_the_tool_promises() {
        let j = jail();
        let made = with_home(&j, || {
            new_folder("~/Research/2026/Q3/drafts").expect("missing parents must be created")
        });
        assert!(made.is_dir());
        for level in ["Research", "Research/2026", "Research/2026/Q3"] {
            assert!(
                j.home.join(level).is_dir(),
                "{level} was not created on the way down"
            );
        }
        // Still idempotent, and still through descriptors.
        let again = with_home(&j, || new_folder("~/Research/2026/Q3/drafts").unwrap());
        assert_eq!(made, again);
    }

    /// The jail applies at every level, not only the last one. A link or a
    /// regular file part-way down is refused rather than followed or replaced.
    #[test]
    fn a_parent_that_is_not_a_real_directory_is_refused_rather_than_created_through() {
        let j = jail();
        std::os::unix::fs::symlink(&j.outside, j.home.join("Linked")).unwrap();
        std::fs::write(j.home.join("Notes"), "not a directory").unwrap();

        with_home(&j, || {
            new_folder("~/Linked/Q3").expect_err("a symlinked parent must be refused");
            new_folder("~/Notes/Q3").expect_err("a regular file as a parent must be refused");
        });
        assert!(
            !j.outside.join("Q3").exists(),
            "a folder was created through a link — this is detection, not prevention"
        );
        assert!(
            std::fs::symlink_metadata(j.home.join("Linked"))
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link was replaced instead of refused"
        );
        assert!(j.home.join("Notes").is_file());
    }

    /// `mkdir -p` will happily create a thousand levels. A model that has
    /// misread a task can ask for that, so the depth is bounded and the
    /// refusal happens before anything is created.
    #[test]
    fn an_absurdly_deep_request_is_refused_before_anything_is_made() {
        let j = jail();
        let deep = std::iter::repeat_n("d", MAX_NEW_FOLDER_DEPTH + 1)
            .collect::<Vec<_>>()
            .join("/");
        with_home(&j, || {
            new_folder(&format!("~/{deep}")).expect_err("an unbounded depth must be refused")
        });
        assert!(
            !j.home.join("d").exists(),
            "the first level was created anyway"
        );
    }

    #[test]
    fn a_symlink_standing_where_the_folder_should_go_is_an_error_not_a_silent_success() {
        // `mkdirat` returns EEXIST for a symlink just as it does for a real
        // directory. Treating EEXIST as success — which is what `mkdir -p`
        // does — would accept exactly the case the walk exists to refuse.
        let j = jail();
        std::os::unix::fs::symlink(&j.outside, j.home.join("Q3")).unwrap();
        with_home(&j, || {
            new_folder("~/Q3").expect_err("a symlink in the target's place must fail")
        });
        // The link is still a link: nothing was created through it, and it was
        // not silently accepted as "the folder already exists".
        assert!(std::fs::symlink_metadata(j.home.join("Q3"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn identity_distinguishes_the_same_name_from_the_same_object() {
        // What a grant has to be bound to. Two names for one object share an
        // identity; one name that has been replaced does not.
        let j = jail();
        std::fs::create_dir_all(j.home.join("Docs")).unwrap();
        std::fs::write(j.home.join("Docs/a.txt"), "x").unwrap();
        let (dir, name) = walk_to_parent(&j.home, &j.home.join("Docs/a.txt")).unwrap();
        let first = identify_at(&dir, &name).unwrap().expect("the file exists");

        std::fs::remove_file(j.home.join("Docs/a.txt")).unwrap();
        std::fs::write(j.home.join("Docs/a.txt"), "y").unwrap();
        let second = identify_at(&dir, &name)
            .unwrap()
            .expect("the new file exists");
        assert_ne!(
            first, second,
            "a replaced file kept its identity — a grant bound to it would follow the swap"
        );

        // And a missing name has no identity at all, rather than a stale one.
        std::fs::remove_file(j.home.join("Docs/a.txt")).unwrap();
        assert_eq!(identify_at(&dir, &name).unwrap(), None);
    }

    #[test]
    fn the_walk_refuses_a_symlinked_component_even_when_it_stays_inside_home() {
        // Inside-home is not the test; *not following a link* is. A link
        // between two home folders is still a name whose meaning can change
        // after it is checked.
        let j = jail();
        std::fs::create_dir_all(j.home.join("Real")).unwrap();
        std::os::unix::fs::symlink(j.home.join("Real"), j.home.join("Alias")).unwrap();
        let err = walk_to_parent(&j.home, &j.home.join("Alias/file.txt"))
            .expect_err("a symlinked component must be refused")
            .to_string();
        assert!(err.contains("symbolic link"), "unexpected error: {err}");
    }

    #[test]
    fn a_path_that_became_a_symlink_after_the_check_is_not_reported_as_success() {
        // L-243. `resolve_in` decides where a path points; `mkdir -p`/`open`
        // resolve it again a moment later. Between the two, the last component
        // can be replaced by a link out of home — and `mkdir -p` on an existing
        // symlink-to-directory exits 0, so the old `is_dir()` postcondition
        // (which follows links) reported success for a folder created outside
        // the jail. Simulated here by doing the swap directly.
        let j = jail();
        let target = j.home.join("Reports");
        std::os::unix::fs::symlink(&j.outside, &target).unwrap();
        with_home(&j, || {
            let err = check(&Postcondition::PathIsDir(target.clone()))
                .expect_err("a symlinked result must not verify");
            assert!(
                err.to_string().contains("symbolic link"),
                "unexpected error: {err}"
            );
        });
    }

    #[test]
    fn a_path_that_now_resolves_outside_home_is_not_reported_as_success() {
        // The same defect one level up: the *parent* is swapped, so the final
        // component is a real directory but lives outside the jail.
        let j = jail();
        let real = j.outside.join("escaped");
        std::fs::create_dir_all(&real).unwrap();
        let link = j.home.join("Docs");
        std::os::unix::fs::symlink(&j.outside, &link).unwrap();
        let via_link = link.join("escaped");
        with_home(&j, || {
            let err = check(&Postcondition::PathIsDir(via_link))
                .expect_err("a path outside home must not verify");
            assert!(
                err.to_string().contains("outside the home directory"),
                "unexpected error: {err}"
            );
        });
    }

    // ── L-231: the home boundary survives a symlink ──
    //
    // The check used to be purely lexical, so `~/escape/x` passed while
    // `~/escape` was a symlink to somewhere else entirely and `mkdir -p`
    // happily followed it. Isolated temp home/outside dirs, per the acceptance
    // criteria — and the outside directory must still be empty at the end.

    /// An isolated home + an outside directory, cleaned up on drop. Built from
    /// `std::env::temp_dir` like the rest of this file's tests rather than
    /// pulling in a temp-dir crate for six lines.
    struct Jail {
        root: PathBuf,
        home: PathBuf,
        outside: PathBuf,
    }

    impl Drop for Jail {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }

    fn jail() -> Jail {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("lilypad_jail_{}_{n}", std::process::id()));
        let home = root.join("home");
        let outside = root.join("outside");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        Jail {
            root,
            home,
            outside,
        }
    }

    #[test]
    fn a_legitimate_in_home_path_is_accepted() {
        let j = jail();
        let got = resolve_in(&j.home, "~/Documents/notes").expect("in-home path must resolve");
        assert_eq!(got, j.home.canonicalize().unwrap().join("Documents/notes"));
    }

    #[test]
    fn direct_traversal_out_of_home_is_rejected() {
        let j = jail();
        for raw in [
            "../outside",
            "~/../outside",
            "../../etc/passwd",
            "/etc/passwd",
        ] {
            let err = resolve_in(&j.home, raw)
                .expect_err("{raw} must not resolve")
                .to_string();
            assert!(
                err.contains("outside the home directory") || err.contains("escapes above root"),
                "{raw}: unexpected error {err}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_home_is_rejected_even_though_its_text_looks_innocent() {
        let j = jail();
        let link = j.home.join("escape");
        std::os::unix::fs::symlink(&j.outside, &link).unwrap();
        // Textually this is "~/escape" — squarely inside home.
        let err = resolve_in(&j.home, "~/escape")
            .expect_err("a symlink leaving home must be rejected")
            .to_string();
        assert!(err.contains("resolves outside the home directory"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_child_below_an_escaping_symlink_is_rejected() {
        // This is the one that mattered: `new_folder` takes a path that does
        // not exist yet, so nothing could be canonicalized at the leaf — and
        // the old code therefore never looked at the filesystem at all.
        let j = jail();
        let link = j.home.join("escape");
        std::os::unix::fs::symlink(&j.outside, &link).unwrap();
        let err = resolve_in(&j.home, "~/escape/new_folder")
            .expect_err("a missing child below an escaping symlink must be rejected")
            .to_string();
        assert!(err.contains("resolves outside the home directory"), "{err}");
        assert_eq!(
            std::fs::read_dir(&j.outside).unwrap().count(),
            0,
            "the outside directory must remain untouched"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_stays_inside_home_is_still_allowed() {
        // The jail is about leaving home, not about symlinks as such.
        let j = jail();
        let real = j.home.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, j.home.join("alias")).unwrap();
        let got = resolve_in(&j.home, "~/alias/child").expect("in-home symlink must resolve");
        assert_eq!(
            got,
            real.join("child")
                .canonicalize()
                .unwrap_or_else(|_| real.canonicalize().unwrap().join("child")),
            "execution uses the checked location, not the mutable alias"
        );
    }

    #[test]
    fn deepest_existing_splits_at_the_first_missing_component() {
        let j = jail();
        let (existing, missing) = deepest_existing(&j.home.join("a/b/c"));
        assert_eq!(existing, j.home);
        assert_eq!(
            missing,
            vec![
                OsString::from("a"),
                OsString::from("b"),
                OsString::from("c")
            ]
        );
    }
    #[test]
    fn a_rejected_path_is_not_a_successful_postcondition() {
        assert!(check(&postcondition(&Action::NewFolder { path: "/".into() })).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_valid_alias_does_not_redirect_the_resolved_path() {
        let j = jail();
        let real = j.home.join("real");
        std::fs::create_dir(&real).unwrap();
        let alias = j.home.join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let target = resolve_in(&j.home, "~/alias/child").unwrap();
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&j.outside, &alias).unwrap();
        std::fs::create_dir(&target).unwrap();
        assert!(real.join("child").exists());
        assert!(!j.outside.join("child").exists());
    }
}
