//! Tier-2 perception + action: the macOS Accessibility tree (P3). Reading the
//! AX tree (~50ms) and acting on real elements is 40–100× faster and grounds
//! far better than a screenshot→VLM round trip — the default execution path
//! and the moat (`docs/ask-architecture-audit.md` §5). We already hold the
//! Accessibility permission and inject via CGEvent.
//!
//! `tree` is the pure model + serialization; `macos` is the thin FFI walk.

pub mod tree;

/// Activation identity for click revalidation. Deliberately not a `HitInfo`:
/// the OS saying which app is frontmost is not evidence of a keyboard target.
pub struct AppIdentity {
    pub pid: i32,
    pub path: String,
}

/// What kind of app a process is, judged from its executable path — which
/// macOS surfaces Ask must never operate, and which apps take typed text as
/// commands. Pure, so the lists are table-tested without the apps running.
pub fn surface_of(path: &str) -> (Option<&'static str>, bool) {
    const PROTECTED: &[(&str, &str)] = &[
        ("/SecurityAgent.bundle/", "the macOS password prompt"),
        ("/coreautha.bundle/", "the Touch ID and password prompt"),
        ("/LocalAuthentication", "the Touch ID and password prompt"),
        ("/loginwindow.app/", "the login window"),
        ("/UserNotificationCenter.app/", "a system permission prompt"),
        (
            "/universalAccessAuthWarn.app/",
            "the accessibility permission prompt",
        ),
        ("/Keychain Access.app/", "Keychain Access"),
        ("/Passwords.app/", "the Passwords app"),
        ("/ScreenSharingAgent", "the screen sharing prompt"),
    ];
    const TERMINALS: &[&str] = &[
        "/Terminal.app/",
        "/iTerm.app/",
        "/iTerm2.app/",
        "/Warp.app/",
        "/Alacritty.app/",
        "/kitty.app/",
        "/WezTerm.app/",
        "/Ghostty.app/",
        "/Hyper.app/",
        "/Tabby.app/",
    ];
    let protected = PROTECTED
        .iter()
        .find(|(needle, _)| path.contains(needle))
        .map(|(_, name)| *name);
    let terminal = TERMINALS.iter().any(|t| path.contains(t));
    (protected, terminal)
}

#[cfg(test)]
mod surface_tests {
    use super::surface_of;

    #[test]
    fn password_and_permission_prompts_are_protected() {
        for path in [
            "/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent",
            "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow",
            "/System/Library/CoreServices/UserNotificationCenter.app/Contents/MacOS/UserNotificationCenter",
            "/System/Applications/Passwords.app/Contents/MacOS/Passwords",
        ] {
            assert!(surface_of(path).0.is_some(), "{path}");
        }
        assert_eq!(
            surface_of("/Applications/Safari.app/Contents/MacOS/Safari"),
            (None, false)
        );
    }

    #[test]
    fn terminals_are_recognised() {
        assert!(
            surface_of("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal").1
        );
        assert!(surface_of("/Applications/iTerm.app/Contents/MacOS/iTerm2").1);
        assert!(!surface_of("/Applications/TextEdit.app/Contents/MacOS/TextEdit").1);
    }
}

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "macos")]
pub use macos::{
    active_app, describe_live, focus, hit_test, perform, read_focused_tree, secure_input_enabled,
    set_value, AxHandle, AxSnapshot, HitInfo,
};

// Non-macOS stub so the crate builds everywhere; the AX tier is macOS-only.
#[cfg(not(target_os = "macos"))]
mod stub {
    use super::tree::AxNode;
    use super::AppIdentity;
    use anyhow::{bail, Result};

    pub type AxHandle = ();
    pub struct AxSnapshot {
        pub nodes: Vec<AxNode>,
        pub app: String,
        pub pid: i32,
        pub path: String,
        pub window: Option<String>,
        pub bounds: [f64; 4],
    }
    impl AxSnapshot {
        pub fn handle(&self, _id: usize) -> Option<&()> {
            None
        }
        #[cfg(test)]
        pub fn for_test(nodes: Vec<AxNode>) -> Self {
            AxSnapshot {
                nodes,
                app: String::new(),
                pid: 0,
                path: String::new(),
                window: None,
                bounds: [0.0, 0.0, 1.0, 1.0],
            }
        }
    }
    #[derive(Debug, Clone, Default)]
    pub struct HitInfo {
        pub role: String,
        pub label: String,
        pub pid: i32,
        pub app: String,
        pub path: String,
        pub secure: bool,
    }
    pub fn describe_live(_handle: &()) -> Option<(String, String)> {
        None
    }
    pub fn read_focused_tree(_display: Option<u32>) -> Result<AxSnapshot> {
        bail!("the accessibility tier is only available on macOS")
    }
    pub fn hit_test(_x: f64, _y: f64) -> Option<HitInfo> {
        None
    }
    pub fn focus() -> Option<HitInfo> {
        None
    }
    pub fn active_app() -> Option<AppIdentity> {
        None
    }
    pub fn secure_input_enabled() -> bool {
        false
    }
    pub fn set_value(_handle: &(), _text: &str) -> Result<()> {
        bail!("the accessibility tier is only available on macOS")
    }
    pub fn perform(_handle: &(), _action: &str) -> Result<()> {
        bail!("the accessibility tier is only available on macOS")
    }
}

#[cfg(not(target_os = "macos"))]
pub use stub::{
    active_app, describe_live, focus, hit_test, perform, read_focused_tree, secure_input_enabled,
    set_value, AxHandle, AxSnapshot, HitInfo,
};
