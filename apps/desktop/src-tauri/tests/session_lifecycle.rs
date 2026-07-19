//! Characterization tests for `run_session`'s pre-peer-connection lifecycle:
//! registration, pair-request relay, approve/deny, and the two ways the
//! session ends before a WebRTC peer ever exists (explicit disconnect, and a
//! dead signaling socket). Written as a safety net BEFORE the M3 architecture
//! audit's planned decomposition of `run_session` — each test pins an
//! observable behavior (exact envelopes sent, exact `SessionEvent`s emitted)
//! that the refactor must preserve bit-for-bit.
//!
//! The full ICE/DTLS connect path (offer → answer → connected →
//! InputChannelOpen) is covered separately in `session_connect_lifecycle.rs`;
//! the pairing-timeout path is covered in `session_pairing_timeout.rs` (it
//! mutates a process-global env var, so it gets its own test binary).

mod support;

use lilypad_desktop_lib::session::{run_session, Control, SessionEvent};
use lilypad_desktop_lib::signaling::messages::DeviceKind;
use support::{expect_event, expect_outbound, fake_signaling_server, inbound};
use tokio::sync::mpsc::unbounded_channel;

const ROOM: &str = "room-1";
const DEVICE: &str = "desktop-01";

#[tokio::test]
async fn registers_on_connect() {
    let (url, _to_desktop, mut from_desktop) = fake_signaling_server().await;
    let (_control_tx, control_rx) = unbounded_channel::<Control>();
    let (event_tx, mut event_rx) = unbounded_channel::<SessionEvent>();

    let handle = tokio::spawn(run_session(
        url,
        ROOM.to_owned(),
        DEVICE.to_owned(),
        control_rx,
        event_tx,
    ));

    let reg = expect_outbound(&mut from_desktop, "register").await;
    assert_eq!(reg.room_id, ROOM);
    assert_eq!(reg.from, DeviceKind::Desktop);
    assert_eq!(reg.payload["deviceId"], DEVICE);
    assert_eq!(reg.payload["role"], "desktop");

    expect_event(&mut event_rx, "Registered", |e| {
        matches!(e, SessionEvent::Registered)
    })
    .await;

    drop(_control_tx); // Control::Disconnect equivalent — end the runner cleanly
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;
}

#[tokio::test]
async fn relays_pair_request_and_denies_on_control_deny() {
    let (url, to_desktop, mut from_desktop) = fake_signaling_server().await;
    let (control_tx, control_rx) = unbounded_channel::<Control>();
    let (event_tx, mut event_rx) = unbounded_channel::<SessionEvent>();

    let handle = tokio::spawn(run_session(
        url,
        ROOM.to_owned(),
        DEVICE.to_owned(),
        control_rx,
        event_tx,
    ));

    expect_outbound(&mut from_desktop, "register").await;

    to_desktop
        .send(inbound(
            "pair-request",
            ROOM,
            DeviceKind::Mobile,
            serde_json::json!({
                "deviceId": "mobile-01",
                "deviceName": "Test iPhone",
                "requestedScopes": ["view", "control"],
            }),
        ))
        .expect("send pair-request");

    let ev = expect_event(&mut event_rx, "PairRequested", |e| {
        matches!(e, SessionEvent::PairRequested { .. })
    })
    .await;
    match ev {
        SessionEvent::PairRequested {
            device_name,
            requested_scopes,
        } => {
            assert_eq!(device_name.as_deref(), Some("Test iPhone"));
            assert_eq!(requested_scopes, vec!["view", "control"]);
        }
        _ => unreachable!(),
    }

    control_tx.send(Control::Deny).expect("send deny");

    let denied = expect_outbound(&mut from_desktop, "pair-denied").await;
    assert_eq!(denied.from, DeviceKind::Desktop);

    let ended = expect_event(&mut event_rx, "Ended", |e| {
        matches!(e, SessionEvent::Ended { .. })
    })
    .await;
    match ended {
        SessionEvent::Ended { reason } => assert_eq!(reason, "denied"),
        _ => unreachable!(),
    }

    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;
}

