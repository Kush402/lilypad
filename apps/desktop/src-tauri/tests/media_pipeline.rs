//! Integration test: the full media pipeline produces real H.264 samples end to
//! end (synthetic capture → convert → openh264 → bounded queue), with metrics.

use std::time::Duration;

use lilypad_desktop_lib::media::{EncodedSample, MediaPipeline, PipelineConfig};

/// How long a test may wait for the next encoded sample.
///
/// `timeout` returns the instant the sample arrives, so a large budget costs a
/// passing run nothing — this file finishes in about five seconds on an idle
/// machine. Five seconds was a wall-clock assertion about the host's spare
/// capacity instead: this suite went one-of-four red on 2026-08-24 while a
/// full `pnpm -w test` had every core, and green the moment it ran alone.
/// Software H.264 on a starved CPU is slow, not broken.
///
/// Same number and the same reasoning as `input_worker.rs`'s `SETTLE`.
const SAMPLE: Duration = Duration::from_secs(20);

/// A PLI from the viewer must produce an IDR on the next frame — not at the
/// next periodic keyframe.
#[tokio::test]
async fn keyframe_request_forces_idr_on_next_frame() {
    let mut cfg = PipelineConfig::default();
    cfg.capture.width = 320;
    cfg.capture.height = 240;
    cfg.encoder.width = 320;
    cfg.encoder.height = 240;
    // Long GOP so a periodic IDR can't produce a false positive.
    cfg.encoder.keyframe_interval = 3000;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<EncodedSample>(8);
    let mut pipeline = MediaPipeline::start(cfg, tx).expect("pipeline starts");

    // Frame 0 is always an IDR; drain a few frames to get past it.
    for _ in 0..3 {
        let s = tokio::time::timeout(SAMPLE, rx.recv())
            .await
            .expect("sample")
            .expect("open");
        drop(s);
    }

    pipeline.control().request_keyframe();

    // The request applies before the next encoded frame; allow the couple of
    // frames already in flight/queued to pass, then expect an IDR promptly.
    let mut got_idr = false;
    for _ in 0..6 {
        let s = tokio::time::timeout(SAMPLE, rx.recv())
            .await
            .expect("sample")
            .expect("open");
        if s.is_keyframe {
            got_idr = true;
            break;
        }
    }
    pipeline.stop();
    assert!(got_idr, "no IDR within 6 frames of a keyframe request");
}

#[tokio::test]
async fn pipeline_streams_real_h264_with_metrics() {
    let mut cfg = PipelineConfig::default();
    // Small + fast for CI.
    cfg.capture.width = 320;
    cfg.capture.height = 240;
    cfg.capture.fps = 30;
    cfg.encoder.width = 320;
    cfg.encoder.height = 240;
    cfg.encoder.fps = 30;
    cfg.encoder.keyframe_interval = 30;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<EncodedSample>(30);
    let mut pipeline = MediaPipeline::start(cfg, tx).expect("pipeline starts");

    // Collect several encoded frames.
    let mut samples = Vec::new();
    for _ in 0..6 {
        let s = tokio::time::timeout(SAMPLE, rx.recv())
            .await
            .expect("a sample within 5s")
            .expect("channel stays open");
        samples.push(s);
    }

    let metrics = pipeline.metrics().snapshot();
    pipeline.stop();

    // First frame is an IDR keyframe; all frames are non-empty Annex-B.
    assert!(samples[0].is_keyframe, "first sample must be a keyframe");
    for s in &samples {
        assert!(!s.data.is_empty(), "encoded sample must be non-empty");
        assert!(
            s.data.starts_with(&[0, 0, 0, 1]) || s.data.starts_with(&[0, 0, 1]),
            "expected Annex-B start code",
        );
    }
    // Timestamps advance monotonically.
    assert!(samples[5].timestamp > samples[0].timestamp);

    // Metrics were recorded.
    assert!(
        metrics.frames_captured >= 6,
        "captured {}",
        metrics.frames_captured
    );
    assert!(
        metrics.frames_encoded >= 6,
        "encoded {}",
        metrics.frames_encoded
    );
    assert!(metrics.bytes_encoded > 0);
    assert!(metrics.keyframes >= 1);
    // End-to-end latency (capture → queued) is measured for every queued sample.
    assert!(metrics.avg_latency_ms > 0.0, "latency must be recorded");
    assert!(metrics.max_latency_ms >= metrics.avg_latency_ms);
    // A real keyframe is always larger than a real delta frame — sanity-checks
    // the new keyframe/delta byte split against a real encoded stream, not
    // just synthetic counter values. See
    // docs/audit/m3/streaming-media.md Finding 16.
    assert!(metrics.avg_keyframe_bytes > 0.0);
    assert!(metrics.avg_delta_bytes > 0.0);
    assert!(
        metrics.avg_keyframe_bytes > metrics.avg_delta_bytes,
        "expected a keyframe to average larger than a delta frame: {} vs {}",
        metrics.avg_keyframe_bytes,
        metrics.avg_delta_bytes
    );
}

