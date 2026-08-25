//! macOS ScreenCaptureKit capture source — real implementation.
//!
//! Creates an `SCStream` over the main display, receives `CMSampleBuffer`s on
//! a stream-output handler (invoked on an internal ScreenCaptureKit dispatch
//! queue — not the pipeline's capture thread), converts each `CVPixelBuffer`
//! to BGRA respecting row stride, and publishes it to a shared "latest frame"
//! slot. `next_frame()` (called from the pipeline's dedicated capture thread)
//! blocks on a condvar for the next frame — this is a push→pull bridge, and
//! deliberately keeps only the latest frame rather than queuing, since a
//! real-time remote-control viewer should always show the newest frame
//! instead of catching up through a backlog.
//!
//! Requires **Screen Recording** permission (System Settings ▸ Privacy &
//! Security ▸ Screen Recording) — checked via `CGPreflightScreenCaptureAccess`
//! before attempting to start, and the authoritative `SCShareableContent::get()`
//! failure is also mapped to the same actionable error, so a revoked/missing
//! grant is always surfaced, never silently swallowed.

use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use core_graphics::display::CGDisplay;
use screencapturekit::error::SCError;
use screencapturekit::prelude::*;
use screencapturekit::stream::delegate_trait::SCStreamDelegateTrait;

use super::{CaptureBackend, CaptureConfig, Display};
use crate::media::frame::RawFrame;
use crate::permission::PermissionStatus;

/// How stale the cached Screen-Recording permission check may be. Mirrors the
/// same fix applied to macOS Accessibility in `crate::input::macos`:
/// `CGPreflightScreenCaptureAccess` is also a TCC round-trip, not a cheap
/// local check, and this plugin's health is polled by the UI periodically.
const PERMISSION_CACHE_TTL: Duration = Duration::from_millis(500);

/// How long `next_frame()` waits for a new frame before reporting a stall.
/// Generous relative to any real frame interval (even 5 fps = 200ms) so it
/// only fires on a genuine stream stall, not ordinary jitter.
const FRAME_WAIT_TIMEOUT: Duration = Duration::from_secs(2);

/// Query the real primary display's resolution, downscaled to fit within
/// `max_long_edge` while preserving its aspect ratio (and H.264/I420's
/// even-dimension requirement). Encode cost scales roughly with pixel count,
/// so passing a real 5K/6K Retina display's native resolution straight
/// through would be a large, unvalidated jump in CPU/GPU/bandwidth cost — the
/// caller picks the ceiling (`CaptureMode::max_capture_long_edge`): 1920
/// preserves a 13" MacBook's real 16:10 aspect ratio (2560×1600 → 1920×1200)
/// at today's `Motion` mode's 720p-class cost; `Text` mode passes a higher
/// ceiling to trade that cost for readability. `None` if ScreenCaptureKit
/// can't enumerate a display right now (e.g. Screen Recording not yet
/// granted) — the caller falls back to its own mode-specific default in that
/// case. Refresh-rate matching is deliberately out of scope here (`SCDisplay`
/// doesn't expose one; capture stays at its configured fps) — this fixes the
/// resolution/aspect-ratio mismatch, the finding's primary complaint, not
/// frame-rate matching. See `docs/audit/m3/streaming-media.md` Finding 1 and
/// `docs/audit/m3/prior-art.md` Finding 2.
pub fn display_resolution(display_id: Option<u32>, max_long_edge: u32) -> Option<(u32, u32)> {
    let content = SCShareableContent::get().ok()?;
    let displays = content.displays();
    let display = pick_display(&displays, display_id)?;
    let (w, h) = (display.width(), display.height());
    if w == 0 || h == 0 {
        return None; // degenerate report — keep the caller's existing default
    }
    Some(downscale_to_fit(w, h, max_long_edge))
}

/// The requested display, or the first one when nothing was requested or the
/// requested one is no longer attached. Falling back rather than failing is
/// deliberate: a monitor unplugged between the moment the phone tapped its
/// button and the moment the pipeline rebuilds should cost a switch, not the
/// session.
fn pick_display(displays: &[SCDisplay], display_id: Option<u32>) -> Option<&SCDisplay> {
    match display_id {
        Some(id) => displays
            .iter()
            .find(|d| d.display_id() == id)
            .or_else(|| displays.first()),
        None => displays.first(),
    }
}

