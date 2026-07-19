//! Media pipeline + adaptive-bitrate lifecycle, extracted from `run_session`.
//! Previously `pipeline: Option<MediaPipeline>` and `abr: Option<BitrateController>`
//! were two independent locals in the orchestrator, started together inline
//! inside the peer-event `select!` arm and fed RTCP feedback via three more
//! inline `if let` blocks scattered through the same arm. Same behavior,
//! now one owner.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::media::{
    AbrConfig, BitrateController, CaptureMode, EncodedSample, MediaPipeline, PipelineConfig,
};
use crate::rtc::WebRtcPeer;

/// Which capture source a live session uses. Defaults to the real
/// ScreenCaptureKit source — a live session should show the user's actual
/// screen, or a clear permission error, never a silent substitute. The
/// synthetic source stays opt-in (`LILYPAD_CAPTURE_KIND=synthetic`) purely as
/// a developer convenience for exercising the pipeline without granting
/// Screen Recording every time; `PipelineConfig::default()` itself is
/// unaffected and still defaults to Synthetic for the crate's own tests.
fn session_capture_kind() -> crate::media::CaptureKind {
    if std::env::var("LILYPAD_CAPTURE_KIND").as_deref() == Ok("synthetic") {
        return crate::media::CaptureKind::Synthetic;
    }
    // ScreenCaptureKit is macOS-only; Windows Graphics Capture isn't wired yet
    // (M3, tracked separately), so there's no real backend to prefer there.
    #[cfg(target_os = "macos")]
    {
        crate::media::CaptureKind::ScreenCaptureKit
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::media::CaptureKind::Synthetic
    }
}

/// Which encoder a live session uses. VideoToolbox needs no OS permission
/// (unlike ScreenCaptureKit), so unlike capture there's no permission-error
/// tradeoff — real hardware encoding is simply better (lower CPU, lower
/// latency) whenever it's available. `LILYPAD_ENCODER_KIND=software` stays
/// available as a dev override; `PipelineConfig::default()` itself still
/// defaults to Software for the crate's own tests.
fn session_encoder_kind() -> crate::media::EncoderKind {
    if std::env::var("LILYPAD_ENCODER_KIND").as_deref() == Ok("software") {
        return crate::media::EncoderKind::Software;
    }
    #[cfg(target_os = "macos")]
    {
        crate::media::EncoderKind::VideoToolbox
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::media::EncoderKind::Software
    }
}

/// Build a live session's `PipelineConfig` for the given `mode`, matching the
/// real display's resolution/aspect ratio where possible instead of always
/// falling back to a fixed default — a 4K/5K/ultrawide display was previously
/// always downscaled/cropped into a 16:9 buffer regardless of its real aspect
/// ratio, which is both a legibility regression and (per Finding 1's own
/// analysis) compounds into a touch-mapping precision bug on the mobile side.
/// Capture AND encoder settings are updated together so they never disagree
/// about the frame size the running session actually uses. Synthetic/dev-mode
/// capture (and any non-macOS target) falls back to `mode`'s own fixed
/// dimensions — there's no real display to query in that case. See
/// `docs/audit/m3/streaming-media.md` Finding 1 and
/// `docs/audit/m3/prior-art.md` Finding 2 (`Text` mode).
fn resolved_pipeline_config(mode: CaptureMode) -> PipelineConfig {
    let (w, h) = mode.fallback_dimensions();
    let fps = mode.fps();
    let mut config = PipelineConfig {
        capture_kind: session_capture_kind(),
        encoder_kind: session_encoder_kind(),
        capture: crate::media::CaptureConfig {
            width: w,
            height: h,
            fps,
        },
        encoder: crate::media::EncoderSettings {
            width: w,
            height: h,
            fps,
            // Effectively infinite GOP: a live session forces a fresh IDR on
            // demand (viewer PLI/FIR, drop recovery, reconnect) through the
            // pipeline's force-keyframe path, so periodic IDRs would only
            // burn bitrate on giant frames every second and pump quality on
            // static desktop content. See docs/m5-ai-remote-controller.md §3
            // item 2. (~10 min at 30fps; the on-demand path is the real
            // keyframe source.)
            keyframe_interval: fps.saturating_mul(600),
            ..crate::media::EncoderSettings::default()
        },
    };
    apply_real_display_resolution(&mut config, mode);
    config
}