#[tokio::test]
async fn approve_sends_pair_approved_with_granted_scopes() {
    let (url, to_desktop, mut from_desktop) = fake_signaling_server().await;
    let (control_tx, control_rx) = unbounded_channel::<Control>();
    let (event_tx, _event_rx) = unbounded_channel::<SessionEvent>();

    let handle = tokio::spawn(run_session(
        url,
        ROOM.to_owned(),
        DEVICE.to_owned(),
        control_rx,
        event_tx,
    ));

    expect_outbound(&mut from_desktop, "register").await;
    to_desktop
        .send(inbound(
            "pair-request",
            ROOM,
            DeviceKind::Mobile,
            serde_json::json!({
                "deviceId": "mobile-01",
                "deviceName": "Test iPhone",
                "requestedScopes": ["view", "control"],
            }),
        ))
        .expect("send pair-request");

    control_tx
        .send(Control::Approve {
            scopes: vec!["view".into(), "control".into()],
            trust: false,
        })
        .expect("send approve");

    let approved = expect_outbound(&mut from_desktop, "pair-approved").await;
    assert_eq!(
        approved.payload["grantedScopes"],
        serde_json::json!(["view", "control"])
    );

    // Tear down: no session-start was sent back (test ends before a peer would
    // ever be created), so the runner is just waiting on signaling/control.
    drop(control_tx);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;
}

#[tokio::test]
async fn disconnect_before_any_peer_ends_the_session_cleanly() {
    let (url, _to_desktop, mut from_desktop) = fake_signaling_server().await;
    let (control_tx, control_rx) = unbounded_channel::<Control>();
    let (event_tx, mut event_rx) = unbounded_channel::<SessionEvent>();

    let handle = tokio::spawn(run_session(
        url,
        ROOM.to_owned(),
        DEVICE.to_owned(),
        control_rx,
        event_tx,
    ));

    expect_outbound(&mut from_desktop, "register").await;

    control_tx
        .send(Control::Disconnect)
        .expect("send disconnect");

    let disc = expect_outbound(&mut from_desktop, "disconnect").await;
    assert_eq!(disc.from, DeviceKind::Desktop);

    let ended = expect_event(&mut event_rx, "Ended", |e| {
        matches!(e, SessionEvent::Ended { .. })
    })
    .await;
    match ended {
        SessionEvent::Ended { reason } => assert_eq!(reason, "disconnected"),
        _ => unreachable!(),
    }

    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;
}

#[tokio::test]
async fn dropping_the_control_sender_disconnects_like_an_explicit_disconnect() {
    // `control_rx.recv()` returning `None` (sender dropped, e.g. the desktop
    // app UI/window closed) is handled identically to `Some(Control::Disconnect)`
    // — same envelope, same Ended reason. Pins that equivalence explicitly.
    let (url, _to_desktop, mut from_desktop) = fake_signaling_server().await;
    let (control_tx, control_rx) = unbounded_channel::<Control>();
    let (event_tx, mut event_rx) = unbounded_channel::<SessionEvent>();

    let handle = tokio::spawn(run_session(
        url,
        ROOM.to_owned(),
        DEVICE.to_owned(),
        control_rx,
        event_tx,
    ));

    expect_outbound(&mut from_desktop, "register").await;
    drop(control_tx);

    let disc = expect_outbound(&mut from_desktop, "disconnect").await;
    assert_eq!(disc.from, DeviceKind::Desktop);

    let ended = expect_event(&mut event_rx, "Ended", |e| {
        matches!(e, SessionEvent::Ended { .. })
    })
    .await;
    match ended {
        SessionEvent::Ended { reason } => assert_eq!(reason, "disconnected"),
        _ => unreachable!(),
    }

    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;
}

#[tokio::test]
async fn signaling_closed_before_peer_connected_ends_the_session() {
    let (url, to_desktop, mut from_desktop) = fake_signaling_server().await;
    let (_control_tx, control_rx) = unbounded_channel::<Control>();
    let (event_tx, mut event_rx) = unbounded_channel::<SessionEvent>();

    let handle = tokio::spawn(run_session(
        url,
        ROOM.to_owned(),
        DEVICE.to_owned(),
        control_rx,
        event_tx,
    ));

    expect_outbound(&mut from_desktop, "register").await;

    // Before any peer exists, signaling IS the session — a dead socket must
    // end the runner immediately, not attempt the background reconnect path
    // (that path is reserved for a drop AFTER `peer_connected`).
    drop(to_desktop);

    let ended = expect_event(&mut event_rx, "Ended", |e| {
        matches!(e, SessionEvent::Ended { .. })
    })
    .await;
    match ended {
        SessionEvent::Ended { reason } => assert_eq!(reason, "signaling closed"),
        _ => unreachable!(),
    }

    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;
}
