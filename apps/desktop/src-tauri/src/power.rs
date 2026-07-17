//! Keep the display awake while a remote session is live.
//!
//! The whole point of Lilypad is that nobody is touching the Mac — which is
//! exactly the condition macOS uses to decide the display should sleep, and
//! a sleeping display makes ScreenCaptureKit stop the capture stream
//! ("stopped by the system"), killing the session. Every remote-desktop tool
//! holds a power assertion for this; RAII here so it can never leak past the
//! session that created it.
//!
//! Phone-side has the mirror-image fix (`useKeepAwake` in ViewerScreen).

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    type IOPMAssertionID = u32;
    const IOPM_ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> i32;
    }

    pub struct DisplaySleepGuard {
        id: Option<IOPMAssertionID>,
    }

    impl DisplaySleepGuard {
        pub fn new() -> Self {
            let kind = CFString::from_static_string("PreventUserIdleDisplaySleep");
            let reason = CFString::from_static_string("Lilypad remote session active");
            let mut id: IOPMAssertionID = 0;
            let ret = unsafe {
                IOPMAssertionCreateWithName(
                    kind.as_concrete_TypeRef(),
                    IOPM_ASSERTION_LEVEL_ON,
                    reason.as_concrete_TypeRef(),
                    &mut id,
                )
            };
            if ret == 0 {
                log::info!(target: "lilypad::power", "display-sleep prevention active for session");
                Self { id: Some(id) }
            } else {
                // Non-fatal: the session still works, it just remains exposed
                // to display sleep — worth a log line, not an error path.
                log::warn!(target: "lilypad::power", "IOPMAssertionCreateWithName failed: {ret}");
                Self { id: None }
            }
        }
    }

    impl Drop for DisplaySleepGuard {
        fn drop(&mut self) {
            if let Some(id) = self.id.take() {
                unsafe { IOPMAssertionRelease(id) };
                log::info!(target: "lilypad::power", "display-sleep prevention released");
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    /// No-op on platforms without an implementation yet (Windows will use
    /// `SetThreadExecutionState(ES_DISPLAY_REQUIRED)` when the Windows
    /// capture backend lands).
    pub struct DisplaySleepGuard;

    impl DisplaySleepGuard {
        pub fn new() -> Self {
            Self
        }
    }
}

pub use imp::DisplaySleepGuard;
