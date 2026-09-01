//! Frame buffers that flow through the media pipeline.

use std::sync::Arc;
use std::time::{Duration, Instant};

/// A captured frame in BGRA8888 — the layout both ScreenCaptureKit and the
/// synthetic source produce. `bgra.len() == width * height * 4`.
///
/// `bgra` is `Arc<Vec<u8>>` rather than a bare `Vec<u8>` so a frame can be
/// cheaply shared instead of memcpy'd. The one place that needs this is
/// `ScreenCaptureKitSource::next_frame` (`capture/screencapturekit.rs`),
/// which used to `.clone()` the whole buffer (~8.8MB at 1920×1200, on EVERY
/// frame) just to keep a spare for its static-screen keepalive re-send —
/// with `bgra` behind an `Arc`, that clone is a refcount bump. Every other
/// consumer downstream (`VideoEncoder::encode`, `convert::bgra_to_i420`)
/// only ever reads through `&RawFrame`, so sharing the buffer costs it
/// nothing. See the reuse-vs-share reasoning in `FrameHandler::
/// did_output_sample_buffer`'s doc comment before changing either side of
/// this.
#[derive(Clone)]
pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    pub bgra: Arc<Vec<u8>>,
    /// Capture time, monotonic from stream start.
    pub timestamp: Duration,
    /// Wall-clock instant the pixels were produced — lets the pipeline measure
    /// true frame age (staleness + encode) at the point a sample is queued.
    pub captured_at: Instant,
    pub index: u64,
}

impl RawFrame {
    /// Always a freshly allocated, uniquely-owned buffer — `bgra`'s `Arc`
    /// refcount is 1. Callers that need to write into it directly (tests
    /// build fixture frames this way) can do so via
    /// `Arc::get_mut(&mut frame.bgra)`, which is guaranteed to succeed on a
    /// frame no one else has cloned yet.
    pub fn new(width: u32, height: u32, timestamp: Duration, index: u64) -> Self {
        Self {
            width,
            height,
            bgra: Arc::new(vec![0; (width as usize) * (height as usize) * 4]),
            timestamp,
            captured_at: Instant::now(),
            index,
        }
    }
}

/// Planar I420 (YUV 4:2:0, BT.601 limited range) — the encoder's input.
#[derive(Clone)]
pub struct I420Buffer {
    pub width: u32,
    pub height: u32,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
    pub timestamp: Duration,
}

impl I420Buffer {
    pub fn new(width: u32, height: u32, timestamp: Duration) -> Self {
        let (w, h) = (width as usize, height as usize);
        let cw = w.div_ceil(2);
        let ch = h.div_ceil(2);
        Self {
            width,
            height,
            y: vec![0; w * h],
            u: vec![128; cw * ch],
            v: vec![128; cw * ch],
            timestamp,
        }
    }

    pub fn y_stride(&self) -> usize {
        self.width as usize
    }

    pub fn chroma_stride(&self) -> usize {
        (self.width as usize).div_ceil(2)
    }

    /// Resize the planes in place for `width`×`height`, reallocating only
    /// when the dimensions actually changed — the common case (a stable
    /// capture resolution) touches nothing, which is the whole point of
    /// reusing a buffer across frames (`convert::bgra_to_i420_into`,
    /// `Openh264Encoder`'s persistent scratch buffer) instead of allocating
    /// three fresh `Vec`s every call. The fill values on a genuine resize
    /// (0 for luma, 128 — neutral chroma — for U/V) don't matter in
    /// practice: every caller of this immediately overwrites every plane
    /// byte via the conversion loop, exactly as `I420Buffer::new`'s callers
    /// always have.
    pub fn ensure_size(&mut self, width: u32, height: u32) {
        if self.width == width && self.height == height {
            return;
        }
        let (w, h) = (width as usize, height as usize);
        let cw = w.div_ceil(2);
        let ch = h.div_ceil(2);
        self.y.resize(w * h, 0);
        self.u.resize(cw * ch, 128);
        self.v.resize(cw * ch, 128);
        self.width = width;
        self.height = height;
    }
}
