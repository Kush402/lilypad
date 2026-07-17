//! Debug health overlay data source — replaces the M1-era `PluginHost`.
//!
//! The old plugin system registered eight `Plugin` objects with a uniform
//! init/start/stop/health-check lifecycle; five could never report anything
//! but "ok" (no real logic at all), two duplicated a real capture/input
//! backend instance purely to poll a permission status the real session
//! pipeline already checks independently, and one (`EncoderPlugin`) built and
//! discarded a real hardware encoder at every app launch for a health value
//! that then never updated again. See `docs/audit/m3/architecture.md`
//! (Finding F3) for the full before/after rationale.
//!
//! This module reports only the health that was ever real: the two OS
//! permissions that gate live functionality. `Permission` metadata for
//! non-gating capabilities (clipboard, dev shortcuts, QR pairing, WebRTC
//! transport, audit logging) doesn't need a runtime object — those either
//! have no state worth reporting or, in the case of audit logging, are a
//! plain logging call already made directly from `commands.rs`.

use std::collections::BTreeMap;

use crate::permission::{accessibility_status, screen_capture_status, PermissionStatus};

fn label(status: PermissionStatus, permission_name: &str) -> String {
    match status {
        PermissionStatus::Granted | PermissionStatus::NotApplicable => "ok".to_owned(),
        PermissionStatus::NotGranted => {
            format!("degraded: {permission_name} permission not granted")
        }
    }
}

/// Snapshot for the debug health overlay (`AppStateDto.plugin_health`,
/// `Control.tsx`'s "Plugin health" section). Queried fresh on every
/// `get_state` poll — no stale boot-time values, no owned backend instances
/// kept alive just to be asked a yes/no question.
pub fn plugin_health() -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    m.insert(
        "ScreenCapture".to_owned(),
        label(screen_capture_status(), "Screen Recording"),
    );
    m.insert(
        "Accessibility".to_owned(),
        label(accessibility_status(), "Accessibility"),
    );
    // Unlike the two permission checks above, encoder health has no cheap
    // instance-free query: VideoToolbox/openh264 health is only meaningful
    // in the context of a running session's MediaController, and there is no
    // live query channel from a running session back to this free function
    // today (Phase 1's session decomposition made MediaController a private,
    // per-session-runner-owned type — see `session::media_controller`). A
    // static label that has never been wrong is a real improvement over the
    // old plugin's frozen-at-boot value, which could actively lie about a
    // mid-stream encoder failure. Wiring a genuine live signal is real,
    // separate work (tracked as a Phase 2+ follow-up), not a side effect of
    // removing dead code.
    m.insert("Encoder".to_owned(), "not yet tested this run".to_owned());
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_maps_granted_and_not_applicable_to_ok() {
        assert_eq!(label(PermissionStatus::Granted, "X"), "ok");
        assert_eq!(label(PermissionStatus::NotApplicable, "X"), "ok");
    }

    #[test]
    fn label_maps_not_granted_to_a_degraded_reason_naming_the_permission() {
        assert_eq!(
            label(PermissionStatus::NotGranted, "Screen Recording"),
            "degraded: Screen Recording permission not granted"
        );
    }

    #[test]
    fn plugin_health_reports_exactly_the_three_real_capabilities() {
        let health = plugin_health();
        assert_eq!(health.len(), 3);
        assert!(health.contains_key("ScreenCapture"));
        assert!(health.contains_key("Accessibility"));
        assert!(health.contains_key("Encoder"));
    }
}