/// Every attached display, left to right by its position in the Mac's own
/// arrangement — so the phone's second button is the person's second screen.
///
/// CoreGraphics rather than `SCShareableContent`: this is polled during a live
/// session to notice a monitor being plugged in or pulled out, and
/// `SCShareableContent::get()` is a window-server round trip that also
/// requires the Screen Recording grant. `CGDisplay::active_displays()` is a
/// local call that needs neither.
pub(super) fn list_displays() -> Vec<Display> {
    let Ok(ids) = CGDisplay::active_displays() else {
        return Vec::new();
    };
    let mut ordered: Vec<(f64, CGDisplay)> = ids
        .into_iter()
        .map(|id| {
            let d = CGDisplay::new(id);
            (d.bounds().origin.x, d)
        })
        .collect();
    ordered.sort_by(|a, b| a.0.total_cmp(&b.0));
    ordered
        .into_iter()
        .enumerate()
        .filter_map(|(i, (_, d))| {
            let size = d.bounds().size;
            let (w, h) = (size.width as u32, size.height as u32);
            if w == 0 || h == 0 {
                return None; // a display reporting no size is one we cannot offer
            }
            Some(Display {
                id: d.id,
                name: if d.is_builtin() {
                    "Built-in Display".to_owned()
                } else {
                    format!("Display {}", i + 1)
                },
                width: w,
                height: h,
            })
        })
        .collect()
}

/// Scale `(width, height)` down (never up) so its long edge fits within
/// `max_long_edge`, preserving aspect ratio, then round both dimensions down
/// to even numbers (H.264/I420 require even width/height, and rounding DOWN
/// rather than to nearest guarantees the result never exceeds the ceiling).
fn downscale_to_fit(width: u32, height: u32, max_long_edge: u32) -> (u32, u32) {
    let long_edge = width.max(height);
    let (w, h) = if long_edge <= max_long_edge {
        (width, height)
    } else {
        let scale = f64::from(max_long_edge) / f64::from(long_edge);
        (
            (f64::from(width) * scale) as u32,
            (f64::from(height) * scale) as u32,
        )
    };
    ((w & !1).max(2), (h & !1).max(2))
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    /// The PROMPTING variant — triggers the native "Lilypad would like to
    /// record this computer's screen" dialog if the user hasn't decided yet
    /// (a no-op if already granted or denied). See
    /// `docs/audit/m3/desktop-ux.md` Finding 1.
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Cheap, instance-free preflight check — `permission::screen_capture_status()`
/// calls this directly (with its own process-wide cache) so the debug health
/// overlay never needs to construct a full capture backend just to ask the OS
/// a yes/no question.
pub(crate) fn screen_capture_preflight() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Actively request Screen Recording, prompting the user if undecided. Used
/// by the first-run Setup flow's "Grant" button. Distinct from
/// `screen_capture_preflight()` above (the passive check used on the hot
/// capture-start path and the ongoing health poll), which must never itself
/// trigger a dialog mid-session.
pub(crate) fn screen_capture_request() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

/// Shared slot the output handler publishes into and `next_frame()` drains.
struct FrameSlot {
    frame: Mutex<Option<RawFrame>>,
    cond: Condvar,
    /// Set (with the OS error text) when ScreenCaptureKit reports the stream
    /// stopped — the one signal that distinguishes a genuinely dead stream
    /// from a static screen that simply has no changes to deliver.
    dead: Mutex<Option<String>>,
}

/// Receives SCStream lifecycle callbacks — specifically stream death (TCC
/// revocation, display disconnect, "stopped by the system"). Marks the shared
/// slot dead and wakes the capture thread so it fails fast with the real
/// reason instead of idling in keepalive re-sends forever.
struct StreamDeathWatch {
    slot: Arc<FrameSlot>,
}

impl SCStreamDelegateTrait for StreamDeathWatch {
    fn did_stop_with_error(&self, error: SCError) {
        log::error!(target: "lilypad::media", "ScreenCaptureKit stream stopped: {error}");
        *self.slot.dead.lock().unwrap() = Some(error.to_string());
        self.slot.cond.notify_all();
    }
}

/// Runs on ScreenCaptureKit's internal dispatch queue — converts each sample
/// to BGRA and replaces whatever frame is currently in the slot.
struct FrameHandler {
    slot: Arc<FrameSlot>,
    start: Instant,
    index: AtomicU64,
}

impl SCStreamOutputTrait for FrameHandler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
        if of_type != SCStreamOutputType::Screen {
            return;
        }
        let Some(pixel_buffer) = sample.image_buffer() else {
            return;
        };
        let Ok(guard) = pixel_buffer.lock_read_only() else {
            return;
        };

        let width = guard.width() as u32;
        let height = guard.height() as u32;
        let row_bytes = width as usize * 4;
        let total = row_bytes * height as usize;

        // Reuse the allocation of a frame the consumer never picked up
        // (drop-oldest semantics) instead of allocating ~4MB per frame; a
        // fresh Vec is only needed when the consumer is keeping up.
        let mut bgra = self
            .slot
            .frame
            .lock()
            .unwrap()
            .take()
            .map(|old| old.bgra)
            .unwrap_or_default();
        bgra.clear();
        bgra.reserve(total);
        for y in 0..height as usize {
            match guard.row(y) {
                Some(row) if row.len() >= row_bytes => bgra.extend_from_slice(&row[..row_bytes]),
                Some(row) => {
                    bgra.extend_from_slice(row);
                    bgra.resize((y + 1) * row_bytes, 0);
                }
                None => bgra.resize((y + 1) * row_bytes, 0),
            }
        }
        drop(guard);

        let index = self.index.fetch_add(1, Ordering::Relaxed);
        let frame = RawFrame {
            width,
            height,
            bgra,
            timestamp: self.start.elapsed(),
            captured_at: Instant::now(),
            index,
        };

        *self.slot.frame.lock().unwrap() = Some(frame);
        self.slot.cond.notify_one();
    }
}

