//! Media pipeline orchestrator.
//!
//!   CaptureBackend → BGRA → convert → I420 → VideoEncoder → EncodedSample
//!     → bounded queue (drop-oldest-on-full) → WebRTC track
//!
//! The capture+encode loop runs on a dedicated OS thread (CPU-bound work must
//! not block the tokio runtime), paced to the source's fps, and pushes samples
//! to a bounded `tokio::mpsc` the consumer drains onto the video track.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::Result;
use tokio::sync::mpsc::{error::TrySendError, Sender};

use super::capture::{create_capture, CaptureConfig, CaptureKind};
use super::encoder::{create_encoder, EncodedSample, EncoderKind, EncoderSettings};
use super::metrics::PipelineMetrics;

/// Minimum spacing between `encoder.set_bitrate` calls. A burst of RTCP
/// receiver reports/REMB updates arriving close together (e.g. all describing
/// the same network event) would otherwise retarget the encoder once per
/// report — for the software (openh264) backend, which still rebuilds its
/// session on every retarget, that means an IDR storm from a single
/// congestion event. The bounded queue only holds a handful of frames
/// (`session::MediaController::start`'s doc comment), so IDR storms are
/// exactly what risks overflowing it. See
/// `docs/audit/m3/streaming-media.md` Finding 2, redesign item 4.
const BITRATE_RETARGET_DEBOUNCE: Duration = Duration::from_millis(250);

/// A persistent encoder failure (every `encode()` call errors, but `reset()`
/// itself keeps "succeeding") previously spun the pipeline resetting the
/// encoder on every single frame forever — burning CPU, repeatedly paying a
/// session-rebuild cost, and never surfacing an error while the viewer sees
/// an indefinitely frozen stream on a session that still reads "connected".
/// Once consecutive encode errors exceed this, the loop escalates to the
/// same fatal `break` path a capture failure already uses, letting
/// `session.rs`'s existing crash-detection end the session cleanly. See
/// `docs/audit/m3/streaming-media.md` Finding 14.
const MAX_CONSECUTIVE_ENCODE_ERRORS: u32 = 5;

/// Pure decision extracted from the encode loop, mirroring
/// `bitrate_retarget_due`'s pattern, so the threshold itself is directly
/// unit-testable independent of the background thread.
fn encode_error_budget_exhausted(consecutive_errors: u32) -> bool {
    consecutive_errors >= MAX_CONSECUTIVE_ENCODE_ERRORS
}

/// Windowed-metrics cadence, in seconds of stream time — matches the
/// "trailing 60 seconds" granularity `docs/audit/m3/testing-reliability.md`
/// Finding 7 asks for. Frame-count-based (via `fps`), not a wall-clock
/// timer, so window boundaries stay deterministic under test.
const METRICS_WINDOW_SECS: u64 = 60;

/// Pure decision extracted from the encode loop so the debounce logic itself
/// is directly unit-testable, independent of the background thread's timing.
fn bitrate_retarget_due(last_retarget: Option<Instant>, now: Instant) -> bool {
    match last_retarget {
        Some(t) => now.duration_since(t) >= BITRATE_RETARGET_DEBOUNCE,
        None => true,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PipelineConfig {
    pub capture_kind: CaptureKind,
    pub encoder_kind: EncoderKind,
    pub capture: CaptureConfig,
    pub encoder: EncoderSettings,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            capture_kind: CaptureKind::Synthetic,
            encoder_kind: EncoderKind::Software,
            capture: CaptureConfig::default(),
            encoder: EncoderSettings::default(),
        }
    }
}

/// Live-tunable controls the session owner adjusts mid-stream; the encode loop
/// applies changes between frames (never mid-encode).
pub struct PipelineControl {
    target_bitrate_kbps: AtomicU32,
    keyframe_request: AtomicBool,
}

