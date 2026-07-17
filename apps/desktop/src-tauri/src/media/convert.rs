//! Pixel conversion stage: BGRA8888 → planar I420 (BT.601 limited range).
//! Chroma is 2×2-averaged for quality. This is the only place that touches raw
//! pixel layout, so swapping the capture source never affects the encoder.

use super::frame::{I420Buffer, RawFrame};

#[inline]
fn clamp_u8(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

/// Convert one BGRA frame to I420.
pub fn bgra_to_i420(frame: &RawFrame) -> I420Buffer {
    let w = frame.width as usize;
    let h = frame.height as usize;
    let mut out = I420Buffer::new(frame.width, frame.height, frame.timestamp);
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

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn solid(w: u32, h: u32, b: u8, g: u8, r: u8) -> RawFrame {
        let mut f = RawFrame::new(w, h, Duration::ZERO, 0);
        for px in f.bgra.chunks_exact_mut(4) {
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
}
