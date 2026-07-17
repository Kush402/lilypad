//! Video encoder abstraction. The pipeline is encoder-agnostic, so the software
//! (openh264) and hardware (VideoToolbox) backends are interchangeable.

pub mod software;
#[cfg(target_os = "macos")]
pub mod videotoolbox;

use std::time::Duration;

use anyhow::Result;
use bytes::Bytes;

use crate::media::frame::RawFrame;

/// One encoded H.264 access unit (Annex-B), ready for the WebRTC track.
#[derive(Clone)]
pub struct EncodedSample {
    pub data: Bytes,
    pub is_keyframe: bool,
    pub timestamp: Duration,
}

#[derive(Debug, Clone, Copy)]
pub struct EncoderSettings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    /// Force an IDR every N frames (short GOP for fast recovery / low latency).
    pub keyframe_interval: u32,
}

impl Default for EncoderSettings {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_kbps: 2500,
            keyframe_interval: 30, // ~1s GOP
        }
    }
}

/// A low-latency H.264 encoder: no B-frames, short GOP, adaptive bitrate.
///
/// Takes the captured `RawFrame` (BGRA) directly rather than a pre-converted
/// pixel format — each backend knows its own native input best (software
/// openh264 converts to I420 internally; VideoToolbox wraps BGRA in an
/// `IOSurface` directly, matching its own documented usage and skipping a
/// conversion pass entirely).
pub trait VideoEncoder: Send {
    /// Encode one frame. Returns None if the encoder produced no output
    /// (e.g. a skipped frame). `force_keyframe` requests an IDR.
    fn encode(&mut self, frame: &RawFrame, force_keyframe: bool) -> Result<Option<EncodedSample>>;
    /// Adaptive bitrate: retarget the encoder (kbps).
    fn set_bitrate(&mut self, kbps: u32) -> Result<()>;
    /// Reset encoder state (e.g. after a resolution change or error recovery).
    fn reset(&mut self) -> Result<()>;
    fn name(&self) -> &'static str;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderKind {
    /// Software openh264 — the verifiable, cross-platform default.
    Software,
    /// macOS VideoToolbox hardware H.264 (compile-complete; wired on device).
    VideoToolbox,
}

pub fn create_encoder(
    kind: EncoderKind,
    settings: EncoderSettings,
) -> Result<Box<dyn VideoEncoder>> {
    match kind {
        EncoderKind::Software => Ok(Box::new(software::Openh264Encoder::new(settings)?)),
        #[cfg(target_os = "macos")]
        EncoderKind::VideoToolbox => {
            Ok(Box::new(videotoolbox::VideoToolboxEncoder::new(settings)?))
        }
        #[cfg(not(target_os = "macos"))]
        EncoderKind::VideoToolbox => {
            log::warn!(target: "lilypad::media", "VideoToolbox requested but this isn't macOS — falling back to software");
            Ok(Box::new(software::Openh264Encoder::new(settings)?))
        }
    }
}
