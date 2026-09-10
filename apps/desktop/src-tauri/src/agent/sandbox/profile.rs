//! Seatbelt (SBPL) profile generation — the security-critical, pure core of
//! the sandbox. Given a [`SandboxPolicy`], produce the exact profile string
//! passed to `sandbox-exec -p`. No I/O, so every rule is unit-testable.
//!
//! Posture: **deny by default**, for reads as well as writes.
//!
//!   - **Writes** are jailed to the per-run scratch dir (plus the stdio
//!     devices and any approved output paths). Nothing else on disk can be
//!     created or modified.
//!   - **Network** is denied unless the policy explicitly allows it (a
//!     network step is held for human approval before it ever reaches here).
//!   - **Reads** are an allow-list: the OS locations an interpreter needs to
//!     bootstrap, the run's own scratch dir, and the paths the user explicitly
//!     granted for this script. The user's home directory is *not* on that
//!     list. A grant that falls inside the secret deny-list is still denied.
//!
//! ### Why reads used to be broad, and why that was wrong (L-247)
//!
//! This file previously allowed `file-read*` everywhere except a deny-list of
//! secret locations, and justified it like this: a hard read-allow-list that
//! still lets dyld bootstrap is brittle across macOS versions, and the
//! exfiltration threat is cut at both ends anyway, because network is denied.
//!
//! The first half is true. The second half is false, and it is false for a
//! reason the sentence never mentions: **stdout is the network.** A sandboxed
//! script's output is folded straight back into the model prompt and sent to
//! the provider. `cat ~/Documents/taxes.pdf` needs no sockets. So "network
//! denied" bounded where a script could *connect*, never what it could
//! *disclose*, and a finite deny-list of secret paths was never going to
//! enumerate a person's private documents, their project `.env` files, or
//! their Notes database.
//!
//! Runtime compatibility is tested with explicit OS and developer-runtime
//! locations. Whole `/Library`, `/Applications`, `/opt` and macOS temporary
//! directories also contain user data and must not be treated as system-only.
//! Nonstandard interpreter installations fail closed until their runtime-only
//! access is reviewed. This is a path-access boundary, not a guarantee that
//! arbitrary IPC or content inside explicitly granted files is non-sensitive.
//!
//! ### Rule precedence — measured, not assumed
//!
//! Established on macOS 26 (Darwin 25.5) by running `sandbox-exec` against
//! real files, because getting this backwards silently inverts the boundary:
//!
//!   1. A `(deny file-read* (subpath X))` beats a bare `(allow file-read*)`
//!      whichever order they appear in. The secret list therefore survives a
//!      broad allow.
//!   2. **But a *more specific* filter wins.** An `(allow file-read* (subpath
//!      X/Y/file))` beats a `(deny file-read* (subpath X))`. Specificity
//!      outranks both order and verb.
//!
//! Rule 2 is the one that matters here, and it is the opposite of what the
//! first draft of this module assumed. It means SBPL cannot be trusted to keep
//! an approved read grant out of `~/.ssh`: a grant naming a file *inside* a
//! denied subtree would win. So the deny list is enforced **in Rust**, by
//! dropping such a grant before the profile is built ([`is_denied_read`]) and
//! by refusing the step in the executor, and the SBPL denies remain only as a
//! second layer. A regression test runs a real `sandbox-exec` against a real
//! file under `~/.config` to keep this honest.
//!
//! Home is excluded by *omission* rather than by an explicit deny, so that an
//! ordinary grant under home works at all.

use std::path::{Path, PathBuf};

/// What one sandboxed run is permitted to touch. Everything not named here is
/// denied — reads included.
#[derive(Debug, Clone)]
pub struct SandboxPolicy {
    /// The per-run scratch dir: always writable.
    pub scratch_dir: PathBuf,
    /// Extra paths (beyond scratch) the script may write to — home-jailed by
    /// the executor before it reaches here (e.g. a plan-named output folder).
    pub writable_paths: Vec<PathBuf>,
    /// Paths under the user's home the script may read, each named by the
    /// model, home-jailed by the executor and shown on the approval card
    /// before the person approved the step. Empty is the default: a script
    /// that declares no reads cannot see anything the person owns.
    pub readable_paths: Vec<PathBuf>,
    /// Whether outbound network is permitted. Default false; only true when a
    /// network-needing step has been approved.
    pub allow_network: bool,
}

