//! Seeing the screen: capture, fit, annotate, encode.
//!
//! Every look Ask takes goes through here, so every model gets the same kind
//! of picture: the shared display only (L-230), fitted to a size every
//! vendor's vision models accept without resampling it again, with the
//! pointer drawn in (a real screenshot leaves it out, and a model that cannot
//! see the pointer cannot reason about hovering or dragging), optionally with
//! numbered marks over the elements it can target by id, and encoded as JPEG —
//! a screenshot is mostly flat colour and text, where JPEG at this quality is
//! a fraction of PNG's size for no loss the model can use.
//!
//! Capture failures are specific. "Could not capture" helps nobody; "the
//! screen is locked" and "Screen Recording is off" each tell the model — and
//! the person reading the step — what is actually wrong.

use anyhow::Result;
use image::RgbaImage;

use crate::agent::runner::ObservedImage;

/// Longest edge of a screenshot sent to a model, and its largest area. Both
/// bounds hold for every current vendor's vision input without a second
/// resize on their side — which matters, because a model's coordinates are
/// only right against the image it actually saw.
pub const MAX_EDGE: u32 = 1366;
pub const MAX_PIXELS: u64 = 1_150_000;

/// JPEG quality. Text stays legible; a full screen is ~100–200 KB.
const JPEG_QUALITY: u8 = 75;

/// One capture of the shared display at full resolution.
pub struct Frame {
    pub rgba: RgbaImage,
    /// The display's global rectangle in points `[x, y, w, h]`.
    pub bounds: [f64; 4],
}

impl Frame {
    /// A coarse picture of the frame for comparing two moments: small,
    /// grayscale, and blind to a blinking caret.
    pub fn thumbnail(&self) -> Vec<u8> {
        let small = image::imageops::thumbnail(&self.rgba, 64, 40);
        small
            .pixels()
            .map(|p| ((u16::from(p[0]) * 3 + u16::from(p[1]) * 6 + u16::from(p[2])) / 10) as u8)
            .collect()
    }

    /// A stable fingerprint of what is on screen, for noticing that an action
    /// changed nothing.
    pub fn fingerprint(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        // Coarser than the settling thumbnail and quantized to eight levels,
        // so a blinking caret or a ticking clock is not "the screen changed".
        // ponytail: a quantization boundary can still flip on a tiny change;
        // that only resets the loop guard's count, never stops a run.
        let small = image::imageops::thumbnail(&self.rgba, 32, 20);
        for p in small.pixels() {
            let v = (u16::from(p[0]) * 3 + u16::from(p[1]) * 6 + u16::from(p[2])) / 10;
            (v >> 5).hash(&mut h);
        }
        h.finish()
    }

    /// Is the frame pure black? That is a display asleep or a capture the
    /// system blanked, not a picture of anything. Pure, not dark: a dark-mode
    /// screen still has a menu bar, a caret, text — and refusing to look at
    /// one would break Ask for everyone who likes black backgrounds.
    pub fn is_black(&self) -> bool {
        self.thumbnail().iter().all(|&v| v <= 1)
    }
}

/// Have two thumbnails settled into the same picture?
pub fn similar(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let total: u64 = a
        .iter()
        .zip(b)
        .map(|(x, y)| u64::from(x.abs_diff(*y)))
        .sum();
    let changed = a
        .iter()
        .zip(b)
        .filter(|(x, y)| x.abs_diff(**y) > 24)
        .count();
    // Mean difference under one level, and almost nothing changed sharply.
    total < a.len() as u64 && changed <= 2
}

/// The size a `w`×`h` capture is fitted to.
pub fn fit_size(w: u32, h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (1, 1);
    }
    let (w64, h64) = (f64::from(w), f64::from(h));
    let mut scale = (f64::from(MAX_EDGE) / w64.max(h64)).min(1.0);
    let area = w64 * h64 * scale * scale;
    if area > MAX_PIXELS as f64 {
        scale *= (MAX_PIXELS as f64 / area).sqrt();
    }
    (
        ((w64 * scale).floor() as u32).max(1),
        ((h64 * scale).floor() as u32).max(1),
    )
}