impl PipelineControl {
    /// Retarget the encoder bitrate (adaptive bitrate — driven by RTCP
    /// receiver feedback). Applied before the next frame.
    pub fn set_target_bitrate(&self, kbps: u32) {
        self.target_bitrate_kbps
            .store(kbps.max(1), Ordering::Relaxed);
    }

    /// Force an IDR on the next frame (viewer sent PLI/FIR — its decoder
    /// needs a new reference frame *now*, not at the next periodic keyframe).
    pub fn request_keyframe(&self) {
        self.keyframe_request.store(true, Ordering::Relaxed);
    }
}

pub struct MediaPipeline {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    metrics: Arc<PipelineMetrics>,
    control: Arc<PipelineControl>,
    /// The capture source's actual pixel resolution (width, height), read
    /// from the backend after `start()`. The phone needs this to map touches
    /// onto the letterboxed video content rect rather than the whole view —
    /// see `docs/audit/m3/input-touch.md` Finding 1. It reflects the real
    /// captured dimensions, so it's correct even while the capture resolution
    /// itself is still a fixed default (that's Finding/Phase-5 item 8).
    resolution: (u32, u32),
}

impl MediaPipeline {
    /// Build the capture + encoder, then run the loop feeding `sample_tx`.
    pub fn start(config: PipelineConfig, sample_tx: Sender<EncodedSample>) -> Result<Self> {
        let mut capture = create_capture(config.capture_kind, config.capture);
        capture.initialize()?;
        capture.start()?;
        let resolution = capture.resolution();
        let mut encoder = create_encoder(config.encoder_kind, config.encoder)?;

        let fps = capture.fps().max(1);
        let frame_interval = Duration::from_secs_f64(1.0 / fps as f64);
        // Push sources (ScreenCaptureKit) block in next_frame() until the OS
        // delivers the next frame — adding sleep-pacing on top would let each
        // fresh frame age up to a full frame interval before encoding.
        let self_paced = capture.provides_pacing();

        let metrics = Arc::new(PipelineMetrics::default());
        let stop = Arc::new(AtomicBool::new(false));
        let control = Arc::new(PipelineControl {
            target_bitrate_kbps: AtomicU32::new(config.encoder.bitrate_kbps),
            keyframe_request: AtomicBool::new(false),
        });

        let m = Arc::clone(&metrics);
        let s = Arc::clone(&stop);
        let c = Arc::clone(&control);

        let handle = std::thread::Builder::new()
            .name("lilypad-media".into())
            .spawn(move || {
                let mut frame_no: u64 = 0;
                let mut next_tick = Instant::now();
                let log_every = fps as u64; // ~1s
                let window_every = (fps as u64 * METRICS_WINDOW_SECS).max(1);
                // Set when a sample was dropped on a full queue: the receiver
                // is now missing a reference frame, so deltas would smear until
                // a fresh IDR resyncs it. We OWE the receiver that keyframe, but
                // WHEN we spend it is the whole game on a constrained path — see
                // `last_recovery_keyframe` below.
                let mut recover_with_keyframe = false;
                // Recovery-keyframe discipline. A keyframe is the LARGEST frame
                // the encoder emits, so forcing one into a still-full send queue
                // is the worst possible move: it can't fit, it's dropped, that
                // re-arms `recover_with_keyframe`, and every following frame
                // becomes another forced IDR — a keyframe storm that freezes the
                // stream for the entire duration of any motion. This is the
                // "any touch destabilizes the connection" failure on cellular.
                // So we only actually FORCE the owed keyframe once the queue has
                // drained enough to carry it, and no more than once per spacing
                // window. While congested we keep shipping cheap delta frames (a
                // brief smear) and let the congestion cap shrink them until they
                // fit — then a single IDR resyncs cleanly. `None` = none forced
                // yet this episode.
                let mut last_recovery_keyframe: Option<Instant> = None;
                const RECOVERY_KEYFRAME_MIN_SPACING: Duration = Duration::from_millis(500);
                let mut current_bitrate = config.encoder.bitrate_kbps;
                let mut last_bitrate_retarget: Option<Instant> = None;
                let mut consecutive_encode_errors: u32 = 0;
                // A stopped capture stream (display reconfiguration, GPU
                // hiccup, "stopped by the system") is often recoverable by
                // simply starting a fresh stream — ending the whole session
                // on the first stop is needlessly fatal. Bounded so a
                // genuinely broken source (permission revoked, display gone)
                // still fails fast instead of freeze-looping.
                let mut capture_restarts: u32 = 0;
                const MAX_CAPTURE_RESTARTS: u32 = 3;
                // The budget guards against a freeze-LOOP, not against a long
                // session: macOS legitimately stops the stream on display
                // reconfiguration (fullscreen video, resolution change) every
                // so often, and without a reset a multi-hour session slowly
                // consumes its 3 restarts and then dies on an event it had
                // recovered from many times before (observed live: 2/3 spent
                // in the first minutes of a session). A sustained healthy
                // period proves the source is fine — re-arm the full budget.
                let mut last_capture_failure: Option<Instant> = None;
                const CAPTURE_HEALTH_RESET: Duration = Duration::from_secs(60);

                // Pipeline-side congestion control. A full sample queue is the
                // ONLY reliable "the network can't keep up" signal on a
                // constrained path: when the send side backs up, the phone's
                // RTCP (REMB/loss) is delayed or dropped too, so the ABR — which
                // reacts to RTCP — goes blind exactly when it's needed. Observed
                // live (2026-07-19, cellular): the ABR probed to ~4.4 Mbps, the
                // queue overflowed, RTCP starved for >12s, ICE falsely reported
                // `failed`, and a restart fired — on a ~18s cycle that reads as
                // constant "connecting → connected" churn. So the pipeline
                // caps its OWN bitrate immediately on overflow (independent of
                // the ABR), then relaxes the cap gradually once the queue stays
                // healthy — a fast AIMD on the one signal that survives
                // congestion. `None` = no cap; the ABR target applies as-is.
                let mut congestion_cap: Option<u32> = None;
                let mut last_congestion_cut: Option<Instant> = None;
                let mut last_congestion_relax: Option<Instant> = None;
                const CONGESTION_FLOOR_KBPS: u32 = 800;
                const CONGESTION_CUT: f64 = 0.75; // ×0.75 per overflow burst
                const CONGESTION_CUT_INTERVAL: Duration = Duration::from_millis(700);
                const CONGESTION_RELAX_STEP: f64 = 1.20; // ×1.20 per healthy tick
                const CONGESTION_RELAX_INTERVAL: Duration = Duration::from_secs(3);

                while !s.load(Ordering::Relaxed) {
                    // Gradually lift the congestion cap after a healthy spell so
                    // quality recovers once the path improves; clear it entirely
                    // once it catches up to what the ABR wants.
                    if let Some(cap) = congestion_cap {
                        let want = c.target_bitrate_kbps.load(Ordering::Relaxed);
                        let healthy = last_congestion_cut
                            .is_none_or(|t| t.elapsed() >= CONGESTION_RELAX_INTERVAL);
                        let relax_due = last_congestion_relax
                            .is_none_or(|t| t.elapsed() >= CONGESTION_RELAX_INTERVAL);
                        if healthy && relax_due {
                            let raised = ((cap as f64 * CONGESTION_RELAX_STEP) as u32).max(cap + 1);
                            if raised >= want {
                                congestion_cap = None; // caught up — hand control back to the ABR
                            } else {
                                congestion_cap = Some(raised);
                            }
                            last_congestion_relax = Some(Instant::now());
                        }
                    }

                    // Apply live control changes between frames, debounced so a
                    // burst of ABR updates collapses to at most one retarget per
                    // window instead of one per report.
                    // Effective target = ABR's wish, clamped by any active
                    // congestion cap (the pipeline's fast defense).
                    let want_bitrate = c
                        .target_bitrate_kbps
                        .load(Ordering::Relaxed)
                        .min(congestion_cap.unwrap_or(u32::MAX));
                    if want_bitrate != current_bitrate
                        && bitrate_retarget_due(last_bitrate_retarget, Instant::now())
                    {
                        match encoder.set_bitrate(want_bitrate) {
                            Ok(()) => {
                                log::info!(target: "lilypad::media", "bitrate retargeted {current_bitrate} → {want_bitrate} kbps");
                                current_bitrate = want_bitrate;
                                last_bitrate_retarget = Some(Instant::now());
                                m.bitrate_kbps.store(want_bitrate as u64, Ordering::Relaxed);
                            }
                            Err(e) => log::warn!(target: "lilypad::media", "set_bitrate({want_bitrate}) failed: {e}"),
                        }
                    }
                    let keyframe_requested = c.keyframe_request.swap(false, Ordering::Relaxed);
                    if keyframe_requested {
                        log::info!(target: "lilypad::media", "viewer requested keyframe (PLI/FIR) — forcing IDR");
                    }

                    let t0 = Instant::now();
                    let raw = match capture.next_frame() {
                        Ok(f) => {
                            if capture_restarts > 0
                                && last_capture_failure
                                    .is_some_and(|t| t.elapsed() >= CAPTURE_HEALTH_RESET)
                            {
                                log::info!(
                                    target: "lilypad::media",
                                    "capture healthy for {}s — restart budget re-armed",
                                    CAPTURE_HEALTH_RESET.as_secs()
                                );
                                capture_restarts = 0;
                                last_capture_failure = None;
                            }
                            f
                        }
                        Err(e) => {
                            log::error!(target: "lilypad::media", "capture failed: {e}");
                            last_capture_failure = Some(Instant::now());
                            if capture_restarts >= MAX_CAPTURE_RESTARTS {
                                break;
                            }
                            capture_restarts += 1;
                            std::thread::sleep(Duration::from_millis(
                                300u64 << (capture_restarts - 1),
                            ));
                            if s.load(Ordering::Relaxed) {
                                break;
                            }
                            match capture.start() {
                                Ok(()) => {
                                    log::warn!(
                                        target: "lilypad::media",
                                        "capture restarted after failure (attempt {capture_restarts}/{MAX_CAPTURE_RESTARTS})"
                                    );
                                    // The receiver lost continuity — resync
                                    // with an IDR on the next encoded frame.
                                    recover_with_keyframe = true;
                                    continue;
                                }
                                Err(restart_err) => {
                                    log::error!(target: "lilypad::media", "capture restart failed: {restart_err}");
                                    break;
                                }
                            }
                        }
                    };
                    m.frames_captured.fetch_add(1, Ordering::Relaxed);
                    m.capture_us_total
                        .fetch_add(t0.elapsed().as_micros() as u64, Ordering::Relaxed);

                    let t1 = Instant::now();
                    // Periodic GOP keyframes are the ENCODER's job (openh264
                    // counts frames internally; VideoToolbox enforces
                    // max_keyframe_interval in-session). Forcing them here too
                    // was redundant for openh264 and made VideoToolbox rebuild
                    // its whole session every interval (~1/s) — force only the
                    // cases the encoder can't know about: first frame, drop
                    // recovery, and viewer PLI/FIR.
                    //
                    // Drop-recovery is gated: only spend the owed IDR when the
                    // send queue has room to carry it (`capacity() > 0`) and the
                    // spacing window has elapsed — otherwise a big frame just
                    // re-congests a full queue and spirals into a keyframe storm
                    // (see `last_recovery_keyframe`). Viewer PLI/FIR and the
                    // first frame are always honored: those aren't congestion,
                    // they're the receiver explicitly asking, or session start.
                    let queue_has_room = sample_tx.capacity() > 0;
                    let recovery_due = last_recovery_keyframe
                        .is_none_or(|t| t.elapsed() >= RECOVERY_KEYFRAME_MIN_SPACING);
                    let force_recovery = recover_with_keyframe && queue_has_room && recovery_due;
                    let force_kf = frame_no == 0 || force_recovery || keyframe_requested;
                    if force_recovery {
                        last_recovery_keyframe = Some(Instant::now());
                    }
                    match encoder.encode(&raw, force_kf) {
                        Ok(Some(sample)) => {
                            consecutive_encode_errors = 0;
                            m.frames_encoded.fetch_add(1, Ordering::Relaxed);
                            m.encode_us_total
                                .fetch_add(t1.elapsed().as_micros() as u64, Ordering::Relaxed);
                            m.bytes_encoded
                                .fetch_add(sample.data.len() as u64, Ordering::Relaxed);
                            if sample.is_keyframe {
                                m.keyframes.fetch_add(1, Ordering::Relaxed);
                                m.keyframe_bytes_total
                                    .fetch_add(sample.data.len() as u64, Ordering::Relaxed);
                            } else {
                                m.delta_bytes_total
                                    .fetch_add(sample.data.len() as u64, Ordering::Relaxed);
                            }
                            let sent_keyframe = sample.is_keyframe;
                            match sample_tx.try_send(sample) {
                                Ok(()) => {
                                    // Clear the owed-keyframe debt only when an
                                    // actual IDR reached the wire — a delta that
                                    // happens to fit does NOT give the receiver
                                    // the fresh reference it's missing, so
                                    // clearing on any send would leave it
                                    // smearing on frames whose references never
                                    // arrived.
                                    if sent_keyframe {
                                        recover_with_keyframe = false;
                                    }
                                    m.record_latency(raw.captured_at.elapsed().as_micros() as u64);
                                }
                                Err(TrySendError::Full(_)) => {
                                    // Backpressure: consumer (network) is behind — drop,
                                    // and recover with an IDR once there's room again.
                                    recover_with_keyframe = true;
                                    m.frames_dropped.fetch_add(1, Ordering::Relaxed);
                                    log::warn!(target: "lilypad::media", "sample queue full — dropping frame {frame_no}");
                                    // Immediate congestion backoff (rate-limited
                                    // so a burst of drops is one cut, not many).
                                    // This is the fast defense the ABR can't
                                    // provide when RTCP is starved.
                                    if last_congestion_cut
                                        .is_none_or(|t| t.elapsed() >= CONGESTION_CUT_INTERVAL)
                                    {
                                        let base = congestion_cap.unwrap_or(current_bitrate);
                                        let cut = ((base as f64 * CONGESTION_CUT) as u32)
                                            .max(CONGESTION_FLOOR_KBPS);
                                        congestion_cap = Some(cut);
                                        last_congestion_cut = Some(Instant::now());
                                        last_congestion_relax = Some(Instant::now());
                                        log::info!(
                                            target: "lilypad::media",
                                            "queue overflow — congestion cap → {cut} kbps"
                                        );
                                    }
                                }
                                Err(TrySendError::Closed(_)) => break, // consumer gone
                            }
                            let depth = (sample_tx.max_capacity() - sample_tx.capacity()) as u64;
                            m.queue_depth.store(depth, Ordering::Relaxed);
                        }
                        Ok(None) => {
                            consecutive_encode_errors = 0;
                        }
                        Err(e) => {
                            consecutive_encode_errors += 1;
                            if encode_error_budget_exhausted(consecutive_encode_errors) {
                                log::error!(target: "lilypad::media", "encode failed {consecutive_encode_errors} times in a row ({e}) — giving up");
                                break;
                            }
                            // Error recovery: reset the encoder and continue.
                            log::error!(target: "lilypad::media", "encode failed: {e} — resetting encoder ({consecutive_encode_errors}/{MAX_CONSECUTIVE_ENCODE_ERRORS})");
                            if let Err(re) = encoder.reset() {
                                log::error!(target: "lilypad::media", "encoder reset failed: {re}");
                                break;
                            }
                        }
                    }

                    frame_no += 1;
                    if frame_no % log_every == 0 {
                        let snap = m.snapshot();
                        log::info!(target: "lilypad::media", "media {:?}", snap);
                    }
                    if frame_no % window_every == 0 {
                        m.swap_window();
                    }

                    // Pace pull sources to fps without drift; push sources are
                    // already paced by the OS inside next_frame().
                    if !self_paced {
                        next_tick += frame_interval;
                        let now = Instant::now();
                        if next_tick > now {
                            std::thread::sleep(next_tick - now);
                        } else {
                            next_tick = now; // fell behind; reset cadence
                        }
                    }
                }

                let _ = capture.stop();
                let _ = capture.shutdown();
                log::info!(target: "lilypad::media", "media pipeline stopped: {:?}", m.snapshot());
            })?;

        metrics
            .bitrate_kbps
            .store(config.encoder.bitrate_kbps as u64, Ordering::Relaxed);

        Ok(Self {
            stop,
            handle: Some(handle),
            metrics,
            control,
            resolution,
        })
    }

