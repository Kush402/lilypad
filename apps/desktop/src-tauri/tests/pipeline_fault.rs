//! Fault-injection: a mid-stream capture failure must close the sample channel
//! WITHOUT the stop flag being set — the exact signal the session runner uses
//! to distinguish a pipeline crash (→ end session, disable input) from an
//! intentional stop. In its own test binary so the process-global fault env
//! can't race other pipeline tests.

use std::time::Duration;

use lilypad_desktop_lib::media::{EncodedSample, MediaPipeline, PipelineConfig};

#[tokio::test]
async fn unexpected_capture_death_closes_channel_with_stop_flag_unset() {
    std::env::set_var("LILYPAD_SYNTHETIC_FAIL_AFTER", "5");
    let mut cfg = PipelineConfig::default();
    cfg.capture.width = 320;
    cfg.capture.height = 240;
    cfg.encoder.width = 320;
    cfg.encoder.height = 240;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<EncodedSample>(8);
    let pipeline = MediaPipeline::start(cfg, tx).expect("pipeline starts");

    // Drain until the channel closes. The pipeline restarts a failed capture
    // source up to 3 times (recoverable OS stream stops) before declaring
    // death, and the synthetic source's fault counter resets on each restart
    // — so up to 4 lives × 5 frames flow before the channel closes.
    let mut got = 0;
    while tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("no hang")
        .is_some()
    {
        got += 1;
    }
    std::env::remove_var("LILYPAD_SYNTHETIC_FAIL_AFTER");

    assert!(
        (1..=20).contains(&got),
        "produced {got} frames across the injected faults and bounded restarts"
    );
    // The channel closed because the pipeline DIED, not because we stopped it.
    assert!(
        !pipeline.stop_requested(),
        "stop flag must be false on an unexpected death (this is the crash signal)"
    );
}
mod common;
