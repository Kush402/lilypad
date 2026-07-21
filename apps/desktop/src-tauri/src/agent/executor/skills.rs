//! Tier-1 executor — deterministic, allowlisted "skills".
//!
//! Skills are the cheapest, safest tier: a fixed set of parameterized macOS
//! commands (launch an app, open a URL, reveal a path, run a Shortcut). There
//! is deliberately **no free-form shell** here — the mapping from [`Action`] to
//! a concrete command is a closed, pure function ([`plan_command`]) so exactly
//! what will be spawned is unit-testable and auditable. The security gate still
//! classifies every action independently upstream; this tier just refuses to
//! even *construct* a command for anything outside its allowlist.

use anyhow::{anyhow, bail, Result};

use crate::agent::executor::verify::{self, resolve_user_path};
use crate::agent::runner::{Executor, Observation};
use crate::agent::Action;

/// A concrete command to spawn: program + args, never a shell string (so there
/// is no shell to inject into).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl CommandSpec {
    fn new(program: &str, args: &[&str]) -> Self {
        CommandSpec {
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// Map a tier-1 [`Action`] to the exact command that performs it. Pure. Returns
/// `Err` for any action this tier does not handle (higher tiers own those) and
/// for a URL whose scheme this tier won't open.
pub fn plan_command(action: &Action) -> Result<CommandSpec> {
    match action {
        Action::OpenApp { name } => {
            reject_control_chars(name, "app name")?;
            Ok(CommandSpec::new("open", &["-a", name]))
        }
        Action::OpenUrl { url } => {
            let lower = url.trim().to_ascii_lowercase();
            if !(lower.starts_with("http://") || lower.starts_with("https://")) {
                bail!("tier-1 open_url only handles http(s) URLs, got: {url}");
            }
            reject_control_chars(url, "url")?;
            Ok(CommandSpec::new("open", &[url]))
        }
        Action::RevealInFinder { path } => {
            // Jail to the user's home so the model can't probe arbitrary
            // filesystem locations by "revealing" them.
            let jailed = resolve_user_path(path)?;
            Ok(CommandSpec::new("open", &["-R", &jailed.to_string_lossy()]))
        }
        Action::OpenFile { path } => {
            let jailed = resolve_user_path(path)?;
            Ok(CommandSpec::new("open", &[&jailed.to_string_lossy()]))
        }
        Action::NewFolder { path } => {
            let jailed = resolve_user_path(path)?;
            // `mkdir -p`: idempotent, argv-only (no shell). Verification
            // (below) confirms the directory actually exists afterward.
            Ok(CommandSpec::new(
                "mkdir",
                &["-p", &jailed.to_string_lossy()],
            ))
        }
        Action::RunShortcut { name } => {
            reject_control_chars(name, "shortcut name")?;
            Ok(CommandSpec::new("shortcuts", &["run", name]))
        }
        other => Err(anyhow!(
            "action is not a tier-1 skill (needs a higher tier): {other:?}"
        )),
    }
}

/// Reject NUL and newlines defensively — arguments are passed directly to
/// `Command` (no shell), so this is belt-and-suspenders against a
/// control-character-laden argument slipping through.
fn reject_control_chars(s: &str, what: &str) -> Result<()> {
    if s.contains('\0') || s.contains('\n') || s.contains('\r') {
        bail!("{what} contains a control character");
    }
    Ok(())
}

/// The tier-1 [`Executor`]. Spawns the planned command and maps its exit status
/// to an [`Observation`] the brain can reason over.
#[derive(Default)]
pub struct SkillsExecutor;

impl Executor for SkillsExecutor {
    async fn execute(&mut self, action: &Action) -> Result<Observation> {
        let spec = plan_command(action)?;
        let status = tokio::process::Command::new(&spec.program)
            .args(&spec.args)
            .status()
            .await
            .map_err(|e| anyhow!("failed to spawn `{}`: {e}", spec.program))?;
        if !status.success() {
            return Ok(Observation::fail(format!(
                "{} exited with {}",
                spec.program, status
            )));
        }
        // Exit 0 is necessary, not sufficient — verify the real postcondition
        // (Verifier v1). A command can "succeed" while the intended state
        // didn't materialize; the brain must see that, not a false success.
        match verify::check(&verify::postcondition(action)) {
            Ok(()) => Ok(Observation::ok(format!(
                "{} {} — ok",
                spec.program,
                spec.args.join(" ")
            ))),
            Err(e) => Ok(Observation::fail(format!(
                "{} ran but verification failed: {e}",
                spec.program
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_open_app() {
        assert_eq!(
            plan_command(&Action::OpenApp {
                name: "Safari".into()
            })
            .unwrap(),
            CommandSpec::new("open", &["-a", "Safari"])
        );
    }

    #[test]
    fn plans_http_url_only() {
        assert_eq!(
            plan_command(&Action::OpenUrl {
                url: "https://example.com".into()
            })
            .unwrap(),
            CommandSpec::new("open", &["https://example.com"])
        );
        // Non-http schemes are refused at this tier (the gate also holds them).
        assert!(plan_command(&Action::OpenUrl {
            url: "file:///etc/passwd".into()
        })
        .is_err());
        assert!(plan_command(&Action::OpenUrl {
            url: "javascript:alert(1)".into()
        })
        .is_err());
    }

    #[test]
    fn plans_reveal_and_shortcut() {
        let _g = crate::agent::executor::verify::HOME_TEST_LOCK
            .lock()
            .unwrap();
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", "/Users/x");
        assert_eq!(
            plan_command(&Action::RevealInFinder {
                path: "~/Downloads/a.pdf".into()
            })
            .unwrap(),
            CommandSpec::new("open", &["-R", "/Users/x/Downloads/a.pdf"])
        );
        // Reveal is jailed too — no probing outside home.
        assert!(plan_command(&Action::RevealInFinder {
            path: "/etc/hosts".into()
        })
        .is_err());
        match prev {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        assert_eq!(
            plan_command(&Action::RunShortcut {
                name: "New Note".into()
            })
            .unwrap(),
            CommandSpec::new("shortcuts", &["run", "New Note"])
        );
    }

    #[test]
    fn rejects_control_characters() {
        assert!(plan_command(&Action::OpenApp {
            name: "Safari\n; rm -rf".into()
        })
        .is_err());
    }

    #[test]
    fn plans_jailed_file_and_folder_skills() {
        let _g = crate::agent::executor::verify::HOME_TEST_LOCK
            .lock()
            .unwrap();
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", "/Users/kush");
        assert_eq!(
            plan_command(&Action::NewFolder {
                path: "~/Research".into()
            })
            .unwrap(),
            CommandSpec::new("mkdir", &["-p", "/Users/kush/Research"])
        );
        assert_eq!(
            plan_command(&Action::OpenFile {
                path: "Downloads/a.pdf".into()
            })
            .unwrap(),
            CommandSpec::new("open", &["/Users/kush/Downloads/a.pdf"])
        );
        // Escaping paths are refused before any command is constructed.
        assert!(plan_command(&Action::NewFolder {
            path: "/etc/evil".into()
        })
        .is_err());
        assert!(plan_command(&Action::OpenFile {
            path: "~/../../etc/passwd".into()
        })
        .is_err());
        match prev {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn refuses_non_tier1_actions() {
        assert!(plan_command(&Action::Click {
            x: 0.5,
            y: 0.5,
            count: 1
        })
        .is_err());
        assert!(plan_command(&Action::TypeText { text: "hi".into() }).is_err());
    }
}