/// A numbered box drawn over an element the model can target by id.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mark {
    pub id: usize,
    /// Normalized `[x, y, w, h]` on the display.
    pub rect: [f64; 4],
}

/// Fit, annotate and encode a frame for the model.
pub fn render(frame: &Frame, cursor: Option<(f64, f64)>, marks: &[Mark]) -> Result<ObservedImage> {
    let (w, h) = fit_size(frame.rgba.width(), frame.rgba.height());
    let mut img = if (w, h) == frame.rgba.dimensions() {
        frame.rgba.clone()
    } else {
        image::imageops::thumbnail(&frame.rgba, w, h)
    };
    for (i, mark) in marks.iter().enumerate() {
        draw_mark(&mut img, mark, MARK_COLOURS[i % MARK_COLOURS.len()]);
    }
    if let Some((x, y)) = cursor {
        draw_pointer(&mut img, x * f64::from(w), y * f64::from(h));
    }
    encode(img, true)
}

/// A region of the frame at full resolution, fitted like a screenshot.
/// `region` is normalized `[x0, y0, x1, y1]`.
pub fn zoom(frame: &Frame, region: [f64; 4]) -> Result<ObservedImage> {
    let (fw, fh) = frame.rgba.dimensions();
    let px = |v: f64, of: u32| ((v.clamp(0.0, 1.0) * f64::from(of)).round() as u32).min(of);
    let (x0, y0) = (px(region[0], fw), px(region[1], fh));
    let (x1, y1) = (px(region[2], fw), px(region[3], fh));
    if x1 <= x0 + 1 || y1 <= y0 + 1 {
        anyhow::bail!("that region is too small to show");
    }
    let crop = image::imageops::crop_imm(&frame.rgba, x0, y0, x1 - x0, y1 - y0).to_image();
    let (w, h) = fit_size(crop.width(), crop.height());
    let img = if (w, h) == crop.dimensions() {
        crop
    } else {
        image::imageops::thumbnail(&crop, w, h)
    };
    encode(img, false)
}

fn encode(img: RgbaImage, is_screen: bool) -> Result<ObservedImage> {
    use base64::Engine;
    let (width, height) = img.dimensions();
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let mut jpeg: Vec<u8> = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode_image(&rgb)?;
    Ok(ObservedImage {
        base64: base64::engine::general_purpose::STANDARD.encode(&jpeg),
        media_type: "image/jpeg",
        width,
        height,
        is_screen,
    })
}

// ── drawing ─────────────────────────────────────────────────────────────

/// High-contrast colours for marks, cycled so neighbours differ.
const MARK_COLOURS: [[u8; 3]; 5] = [
    [230, 0, 118],
    [0, 110, 230],
    [0, 150, 70],
    [200, 90, 0],
    [120, 40, 200],
];

fn put(img: &mut RgbaImage, x: i64, y: i64, rgb: [u8; 3]) {
    if x >= 0 && y >= 0 && (x as u32) < img.width() && (y as u32) < img.height() {
        img.put_pixel(
            x as u32,
            y as u32,
            image::Rgba([rgb[0], rgb[1], rgb[2], 255]),
        );
    }
}

/// 3×5 bitmap digits, one row per `u8` (low three bits, left to right).
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];
const DIGIT_SCALE: i64 = 2;

fn draw_number(img: &mut RgbaImage, x: i64, y: i64, n: usize, fg: [u8; 3], bg: [u8; 3]) {
    let text = n.to_string();
    let w = text.len() as i64 * 4 * DIGIT_SCALE + DIGIT_SCALE;
    let h = 7 * DIGIT_SCALE;
    for yy in 0..h {
        for xx in 0..w {
            put(img, x + xx, y + yy, bg);
        }
    }
    for (i, ch) in text.bytes().enumerate() {
        let glyph = DIGITS[(ch - b'0') as usize];
        let ox = x + DIGIT_SCALE + i as i64 * 4 * DIGIT_SCALE;
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) != 0 {
                    for sy in 0..DIGIT_SCALE {
                        for sx in 0..DIGIT_SCALE {
                            put(
                                img,
                                ox + col * DIGIT_SCALE + sx,
                                y + DIGIT_SCALE + row as i64 * DIGIT_SCALE + sy,
                                fg,
                            );
                        }
                    }
                }
            }
        }
    }
}