    pub fn metrics(&self) -> Arc<PipelineMetrics> {
        Arc::clone(&self.metrics)
    }

    /// The capture source's actual (width, height) in pixels — signaled to
    /// the phone so its touch-coordinate mapping accounts for letterboxing
    /// (`docs/audit/m3/input-touch.md` Finding 1).
    pub fn frame_size(&self) -> (u32, u32) {
        self.resolution
    }

    /// Handle for live mid-stream adjustments (adaptive bitrate, PLI keyframes).
    pub fn control(&self) -> Arc<PipelineControl> {
        Arc::clone(&self.control)
    }

    /// Shared stop flag, so a consumer draining the sample channel can tell an
    /// intentional `stop()` from an unexpected pipeline death (capture stall,
    /// encoder failure). Set true only by `stop()`.
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop)
    }

    /// Whether `stop()` has been requested (for tests / crash detection).
    pub fn stop_requested(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for MediaPipeline {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitrate_retarget_is_due_immediately_with_no_prior_retarget() {
        assert!(bitrate_retarget_due(None, Instant::now()));
    }

    #[test]
    fn bitrate_retarget_is_not_due_within_the_debounce_window() {
        let last = Instant::now();
        let now = last + Duration::from_millis(100);
        assert!(!bitrate_retarget_due(Some(last), now));
    }

    #[test]
    fn bitrate_retarget_is_due_again_once_the_window_elapses() {
        let last = Instant::now();
        let now = last + BITRATE_RETARGET_DEBOUNCE;
        assert!(bitrate_retarget_due(Some(last), now));
    }

    #[test]
    fn a_burst_of_rapid_changes_collapses_to_a_single_retarget() {
        // Simulates several RTCP-driven retarget requests arriving within one
        // debounce window — only the first should be "due"; the rest must
        // wait, exactly the IDR-storm-prevention property Finding 2 asks for.
        let t0 = Instant::now();
        let mut last_retarget: Option<Instant> = None;
        let mut applied = 0;
        for i in 0..5u32 {
            let now = t0 + Duration::from_millis(u64::from(i) * 40); // 0,40,80,120,160ms
            if bitrate_retarget_due(last_retarget, now) {
                applied += 1;
                last_retarget = Some(now);
            }
        }
        assert_eq!(
            applied, 1,
            "only the first retarget in the burst should apply within the debounce window"
        );
    }

    #[test]
    fn encode_error_budget_is_not_exhausted_below_the_threshold() {
        for n in 0..MAX_CONSECUTIVE_ENCODE_ERRORS {
            assert!(!encode_error_budget_exhausted(n), "n={n}");
        }
    }

    #[test]
    fn encode_error_budget_is_exhausted_at_and_beyond_the_threshold() {
        assert!(encode_error_budget_exhausted(MAX_CONSECUTIVE_ENCODE_ERRORS));
        assert!(encode_error_budget_exhausted(
            MAX_CONSECUTIVE_ENCODE_ERRORS + 1
        ));
    }
}
