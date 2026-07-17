//! Shared OS-permission status shape. Both input injection (macOS
//! Accessibility) and screen capture (macOS Screen Recording) gate real
//! functionality behind an explicit, human-granted OS permission — this is
//! the common 3-state result both report through their respective backend
//! traits, so the UI/plugin-health story is uniform across capabilities.
//!
//! The free functions below (`screen_capture_status`/`accessibility_status`)
//! let the debug health overlay ask "is this granted?" without constructing a
//! full `CaptureBackend`/`InputBackend` instance — the two OS preflight calls
//! they wrap are cheap TCC round-trips, not something that needs an owned
//! backend object alive just to be queried once for a health check.

use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionStatus {
    Granted,
    NotGranted,
    /// The platform doesn't gate this capability behind an explicit permission.
    NotApplicable,
}

/// The two OS permissions Lilypad's first-run Setup flow walks a user
/// through — see `docs/audit/m3/desktop-ux.md` Finding 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionKind {
    ScreenCapture,
    Accessibility,
}

impl PermissionKind {
    pub fn status(self) -> PermissionStatus {
        match self {
            PermissionKind::ScreenCapture => screen_capture_status(),
            PermissionKind::Accessibility => accessibility_status(),
        }
    }

    /// Deep link straight to the relevant Settings row — one click lands the
    /// user on the correct pane instead of them navigating "Privacy &
    /// Security" themselves. If a specific anchor doesn't exist on the
    /// running macOS version, System Settings silently opens the parent pane
    /// instead of erroring, so this doesn't need a per-OS-version fallback
    /// table.
    pub fn settings_url(self) -> &'static str {
        match self {
            PermissionKind::ScreenCapture => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            PermissionKind::Accessibility => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PermissionKind::ScreenCapture => "Screen Recording",
            PermissionKind::Accessibility => "Accessibility",
        }
    }
}

/// How stale a cached preflight check may be before re-querying the OS.
/// `CGPreflightScreenCaptureAccess`/`AXIsProcessTrusted` are TCC round-trips
/// (tens of milliseconds), not free — a sub-second staleness window is
/// invisible to a human granting/revoking a permission, but keeps the debug
/// overlay's 800ms poll cheap.
const PERMISSION_CACHE_TTL: Duration = Duration::from_millis(500);

/// Process-wide cache (not per-instance): these free functions have no
/// backend object to hold state on, and the query result doesn't depend on
/// which thread asks.
static SCREEN_CAPTURE_CACHE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
static ACCESSIBILITY_CACHE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);

fn cached(cache: &Mutex<Option<(Instant, bool)>>, query: impl FnOnce() -> bool) -> bool {
    let mut guard = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    if let Some((checked_at, result)) = *guard {
        if now.duration_since(checked_at) < PERMISSION_CACHE_TTL {
            return result;
        }
    }
    let result = query();
    *guard = Some((now, result));
    result
}

/// Current Screen Recording permission state (macOS only; `NotApplicable`
/// elsewhere, matching `CaptureBackend::permission_status()`'s stub behavior
/// on non-macOS today).
pub fn screen_capture_status() -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        let granted = cached(
            &SCREEN_CAPTURE_CACHE,
            crate::media::capture::screencapturekit::screen_capture_preflight,
        );
        if granted {
            PermissionStatus::Granted
        } else {
            PermissionStatus::NotGranted
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        PermissionStatus::NotApplicable
    }
}

/// Current Accessibility permission state (macOS only; `NotApplicable`
/// elsewhere, matching `InputBackend::permission_status()`'s stub behavior on
/// Windows today).
pub fn accessibility_status() -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        let trusted = cached(
            &ACCESSIBILITY_CACHE,
            crate::input::macos::accessibility_trusted,
        );
        if trusted {
            PermissionStatus::Granted
        } else {
            PermissionStatus::NotGranted
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        PermissionStatus::NotApplicable
    }
}

/// Actively request `kind`, prompting the user if undecided (a no-op if
/// already decided this run), then return the freshly-queried status — the
/// cache is bypassed here, not just re-checked early, since a "Grant" button
/// click is exactly the moment a stale cached `NotGranted` would be most
/// misleading. Used by the first-run Setup flow. See
/// `docs/audit/m3/desktop-ux.md` Finding 1.
pub fn request(kind: PermissionKind) -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        let (cache, granted) = match kind {
            PermissionKind::ScreenCapture => (
                &SCREEN_CAPTURE_CACHE,
                crate::media::capture::screencapturekit::screen_capture_request(),
            ),
            PermissionKind::Accessibility => (
                &ACCESSIBILITY_CACHE,
                crate::input::macos::accessibility_request(),
            ),
        };
        let mut guard = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some((Instant::now(), granted));
        drop(guard);
        if granted {
            PermissionStatus::Granted
        } else {
            PermissionStatus::NotGranted
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        PermissionStatus::NotApplicable
    }
}