fn draw_mark(img: &mut RgbaImage, mark: &Mark, colour: [u8; 3]) {
    let (w, h) = (f64::from(img.width()), f64::from(img.height()));
    let x0 = (mark.rect[0] * w).round() as i64;
    let y0 = (mark.rect[1] * h).round() as i64;
    let x1 = ((mark.rect[0] + mark.rect[2]) * w).round() as i64;
    let y1 = ((mark.rect[1] + mark.rect[3]) * h).round() as i64;
    // Two pixels wide: one survives JPEG and a model's own downscaling.
    for x in x0..=x1 {
        for t in 0..2 {
            put(img, x, y0 + t, colour);
            put(img, x, y1 - t, colour);
        }
    }
    for y in y0..=y1 {
        for t in 0..2 {
            put(img, x0 + t, y, colour);
            put(img, x1 - t, y, colour);
        }
    }
    draw_number(img, x0, y0, mark.id, [255, 255, 255], colour);
}

/// The classic arrow pointer, tip at the origin, in output pixels.
const POINTER: [(f64, f64); 7] = [
    (0.0, 0.0),
    (0.0, 17.0),
    (4.5, 13.0),
    (7.5, 19.5),
    (10.0, 18.5),
    (7.0, 12.0),
    (12.0, 12.0),
];

fn draw_pointer(img: &mut RgbaImage, tip_x: f64, tip_y: f64) {
    let inside = |px: f64, py: f64| {
        let mut odd = false;
        let mut j = POINTER.len() - 1;
        for (i, &(xi, yi)) in POINTER.iter().enumerate() {
            let (xj, yj) = POINTER[j];
            if (yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi {
                odd = !odd;
            }
            j = i;
        }
        odd
    };
    let edge = |px: f64, py: f64| {
        let mut best = f64::MAX;
        let mut j = POINTER.len() - 1;
        for (i, &(bx, by)) in POINTER.iter().enumerate() {
            let (ax, ay) = POINTER[j];
            let (dx, dy) = (bx - ax, by - ay);
            let t = (((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
            let (cx, cy) = (ax + t * dx - px, ay + t * dy - py);
            best = best.min((cx * cx + cy * cy).sqrt());
            j = i;
        }
        best
    };
    for oy in -2..22 {
        for ox in -2..15 {
            let (px, py) = (f64::from(ox) + 0.5, f64::from(oy) + 0.5);
            let (x, y) = ((tip_x + px) as i64, (tip_y + py) as i64);
            if edge(px, py) < 1.2 {
                put(img, x, y, [0, 0, 0]);
            } else if inside(px, py) {
                put(img, x, y, [255, 255, 255]);
            }
        }
    }
}

// ── capture ─────────────────────────────────────────────────────────────

/// How a display is named to the model and in failures.
pub fn display_name(target: Option<u32>) -> String {
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

/// Capture the shared display, or say exactly why not.
#[cfg(target_os = "macos")]
pub fn grab(target: Option<u32>) -> Result<Frame> {
    use core_graphics::display::CGDisplay;

    if !screen_capture_allowed() {
        anyhow::bail!(
            "Lilypad does not have Screen Recording permission on this Mac, so it cannot see \
             the screen (System Settings ▸ Privacy & Security ▸ Screen Recording)"
        );
    }
    if screen_locked() {
        anyhow::bail!(
            "the Mac's screen is locked. Someone at the Mac has to unlock it; Ask never \
             types a login password"
        );
    }
    // The display the phone is actually sharing. A screenshot of a monitor
    // the phone is not watching would send the provider a screen the person
    // did not choose to share (L-230).
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
                    "display {id} is no longer attached — the shared display went away; look \
                     again after the session picks a new one"
                );
            }
            CGDisplay::new(id)
        }
    };
    let bounds = display.bounds();
    let cg_image = display.image().ok_or_else(|| {
        anyhow::anyhow!("macOS returned no image of the screen (is Screen Recording allowed?)")
    })?;

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
            rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
        }
    }
    let rgba = RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| anyhow::anyhow!("screenshot buffer size mismatch"))?;
    let frame = Frame {
        rgba,
        bounds: [
            bounds.origin.x,
            bounds.origin.y,
            bounds.size.width,
            bounds.size.height,
        ],
    };
    if frame.is_black() {
        anyhow::bail!(
            "the screen came back completely black — the display may be asleep, or macOS is \
             hiding it"
        );
    }
    Ok(frame)
}

