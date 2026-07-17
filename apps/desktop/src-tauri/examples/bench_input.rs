// Measures real per-event dispatcher latency (decode + gate + dedup + the
// real macOS permission check + attempted injection), driven directly against
// InputDispatcher — no channel in the loop, so it isolates processing cost
// from producer/consumer scheduling.
use std::sync::Arc;
use std::time::Instant;

use lilypad_desktop_lib::input::{
    create_input_backend, decode_input_batch, InputDispatcher, InputMetrics,
};

fn main() {
    let backend = create_input_backend();
    let metrics = Arc::new(InputMetrics::default());
    let mut dispatcher = InputDispatcher::new(backend, Arc::clone(&metrics));
    dispatcher.set_enabled(true);

    const N: u64 = 5000;
    let t0 = Instant::now();
    for i in 0..N {
        let frame = format!(
            r#"{{"kind":"input_batch","events":[{{"kind":"pointer_move","x":0.5,"y":0.5,"ts":{}}}]}}"#,
            i + 1
        );
        let batch = decode_input_batch(frame.as_bytes()).unwrap();
        dispatcher.process_batch(batch);
    }
    let elapsed = t0.elapsed();

    let snap = metrics.snapshot();
    println!("events processed: {N}");
    println!("total wall time: {:?}", elapsed);
    println!(
        "avg latency per event (decode+gate+dedup+permission-check+inject-attempt): {:.1} us",
        elapsed.as_micros() as f64 / N as f64
    );
    println!(
        "throughput: {:.0} events/sec (single-threaded, synchronous)",
        N as f64 / elapsed.as_secs_f64()
    );
    println!("events_received: {}", snap.events_received);
    println!("events_injected: {}", snap.events_injected);
    println!(
        "events_dropped_permission: {}",
        snap.events_dropped_permission
    );
    println!(
        "avg_inject_us (backend.apply() only, excludes gating/dedup): {:.2}",
        snap.avg_inject_us
    );
}