impl SandboxPolicy {
    pub fn read_only(scratch_dir: PathBuf) -> Self {
        SandboxPolicy {
            scratch_dir,
            writable_paths: Vec::new(),
            readable_paths: Vec::new(),
            allow_network: false,
        }
    }
}

/// Secret locations under the user's home that must NEVER be read by a
/// sandboxed script. Explicit denies win over the broad `file-read*` allow in
/// SBPL, so this list is the authoritative read boundary. Anchored per run by
/// prepending the (injected) home directory.
fn sensitive_deny_subpaths(home: &Path) -> Vec<PathBuf> {
    [
        // ── shells / SSH / GPG / package registries ──
        ".ssh",
        ".gnupg",
        ".netrc",
        ".npmrc",
        ".pypirc",
        // ── cloud / container / infra credentials ──
        ".aws",
        ".azure",
        ".config/gcloud",
        ".config/gh",
        ".config/git", // may hold credential helpers / tokens
        ".docker",     // config.json holds registry auth
        ".kube",       // cluster credentials
        ".terraform.d",
        // ── macOS secret stores ──
        "Library/Keychains",
        "Library/Cookies",
        "Library/Application Support/Lilypad", // our own agent-settings + key refs
        // ── browsers (saved logins, cookies, session tokens) ──
        "Library/Application Support/Google/Chrome",
        "Library/Application Support/Chromium",
        "Library/Application Support/BraveSoftware",
        "Library/Application Support/Microsoft Edge",
        "Library/Application Support/Firefox",
        "Library/Safari",
        "Library/Containers/com.apple.Safari",
        // ── messaging / notes app databases ──
        "Library/Messages",
        "Library/Application Support/Signal",
        // ── crypto wallets ──
        ".electrum",
        ".bitcoin",
        "Library/Application Support/Exodus",
        // ── the whole ~/.config is a common catch-all for tool tokens ──
        // (denied broadly; the specific entries above are belt-and-suspenders
        // in case a tool stores creds outside ~/.config too).
        ".config",
    ]
    .iter()
    .map(|s| home.join(s))
    .collect()
}

/// Runtime locations, excluding shared writable data and temporary roots.
/// Python uses the real developer-tools executable rather than the OS shim.
/// Test on supported macOS/toolchain layouts before adding any new root.
const SYSTEM_READ_ROOTS: &[&str] = &[
    "/System/Library",
    "/usr/bin",
    "/usr/lib",
    "/usr/share",
    "/bin",
    "/sbin",
    "/Library/Developer/CommandLineTools",
    "/Applications/Xcode.app/Contents/Developer",
    "/Applications/Xcode.app/Contents/SharedFrameworks",
    "/Applications/Xcode.app/Contents/Frameworks",
    "/private/var/db/dyld",
];

/// System keychain locations (outside home) that must also never be read.
const SYSTEM_SECRET_DENY: &[&str] = &["/Library/Keychains", "/private/var/db/SystemKey"];

/// SBPL string-literal escaping: wrap in double quotes, escape `\` and `"`.
/// Is reading `path` forbidden outright, regardless of any approval?
///
/// SBPL will not enforce this for us — a specific enough `allow` outranks a
/// broader `deny` (see this module's precedence notes) — so the secret list is
/// applied here, in code, before a path can reach the profile.
pub fn is_denied_read(path: &Path, home: &Path) -> bool {
    sensitive_deny_subpaths(home)
        .iter()
        .any(|deny| path == deny || path.starts_with(deny))
        || SYSTEM_SECRET_DENY
            .iter()
            .any(|deny| path == Path::new(deny) || path.starts_with(deny))
}