#[cfg(target_os = "macos")]
fn apply_real_display_resolution(config: &mut PipelineConfig, mode: CaptureMode) {
    if matches!(
        config.capture_kind,
        crate::media::CaptureKind::ScreenCaptureKit
    ) {
        if let Some((w, h)) = crate::media::capture::screencapturekit::primary_display_resolution(
            mode.max_capture_long_edge(),
        ) {
            config.capture.width = w;
            config.capture.height = h;
            config.encoder.width = w;
            config.encoder.height = h;
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_real_display_resolution(_config: &mut PipelineConfig, _mode: CaptureMode) {}

/// Owns the capture→encode→RTP pipeline and the adaptive-bitrate controller
/// fed by RTCP receiver feedback for one session.
pub struct MediaController {
    pipeline: Option<MediaPipeline>,
    abr: Option<BitrateController>,
    /// The capture resolution reported by the pipeline once started, so the
    /// session can signal it to the phone (`docs/audit/m3/input-touch.md`
    /// Finding 1). `None` until `start()` succeeds.
    frame_size: Option<(u32, u32)>,
    /// The mode the (running or most recently running) pipeline was built
    /// with. Tracked here rather than re-derived, so `set_mode` knows what
    /// it's switching FROM and a repeat request for the current mode is a
    /// no-op instead of an unnecessary rebuild. See
    /// `docs/audit/m3/prior-art.md` Finding 2.
    mode: CaptureMode,
    media_fail_tx: UnboundedSender<String>,
    media_fail_rx: UnboundedReceiver<String>,
    /// Set by `pause`/`resume` (phone backgrounded, or the user explicitly
    /// paused). Gates the send side only — capture/encode keep running, so
    /// resuming is instant with no re-negotiation. Stopping capture/encode
    /// too (for the fuller CPU/battery win) is a deliberate follow-up, not
    /// done here to avoid touching pipeline internals for this pass.
    paused: Arc<AtomicBool>,
    /// Held while the pipeline runs: a remote session means nobody touches
    /// the Mac, which is exactly when macOS sleeps the display — and a
    /// sleeping display makes the OS stop the capture stream, killing the
    /// session. RAII, so stopping the pipeline always releases it.
    sleep_guard: Option<crate::power::DisplaySleepGuard>,
}

impl MediaController {
    pub fn new() -> Self {
        let (media_fail_tx, media_fail_rx) = mpsc::unbounded_channel::<String>();
        Self {
            pipeline: None,
            abr: None,
            frame_size: None,
            mode: CaptureMode::default(),
            media_fail_tx,
            media_fail_rx,
            paused: Arc::new(AtomicBool::new(false)),
            sleep_guard: None,
        }
    }

    /// Stop (or resume) sending encoded samples to the peer without tearing
    /// down capture/encode or the WebRTC track — backs the protocol's
    /// `pause`/`resume` messages (phone backgrounded / foregrounded).
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
    }

    pub fn is_started(&self) -> bool {
        self.pipeline.is_some()
    }

    /// The mode the running pipeline was built with (`CaptureMode::Motion`
    /// before the first `start()`).
    pub fn mode(&self) -> CaptureMode {
        self.mode
    }

    /// Start the media pipeline and spawn a task draining encoded samples
    /// onto the peer's video track. A failure reported later via
    /// `poll_failure` (capture stall, encoder failure) means the pipeline
    /// died unexpectedly rather than being stopped — the caller should end
    /// the session rather than leave the viewer on a stale frame while input
    /// stays live.
    pub async fn start(&mut self, peer: Arc<WebRtcPeer>) -> Result<()> {
        self.start_with_mode(peer, self.mode).await
    }

    /// Switch capture/encode mode mid-session. Unlike bitrate (a true
    /// live-tunable, `PipelineControl::set_target_bitrate`), a resolution
    /// change forces a full capture+encoder rebuild — there's no live-resize
    /// path on either the capture backend or either encoder backend, and the
    /// audit's own Tradeoffs section accepts a brief visible glitch during
    /// the switch as the cost of reusing the existing, proven stop/start
    /// machinery instead of building new in-place resize plumbing across
    /// three backends that have never been tested for it. A no-op if already
    /// running in the requested mode. See `docs/audit/m3/prior-art.md`
    /// Finding 2.
    pub async fn set_mode(&mut self, mode: CaptureMode, peer: Arc<WebRtcPeer>) -> Result<()> {
        if mode == self.mode && self.pipeline.is_some() {
            return Ok(());
        }
        self.stop_pipeline().await;
        self.start_with_mode(peer, mode).await
    }

    async fn start_with_mode(&mut self, peer: Arc<WebRtcPeer>, mode: CaptureMode) -> Result<()> {
        let config = resolved_pipeline_config(mode);
        let fps = config.capture.fps.max(1);
        let frame_dur = Duration::from_secs_f64(1.0 / fps as f64);

        // Bounded queue, kept shallow on purpose: every queued sample is
        // latency the viewer sees. 2 frames ≈ 66ms worst-case at 30fps —
        // absorbs single-send jitter while keeping worst-case queue latency
        // near one frame interval (bring-up feedback: perceived lag on LAN;
        // dropping 4 → 2 shaves ~66ms off the worst case). On overflow the
        // pipeline drops the frame and forces an IDR so the stream recovers
        // immediately instead of smearing until the next periodic keyframe.
        let (tx, mut rx) = mpsc::channel::<EncodedSample>(2);
        // MediaPipeline::start does the capture bring-up synchronously —
        // ScreenCaptureKit's SCShareableContent::get / stream start and the
        // VideoToolbox session build are blocking XPC/kernel round-trips
        // (100ms+). Run it on the blocking pool so it never stalls a tokio
        // worker.
        let pipeline = tokio::task::spawn_blocking(move || MediaPipeline::start(config, tx))
            .await
            .map_err(|e| anyhow::anyhow!("pipeline start task panicked: {e}"))??;
        let stop_flag = pipeline.stop_flag();

        let media_fail_tx = self.media_fail_tx.clone();
        let paused = Arc::clone(&self.paused);
        let control = pipeline.control();
        tokio::spawn(async move {
            // RTP timestamps advance by each sample's DURATION — stamping a
            // fixed 1/fps regardless of real inter-frame spacing makes the
            // RTP clock fall behind wall time whenever capture delivers
            // slower than nominal fps (ScreenCaptureKit is change-driven: a
            // quiet screen ships keepalives seconds apart). The receiver's
            // jitter buffer then renders ever further behind real time —
            // observed on-device as "the Mac did it, the phone shows it
            // late". Stamp the real gap between capture timestamps instead.
            let mut last_ts: Option<Duration> = None;
            // A failed send is a NETWORK condition (path migration, ICE
            // restart in flight — e.g. "No route to host" the instant the
            // radio path flips), not a pipeline failure. The session's
            // recovery machinery owns connection life/death; breaking out
            // here used to masquerade as "pipeline stopped unexpectedly"
            // and tear down a session that ICE restart was about to save.
            // Drop frames while the path is down, keep draining, and force
            // a fresh IDR once sends succeed again so the viewer doesn't
            // smear on delta frames whose references never arrived.
            let mut dropped_sends: u64 = 0;
            while let Some(sample) = rx.recv().await {
                if paused.load(Ordering::Relaxed) {
                    continue; // drop the frame — capture/encode still run, we just don't send
                }
                let dur = match last_ts {
                    Some(prev) if sample.timestamp > prev => sample.timestamp - prev,
                    _ => frame_dur,
                };
                last_ts = Some(sample.timestamp);
                match peer.send_video_sample(sample.data, dur).await {
                    Ok(()) => {
                        if dropped_sends > 0 {
                            log::info!(target: "lilypad::media",
                                "video send recovered after {dropped_sends} dropped frame(s) — forcing IDR");
                            control.request_keyframe();
                            dropped_sends = 0;
                        }
                    }
                    Err(e) => {
                        if dropped_sends == 0 {
                            log::warn!(target: "lilypad::media",
                                "send_video_sample failed — dropping frames until the path recovers: {e}");
                        }
                        dropped_sends += 1;
                    }
                }
            }
            // The sample channel closed. If we didn't ask the pipeline to
            // stop, its capture/encode thread died on its own — surface it
            // so the session tears down rather than leaving a frozen stream
            // with live input.
            if !stop_flag.load(Ordering::Relaxed) {
                let _ = media_fail_tx.send(
                    "media pipeline stopped unexpectedly (capture or encoder failure)".to_owned(),
                );
            }
        });

        log::info!(target: "lilypad::media", "streaming started ({} mode)", mode.as_str());
        let initial_kbps = pipeline.metrics().snapshot().bitrate_kbps as u32;
        self.abr = Some(BitrateController::new(initial_kbps, AbrConfig::default()));
        self.frame_size = Some(pipeline.frame_size());
        self.mode = mode;
        self.pipeline = Some(pipeline);
        self.sleep_guard = Some(crate::power::DisplaySleepGuard::new());
        Ok(())
    }

    /// The capture resolution (width, height) once the pipeline has started,
    /// for the session to signal to the phone. `None` before `start()`.
    pub fn frame_size(&self) -> Option<(u32, u32)> {
        self.frame_size
    }

    pub fn on_loss_report(&mut self, fraction_lost: f64) {
        if let (Some(pl), Some(ctl)) = (&self.pipeline, &mut self.abr) {
            if let Some(kbps) = ctl.on_loss_report(fraction_lost, Instant::now()) {
                pl.control().set_target_bitrate(kbps);
            }
        }
    }

    pub fn on_remb(&mut self, bitrate_bps: u64) {
        if let (Some(pl), Some(ctl)) = (&self.pipeline, &mut self.abr) {
            if let Some(kbps) = ctl.on_remb(bitrate_bps) {
                pl.control().set_target_bitrate(kbps);
            }
        }
    }

    pub fn request_keyframe(&self) {
        if let Some(pl) = &self.pipeline {
            pl.control().request_keyframe();
        }
    }

    /// Await the next unexpected pipeline failure. Pends forever until the
    /// background sample-drain task (spawned by `start`) reports one —
    /// mirrors the original bare `media_fail_rx.recv()` select arm, which
    /// behaved identically whether or not the pipeline had started yet.
    pub async fn poll_failure(&mut self) -> Option<String> {
        self.media_fail_rx.recv().await
    }

    /// Stop the running pipeline (if any), joining its capture/encode thread,
    /// without consuming `self` — shared by `set_mode` (which restarts right
    /// after) and `stop` (which doesn't). That join can park up to the
    /// capture frame-wait timeout (~2s) — callers are expected to have
    /// already run this off the async runtime worker's fast path (it
    /// internally uses `spawn_blocking`).
    async fn stop_pipeline(&mut self) {
        if let Some(pl) = self.pipeline.take() {
            let _ = tokio::task::spawn_blocking(move || {
                let mut pl = pl;
                pl.stop();
            })
            .await;
        }
        self.abr = None;
        self.frame_size = None;
        self.sleep_guard = None; // drop → releases the IOPM assertion
    }

    /// Stop the pipeline (if started) and consume the controller — the
    /// session-teardown path. See `stop_pipeline` for the reusable half.
    pub async fn stop(mut self) {
        self.stop_pipeline().await;
    }
}

impl Default for MediaController {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // `LILYPAD_CAPTURE_KIND` is process-global and `cargo test` runs lib
    // tests on multiple threads by default, so any test touching it must
    // serialize against any other that reads or sets it concurrently. No
    // other lib test touches this var today, but this guard is cheap
    // insurance against a future one introducing a flaky race — every test
    // below acquires it, including the one that only reads.
    static CAPTURE_KIND_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn resolved_pipeline_config_never_disagrees_between_capture_and_encoder() {
        let _guard = CAPTURE_KIND_ENV_LOCK.lock().unwrap();
        // Whichever path was taken — a real display successfully queried, or
        // the fallback default (e.g. Screen Recording not granted to this
        // test process, or a non-macOS target) — capture and encoder
        // dimensions must always agree and stay even (H.264/I420's
        // requirement). A mismatch here is exactly the real bug this change
        // guards against: the encoder session built for one size fed frames
        // of another. See docs/audit/m3/streaming-media.md Finding 1.
        for mode in [CaptureMode::Motion, CaptureMode::Text] {
            let config = resolved_pipeline_config(mode);
            assert_eq!(config.capture.width, config.encoder.width);
            assert_eq!(config.capture.height, config.encoder.height);
            assert_eq!(config.capture.width % 2, 0);
            assert_eq!(config.capture.height % 2, 0);
            assert_eq!(config.capture.fps, mode.fps());
            assert_eq!(config.encoder.fps, mode.fps());
        }
    }

    #[test]
    fn synthetic_capture_kind_is_never_overridden_with_a_real_display_resolution() {
        let _guard = CAPTURE_KIND_ENV_LOCK.lock().unwrap();
        std::env::set_var("LILYPAD_CAPTURE_KIND", "synthetic");
        let config = resolved_pipeline_config(CaptureMode::Motion);
        std::env::remove_var("LILYPAD_CAPTURE_KIND");
        assert_eq!(config.capture_kind, crate::media::CaptureKind::Synthetic);
        // The synthetic dev path has no real display to query — dimensions
        // stay exactly Motion mode's stable 1280x720 fixture, which the
        // crate's own tests rely on.
        assert_eq!((config.capture.width, config.capture.height), (1280, 720));
        assert_eq!((config.encoder.width, config.encoder.height), (1280, 720));
    }

    #[test]
    fn synthetic_text_mode_falls_back_to_the_literal_1080p_fixture() {
        let _guard = CAPTURE_KIND_ENV_LOCK.lock().unwrap();
        std::env::set_var("LILYPAD_CAPTURE_KIND", "synthetic");
        let config = resolved_pipeline_config(CaptureMode::Text);
        std::env::remove_var("LILYPAD_CAPTURE_KIND");
        // No real display to query — Text mode's own fallback (the literal
        // "1080p" the design doc promised) applies instead of Motion's.
        assert_eq!((config.capture.width, config.capture.height), (1920, 1080));
        assert_eq!((config.encoder.width, config.encoder.height), (1920, 1080));
        assert_eq!(config.capture.fps, 15);
    }
}
