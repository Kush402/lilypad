//! Pixel conversion stage: BGRA8888 → planar I420 (BT.601 limited range).
//! Chroma is 2×2-averaged for quality. This is the only place that touches raw
//! pixel layout, so swapping the capture source never affects the encoder.

use super::frame::{I420Buffer, RawFrame};

#[inline]
fn clamp_u8(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

/// Convert one BGRA frame to I420, allocating a fresh buffer for it.
///
/// Convenience wrapper around `bgra_to_i420_into` for callers that convert
/// occasionally (or want an owned, self-contained result) rather than every
/// frame on a hot path — `Openh264Encoder::encode` is the latter, and uses
/// `bgra_to_i420_into` directly with a buffer it keeps across calls instead
/// of paying this allocation every frame.
pub fn bgra_to_i420(frame: &RawFrame) -> I420Buffer {
    let mut out = I420Buffer::new(frame.width, frame.height, frame.timestamp);
    bgra_to_i420_into(frame, &mut out);
    out
}

/// Convert one BGRA frame to I420, writing into `out` in place instead of
/// allocating. `out`'s planes are resized (`I420Buffer::ensure_size`) only
/// when `frame`'s dimensions differ from what `out` already holds — a
/// stable capture resolution, the common case, touches no allocation at
/// all.
pub fn bgra_to_i420_into(frame: &RawFrame, out: &mut I420Buffer) {
    let w = frame.width as usize;
    let h = frame.height as usize;
    out.ensure_size(frame.width, frame.height);
    out.timestamp = frame.timestamp;
    let cw = w.div_ceil(2);
    let src = &frame.bgra;

    // Luma: per pixel.
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            let b = src[i] as i32;
            let g = src[i + 1] as i32;
            let r = src[i + 2] as i32;
            // Y = 0.257R + 0.504G + 0.098B + 16  (fixed-point /256)
            let yy = (66 * r + 129 * g + 25 * b + 128) >> 8;
            out.y[y * w + x] = clamp_u8(yy + 16);
        }
    }

    // Chroma: average each 2×2 block.
    for cy in 0..h.div_ceil(2) {
        for cx in 0..cw {
            let mut r = 0i32;
            let mut g = 0i32;
            let mut b = 0i32;
            let mut n = 0i32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let px = cx * 2 + dx;
                    let py = cy * 2 + dy;
                    if px < w && py < h {
                        let i = (py * w + px) * 4;
                        b += src[i] as i32;
                        g += src[i + 1] as i32;
                        r += src[i + 2] as i32;
                        n += 1;
                    }
                }
            }
            if n > 0 {
                r /= n;
                g /= n;
                b /= n;
            }
            // U = -0.148R - 0.291G + 0.439B + 128 ; V = 0.439R - 0.368G - 0.071B + 128
            let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
            let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
            out.u[cy * cw + cx] = clamp_u8(u);
            out.v[cy * cw + cx] = clamp_u8(v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn solid(w: u32, h: u32, b: u8, g: u8, r: u8) -> RawFrame {
        let mut f = RawFrame::new(w, h, Duration::ZERO, 0);
        // `RawFrame::new` hands back a uniquely-owned `Arc<Vec<u8>>` — safe
        // to mutate in place via `get_mut`.
        for px in std::sync::Arc::get_mut(&mut f.bgra)
            .unwrap()
            .chunks_exact_mut(4)
        {
            px[0] = b;
            px[1] = g;
            px[2] = r;
            px[3] = 255;
        }
        f
    }

    #[test]
    fn plane_sizes_are_correct() {
        let i = bgra_to_i420(&solid(1280, 720, 0, 0, 0));
        assert_eq!(i.y.len(), 1280 * 720);
        assert_eq!(i.u.len(), 640 * 360);
        assert_eq!(i.v.len(), 640 * 360);
    }

    #[test]
    fn black_and_white_luma() {
        let black = bgra_to_i420(&solid(4, 4, 0, 0, 0));
        assert!(black.y[0] <= 17, "black luma near 16, got {}", black.y[0]);
        let white = bgra_to_i420(&solid(4, 4, 255, 255, 255));
        assert!(white.y[0] >= 234, "white luma near 235, got {}", white.y[0]);
        // Neutral chroma for greyscale.
        assert!((black.u[0] as i32 - 128).abs() <= 2);
        assert!((white.v[0] as i32 - 128).abs() <= 2);
    }

    #[test]
    fn red_has_high_v() {
        let red = bgra_to_i420(&solid(4, 4, 0, 0, 255));
        assert!(red.v[0] > 200, "red should push V high, got {}", red.v[0]);
    }

    #[test]
    fn odd_dimensions_do_not_panic() {
        let _ = bgra_to_i420(&solid(3, 3, 10, 20, 30));
    }

    /// The point of `bgra_to_i420_into`: a stable resolution across calls
    /// must not touch the allocation at all — this is what lets
    /// `Openh264Encoder` reuse one `I420Buffer` for the life of the encoder
    /// instead of allocating three fresh `Vec`s every frame.
    #[test]
    fn bgra_to_i420_into_reuses_the_allocation_when_dimensions_are_unchanged() {
        let mut out = I420Buffer::new(4, 4, Duration::ZERO);
        bgra_to_i420_into(&solid(4, 4, 0, 0, 0), &mut out);
        let (y_cap, u_cap, v_cap) = (out.y.capacity(), out.u.capacity(), out.v.capacity());

        bgra_to_i420_into(&solid(4, 4, 255, 255, 255), &mut out);

        assert_eq!(out.y.capacity(), y_cap, "luma plane must not reallocate");
        assert_eq!(out.u.capacity(), u_cap, "U plane must not reallocate");
        assert_eq!(out.v.capacity(), v_cap, "V plane must not reallocate");
        // And it must still hold the SECOND frame's content, not stale data
        // from the first.
        assert!(out.y[0] >= 234, "expected white luma, got {}", out.y[0]);
    }

    /// The other half: a genuine resolution change (capture mode switch,
    /// display change) must still resize correctly, not silently keep
    /// stale-sized planes.
    #[test]
    fn bgra_to_i420_into_resizes_when_dimensions_change() {
        let mut out = I420Buffer::new(4, 4, Duration::ZERO);
        bgra_to_i420_into(&solid(4, 4, 0, 0, 0), &mut out);

        bgra_to_i420_into(&solid(8, 6, 0, 0, 0), &mut out);

        assert_eq!(out.width, 8);
        assert_eq!(out.height, 6);
        assert_eq!(out.y.len(), 8 * 6);
        assert_eq!(out.u.len(), 4 * 3);
        assert_eq!(out.v.len(), 4 * 3);
    }

    /// `bgra_to_i420_into` must produce exactly what `bgra_to_i420` does —
    /// it's meant to be a drop-in, not an approximation, for a caller on a
    /// hot path that can't afford the allocation.
    #[test]
    fn bgra_to_i420_into_matches_the_allocating_version() {
        let frame = solid(6, 6, 40, 90, 200);
        let allocated = bgra_to_i420(&frame);

        let mut reused = I420Buffer::new(1, 1, Duration::ZERO);
        bgra_to_i420_into(&frame, &mut reused);

        assert_eq!(reused.y, allocated.y);
        assert_eq!(reused.u, allocated.u);
        assert_eq!(reused.v, allocated.v);
        assert_eq!(reused.timestamp, allocated.timestamp);
    }
}
