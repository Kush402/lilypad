//! Fault-injection: a persistent encoder failure (every `encode()` call
//! errors, even though `reset()` itself keeps succeeding) must terminate the
//! pipeline after a bounded number of consecutive failures — not spin
//! resetting the encoder forever, burning CPU on a frozen "connected"
//! session the viewer never gets an error for. A transient failure that
//! self-heals within the budget must NOT terminate the session. In its own
//! test binary so the process-global fault env vars can't race other
//! pipeline tests. See docs/audit/m3/streaming-media.md Finding 14.

use std::time::Duration;

use lilypad_desktop_lib::media::{EncodedSample, MediaPipeline, PipelineConfig};
use tokio::sync::Mutex;

// `LILYPAD_ENCODER_FAIL_AFTER`/`LILYPAD_ENCODER_FAIL_COUNT` are process-global
// and `cargo test` runs the two tests below concurrently by default — without
// this guard, one test's `remove_var`/`set_var` can interleave with the
// other's `Openh264Encoder::new()` reading them, silently changing which
// fault (if any) it injects. Held for the whole test body, not just around
// the env mutation, since the read happens synchronously inside
// `MediaPipeline::start()` at an unpredictable point relative to the other
// test's own env-var window. An async-aware `tokio::sync::Mutex`, not
// `std::sync::Mutex` — the guard is held across `.await` points here.
static ENCODER_FAULT_ENV_LOCK: Mutex<()> = Mutex::const_new(());

#[tokio::test]
async fn persistent_encode_failure_terminates_the_pipeline() {
    let _guard = ENCODER_FAULT_ENV_LOCK.lock().await;
    std::env::set_var("LILYPAD_ENCODER_FAIL_AFTER", "3");
    // No LILYPAD_ENCODER_FAIL_COUNT — fails forever once started.
    let mut cfg = PipelineConfig::default();
    cfg.capture.width = 320;
    cfg.capture.height = 240;
    cfg.encoder.width = 320;
    cfg.encoder.height = 240;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<EncodedSample>(8);
    let pipeline = MediaPipeline::start(cfg, tx).expect("pipeline starts");

    // Drain until the channel closes — a persistent encode failure exhausts
    // the consecutive-error budget and the encode thread exits.
    let mut got = 0;
    while tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("no hang — the pipeline must not spin forever")
        .is_some()
    {
        got += 1;
    }
    std::env::remove_var("LILYPAD_ENCODER_FAIL_AFTER");

    assert!(
        (1..=3).contains(&got),
        "produced {got} frames before the injected fault"
    );
    // The channel closed because the pipeline gave up, not because we
    // stopped it — mirrors `pipeline_fault.rs`'s capture-side assertion.
    assert!(
        !pipeline.stop_requested(),
        "stop flag must be false — this is the crash/give-up signal"
    );
}

#[tokio::test]
async fn a_transient_encode_failure_that_self_heals_does_not_end_the_session() {
    let _guard = ENCODER_FAULT_ENV_LOCK.lock().await;
    std::env::set_var("LILYPAD_ENCODER_FAIL_AFTER", "3");
    // Fails for exactly 2 frames — well under the consecutive-error budget —
    // then resumes succeeding.
    std::env::set_var("LILYPAD_ENCODER_FAIL_COUNT", "2");
    let mut cfg = PipelineConfig::default();
    cfg.capture.width = 320;
    cfg.capture.height = 240;
    cfg.encoder.width = 320;
    cfg.encoder.height = 240;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<EncodedSample>(8);
    let mut pipeline = MediaPipeline::start(cfg, tx).expect("pipeline starts");

    // Collect enough samples to prove the pipeline kept streaming well past
    // the injected fault window (frames 3-4).
    let mut got = 0;
    for _ in 0..10 {
        let sample = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("no hang")
            .expect("channel stays open across a self-healing fault");
        drop(sample);
        got += 1;
    }
    std::env::remove_var("LILYPAD_ENCODER_FAIL_AFTER");
    std::env::remove_var("LILYPAD_ENCODER_FAIL_COUNT");

    assert_eq!(
        got, 10,
        "pipeline must keep streaming past a transient fault"
    );
    pipeline.stop();
    assert!(pipeline.stop_requested());
}
mod common;