pub struct ScreenCaptureKitSource {
    width: u32,
    height: u32,
    fps: u32,
    /// Which display to capture; `None` means the main one. See
    /// `pick_display` for what happens when it is unplugged first.
    display_id: Option<u32>,
    permission_cache: Cell<Option<(Instant, bool)>>,
    stream: Option<SCStream>,
    slot: Option<Arc<FrameSlot>>,
    /// Most recently delivered frame, re-sent as a keepalive when the screen
    /// is static: ScreenCaptureKit only emits samples when content changes,
    /// so "no frame for a while" is the NORMAL idle state, not a stall.
    last_frame: Option<RawFrame>,
    /// When capture started — duplicates get a fresh monotonic timestamp so
    /// downstream pacing/metrics don't see time flowing backwards.
    started_at: Option<Instant>,
}

impl ScreenCaptureKitSource {
    pub fn new(cfg: CaptureConfig) -> Self {
        Self {
            // H.264 / I420 require even dimensions.
            width: cfg.width & !1,
            height: cfg.height & !1,
            fps: cfg.fps.max(1),
            display_id: cfg.display_id,
            permission_cache: Cell::new(None),
            stream: None,
            slot: None,
            last_frame: None,
            started_at: None,
        }
    }

    fn cached_permission(&self) -> bool {
        let now = Instant::now();
        if let Some((checked_at, granted)) = self.permission_cache.get() {
            if now.duration_since(checked_at) < PERMISSION_CACHE_TTL {
                return granted;
            }
        }
        let granted = screen_capture_preflight();
        self.permission_cache.set(Some((now, granted)));
        granted
    }
}

fn map_shareable_content_error(e: SCError) -> anyhow::Error {
    match &e {
        SCError::PermissionDenied(_) | SCError::NoShareableContent(_) => anyhow!(
            "Screen Recording permission not granted — grant Lilypad access in \
             System Settings ▸ Privacy & Security ▸ Screen Recording, then reconnect"
        ),
        _ => anyhow!("failed to enumerate shareable content: {e}"),
    }
}

impl CaptureBackend for ScreenCaptureKitSource {
    fn initialize(&mut self) -> Result<()> {
        if !self.cached_permission() {
            bail!(
                "Screen Recording permission not granted — grant Lilypad access in \
                 System Settings ▸ Privacy & Security ▸ Screen Recording, then retry. \
                 (Falls back to the synthetic source until granted.)"
            );
        }
        Ok(())
    }

