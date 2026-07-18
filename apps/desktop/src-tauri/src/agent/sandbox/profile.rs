//! Seatbelt (SBPL) profile generation — the security-critical, pure core of
//! the sandbox. Given a [`SandboxPolicy`], produce the exact profile string
//! passed to `sandbox-exec -p`. No I/O, so every rule is unit-testable.
//!
//! Posture: **deny by default**, with a deliberately asymmetric read/write
//! stance because the two carry different risk:
//!   - **Writes** are jailed to the per-run scratch dir (plus the stdio
//!     devices). Nothing else on disk can be created or modified.
//!   - **Network** is denied unless the policy explicitly allows it (a
//!     network step is held for human approval before it ever reaches here).
//!   - **Reads** are allowed broadly EXCEPT an explicit deny-list of secret
//!     locations (`~/.ssh`, keychains, cloud creds, …). A hard read-allowlist
//!     that still lets an interpreter's dyld bootstrap is brittle across macOS
//!     versions (the shared-cache paths move); denying the *secrets* while
//!     allowing benign reads is the robust equivalent, because the actual
//!     exfiltration threat is cut at BOTH ends — the secret can't be read, and
//!     even non-secret data can't leave (network denied). Explicit denies win
//!     over the broad allow in SBPL, so the secret list is authoritative.

use std::path::{Path, PathBuf};

/// What one sandboxed run is permitted to touch. Reads are broad (secrets
/// denied, see below), so only WRITE widening and network need enumerating.
#[derive(Debug, Clone)]
pub struct SandboxPolicy {
    /// The per-run scratch dir: always writable.
    pub scratch_dir: PathBuf,
    /// Extra paths (beyond scratch) the script may write to — home-jailed by
    /// the executor before it reaches here (e.g. a plan-named output folder).
    pub writable_paths: Vec<PathBuf>,
    /// Whether outbound network is permitted. Default false; only true when a
    /// network-needing step has been approved.
    pub allow_network: bool,
}

impl SandboxPolicy {
    pub fn read_only(scratch_dir: PathBuf) -> Self {
        SandboxPolicy {
            scratch_dir,
            writable_paths: Vec::new(),
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
        ".ssh",
        ".aws",
        ".config/gcloud",
        ".config/gh",
        "Library/Keychains",
        "Library/Cookies",
        "Library/Application Support/Lilypad", // our own agent-settings + key refs
        ".gnupg",
        ".netrc",
        ".npmrc",
    ]
    .iter()
    .map(|s| home.join(s))
    .collect()
}

/// System keychain locations (outside home) that must also never be read.
const SYSTEM_SECRET_DENY: &[&str] = &["/Library/Keychains", "/private/var/db/SystemKey"];

/// SBPL string-literal escaping: wrap in double quotes, escape `\` and `"`.
fn sbpl_quote(path: &Path) -> String {
    let s = path.to_string_lossy();
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Build the Seatbelt profile for `policy`, with the user's `home` injected so
/// the sensitive-deny anchors are testable without reading the environment.
pub fn build_profile(policy: &SandboxPolicy, home: &Path) -> String {
    let mut p = String::new();
    p.push_str("(version 1)\n");
    p.push_str("(deny default)\n");
    // Let the interpreter fork/exec itself and read process metadata — but not
    // touch other processes.
    p.push_str("(allow process-fork)\n");
    p.push_str("(allow process-exec)\n");
    p.push_str("(allow sysctl-read)\n");
    p.push_str("(allow mach-lookup)\n");
    p.push_str("(allow signal (target self))\n");

    // ── reads ────────────────────────────────────────────────────────────
    // Secret denies FIRST — an explicit deny outranks the broad allow below.
    for deny in sensitive_deny_subpaths(home) {
        p.push_str(&format!("(deny file-read* (subpath {}))\n", sbpl_quote(&deny)));
    }
    for deny in SYSTEM_SECRET_DENY {
        p.push_str(&format!(
            "(deny file-read* (subpath {}))\n",
            sbpl_quote(Path::new(deny))
        ));
    }
    // Everything else is readable — benign reads aren't the threat once secrets
    // are denied and the network is off (nothing read can leave).
    p.push_str("(allow file-read*)\n");

    // ── writes ───────────────────────────────────────────────────────────
    // The scratch dir, any explicitly-granted (approved, home-jailed) output
    // paths, plus the stdio devices. Nothing else.
    p.push_str(&format!(
        "(allow file-write* (subpath {}))\n",
        sbpl_quote(&policy.scratch_dir)
    ));
    for w in &policy.writable_paths {
        p.push_str(&format!("(allow file-write* (subpath {}))\n", sbpl_quote(w)));
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
            allow_network: false,
        };
        let prof = profile(&policy);
        assert!(prof.contains("(allow file-write* (subpath \"/Users/kush/Downloads\"))"));
    }

    #[test]
    fn secret_paths_are_denied_before_the_broad_read_allow() {
        let prof = profile(&SandboxPolicy::read_only("/tmp/r".into()));
        let allow_at = prof.find("(allow file-read*)").expect("broad read allow present");
        for sensitive in [
            "/Users/kush/.ssh",
            "/Users/kush/Library/Keychains",
            "/Users/kush/.aws",
            "/Users/kush/Library/Application Support/Lilypad",
            "/Library/Keychains",
        ] {
            let deny = format!("(deny file-read* (subpath \"{sensitive}\"))");
            assert!(prof.contains(&deny), "missing deny for {sensitive}");
            // Explicit deny must precede the broad allow so it stays authoritative.
            assert!(prof.find(&deny).unwrap() < allow_at, "{sensitive} denied too late");
        }
    }

    #[test]
    fn quotes_escape_hostile_paths() {
        assert_eq!(sbpl_quote(Path::new(r#"/a"b\c"#)), r#""/a\"b\\c""#);
    }
}
