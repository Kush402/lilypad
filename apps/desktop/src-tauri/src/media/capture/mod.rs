//! Capture abstraction. Everything downstream (convert → encode → track) is
//! source-agnostic, so swapping the synthetic source for ScreenCaptureKit means
//! changing only the backend selected here.

#[cfg(target_os = "macos")]
pub mod screencapturekit;
pub mod synthetic;

use crate::media::frame::RawFrame;
use crate::permission::PermissionStatus;
use anyhow::Result;

/// A source of BGRA frames. Lifecycle mirrors the product spec.
pub trait CaptureBackend: Send {
    fn initialize(&mut self) -> Result<()>;
    fn start(&mut self) -> Result<()>;
    /// Produce the next frame. For pull sources this renders on demand; for push
    /// sources (ScreenCaptureKit) it dequeues the latest delivered frame.
    fn next_frame(&mut self) -> Result<RawFrame>;
    /// True when `next_frame()` itself blocks until the OS delivers the next
    /// frame at the configured fps (push sources like ScreenCaptureKit). The
    /// pipeline must NOT add its own sleep-pacing on top of such a source —
    /// doing so lets a fresh frame age in the slot for up to a full frame
    /// interval before it's encoded. Pull sources (synthetic) return false
    /// and rely on the pipeline's pacing.
    fn provides_pacing(&self) -> bool {
        false
    }
    fn resolution(&self) -> (u32, u32);
    fn fps(&self) -> u32;
    /// Current OS permission state for this source (e.g. macOS Screen
    /// Recording). `NotApplicable` for sources that aren't gated (synthetic,
    /// or platforms without an equivalent prompt).
    fn permission_status(&self) -> PermissionStatus;
    fn stop(&mut self) -> Result<()>;
    fn shutdown(&mut self) -> Result<()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureKind {
    /// Fully-functional animated test source (default for automated tests and
    /// the `LILYPAD_CAPTURE_KIND=synthetic` dev override).
    Synthetic,
    /// macOS ScreenCaptureKit — real capture, the default for live sessions.
    ScreenCaptureKit,
}

#[derive(Debug, Clone, Copy)]
pub struct CaptureConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Which display to capture (`CGDirectDisplayID`). `None` — the default
    /// and the only value a synthetic source ever sees — means the main one.
    /// A display that has been unplugged since the caller chose it falls back
    /// to the main display rather than failing the session; the session's own
    /// display poll then tells the phone what it actually got.
    pub display_id: Option<u32>,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 720,
            fps: 30,
            display_id: None,
        }
    }
}

/// One display attached to this Mac, as the phone's switcher shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Display {
    /// The OS's `CGDirectDisplayID` — stable for as long as the display stays
    /// attached, which is all the lifetime a session needs.
    pub id: u32,
    pub name: String,
    /// Points, not backing pixels: this is the size a person recognises from
    /// System Settings, and it is only ever shown, never captured with.
    pub width: u32,
    pub height: u32,
}

/// Every display attached right now, left to right, so "Display 2" means the
/// same thing here as in the Mac's own arrangement. Empty when the platform
/// has no implementation — which the phone reads as "no switcher", the same
/// as a Mac with one screen.
///
/// Cheap by design (CoreGraphics, no window-server round trip, no Screen
/// Recording grant needed) because a live session polls it to notice a
/// monitor being plugged in or pulled out.
pub fn list_displays() -> Vec<Display> {
    #[cfg(target_os = "macos")]
    {
        screencapturekit::list_displays()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// The main display's id — the one a session captures when nothing else has
/// been chosen. The phone highlights a concrete id in its switcher, so "the
/// default" has to be resolvable to one.
pub fn main_display_id() -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        Some(core_graphics::display::CGDisplay::main().id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub fn create_capture(kind: CaptureKind, cfg: CaptureConfig) -> Box<dyn CaptureBackend> {
    match kind {
        CaptureKind::Synthetic => Box::new(synthetic::SyntheticSource::new(cfg)),
        #[cfg(target_os = "macos")]
        CaptureKind::ScreenCaptureKit => {
            Box::new(screencapturekit::ScreenCaptureKitSource::new(cfg))
        }
        #[cfg(not(target_os = "macos"))]
        CaptureKind::ScreenCaptureKit => {
            log::warn!(target: "lilypad::media", "ScreenCaptureKit requested but this isn't macOS — falling back to synthetic");
            Box::new(synthetic::SyntheticSource::new(cfg))
        }
    }
}