    fn start(&mut self) -> Result<()> {
        let content = SCShareableContent::get().map_err(map_shareable_content_error)?;
        let displays = content.displays();
        let display = pick_display(&displays, self.display_id)
            .ok_or_else(|| anyhow!("no display available to capture"))?;

        let filter = SCContentFilter::create()
            .with_display(display)
            .with_excluding_windows(&[])
            .build();
        let config = SCStreamConfiguration::new()
            .with_width(self.width)
            .with_height(self.height)
            .with_pixel_format(PixelFormat::BGRA)
            .with_fps(self.fps)
            .with_shows_cursor(true);

        let slot = Arc::new(FrameSlot {
            frame: Mutex::new(None),
            cond: Condvar::new(),
            dead: Mutex::new(None),
        });
        let handler = FrameHandler {
            slot: Arc::clone(&slot),
            start: Instant::now(),
            index: AtomicU64::new(0),
        };

        let mut stream = SCStream::new_with_delegate(
            &filter,
            &config,
            StreamDeathWatch {
                slot: Arc::clone(&slot),
            },
        );
        stream.add_output_handler(handler, SCStreamOutputType::Screen);
        stream
            .start_capture()
            .map_err(|e| anyhow!("failed to start ScreenCaptureKit stream: {e}"))?;

        self.slot = Some(slot);
        self.stream = Some(stream);
        self.last_frame = None;
        self.started_at = Some(Instant::now());
        Ok(())
    }

    fn next_frame(&mut self) -> Result<RawFrame> {
        let slot = self
            .slot
            .as_ref()
            .ok_or_else(|| anyhow!("capture not started"))?;
        let mut guard = slot.frame.lock().unwrap();
        loop {
            if let Some(frame) = guard.take() {
                drop(guard);
                self.last_frame = Some(frame.clone());
                return Ok(frame);
            }
            // A dead stream never delivers again — fail fast with the OS's
            // reason instead of idling in the keepalive path below.
            if let Some(reason) = slot.dead.lock().unwrap().clone() {
                bail!("capture stream stopped by the OS: {reason}");
            }
            let (next_guard, wait_result) = slot
                .cond
                .wait_timeout(guard, FRAME_WAIT_TIMEOUT)
                .map_err(|_| anyhow!("frame slot lock poisoned"))?;
            guard = next_guard;
            if wait_result.timed_out() && guard.is_none() {
                // ScreenCaptureKit is change-driven: a static screen delivers
                // NO samples, indefinitely — that's an idle desktop, not a
                // dead stream. Re-send the previous frame as a keepalive so
                // the pipeline (and the phone's video) stays alive. Only two
                // cases are genuinely fatal here: the permission was revoked
                // mid-session, or the stream never produced a single frame.
                drop(guard);
                if !self.cached_permission() {
                    bail!(
                        "Screen Recording permission was revoked mid-session — grant Lilypad \
                         access in System Settings ▸ Privacy & Security ▸ Screen Recording"
                    );
                }
                match (&self.last_frame, self.started_at) {
                    (Some(last), started) => {
                        let mut dup = last.clone();
                        dup.timestamp = started
                            .map(|s| s.elapsed())
                            .unwrap_or(dup.timestamp + FRAME_WAIT_TIMEOUT);
                        dup.captured_at = Instant::now();
                        return Ok(dup);
                    }
                    (None, _) => bail!(
                        "no frame received within {FRAME_WAIT_TIMEOUT:?} of stream start — \
                         capture stream failed to produce any output"
                    ),
                }
            }
        }
    }

    fn provides_pacing(&self) -> bool {
        // `next_frame()` blocks on the condvar until ScreenCaptureKit delivers
        // the next frame at the configured fps — the OS is the pacer.
        true
    }

