//! Pipeline metrics — lock-free counters + a serializable snapshot for logging
//! and the debug overlay.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

#[derive(Default)]
pub struct PipelineMetrics {
    pub frames_captured: AtomicU64,
    pub frames_encoded: AtomicU64,
    pub frames_dropped: AtomicU64,
    pub keyframes: AtomicU64,
    pub bytes_encoded: AtomicU64,
    /// `bytes_encoded` split by frame type — a single blended
    /// `avg_frame_bytes` can't distinguish "bandwidth spike from frequent
    /// large keyframes" (an IDR-storm bug, e.g. Finding 2) from "genuinely
    /// high-detail content" (an unavoidable characteristic), which is
    /// exactly the distinction needed to confirm an IDR-storm fix worked.
    /// See `docs/audit/m3/streaming-media.md` Finding 16.
    pub keyframe_bytes_total: AtomicU64,
    pub delta_bytes_total: AtomicU64,
    pub capture_us_total: AtomicU64,
    pub encode_us_total: AtomicU64,
    /// End-to-end frame age (capture instant → sample queued): staleness in
    /// the latest-frame slot + encode time. The desktop-side latency budget.
    pub latency_us_total: AtomicU64,
    pub latency_us_max: AtomicU64,
    pub queue_depth: AtomicU64,
    /// Current encoder target bitrate (kbps) — moves with adaptive bitrate.
    pub bitrate_kbps: AtomicU64,
    /// Latency total/count for the CURRENT windowed period only — reset by
    /// `swap_window`. Kept separate from `latency_us_total`/`frames_encoded`
    /// (which stay lifetime-cumulative, unchanged) because a lifetime
    /// average over a multi-hour session dilutes a late-session regression
    /// (e.g. thermal throttling in hour 20) into invisibility — comparing
    /// window N to window 1 is the only way to see it. See
    /// `docs/audit/m3/testing-reliability.md` Finding 7.
    window_latency_us: AtomicU64,
    window_frame_count: AtomicU64,
    /// The most recently COMPLETED window's average latency — never a
    /// still-accumulating partial window, matching how rate-style metrics
    /// are conventionally reported.
    prev_window_avg_latency_us: AtomicU64,
}

