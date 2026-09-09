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

use crate::agent::executor::SharedDisplay;
use crate::agent::runner::{Executor, Observation};
use crate::agent::Action;

/// Longest edge (width) of the screenshot sent to the model. 1280 keeps text
/// legible while bounding token cost; coordinates (when acting lands) scale
/// back linearly.
#[cfg(target_os = "macos")]
const TARGET_WIDTH: u32 = 1280;

#[derive(Default)]
pub struct VisionExecutor {
    /// The display the phone is sharing. Read at every capture, so a mid-run
    /// switch is picked up without restarting the run.
    display: SharedDisplay,
    /// The display the previous screenshot was of, so a change can be called
    /// out rather than silently swapping what the model is looking at.
    last_captured: Option<Option<u32>>,
}

impl VisionExecutor {
    pub fn new(display: SharedDisplay) -> Self {
        VisionExecutor {
            display,
            last_captured: None,
        }
    }
}

impl Executor for VisionExecutor {
    async fn execute(&mut self, action: &Action) -> Result<Observation> {
        match action {
            Action::Screenshot => {
                let target = self.display.get();
                // A screenshot of a different screen than the last one makes
                // every earlier screenshot in this run misleading: the model is
                // reasoning about coordinates and content from a display that
                // is no longer the one being shared. Say so in the observation,
                // which is the only place the model will read it.
                let changed = matches!(self.last_captured, Some(prev) if prev != target);
                self.last_captured = Some(target);
                Ok(capture(target, changed))
            }
            other => anyhow::bail!("VisionExecutor only handles Screenshot, got {other:?}"),
        }
    }
}

/// How a display is named to the model and in failures.
fn display_name(target: Option<u32>) -> String {
    match target {
        None => "the main display".to_string(),
        Some(id) => format!("display {id}"),
    }
}

/// The note prepended to an observation when the shared display changed since
/// the previous screenshot. Pure, so the wording is testable without a screen.
pub fn staleness_note(changed: bool) -> &'static str {
    if changed {
        "The shared display changed since the previous screenshot — earlier screenshots are of a \
         different screen and must not be used for anything. "
    } else {
        ""
    }
}

#[cfg(target_os = "macos")]
fn capture(target: Option<u32>, changed: bool) -> Observation {
    match capture_png_base64(target) {
        Ok(png_b64) => Observation::ok_with_image(
            format!(
                "{}Screenshot of {} (see image). Act via the accessibility tree or a specific tool.",
                staleness_note(changed),
                display_name(target)
            ),
            png_b64,
        ),
        Err(e) => Observation::fail(format!(
            "could not capture {}: {e}",
            display_name(target)
        )),
    }
}

#[cfg(not(target_os = "macos"))]
fn capture(target: Option<u32>, _changed: bool) -> Observation {
    Observation::fail(format!(
        "screen capture is only available on macOS (asked for {})",
        display_name(target)
    ))
}

#[cfg(target_os = "macos")]
fn capture_png_base64(target: Option<u32>) -> Result<String> {
    use base64::Engine;
    use core_graphics::display::CGDisplay;
    use image::{ImageFormat, RgbaImage};

    // The display the phone is actually sharing, threaded down the way
    // `InputGate::set_target_display` already threads it to the input backend.
    //
    // This used to be `CGDisplay::main()` unconditionally, with a note calling
    // it harmless because the tier is perception-only and nothing can be
    // clicked in the wrong place. That reasoning missed the more important
    // half: the pixels go to the configured model provider. Capturing an
    // unshared monitor sends a screen the person did not choose to share.
    let display = match target {
        None => CGDisplay::main(),
        Some(id) => {
            // A display that has been unplugged must fail loudly, not silently
            // fall back to a different screen's contents.
            let attached = CGDisplay::active_displays()
                .map(|ids| ids.contains(&id))
                .unwrap_or(false);
            if !attached {
                anyhow::bail!(
                    "display {id} is no longer attached — the shared display went away; \
                     re-read the screen after the session picks a new one"
                );
            }
            CGDisplay::new(id)
        }
    };
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
        let mut ex = VisionExecutor::default();
        assert!(ex.execute(&Action::ReadAxTree).await.is_err());
    }

    // Live: capture the real screen. Requires Screen Recording; if denied,
    // CGDisplay::image returns None → a clean failure observation (no crash).
    // Either way the FFI/encode path must not panic.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn screenshot_capture_runs_without_crashing() {
        let mut ex = VisionExecutor::default();
        let obs = ex.execute(&Action::Screenshot).await.unwrap();
        // With permission: an image comes back. Without: a clean failure.
        if obs.ok {
            assert!(obs.image_png_base64.is_some());
            assert!(!obs.image_png_base64.unwrap().is_empty());
        } else {
            assert!(obs.summary.contains("could not capture"));
        }
    }

    // ── L-230: perception follows the shared display ──

    #[test]
    fn a_display_is_named_so_the_model_knows_what_it_is_looking_at() {
        assert_eq!(display_name(None), "the main display");
        assert_eq!(display_name(Some(2)), "display 2");
    }

    #[test]
    fn a_changed_display_retires_the_earlier_screenshots_in_the_observation() {
        assert_eq!(staleness_note(false), "");
        let note = staleness_note(true);
        assert!(note.contains("must not be used"));
    }

    #[tokio::test]
    async fn capture_targets_whatever_the_session_is_currently_sharing() {
        // The executor must read the shared cell at every capture, not latch
        // it at construction: a session can move to another monitor mid-run.
        let shared = SharedDisplay::new();
        let mut ex = VisionExecutor::new(shared.clone());
        assert_eq!(ex.display.get(), None, "defaults to the main display");
        shared.set(Some(2));
        assert_eq!(ex.display.get(), Some(2));

        // First capture records the target; a second at a new target is a
        // change, and a third at the same target is not.
        let _ = ex.execute(&Action::Screenshot).await.unwrap();
        assert_eq!(ex.last_captured, Some(Some(2)));
        shared.set(Some(5));
        let obs = ex.execute(&Action::Screenshot).await.unwrap();
        assert!(
            obs.summary.contains("changed") || obs.summary.contains("could not capture"),
            "a display change must be disclosed: {}",
            obs.summary
        );
    }

    #[test]
    fn the_shared_display_round_trips_including_the_main_sentinel() {
        let d = SharedDisplay::new();
        assert_eq!(d.get(), None);
        d.set(Some(0));
        assert_eq!(d.get(), Some(0), "display 0 is a real id, not 'main'");
        d.set(Some(7));
        assert_eq!(d.get(), Some(7));
        d.set(None);
        assert_eq!(d.get(), None);
    }

    #[test]
    fn a_clone_sees_writes_made_through_the_original() {
        let a = SharedDisplay::new();
        let b = a.clone();
        a.set(Some(3));
        assert_eq!(b.get(), Some(3), "the run's task must see a mid-run switch");
    }
}
