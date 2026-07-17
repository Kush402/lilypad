//! Encoder latency micro-benchmark: per-frame encode time for the software
//! (openh264) and, on macOS, VideoToolbox backends at the default 720p30
//! session settings. Reports avg / p50 / p95 / max over a warm run.
//!
//!   cargo run --release --example bench_encode

use std::time::{Duration, Instant};

use lilypad_desktop_lib::media::encoder::{create_encoder, EncoderKind, EncoderSettings};
use lilypad_desktop_lib::media::frame::RawFrame;

const FRAMES: usize = 300;
const WARMUP: usize = 30;

fn moving_frame(w: u32, h: u32, i: u64) -> RawFrame {
    let mut f = RawFrame::new(w, h, Duration::from_millis(i * 33), i);
    let t = i as usize;
    for y in 0..h as usize {
        let row = y * w as usize * 4;
        for x in 0..w as usize {
            let p = row + x * 4;
            f.bgra[p] = ((x + t * 2) & 0xff) as u8;
            f.bgra[p + 1] = ((y + t * 3) & 0xff) as u8;
            f.bgra[p + 2] = ((x + y + t) & 0xff) as u8;
            f.bgra[p + 3] = 255;
        }
    }
    f
}

fn bench(kind: EncoderKind, label: &str) {
    let settings = EncoderSettings::default(); // 1280x720@30, 2500 kbps
    let mut enc = match create_encoder(kind, settings) {
        Ok(e) => e,
        Err(e) => {
            println!("{label}: unavailable ({e})");
            return;
        }
    };

    // Pre-render frames so frame generation isn't measured.
    let frames: Vec<RawFrame> = (0..(WARMUP + FRAMES) as u64)
        .map(|i| moving_frame(settings.width, settings.height, i))
        .collect();

    let mut times_us: Vec<u64> = Vec::with_capacity(FRAMES);
    let mut bytes_total = 0usize;
    for (i, frame) in frames.iter().enumerate() {
        let force_kf = i == 0;
        let t = Instant::now();
        let out = enc.encode(frame, force_kf).expect("encode failed");
        let us = t.elapsed().as_micros() as u64;
        if i >= WARMUP {
            times_us.push(us);
            if let Some(s) = &out {
                bytes_total += s.data.len();
            }
        }
    }

    times_us.sort_unstable();
    let avg = times_us.iter().sum::<u64>() as f64 / times_us.len() as f64;
    let p = |q: f64| times_us[((times_us.len() - 1) as f64 * q) as usize];
    println!(
        "{label}: avg {:.0}us  p50 {}us  p95 {}us  max {}us  ({} frames, {:.0} kbps observed)",
        avg,
        p(0.50),
        p(0.95),
        times_us[times_us.len() - 1],
        times_us.len(),
        (bytes_total as f64 * 8.0 / 1000.0) / (times_us.len() as f64 / 30.0),
    );
}

fn main() {
    println!("encode benchmark — 1280x720@30, {FRAMES} frames after {WARMUP} warmup");
    bench(EncoderKind::Software, "software (openh264)");
    #[cfg(target_os = "macos")]
    bench(EncoderKind::VideoToolbox, "videotoolbox (hw)  ");
}