/// When the sample queue overflows and a frame is dropped, the receiver has
/// lost a reference frame — the pipeline must recover with an immediate IDR on
/// the next successfully queued sample, not smear until the periodic keyframe.
#[tokio::test]
async fn dropped_frame_recovers_with_immediate_keyframe() {
    let mut cfg = PipelineConfig::default();
    cfg.capture.width = 320;
    cfg.capture.height = 240;
    cfg.capture.fps = 30;
    cfg.encoder.width = 320;
    cfg.encoder.height = 240;
    cfg.encoder.fps = 30;
    // Long GOP so a periodic IDR can't mask a missing recovery keyframe.
    cfg.encoder.keyframe_interval = 3000;

    // Capacity 1 and no draining: frame 0 occupies the queue, subsequent
    // frames drop until we start receiving.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<EncodedSample>(1);
    let mut pipeline = MediaPipeline::start(cfg, tx).expect("pipeline starts");

    // Let drops accumulate. Generous margin (30fps means 500ms is already
    // ~15 frames of headroom past the capacity-1 queue) to absorb capture/
    // encode thread startup latency on a slow or freshly-provisioned CI
    // runner, which can eat several hundred ms before the first frame is
    // even produced.
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let first = tokio::time::timeout(SAMPLE, rx.recv())
        .await
        .expect("first sample")
        .expect("open");
    assert!(first.is_keyframe, "frame 0 is the initial IDR");

    // Everything encoded while the queue was full was dropped; the pipeline
    // owes the receiver a recovery IDR. The guarantee is that it arrives
    // *promptly* — within a small, bounded number of samples — not that it is
    // literally the very next one. There is an unavoidable one-frame window:
    // `queue_has_room` is sampled before `encoder.encode()` commits the
    // keyframe/delta decision, but `try_send()` runs after, so a delta encoded
    // while the queue looked full can still slip through the instant we drain
    // it here. The pipeline self-heals — `recover_with_keyframe` stays armed
    // until an actual keyframe reaches the wire — so the recovery IDR lands on
    // the following attempt. Draining a few samples for it matches the real
    // behavioral contract without coupling the test to that race window.
    let mut recovery_keyframe = false;
    for _ in 0..5 {
        let s = tokio::time::timeout(SAMPLE, rx.recv())
            .await
            .expect("recovery sample")
            .expect("open");
        if s.is_keyframe {
            recovery_keyframe = true;
            break;
        }
    }

    let metrics = pipeline.metrics().snapshot();
    pipeline.stop();

    assert!(
        metrics.frames_dropped > 0,
        "test premise: drops must have occurred"
    );
    assert!(
        recovery_keyframe,
        "a recovery keyframe must arrive promptly after a drop (dropped {})",
        metrics.frames_dropped
    );
}

#[tokio::test]
async fn pipeline_stops_cleanly_and_closes_channel() {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<EncodedSample>(8);
    let mut pipeline = MediaPipeline::start(PipelineConfig::default(), tx).expect("start");
    // Drain a couple frames, then stop.
    let _ = tokio::time::timeout(SAMPLE, rx.recv()).await;
    pipeline.stop();
    // After stop, the sender thread is gone; the channel eventually drains + closes.
    // Give the OS thread a moment, then confirm recv returns None (closed) or empty.
    let mut closed = false;
    for _ in 0..50 {
        match tokio::time::timeout(Duration::from_millis(50), rx.recv()).await {
            Ok(None) => {
                closed = true;
                break;
            }
            Ok(Some(_)) => continue, // draining buffered frames
            Err(_) => continue,
        }
    }
    assert!(closed, "channel should close after pipeline stop");
}
