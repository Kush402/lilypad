//! Tier-3 executor (P4) — the vision fallback. Captures the screen as a
//! downscaled PNG so a vision-capable model can SEE content the accessibility
//! tree can't expose (canvas, images, custom-drawn UI). Perception only in
//! this slice: after looking, the agent acts through the deterministic tiers
//! (skills / AX / sandbox). Pixel-coordinate clicking (full P4/P5) is a
//! documented follow-up that shares the input backend's CGEvent path.
//!
//! Vision is the expensive last resort (§4 of the audit): the `take_screenshot`
//! tool is only offered to a vision-capable provider, and the model is prompted
//! to prefer `read_ax_tree`.

use anyhow::Result;

use crate::agent::runner::{Executor, Observation};
use crate::agent::Action;

/// Longest edge (width) of the screenshot sent to the model. 1280 keeps text
/// legible while bounding token cost; coordinates (when acting lands) scale
/// back linearly.
#[cfg(target_os = "macos")]
const TARGET_WIDTH: u32 = 1280;

#[derive(Default)]
pub struct VisionExecutor;

impl Executor for VisionExecutor {
    async fn execute(&mut self, action: &Action) -> Result<Observation> {
        match action {
            Action::Screenshot => Ok(capture()),
            other => anyhow::bail!("VisionExecutor only handles Screenshot, got {other:?}"),
        }
    }
}

#[cfg(target_os = "macos")]
fn capture() -> Observation {
    match capture_png_base64() {
        Ok(png_b64) => Observation::ok_with_image(
            "Screenshot captured (see image). Act via the accessibility tree or a specific tool.",
            png_b64,
        ),
        Err(e) => Observation::fail(format!("could not capture the screen: {e}")),
    }
}

#[cfg(target_os = "macos")]
fn capture_png_base64() -> Result<String> {
    use base64::Engine;
    use core_graphics::display::CGDisplay;
    use image::{ImageFormat, RgbaImage};

    let display = CGDisplay::main();
    let cg_image = display
        .image()
        .ok_or_else(|| anyhow::anyhow!("CGDisplay::image returned None (Screen Recording?)"))?;

    let width = cg_image.width() as u32;
    let height = cg_image.height() as u32;
    let stride = cg_image.bytes_per_row();
    let data = cg_image.data();
    let bytes = data.bytes();

    // CGDisplay images are 32-bit BGRA (little-endian ARGB); rows may be padded
    // to `stride`. Repack into tight RGBA for the `image` crate.
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height as usize {
        let row = &bytes[y * stride..y * stride + width as usize * 4];
        for px in row.chunks_exact(4) {
            rgba.push(px[2]); // R (from BGRA)
            rgba.push(px[1]); // G
            rgba.push(px[0]); // B
            rgba.push(px[3]); // A
        }
    }
    let img = RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| anyhow::anyhow!("screenshot buffer size mismatch"))?;

    // Downscale to TARGET_WIDTH (only if larger), preserving aspect.
    let img = if width > TARGET_WIDTH {
        let target_h = (height as u64 * TARGET_WIDTH as u64 / width as u64) as u32;
        image::imageops::resize(
            &img,
            TARGET_WIDTH,
            target_h.max(1),
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };

    let mut png: Vec<u8> = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&png))
}

#[cfg(not(target_os = "macos"))]
fn capture() -> Observation {
    Observation::fail("the vision tier is only available on macOS")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_non_screenshot_actions() {
        let mut ex = VisionExecutor;
        assert!(ex.execute(&Action::ReadAxTree).await.is_err());
    }

    // Live: capture the real screen. Requires Screen Recording; if denied,
    // CGDisplay::image returns None → a clean failure observation (no crash).
    // Either way the FFI/encode path must not panic.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn screenshot_capture_runs_without_crashing() {
        let mut ex = VisionExecutor;
        let obs = ex.execute(&Action::Screenshot).await.unwrap();
        // With permission: an image comes back. Without: a clean failure.
        if obs.ok {
            assert!(obs.image_png_base64.is_some());
            assert!(!obs.image_png_base64.unwrap().is_empty());
        } else {
            assert!(obs.summary.contains("could not capture"));
        }
    }
}