#[cfg(not(target_os = "macos"))]
pub fn grab(target: Option<u32>) -> Result<Frame> {
    anyhow::bail!(
        "screen capture is only available on macOS (asked for {})",
        display_name(target)
    )
}

/// Wait for the screen to stop changing, then return the settled frame.
///
/// A fixed sleep after every action is either too short for a page load or
/// wastes time on a checkbox. Instead: wait `min` for the action to land, then
/// compare two looks a moment apart until they agree, giving up at `max` (an
/// animation or a video never settles, and the model is better served by a
/// slightly moving picture than by no picture).
pub fn settle(
    target: Option<u32>,
    min: std::time::Duration,
    max: std::time::Duration,
) -> Result<Frame> {
    let started = std::time::Instant::now();
    std::thread::sleep(min);
    let mut frame = grab(target)?;
    let mut thumb = frame.thumbnail();
    while started.elapsed() < max {
        std::thread::sleep(std::time::Duration::from_millis(120));
        let next = grab(target)?;
        let next_thumb = next.thumbnail();
        let done = similar(&thumb, &next_thumb);
        frame = next;
        thumb = next_thumb;
        if done {
            break;
        }
    }
    Ok(frame)
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGSessionCopyCurrentDictionary() -> core_foundation::dictionary::CFDictionaryRef;
}

#[cfg(target_os = "macos")]
fn screen_capture_allowed() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Is the login session's screen locked (or the screensaver's lock up)?
#[cfg(target_os = "macos")]
fn screen_locked() -> bool {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    let raw = unsafe { CGSessionCopyCurrentDictionary() };
    if raw.is_null() {
        return false;
    }
    let dict: CFDictionary<CFString, CFType> = unsafe { TCFType::wrap_under_create_rule(raw) };
    let key = CFString::from_static_string("CGSSessionScreenIsLocked");
    dict.find(&key)
        .and_then(|v| v.downcast::<CFBoolean>())
        .map(bool::from)
        .unwrap_or(false)
}

/// Where the pointer is, normalized to `bounds`, if it is on that display.
#[cfg(target_os = "macos")]
pub fn pointer_in(bounds: [f64; 4]) -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let at = CGEvent::new(source).ok()?.location();
    let x = (at.x - bounds[0]) / bounds[2];
    let y = (at.y - bounds[1]) / bounds[3];
    ((0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)).then_some((x, y))
}