    fn resolution(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn fps(&self) -> u32 {
        self.fps
    }

    fn permission_status(&self) -> PermissionStatus {
        if self.cached_permission() {
            PermissionStatus::Granted
        } else {
            PermissionStatus::NotGranted
        }
    }

    fn stop(&mut self) -> Result<()> {
        if let Some(stream) = self.stream.take() {
            let _ = stream.stop_capture();
        }
        self.slot = None;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<()> {
        self.stop()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_self_paced_so_pipeline_must_not_sleep() {
        let src = ScreenCaptureKitSource::new(CaptureConfig::default());
        assert!(src.provides_pacing());
    }

    #[test]
    fn even_dimensions_enforced() {
        let src = ScreenCaptureKitSource::new(CaptureConfig {
            width: 1281,
            height: 721,
            fps: 30,
            display_id: None,
        });
        assert_eq!(src.resolution(), (1280, 720));
    }

    #[test]
    fn downscale_to_fit_passes_through_a_display_already_within_the_ceiling() {
        assert_eq!(downscale_to_fit(1280, 720, 1920), (1280, 720));
    }

    #[test]
    fn downscale_to_fit_preserves_aspect_ratio_for_a_13_inch_macbook_display() {
        // 2560x1600 (16:10) -> capped at long edge 1920 -> 1920x1200.
        let (w, h) = downscale_to_fit(2560, 1600, 1920);
        assert_eq!((w, h), (1920, 1200));
    }

    #[test]
    fn downscale_to_fit_preserves_aspect_ratio_for_an_ultrawide_display() {
        // 3440x1440 (21:9) -> capped at long edge 1920 -> 1920x803 (rounded even).
        let (w, h) = downscale_to_fit(3440, 1440, 1920);
        assert_eq!(w, 1920);
        assert!((798..=804).contains(&h), "expected ~803, got {h}");
        assert_eq!(h % 2, 0, "height must stay even for H.264/I420");
    }

    #[test]
    fn downscale_to_fit_never_upscales_a_smaller_display() {
        assert_eq!(downscale_to_fit(800, 600, 1920), (800, 600));
    }

    #[test]
    fn downscale_to_fit_always_returns_even_dimensions() {
        for (w, h) in [(2561, 1601), (3441, 1441), (1281, 721)] {
            let (rw, rh) = downscale_to_fit(w, h, 1920);
            assert_eq!(rw % 2, 0, "width {rw} must be even");
            assert_eq!(rh % 2, 0, "height {rh} must be even");
        }
    }

    #[test]
    fn display_resolution_never_panics_regardless_of_permission_state() {
        // On this dev machine Screen Recording may or may not be granted to
        // the test harness process — either way, this must return an Option,
        // never panic (mirrors the sandboxed-permission acknowledgment in
        // `initialize_without_permission_reports_actionable_error_not_a_panic`
        // below).
        let _ = display_resolution(None, 1920);
        let _ = display_resolution(Some(0xDEAD_BEEF), 1920);
    }

    #[test]
    fn every_listed_display_has_a_name_and_a_real_size() {
        // Runs on whatever this machine actually has attached — one display
        // on CI, two on a desk. The invariants hold either way, and a
        // zero-sized or unnamed entry would be a button on the phone that
        // means nothing.
        for d in list_displays() {
            assert!(!d.name.is_empty(), "display {} has no name", d.id);
            assert!(d.width > 0 && d.height > 0, "display {} has no size", d.id);
        }
    }

    #[test]
    fn display_names_are_unique_so_the_switcher_is_unambiguous() {
        let displays = list_displays();
        let mut names: Vec<&str> = displays.iter().map(|d| d.name.as_str()).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "two displays share a name: {names:?}");
    }

    #[test]
    fn permission_cache_returns_a_stable_value_within_ttl() {
        let src = ScreenCaptureKitSource::new(CaptureConfig::default());
        let first = src.permission_status();
        let second = src.permission_status();
        assert_eq!(
            first, second,
            "cached permission must not flap within the TTL window"
        );
    }

    #[test]
    fn initialize_without_permission_reports_actionable_error_not_a_panic() {
        let mut src = ScreenCaptureKitSource::new(CaptureConfig::default());
        // On this dev machine Screen Recording is not granted to the test
        // harness process, so this exercises the real permission-denied path.
        if src.permission_status() == PermissionStatus::NotGranted {
            let err = src
                .initialize()
                .expect_err("should report missing permission");
            assert!(err.to_string().contains("Screen Recording"));
        }
    }
}
