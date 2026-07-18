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

    // The load-bearing containment check: the normalized path must be inside
    // (or equal to) the home directory. Compare normalized forms so `..`
    // trickery can't slip through.
    let home_norm = lexical_normalize(home).unwrap_or_else(|| home.to_path_buf());
    if normalized != home_norm && !normalized.starts_with(&home_norm) {
        bail!("path is outside the home directory: {}", normalized.display());
    }
    Ok(normalized)
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
        assert_eq!(resolve_in(home(), "~").unwrap(), PathBuf::from("/Users/kush"));
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
            postcondition(&Action::OpenFile { path: "Downloads/a.pdf".into() }),
            Postcondition::PathExists(PathBuf::from("/Users/kush/Downloads/a.pdf"))
        );
        assert_eq!(
            postcondition(&Action::OpenApp { name: "Safari".into() }),
            Postcondition::None
        );
        // An escaping path yields None (plan_command refuses it first).
        assert_eq!(
            postcondition(&Action::NewFolder { path: "/etc/evil".into() }),
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
}