#[cfg(not(target_os = "macos"))]
pub fn pointer_in(_bounds: [f64; 4]) -> Option<(f64, f64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: u32, h: u32, rgb: [u8; 3]) -> Frame {
        Frame {
            rgba: RgbaImage::from_pixel(w, h, image::Rgba([rgb[0], rgb[1], rgb[2], 255])),
            bounds: [0.0, 0.0, f64::from(w), f64::from(h)],
        }
    }

    #[test]
    fn a_retina_capture_fits_every_vendors_limits() {
        for (w, h) in [
            (3024, 1964),
            (5120, 2880),
            (2560, 1600),
            (1920, 1080),
            (6016, 3384),
        ] {
            let (fw, fh) = fit_size(w, h);
            assert!(fw.max(fh) <= MAX_EDGE, "{w}x{h} → {fw}x{fh}");
            assert!(
                u64::from(fw) * u64::from(fh) <= MAX_PIXELS,
                "{w}x{h} → {fw}x{fh}"
            );
            // Aspect kept within a pixel.
            let aspect = f64::from(w) / f64::from(h);
            assert!((f64::from(fw) / f64::from(fh) - aspect).abs() < 0.01);
        }
        // Small screens are never enlarged.
        assert_eq!(fit_size(1024, 768), (1024, 768));
    }

    #[test]
    fn a_render_is_a_fitted_jpeg_with_the_pointer_drawn_in() {
        let f = frame(2880, 1800, [200, 200, 200]);
        let img = render(&f, Some((0.5, 0.5)), &[]).unwrap();
        assert_eq!(img.media_type, "image/jpeg");
        assert!(img.is_screen);
        assert_eq!((img.width, img.height), fit_size(2880, 1800));
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&img.base64)
            .unwrap();
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF], "not a JPEG");
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgb8();
        // Just inside the tip the pointer's outline is dark on a light screen.
        let (cx, cy) = (img.width / 2, img.height / 2);
        let near_tip = decoded.get_pixel(cx, cy + 2);
        assert!(near_tip[0] < 100, "pointer not drawn: {near_tip:?}");
    }

    #[test]
    fn marks_are_drawn_where_their_elements_are() {
        let f = frame(1000, 500, [255, 255, 255]);
        let img = render(
            &f,
            None,
            &[Mark {
                id: 12,
                rect: [0.2, 0.2, 0.2, 0.2],
            }],
        )
        .unwrap();
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&img.base64)
            .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgb8();
        // The box's bottom edge (y = 0.4 × 500), well away from the label.
        let edge = decoded.get_pixel(300, 199);
        assert!(edge[1] < 150, "mark edge missing: {edge:?}");
        // Inside the box, away from the label, the screen is untouched.
        let inside = decoded.get_pixel(300, 150);
        assert!(inside[0] > 200 && inside[1] > 200, "{inside:?}");
    }

    #[test]
    fn a_zoom_is_a_crop_at_full_resolution_that_is_not_the_screen() {
        let mut f = frame(4000, 2000, [255, 255, 255]);
        f.rgba.put_pixel(3000, 1500, image::Rgba([0, 0, 0, 255]));
        let img = zoom(&f, [0.5, 0.5, 1.0, 1.0]).unwrap();
        assert!(
            !img.is_screen,
            "a zoom must not redefine the coordinate frame"
        );
        assert_eq!((img.width, img.height), fit_size(2000, 1000));
        assert!(zoom(&f, [0.5, 0.5, 0.5, 0.9]).is_err());
    }

    #[test]
    fn settling_tolerates_a_caret_and_notices_a_page_change() {
        let a = frame(1280, 800, [240, 240, 240]);
        let mut caret = frame(1280, 800, [240, 240, 240]);
        for y in 100..118 {
            caret.rgba.put_pixel(400, y, image::Rgba([0, 0, 0, 255]));
        }
        assert!(similar(&a.thumbnail(), &caret.thumbnail()));
        assert_eq!(a.fingerprint(), caret.fingerprint());

        let mut changed = frame(1280, 800, [240, 240, 240]);
        for y in 0..400 {
            for x in 0..640 {
                changed
                    .rgba
                    .put_pixel(x, y, image::Rgba([20, 60, 200, 255]));
            }
        }
        assert!(!similar(&a.thumbnail(), &changed.thumbnail()));
        assert_ne!(a.fingerprint(), changed.fingerprint());
        assert!(frame(64, 40, [0, 0, 0]).is_black());
        assert!(!a.is_black());
        // A dark screen with a little text on it is a screen, not a blank.
        let mut dark = frame(1280, 800, [12, 12, 14]);
        for x in 0..200 {
            dark.rgba.put_pixel(x, 5, image::Rgba([220, 220, 220, 255]));
        }
        assert!(!dark.is_black());
    }

    #[test]
    fn a_display_is_named_so_the_model_knows_what_it_is_looking_at() {
        assert_eq!(display_name(None), "the main display");
        assert_eq!(display_name(Some(2)), "display 2");
    }

    #[test]
    fn a_changed_display_retires_the_earlier_screenshots_in_the_observation() {
        assert_eq!(staleness_note(false), "");
        assert!(staleness_note(true).contains("must not be used"));
    }

    /// Live: capture the real screen. Requires Screen Recording; without it
    /// the failure must be the specific sentence, never a crash.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_live_capture_either_works_or_says_why() {
        match grab(None) {
            Ok(frame) => assert!(frame.rgba.width() > 0),
            Err(e) => {
                let e = e.to_string();
                assert!(
                    e.contains("Screen Recording")
                        || e.contains("locked")
                        || e.contains("black")
                        || e.contains("no image"),
                    "{e}"
                );
            }
        }
    }
}
