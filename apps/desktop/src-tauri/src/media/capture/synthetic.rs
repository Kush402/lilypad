//! Fully-functional synthetic capture source: an animated test pattern so real
//! frames (and therefore real encoded RTP) flow without any OS permission.
//!
//! Renders a moving gradient, an animated square, and a color-bar strip whose
//! offset advances each frame — every frame differs, which the encoder turns
//! into real inter-frame deltas.

use std::time::Duration;

use anyhow::Result;

use super::{CaptureBackend, CaptureConfig};
use crate::media::frame::RawFrame;

pub struct SyntheticSource {
    width: u32,
    height: u32,
    fps: u32,
    index: u64,
    running: bool,
    /// Fault injection: if set, `next_frame` returns an error once `index`
    /// reaches this value — used to exercise the pipeline's unexpected-death
    /// handling (`LILYPAD_SYNTHETIC_FAIL_AFTER=<n>`). Off by default.
    fail_after: Option<u64>,
    /// Persistent scratch buffer `render()` writes into and clones out of,
    /// zero-filled once at construction rather than on every single frame —
    /// `render()`'s own loops overwrite every byte unconditionally, so a
    /// fresh `vec![0; n]` per frame (what `RawFrame::new` used to be called
    /// with here) was pure redundant work on this hot path. See
    /// `docs/audit/m3/streaming-media.md` Finding 15.
    scratch: Vec<u8>,
}

impl SyntheticSource {
    pub fn new(cfg: CaptureConfig) -> Self {
        let fail_after = std::env::var("LILYPAD_SYNTHETIC_FAIL_AFTER")
            .ok()
            .and_then(|v| v.parse::<u64>().ok());
        // H.264 / I420 require even dimensions.
        let width = cfg.width & !1;
        let height = cfg.height & !1;
        Self {
            width,
            height,
            fps: cfg.fps.max(1),
            index: 0,
            running: false,
            fail_after,
            scratch: vec![0; (width as usize) * (height as usize) * 4],
        }
    }

    #[cfg(test)]
    fn with_fail_after(cfg: CaptureConfig, n: u64) -> Self {
        let mut s = Self::new(cfg);
        s.fail_after = Some(n);
        s
    }

    fn render(&mut self, index: u64) -> RawFrame {
        let w = self.width as usize;
        let h = self.height as usize;
        let ts = Duration::from_nanos(index.saturating_mul(1_000_000_000) / self.fps as u64);
        let t = index as usize;
        let bgra = &mut self.scratch;

        for y in 0..h {
            let row = y * w * 4;
            for x in 0..w {
                let i = row + x * 4;
                bgra[i] = ((x + t * 2) & 0xff) as u8; // B
                bgra[i + 1] = ((y + t * 3) & 0xff) as u8; // G
                bgra[i + 2] = ((x + y + t) & 0xff) as u8; // R
                bgra[i + 3] = 255;
            }
        }

        // Color-bar strip across the top (static reference).
        let bars = [
            (255u8, 255u8, 255u8),
            (0, 255, 255),
            (255, 255, 0),
            (0, 255, 0),
            (255, 0, 255),
            (0, 0, 255),
            (255, 0, 0),
        ];
        let strip = (h / 10).max(1);
        for y in 0..strip {
            for x in 0..w {
                let (r, g, b) = bars[(x * bars.len()) / w.max(1)];
                let i = (y * w + x) * 4;
                bgra[i] = b;
                bgra[i + 1] = g;
                bgra[i + 2] = r;
                bgra[i + 3] = 255;
            }
        }

        // Moving white square.
        let sq = (w / 12).max(8);
        let span = w.saturating_sub(sq).max(1);
        let sx = (t * 6) % span;
        let sy = h / 2 - (sq / 2).min(h / 2);
        for yy in sy..(sy + sq).min(h) {
            for xx in sx..(sx + sq).min(w) {
                let i = (yy * w + xx) * 4;
                bgra[i] = 255;
                bgra[i + 1] = 255;
                bgra[i + 2] = 255;
                bgra[i + 3] = 255;
            }
        }

        RawFrame {
            width: self.width,
            height: self.height,
            bgra: std::sync::Arc::new(self.scratch.clone()),
            timestamp: ts,
            captured_at: std::time::Instant::now(),
            index,
        }
    }
}

impl CaptureBackend for SyntheticSource {
    fn initialize(&mut self) -> Result<()> {
        Ok(())
    }

    fn start(&mut self) -> Result<()> {
        self.running = true;
        self.index = 0;
        Ok(())
    }

    fn next_frame(&mut self) -> Result<RawFrame> {
        if let Some(n) = self.fail_after {
            if self.index >= n {
                anyhow::bail!("synthetic capture fault injected after {n} frames");
            }
        }
        let frame = self.render(self.index);
        self.index = self.index.saturating_add(1);
        Ok(frame)
    }

    fn resolution(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn fps(&self) -> u32 {
        self.fps
    }

    fn permission_status(&self) -> crate::permission::PermissionStatus {
        crate::permission::PermissionStatus::NotApplicable
    }

    fn stop(&mut self) -> Result<()> {
        self.running = false;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<()> {
        self.running = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_not_self_paced() {
        // Synthetic renders on demand — the pipeline must pace it.
        let s = SyntheticSource::new(CaptureConfig::default());
        assert!(!s.provides_pacing());
    }

    #[test]
    fn produces_even_dimensions() {
        let s = SyntheticSource::new(CaptureConfig {
            width: 1281,
            height: 721,
            fps: 30,
            display_id: None,
        });
        assert_eq!(s.resolution(), (1280, 720));
    }

    #[test]
    fn fail_after_injects_a_capture_error() {
        let mut s = SyntheticSource::with_fail_after(
            CaptureConfig {
                width: 320,
                height: 240,
                fps: 30,
                display_id: None,
            },
            3,
        );
        s.start().unwrap();
        assert!(s.next_frame().is_ok()); // 0
        assert!(s.next_frame().is_ok()); // 1
        assert!(s.next_frame().is_ok()); // 2
        assert!(
            s.next_frame().is_err(),
            "must fail once index reaches fail_after"
        );
    }

    #[test]
    fn frames_differ_and_advance() {
        let mut s = SyntheticSource::new(CaptureConfig {
            width: 320,
            height: 240,
            fps: 30,
            display_id: None,
        });
        s.start().unwrap();
        let f0 = s.next_frame().unwrap();
        let f1 = s.next_frame().unwrap();
        assert_eq!(f0.index, 0);
        assert_eq!(f1.index, 1);
        assert_eq!(f0.bgra.len(), 320 * 240 * 4);
        assert_ne!(f0.bgra, f1.bgra, "consecutive frames must differ");
        assert!(f1.timestamp > f0.timestamp);
    }
}
