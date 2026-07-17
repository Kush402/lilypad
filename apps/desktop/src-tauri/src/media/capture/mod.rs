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
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 720,
            fps: 30,
        }
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
