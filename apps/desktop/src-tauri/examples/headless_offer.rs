//! Headless driver for the desktop WebRTC transport — no Tauri GUI.
//!
//! Runs `run_session` against a live backend room (env-configured) and
//! auto-approves the first pair-request, so a JS "mobile" stub can verify the
//! desktop produces a real WebRTC offer + ICE. Used by the E2E transport test.
//!
//!   LILYPAD_SIGNALING=ws://localhost:8080/ws/signal \
//!   LILYPAD_ROOM=<roomId> cargo run --example headless_offer

use std::time::Duration;

use lilypad_desktop_lib::session::{run_session, Control, SessionEvent};
use tokio::sync::mpsc::unbounded_channel;

#[tokio::main]
async fn main() {
    // RUST_LOG-controlled logging so live runs show the pipeline/ABR activity.
    let _ = env_logger::try_init();
    let signaling = std::env::var("LILYPAD_SIGNALING").expect("LILYPAD_SIGNALING not set");
    let room = std::env::var("LILYPAD_ROOM").expect("LILYPAD_ROOM not set");
    let device = std::env::var("LILYPAD_DEVICE").unwrap_or_else(|_| "desktop-headless".to_owned());

    let (control_tx, control_rx) = unbounded_channel::<Control>();
    let (event_tx, mut event_rx) = unbounded_channel::<SessionEvent>();

    // Optional: fire a Disconnect after N seconds — used to prove the session
    // loop stays responsive to control even while a signaling reconnect is in
    // flight (H5). Prints the wall-clock time it was sent for latency checks.
    if let Some(secs) = std::env::var("LILYPAD_DISCONNECT_AFTER_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        let ctl = control_tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(secs)).await;
            eprintln!("[desktop] sending Disconnect now");
            let _ = ctl.send(Control::Disconnect);
        });
    }

    // Auto-approve on pair-request; log every event to stderr.
    tokio::spawn(async move {
        while let Some(ev) = event_rx.recv().await {
            eprintln!("[desktop-event] {ev:?}");
            if matches!(ev, SessionEvent::PairRequested { .. }) {
                let _ = control_tx.send(Control::Approve {
                    scopes: vec!["view".into(), "control".into()],
                    trust: false,
                });
            }
        }
    });

    let run_secs: u64 = std::env::var("LILYPAD_RUN_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(12);
    let fut = run_session(signaling, room, device, None, None, control_rx, event_tx);
    let _ = tokio::time::timeout(Duration::from_secs(run_secs), fut).await;
    eprintln!("[desktop] headless session ended");
}
