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
        // `open_file` and `reveal_in_finder` are **disabled**, not merely
        // jailed (L-243).
        //
        // Both hand a path to `/usr/bin/open`, which resolves that text a
        // second time. Everything this tier can do about that happens before
        // the launch, and a check that runs before an effect is a check the
        // effect can outrun: a component of the path can change meaning in
        // between, and a launch cannot be un-launched. The re-check in
        // `verify::check` reports such an escape but cannot undo it.
        //
        // That window is not theoretical here. A sandboxed script granted a
        // writable folder can create a symbolic link inside it, and can leave
        // a background process doing so repeatedly — so the model itself can
        // race this, which is what separates it from "an attacker who already
        // has local code execution".
        //
        // `new_folder` below keeps working because `mkdirat` takes a
        // *descriptor*: there is nothing to re-resolve, so nothing to race.
        // These two take a path by definition, so the honest thing is to
        // refuse them until they are anchored, and to say why.
        Action::OpenFile { .. } | Action::RevealInFinder { .. } => bail!(
            "opening or revealing a file is unavailable in this build: the launcher \
             takes a path and re-resolves it, so the check cannot be tied to the file \
             that ends up being opened. Creating folders and opening apps still work."
        ),
        // Handled in-process by `verify::new_folder`, anchored to a directory
        // descriptor rather than to a path. There is no command to plan.
        Action::NewFolder { .. } => {
            bail!("new_folder is performed in-process, not by spawning a command")
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
        // Creating a folder is the one tier-1 effect that can be anchored to
        // the directory it was checked against, so it is performed here rather
        // than spawned. See `verify::new_folder`.
        if let Action::NewFolder { path } = action {
            return Ok(match verify::new_folder(path) {
                Ok(made) => Observation::ok(format!("created {}", made.display())),
                Err(e) => Observation::fail(format!("could not create the folder: {e}")),
            });
        }
        let spec = plan_command(action)?;
        let status = tokio::process::Command::new(&spec.program)
            .args(&spec.args)
            .kill_on_drop(true)
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
    fn plans_the_shortcut_skill() {
        assert_eq!(
            plan_command(&Action::RunShortcut {
                name: "New Note".into()
            })
            .unwrap(),
            CommandSpec::new("shortcuts", &["run", "New Note"])
        );
    }

    #[test]
    fn the_two_launch_verbs_are_refused_rather_than_jailed() {
        // L-243. These used to plan `open <path>` / `open -R <path>` after
        // jailing the text. `open` resolves that text again, so the jail was
        // checking one thing and the launcher could act on another — and a
        // sandboxed script with a writable folder can create the symlink that
        // makes them differ. A launch cannot be undone by a later check, so
        // the tier refuses to construct the command at all.
        //
        // The refusal has to *say so*: a bare error would read as a bug, and
        // the model would retry.
        for action in [
            Action::OpenFile {
                path: "~/Downloads/a.pdf".into(),
            },
            Action::RevealInFinder {
                path: "~/Downloads/a.pdf".into(),
            },
        ] {
            let err = plan_command(&action)
                .expect_err("must be refused")
                .to_string();
            assert!(err.contains("unavailable"), "unhelpful refusal: {err}");
            assert!(
                err.contains("re-resolves"),
                "refusal without a reason: {err}"
            );
        }
    }

    #[test]
    fn rejects_control_characters() {
        assert!(plan_command(&Action::OpenApp {
            name: "Safari\n; rm -rf".into()
        })
        .is_err());
    }

    #[test]
    fn new_folder_is_performed_in_process_not_spawned() {
        // It is anchored to a directory descriptor now, so there is no command
        // to plan. Planning one would mean a second path resolution — the very
        // thing the anchoring removes.
        let err = plan_command(&Action::NewFolder {
            path: "~/Research".into(),
        })
        .expect_err("no command is planned for new_folder")
        .to_string();
        assert!(err.contains("in-process"), "unexpected error: {err}");
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