fn sbpl_quote(path: &Path) -> String {
    let s = path.to_string_lossy();
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Build the Seatbelt profile for `policy`, with the user's `home` injected so
/// the sensitive-deny anchors are testable without reading the environment.
pub fn build_profile(policy: &SandboxPolicy, home: &Path) -> String {
    build_profile_with_runtime_roots(policy, home, &[])
}

/// Extra roots are resolved and constrained by the runner, never model input.
pub(super) fn build_profile_with_runtime_roots(
    policy: &SandboxPolicy,
    home: &Path,
    runtime_roots: &[PathBuf],
) -> String {
    let mut p = String::new();
    p.push_str("(version 1)\n");
    p.push_str("(deny default)\n");
    // Let the interpreter fork/exec itself and read process metadata — but not
    // touch other processes.
    p.push_str("(allow process-fork)\n");
    p.push_str("(allow process-exec)\n");
    p.push_str("(allow sysctl-read)\n");
    p.push_str("(allow signal (target self))\n");
    // mach-lookup is needed broadly for an interpreter to bootstrap (dyld,
    // libSystem services), but a blanket allow also reaches the pasteboard
    // server — a script could read whatever the user last copied (passwords,
    // 2FA codes). Deny the pasteboard service specifically while keeping the
    // broad lookup the runtime needs. Explicit deny wins over the allow.
    // See the 2026-07-19 security audit.
    p.push_str("(deny mach-lookup (global-name \"com.apple.pasteboard.1\"))\n");
    p.push_str("(deny mach-lookup (global-name \"com.apple.pboard\"))\n");
    p.push_str("(allow mach-lookup)\n");

    // ── reads ────────────────────────────────────────────────────────────
    // Secret denies are defense in depth; grant filtering below enforces
    // the restriction before SBPL specificity can reopen a denied subtree.
    for deny in sensitive_deny_subpaths(home) {
        p.push_str(&format!(
            "(deny file-read* (subpath {}))\n",
            sbpl_quote(&deny)
        ));
    }
    for deny in SYSTEM_SECRET_DENY {
        p.push_str(&format!(
            "(deny file-read* (subpath {}))\n",
            sbpl_quote(Path::new(deny))
        ));
    }
    // Metadata (stat) everywhere: an interpreter probes for files it may not
    // open, and a path cannot be reached without walking its parents. This
    // discloses existence and size, never content.
    p.push_str("(allow file-read-metadata)\n");
    // The OS roots an interpreter needs. Whole roots, not individual dyld
    // paths, so a macOS update that moves the shared cache does not break the
    // sandbox. None of these is where a person keeps their own files.
    p.push_str("(allow file-read* (literal \"/\"))\n");
    for root in SYSTEM_READ_ROOTS
        .iter()
        .map(Path::new)
        .chain(runtime_roots.iter().map(PathBuf::as_path))
    {
        p.push_str(&format!(
            "(allow file-read* (subpath {}))\n",
            sbpl_quote(root)
        ));
    }
    // Python's hash seed needs entropy, not blanket access to device nodes.
    p.push_str("(allow file-read* (literal \"/dev/urandom\") (literal \"/dev/random\") (literal \"/dev/null\"))\n");
    // The run's own scratch dir — the script itself lives there, and the
    // interpreter has to read it to run it.
    p.push_str(&format!(
        "(allow file-read* (subpath {}))\n",
        sbpl_quote(&policy.scratch_dir)
    ));
    // Everything the person explicitly granted for this script, and nothing
    // else under their home — minus anything on the secret list, which no
    // approval can unlock. Dropped here rather than left to SBPL because a
    // specific allow would outrank the broader deny above.
    for r in &policy.readable_paths {
        if is_denied_read(r, home) {
            continue;
        }
        p.push_str(&format!("(allow file-read* (subpath {}))\n", sbpl_quote(r)));
    }

    // ── writes ───────────────────────────────────────────────────────────
    // The scratch dir, any explicitly-granted (approved, home-jailed) output
    // paths, plus the stdio devices. Nothing else.
    p.push_str(&format!(
        "(allow file-write* (subpath {}))\n",
        sbpl_quote(&policy.scratch_dir)
    ));
    for w in &policy.writable_paths {
        p.push_str(&format!(
            "(allow file-write* (subpath {}))\n",
            sbpl_quote(w)
        ));
    }
    p.push_str("(allow file-write-data (literal \"/dev/null\") (literal \"/dev/stdout\") (literal \"/dev/stderr\"))\n");

    // ── network ──────────────────────────────────────────────────────────
    if policy.allow_network {
        p.push_str("(allow network*)\n");
    } // else: denied by the default.

    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/kush")
    }

    fn profile(policy: &SandboxPolicy) -> String {
        build_profile(policy, &home())
    }

    #[test]
    fn denies_by_default_and_never_allows_network_unless_requested() {
        let prof = profile(&SandboxPolicy::read_only("/tmp/run1".into()));
        assert!(prof.contains("(deny default)"));
        assert!(!prof.contains("(allow network*)"));
    }

    #[test]
    fn allows_network_only_when_policy_permits() {
        let mut policy = SandboxPolicy::read_only("/tmp/run1".into());
        policy.allow_network = true;
        assert!(profile(&policy).contains("(allow network*)"));
    }

    #[test]
    fn scratch_is_writable_and_by_default_nothing_else_is() {
        let prof = profile(&SandboxPolicy::read_only("/tmp/run-xyz".into()));
        assert!(prof.contains("(allow file-write* (subpath \"/tmp/run-xyz\"))"));
        // The only other write allowance is the stdio devices — no home, no /.
        let write_lines: Vec<&str> = prof.lines().filter(|l| l.contains("file-write")).collect();
        assert_eq!(write_lines.len(), 2);
        assert!(write_lines.iter().all(|l| l.contains("/tmp/run-xyz")
            || l.contains("/dev/null")
            || l.contains("/dev/stdout")
            || l.contains("/dev/stderr")));
    }

    #[test]
    fn granted_writable_paths_are_added_to_the_write_jail() {
        let policy = SandboxPolicy {
            scratch_dir: "/tmp/r".into(),
            writable_paths: vec!["/Users/kush/Downloads".into()],
            readable_paths: Vec::new(),
            allow_network: false,
        };
        let prof = profile(&policy);
        assert!(prof.contains("(allow file-write* (subpath \"/Users/kush/Downloads\"))"));
    }

    #[test]
    fn secret_paths_are_denied_outright() {
        let prof = profile(&SandboxPolicy::read_only("/tmp/r".into()));
        for sensitive in [
            "/Users/kush/.ssh",
            "/Users/kush/Library/Keychains",
            "/Users/kush/.aws",
            "/Users/kush/Library/Application Support/Lilypad",
            "/Library/Keychains",
            // 2026-07-19 audit additions: browsers, cloud/container, ~/.config,
            // wallets, messaging.
            "/Users/kush/Library/Application Support/Google/Chrome",
            "/Users/kush/Library/Safari",
            "/Users/kush/.docker",
            "/Users/kush/.kube",
            "/Users/kush/.config",
            "/Users/kush/Library/Messages",
        ] {
            let deny = format!("(deny file-read* (subpath \"{sensitive}\"))");
            assert!(prof.contains(&deny), "missing deny for {sensitive}");
        }
    }

    #[test]
    fn the_home_directory_is_not_readable_without_a_grant() {
        // L-247. The old profile ended with a blanket `(allow file-read*)`,
        // which meant every document, project `.env` and note the person owned
        // was readable by a model-written script whose stdout goes back to the
        // provider. Nothing under home may be readable by default.
        let prof = profile(&SandboxPolicy::read_only("/tmp/r".into()));
        assert!(
            !prof.contains("(allow file-read*)\n"),
            "the blanket read allow is back:\n{prof}"
        );
        for line in prof.lines().filter(|l| l.starts_with("(allow file-read*")) {
            assert!(
                !line.contains("\"/Users/kush\""),
                "home is readable by default: {line}"
            );
        }
    }

    #[test]
    fn an_approved_read_grant_is_the_only_way_into_home() {
        let mut policy = SandboxPolicy::read_only("/tmp/r".into());
        policy.readable_paths = vec![PathBuf::from("/Users/kush/Documents/report")];
        let prof = profile(&policy);
        assert!(
            prof.contains("(allow file-read* (subpath \"/Users/kush/Documents/report\"))"),
            "granted read missing:\n{prof}"
        );
        // And only that one — a grant widens the boundary by exactly its path.
        let home_allows: Vec<&str> = prof
            .lines()
            .filter(|l| l.starts_with("(allow file-read*") && l.contains("/Users/kush/"))
            .collect();
        assert_eq!(
            home_allows.len(),
            1,
            "unexpected home reads: {home_allows:?}"
        );
    }

    #[test]
    fn a_grant_cannot_reopen_a_secret_path() {
        // No approval card may authorize reading the user's keys — not even if
        // the model names the path and the person taps approve.
        //
        // This cannot be left to SBPL. A `subpath` allow that is *more
        // specific* than the deny wins (measured, see this module's docs), so
        // a grant naming a file inside `~/.ssh` would have been honoured. The
        // grant is dropped here instead, and the deny stays as second cover.
        let mut policy = SandboxPolicy::read_only("/tmp/r".into());
        policy.readable_paths = vec![
            PathBuf::from("/Users/kush/.ssh"),
            PathBuf::from("/Users/kush/.config/gh/hosts.yml"),
            PathBuf::from("/Library/Keychains/System.keychain"),
            PathBuf::from("/Users/kush/Documents/fine.txt"),
        ];
        let prof = profile(&policy);
        assert!(prof.contains("(deny file-read* (subpath \"/Users/kush/.ssh\"))"));
        for secret in [
            "/Users/kush/.ssh",
            "/Users/kush/.config/gh/hosts.yml",
            "/Library/Keychains/System.keychain",
        ] {
            assert!(
                !prof.contains(&format!("(allow file-read* (subpath \"{secret}\"))")),
                "a grant re-opened {secret}:\n{prof}"
            );
        }
        // The legitimate grant in the same list still works.
        assert!(prof.contains("(allow file-read* (subpath \"/Users/kush/Documents/fine.txt\"))"));
    }

    #[test]
    fn the_scratch_dir_is_readable_so_the_script_can_be_run_at_all() {
        let prof = profile(&SandboxPolicy::read_only("/tmp/run-xyz".into()));
        assert!(prof.contains("(allow file-read* (subpath \"/tmp/run-xyz\"))"));
    }

    #[test]
    fn the_system_roots_an_interpreter_needs_stay_readable() {
        let prof = profile(&SandboxPolicy::read_only("/tmp/r".into()));
        assert!(prof.contains("(allow file-read* (literal \"/\"))"));
        for root in [
            "/System/Library",
            "/usr/lib",
            "/bin",
            "/Library/Developer/CommandLineTools",
        ] {
            assert!(
                prof.contains(&format!("(allow file-read* (subpath \"{root}\"))")),
                "missing system read root {root}"
            );
        }
    }

    #[test]
    fn pasteboard_mach_service_is_denied_before_the_broad_mach_allow() {
        let prof = profile(&SandboxPolicy::read_only("/tmp/r".into()));
        let allow_at = prof
            .find("(allow mach-lookup)")
            .expect("broad mach-lookup allow present");
        let deny = "(deny mach-lookup (global-name \"com.apple.pasteboard.1\"))";
        assert!(prof.contains(deny), "pasteboard mach service not denied");
        assert!(
            prof.find(deny).unwrap() < allow_at,
            "pasteboard denied after the broad allow — deny would not take effect"
        );
    }

    #[test]
    fn quotes_escape_hostile_paths() {
        assert_eq!(sbpl_quote(Path::new(r#"/a"b\c"#)), r#""/a\"b\\c""#);
    }
}
