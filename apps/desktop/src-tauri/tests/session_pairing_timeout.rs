//! Characterization test for `run_session`'s abandoned-pairing guard: if no
//! device redeems the QR and sends `pair-request` within the pairing window,
//! the runner must end itself rather than leak the signaling socket +
//! heartbeat task forever.
//!
//! This is its own file (own test binary) deliberately: it sets the
//! `LILYPAD_PAIRING_TIMEOUT_SECS` process-global env var to make the 120s
//! default assertable in a fast test, and every `.rs` file directly under
//! `tests/` compiles to a separate process — so this mutation can never race
//! another test's expectations about the default value.

mod support;

use lilypad_desktop_lib::session::{run_session, Control, SessionEvent};
use support::{expect_event, expect_outbound, fake_signaling_server};
use tokio::sync::mpsc::unbounded_channel;

#[tokio::test]
async fn pairing_expires_when_no_device_ever_scans() {
    std::env::set_var("LILYPAD_PAIRING_TIMEOUT_SECS", "1");

    let (url, _to_desktop, mut from_desktop) = fake_signaling_server().await;
    let (_control_tx, control_rx) = unbounded_channel::<Control>();
    let (event_tx, mut event_rx) = unbounded_channel::<SessionEvent>();

    let handle = tokio::spawn(run_session(
        url,
        "room-1".to_owned(),
        "desktop-01".to_owned(),
        None,
        control_rx,
        event_tx,
    ));

    expect_outbound(&mut from_desktop, "register").await;

    // No pair-request ever arrives — the 1s override must fire the timeout
    // rather than the runner idling forever (or, before this test existed,
    // silently until the real 120s default).
    let ended = expect_event(&mut event_rx, "Ended", |e| {
        matches!(e, SessionEvent::Ended { .. })
    })
    .await;
    match ended {
        SessionEvent::Ended { reason } => {
            assert!(
                reason.contains("pairing expired"),
                "expected a pairing-expired reason, got: {reason}"
            );
        }
        _ => unreachable!(),
    }

    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;
}
mod common;
