//! Soak-test harness: runs the real capture→encode pipeline for a
//! configurable duration, sampling RSS and pipeline liveness, and asserting
//! bounded growth. Defaults to a short (~15s) smoke duration suitable for
//! every `cargo test` run; set `LILYPAD_SOAK_SECS` for the longer 4h/24h
//! tiers `docs/audit/m3/testing-reliability.md` Finding 7 describes — those
//! longer runs are meant to be scheduled CI jobs (nightly/weekly cron), not
//! something the default test suite executes.
//!
//! The RSS-growth budget below (25%) is intentionally generous — tuned for
//! a short smoke run where JIT/allocator/cache warmup can still be settling.
//! The 4h/24h tiers should tighten this empirically against a real baseline
//! run, per the finding's own implementation plan (step 5).

use std::time::{Duration, Instant};

use lilypad_desktop_lib::media::{EncodedSample, MediaPipeline, PipelineConfig};

/// Peak resident set size in bytes, via `getrusage(RUSAGE_SELF)`. macOS
/// reports `ru_maxrss` in bytes directly (unlike Linux, which reports KB) —
/// this harness only needs to run truthfully on the macOS runner this
/// project's `rust` CI job already targets.
#[cfg(target_os = "macos")]
fn peak_rss_bytes() -> u64 {
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        libc::getrusage(libc::RUSAGE_SELF, &mut usage);
        usage.ru_maxrss as u64
    }
}

#[cfg(not(target_os = "macos"))]
fn peak_rss_bytes() -> u64 {
    0 // not sampled off macOS — the growth assertion below no-ops on 0.
}

#[tokio::test]
async fn smoke_soak_pipeline_stays_alive_and_rss_growth_is_bounded() {
    let soak_secs: u64 = std::env::var("LILYPAD_SOAK_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(15);
    let sample_every = Duration::from_secs(2);
    let warmup = Duration::from_secs((soak_secs / 3).clamp(2, 60));

    let (tx, mut rx) = tokio::sync::mpsc::channel::<EncodedSample>(30);
    let mut pipeline =
        MediaPipeline::start(PipelineConfig::default(), tx).expect("pipeline starts");

    // Drain samples so the queue never backs up — mirrors the real send
    // loop's role (`session::MediaController`), minus an actual WebRTC track.
    tokio::spawn(async move { while rx.recv().await.is_some() {} });

    let started = Instant::now();
    let deadline = started + Duration::from_secs(soak_secs);
    let mut baseline_rss: Option<u64> = None;
    let mut max_rss_after_warmup: u64 = 0;

    while Instant::now() < deadline {
        tokio::time::sleep(sample_every).await;
        assert!(
            !pipeline.stop_requested(),
            "pipeline stopped unexpectedly during the soak run — capture/encoder must not die on its own"
        );
        let rss = peak_rss_bytes();
        if started.elapsed() >= warmup {
            baseline_rss.get_or_insert(rss);
            max_rss_after_warmup = max_rss_after_warmup.max(rss);
        }
    }

    let snap = pipeline.metrics().snapshot();
    pipeline.stop();

    assert!(
        snap.frames_encoded > 0,
        "no frames were encoded during the soak run"
    );

    if let Some(baseline) = baseline_rss.filter(|&b| b > 0) {
        let growth_pct =
            ((max_rss_after_warmup as f64 - baseline as f64) / baseline as f64) * 100.0;
        assert!(
            growth_pct < 25.0,
            "RSS grew {growth_pct:.1}% after warmup ({baseline} -> {max_rss_after_warmup} bytes) \
             over a {soak_secs}s run — possible leak"
        );
    }
}
