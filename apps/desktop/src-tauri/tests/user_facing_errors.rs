//! What the Mac says when something goes wrong.
//!
//! Four modules' errors are rendered to a person **verbatim**: every
//! `#[tauri::command]` in `commands.rs` returns `Result<_, String>` built with
//! `e.to_string()`, and the dashboard's four catch blocks all do
//! `setError(String(err))`. So a `bail!` written for a developer is a sentence
//! a customer reads on the screen that makes their computer theirs.
//!
//! Measured 2026-08-25, before this test existed:
//!
//!   auth.rs      `device sign-in failed (HTTP {status}): {body}`
//!   identity.rs  `could not read the device key: {e}`   (a keyring error)
//!   account.rs   `could not clear the stored account session: {e}`
//!
//! The phone learned this lesson twice already — `errors.ts`'s `UserFacingError`
//! and `polish.test.ts`'s scan for `HTTP ${status}`. Rust has no marker type to
//! lean on here (the string crosses an IPC boundary and arrives as a bare
//! `string`), so the property is defended the same way it is on the phone: by
//! reading the source.
//!
//! The raw value is not lost — every site this caught now logs it to
//! `~/Library/Logs/Lilypad/lilypad.log`, which is where whoever diagnoses it
//! will actually look.

use std::fs;
use std::path::Path;

/// The modules whose `bail!`/`anyhow!` strings can reach the dashboard.
const USER_FACING: &[&str] = &["auth.rs", "identity.rs", "account.rs", "commands.rs"];

/// A line that starts one of these macros, once comments are stripped.
fn is_error_macro(line: &str) -> bool {
    line.contains("bail!(") || line.contains("anyhow!(")
}

/// An interpolation of a caught value or a status code — the two shapes that
/// leak. `{}` with a positional argument is fine and common
/// (`bail!("{}", enrollment_code_failure(status))` is the FIX, not the bug).
fn interpolates_a_raw_value(line: &str) -> bool {
    ["{e}", "{err}", "{e:", "{status}", "{body}", "{code}"]
        .iter()
        .any(|needle| line.contains(needle))
}

#[test]
fn no_error_a_customer_reads_carries_a_status_code_or_a_caught_value() {
    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders: Vec<String> = Vec::new();

    for name in USER_FACING {
        let path = src_dir.join(name);
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));

        let mut in_test_module = false;
        for (i, raw) in source.lines().enumerate() {
            let line = raw.trim();
            // Tests may say whatever they like — they are read by whoever
            // wrote them, not by a customer.
            if line == "#[cfg(test)]" {
                in_test_module = true;
            }
            if in_test_module {
                continue;
            }
            // Comments discuss the old strings on purpose, including the ones
            // this test exists to describe.
            if line.starts_with("//") || line.starts_with("///") || line.starts_with('*') {
                continue;
            }
            if is_error_macro(line) && interpolates_a_raw_value(line) {
                offenders.push(format!("{name}:{}: {line}", i + 1));
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "these errors are rendered to a customer verbatim — log the raw value \
         and return a sentence instead:\n{}",
        offenders.join("\n")
    );
}
