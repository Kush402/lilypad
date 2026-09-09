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

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Result};

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
    let mut resolved = existing.canonicalize().unwrap_or(existing);
    for segment in missing {
        resolved.push(segment);
    }
    if !contains(&real_home, &resolved) {
        bail!(
            "path resolves outside the home directory: {}",
            resolved.display()
        );
    }

    // Return the lexical path, not the canonical one. Canonicalization is a
    // *check* here, not a rewrite: on macOS it would turn `/var/…` into
    // `/private/var/…` and hand the user, the Finder reveal and the
    // postcondition a path they never typed. The two differ only where a
    // symlink is involved, and we have just established that any symlink on
    // this path stays inside home.
    Ok(normalized)
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
        if cur.exists() {
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

/// What must be true after an action for it to count as succeeded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Postcondition {
    /// The path must exist (file or dir).
    PathExists(PathBuf),
    /// The path must exist and be a directory.
    PathIsDir(PathBuf),
    /// No cheap deterministic check available at this tier (exit code only).
    None,
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
            .unwrap_or(Postcondition::None),
        Action::OpenFile { path } | Action::RevealInFinder { path } => resolved(path)
            .map(Postcondition::PathExists)
            .unwrap_or(Postcondition::None),
        // OpenApp/OpenUrl/RunShortcut: launch verification needs the tier-2 AX
        // executor (running-app / window / URL-bar read); exit code only in v1.
        _ => Postcondition::None,
    }
}

/// Check a postcondition against the real filesystem. `Ok(())` = verified;
/// `Err` describes what was expected but not found. `None` verifies trivially.
pub fn check(pc: &Postcondition) -> Result<()> {
    match pc {
        Postcondition::None => Ok(()),
        Postcondition::PathExists(p) => {
            if p.exists() {
                Ok(())
            } else {
                bail!("expected {} to exist", p.display())
            }
        }
        Postcondition::PathIsDir(p) => {
            if p.is_dir() {
                Ok(())
            } else {
                bail!("expected {} to be a directory", p.display())
            }
        }
    }
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
        // An escaping path yields None (plan_command refuses it first).
        assert_eq!(
            postcondition(&Action::NewFolder {
                path: "/etc/evil".into()
            }),
            Postcondition::None
        );
        match prev {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn check_verifies_real_filesystem() {
        let dir = std::env::temp_dir().join(format!("lilypad_verify_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(check(&Postcondition::PathIsDir(dir.clone())).is_ok());
        assert!(check(&Postcondition::PathExists(dir.clone())).is_ok());
        let missing = dir.join("nope");
        assert!(check(&Postcondition::PathExists(missing.clone())).is_err());
        assert!(check(&Postcondition::PathIsDir(missing)).is_err());
        assert!(check(&Postcondition::None).is_ok());
        std::fs::remove_dir_all(&dir).ok();
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
        assert_eq!(got, j.home.join("Documents/notes"));
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
            j.home.join("alias/child"),
            "the path the user named is returned"
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
}
