//! Full-pipeline latency benchmark: runs the real MediaPipeline (synthetic
//! source at 720p30 + the platform's session-default encoder) for a few
//! seconds with a live consumer, then prints the metrics snapshot — including
//! the end-to-end capture→queued latency the viewer would experience on the
//! desktop side.
//!
//!   cargo run --release --example bench_pipeline

use std::time::Duration;

use lilypad_desktop_lib::media::{EncodedSample, EncoderKind, MediaPipeline, PipelineConfig};

#[tokio::main]
async fn main() {
    let mut config = PipelineConfig::default();
    #[cfg(target_os = "macos")]
    {
        config.encoder_kind = EncoderKind::VideoToolbox;
    }
    #[cfg(not(target_os = "macos"))]
    {
        config.encoder_kind = EncoderKind::Software;
    }

    // Same shallow queue as a live session.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<EncodedSample>(4);
    let mut pipeline = MediaPipeline::start(config, tx).expect("pipeline start");

    // Live-session-like consumer: drain continuously.
    let consumer = tokio::spawn(async move {
        let mut n = 0u64;
        while rx.recv().await.is_some() {
            n += 1;
        }
        n
    });

    let secs: u64 = std::env::var("LILYPAD_BENCH_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    tokio::time::sleep(Duration::from_secs(secs)).await;
    let snap = pipeline.metrics().snapshot();
    pipeline.stop();
    let received = consumer.await.unwrap();

    println!(
        "pipeline metrics after {secs}s ({:?} encoder):",
        config.encoder_kind
    );
    println!("{}", serde_json::to_string_pretty(&snap).unwrap());
    println!("samples received by consumer: {received}");
}
