//! Frame buffers that flow through the media pipeline.

use std::time::{Duration, Instant};

/// A captured frame in BGRA8888 — the layout both ScreenCaptureKit and the
/// synthetic source produce. `bgra.len() == width * height * 4`.
#[derive(Clone)]
pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
    /// Capture time, monotonic from stream start.
    pub timestamp: Duration,
    /// Wall-clock instant the pixels were produced — lets the pipeline measure
    /// true frame age (staleness + encode) at the point a sample is queued.
    pub captured_at: Instant,
    pub index: u64,
}

impl RawFrame {
    pub fn new(width: u32, height: u32, timestamp: Duration, index: u64) -> Self {
        Self {
            width,
            height,
            bgra: vec![0; (width as usize) * (height as usize) * 4],
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
}