impl PipelineMetrics {
    /// Record one frame's capture→queued latency.
    pub fn record_latency(&self, us: u64) {
        self.latency_us_total.fetch_add(us, Ordering::Relaxed);
        self.latency_us_max.fetch_max(us, Ordering::Relaxed);
        self.window_latency_us.fetch_add(us, Ordering::Relaxed);
        self.window_frame_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Roll the current window into "previous" and start a fresh one.
    /// Called by the encode loop on a frame-count cadence (not wall-clock —
    /// deterministic and testable) roughly every `WINDOW_FRAMES` frames.
    pub fn swap_window(&self) {
        let us = self.window_latency_us.swap(0, Ordering::Relaxed);
        let n = self.window_frame_count.swap(0, Ordering::Relaxed);
        let avg = us.checked_div(n).unwrap_or(0);
        self.prev_window_avg_latency_us
            .store(avg, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricsSnapshot {
    pub frames_captured: u64,
    pub frames_encoded: u64,
    pub frames_dropped: u64,
    pub keyframes: u64,
    pub bytes_encoded: u64,
    pub avg_capture_ms: f64,
    pub avg_encode_ms: f64,
    /// Avg / worst capture→queued frame age (see `latency_us_total`).
    pub avg_latency_ms: f64,
    pub max_latency_ms: f64,
    /// The most recently completed window's average latency — see
    /// `PipelineMetrics::swap_window`. `0.0` until the first window
    /// completes (a session shorter than one window never gets one, and
    /// reads as the lifetime average via `avg_latency_ms` instead).
    pub windowed_avg_latency_ms: f64,
    pub queue_depth: u64,
    pub bitrate_kbps: u64,
    /// Approximate encoded bitrate over the run (kbps), given a frame count/fps.
    pub avg_frame_bytes: u64,
    /// `0.0` until at least one keyframe has been encoded.
    pub avg_keyframe_bytes: f64,
    /// `0.0` until at least one delta frame has been encoded.
    pub avg_delta_bytes: f64,
}

impl PipelineMetrics {
    pub fn snapshot(&self) -> MetricsSnapshot {
        let captured = self.frames_captured.load(Ordering::Relaxed);
        let encoded = self.frames_encoded.load(Ordering::Relaxed);
        let cap_us = self.capture_us_total.load(Ordering::Relaxed);
        let enc_us = self.encode_us_total.load(Ordering::Relaxed);
        let lat_us = self.latency_us_total.load(Ordering::Relaxed);
        let bytes = self.bytes_encoded.load(Ordering::Relaxed);
        let keyframes = self.keyframes.load(Ordering::Relaxed);
        let keyframe_bytes = self.keyframe_bytes_total.load(Ordering::Relaxed);
        let delta_bytes = self.delta_bytes_total.load(Ordering::Relaxed);
        let delta_frames = encoded.saturating_sub(keyframes);
        MetricsSnapshot {
            frames_captured: captured,
            frames_encoded: encoded,
            frames_dropped: self.frames_dropped.load(Ordering::Relaxed),
            keyframes,
            bytes_encoded: bytes,
            avg_capture_ms: if captured > 0 {
                (cap_us as f64 / captured as f64) / 1000.0
            } else {
                0.0
            },
            avg_encode_ms: if encoded > 0 {
                (enc_us as f64 / encoded as f64) / 1000.0
            } else {
                0.0
            },
            avg_latency_ms: if encoded > 0 {
                (lat_us as f64 / encoded as f64) / 1000.0
            } else {
                0.0
            },
            max_latency_ms: self.latency_us_max.load(Ordering::Relaxed) as f64 / 1000.0,
            windowed_avg_latency_ms: self.prev_window_avg_latency_us.load(Ordering::Relaxed) as f64
                / 1000.0,
            queue_depth: self.queue_depth.load(Ordering::Relaxed),
            bitrate_kbps: self.bitrate_kbps.load(Ordering::Relaxed),
            avg_frame_bytes: bytes.checked_div(encoded).unwrap_or(0),
            avg_keyframe_bytes: if keyframes > 0 {
                keyframe_bytes as f64 / keyframes as f64
            } else {
                0.0
            },
            avg_delta_bytes: if delta_frames > 0 {
                delta_bytes as f64 / delta_frames as f64
            } else {
                0.0
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windowed_average_reads_zero_before_the_first_window_completes() {
        let m = PipelineMetrics::default();
        m.record_latency(10_000);
        m.record_latency(20_000);
        // No swap_window() call yet — nothing "completed."
        assert_eq!(m.snapshot().windowed_avg_latency_ms, 0.0);
    }

    #[test]
    fn windowed_average_reflects_only_the_most_recently_completed_window() {
        let m = PipelineMetrics::default();
        // Window 1: avg 10ms.
        m.record_latency(10_000);
        m.record_latency(10_000);
        m.swap_window();
        assert_eq!(m.snapshot().windowed_avg_latency_ms, 10.0);

        // Window 2: avg 50ms — a regression the lifetime average would dilute.
        m.record_latency(50_000);
        m.record_latency(50_000);
        m.swap_window();
        assert_eq!(m.snapshot().windowed_avg_latency_ms, 50.0);
    }

    #[test]
    fn lifetime_cumulative_average_is_unaffected_by_windowing() {
        // The exact regression this design must avoid: window tracking must
        // never perturb the existing, already-relied-upon lifetime average.
        let m = PipelineMetrics::default();
        m.frames_encoded.store(2, Ordering::Relaxed);
        m.record_latency(10_000);
        m.swap_window();
        m.record_latency(50_000);
        let snap = m.snapshot();
        assert_eq!(snap.avg_latency_ms, 30.0); // (10_000 + 50_000) / 2 / 1000
    }

    #[test]
    fn an_empty_window_reports_zero_rather_than_dividing_by_zero() {
        let m = PipelineMetrics::default();
        m.swap_window(); // no record_latency() calls at all
        assert_eq!(m.snapshot().windowed_avg_latency_ms, 0.0);
    }

    // A blended `avg_frame_bytes` can't tell "frequent large keyframes" (an
    // IDR-storm bug) apart from "genuinely high-detail content" — these two
    // counters exist specifically to make that distinction visible. See
    // docs/audit/m3/streaming-media.md Finding 16.
    #[test]
    fn keyframe_and_delta_byte_averages_report_zero_before_any_frame_of_that_type() {
        let m = PipelineMetrics::default();
        let snap = m.snapshot();
        assert_eq!(snap.avg_keyframe_bytes, 0.0);
        assert_eq!(snap.avg_delta_bytes, 0.0);
    }

    #[test]
    fn keyframe_and_delta_bytes_are_tracked_and_averaged_independently() {
        let m = PipelineMetrics::default();
        m.frames_encoded.store(3, Ordering::Relaxed);
        m.keyframes.store(1, Ordering::Relaxed);
        m.keyframe_bytes_total.store(10_000, Ordering::Relaxed); // 1 keyframe
        m.delta_bytes_total.store(2_000, Ordering::Relaxed); // 2 delta frames, 1000 each

        let snap = m.snapshot();
        assert_eq!(snap.avg_keyframe_bytes, 10_000.0);
        assert_eq!(snap.avg_delta_bytes, 1_000.0);
        // A blended average would sit between these two, hiding which one
        // actually dominates the bitrate.
        assert!(snap.avg_keyframe_bytes > snap.avg_delta_bytes);
    }
}
