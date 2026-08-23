//! Shared test support for `run_session` characterization tests.
//!
//! `run_session` dials a real WebSocket (`signaling::connect`) with no seam
//! for injecting a fake transport — that's exactly the god-function shape
//! flagged in the M3 architecture audit. Until Phase 1 decomposes it, the
//! only way to characterize its *current* observable behavior (the FSM this
//! refactor must preserve) is to run it against a real, self-contained fake
//! signaling server and assert on the envelopes it sends + the `SessionEvent`s
//! it emits. This module is that fake server, plus small assertion helpers.
//!
//! Not a mock of the protocol — it speaks the exact wire shape
//! `apps/backend`'s real hub does (see `signaling::messages::Envelope`), just
//! without room/multi-peer routing (each test drives one desktop directly).

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use lilypad_desktop_lib::session::SessionEvent;
use lilypad_desktop_lib::signaling::messages::DeviceKind;
use lilypad_desktop_lib::signaling::Envelope;
use tokio::net::TcpListener;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

// Note on the WebSocketStream lifecycle in this module: an earlier version
// used `.split()` into a `SplitSink`/`SplitStream` pair driven by two
// separate tasks. That's a trap for a fake server that needs to force a
// close — the two halves share the real socket through a lock, so dropping
// only the sink half never closes the connection (the stream half keeps it
// alive), and the client-under-test never observes EOF. Driving the single
// unsplit stream from one task with `tokio::select!` avoids that entirely
// and lets a forced close send a real Close frame.

/// How long any single `recv`/`expect` helper waits before failing the test.
///
/// This is a CEILING, not a delay: a passing test never spends it, so a larger
/// value costs nothing when things work and only makes a genuine hang slower to
/// report. That asymmetry is why it is generous.
///
/// It has now been raised twice for the same test. `full_handshake_reaches_
/// connected_and_opens_input_channel` drives a real `webrtc` peer connection —
/// candidate gathering, DTLS, then SCTP — and even entirely on loopback that is
/// not instant on a shared macOS runner. One second was not enough
/// (2026-08-22); five was not enough either, and CI failed with
/// `timed out waiting for session event: ConnectionState(connected)` on
/// 2026-08-23, on a commit that changed only workflow YAML.
///
/// A flaky gate is the same problem as a monitor that is always red: it teaches
/// people that a failure means nothing. Twenty seconds still fails a hung FSM
/// fast relative to the six-hour job limit.
const WAIT: Duration = Duration::from_secs(20);

/// Start a one-shot fake signaling server on an OS-assigned loopback port.
/// Returns the `ws://` URL to connect to, a sender the test uses to push
/// envelopes to the desktop under test (role-playing the backend hub relaying
/// mobile/session messages), and a receiver of every envelope the desktop
/// sends (so the test can assert on outbound behavior: register, pair-denied,
/// offer, ice-candidate, disconnect, heartbeat, ...).
///
/// Accepts exactly one connection then stops accepting — each test gets its
/// own listener on its own port, so tests never interfere with each other.
pub async fn fake_signaling_server() -> (
    String,
    UnboundedSender<Envelope>,
    UnboundedReceiver<Envelope>,
) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake signaling server");
    let port = listener.local_addr().expect("local_addr").port();
    let url = format!("ws://127.0.0.1:{port}");

    let (to_desktop_tx, mut to_desktop_rx) = mpsc::unbounded_channel::<Envelope>();
    let (from_desktop_tx, from_desktop_rx) = mpsc::unbounded_channel::<Envelope>();

    tokio::spawn(async move {
        let (tcp, _addr) = match listener.accept().await {
            Ok(v) => v,
            Err(_) => return, // test ended without connecting — nothing to serve
        };
        let mut ws = match tokio_tungstenite::accept_async(tcp).await {
            Ok(ws) => ws,
            Err(_) => return,
        };

        loop {
            tokio::select! {
                // Desktop → server: forward every parsed envelope to the test.
                inbound = ws.next() => {
                    match inbound {
                        Some(Ok(Message::Text(t))) => {
                            if let Ok(env) = serde_json::from_str::<Envelope>(t.as_str()) {
                                if from_desktop_tx.send(env).is_err() {
                                    break;
                                }
                            }
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        _ => {}
                    }
                }
                // Server → desktop: relay whatever the test scripts. The test
                // dropping its sender (channel closes → `None`) means "close
                // the connection now" — send a real Close frame so the
                // client's reader observes it instead of hanging forever
                // waiting on a socket nothing will ever actually shut down.
                outbound = to_desktop_rx.recv() => {
                    match outbound {
                        Some(env) => {
                            let Ok(txt) = serde_json::to_string(&env) else { continue };
                            if ws.send(Message::Text(txt)).await.is_err() {
                                break;
                            }
                        }
                        None => {
                            let _ = ws.close(None).await;
                            break;
                        }
                    }
                }
            }
        }
    });

    (url, to_desktop_tx, from_desktop_rx)
}

/// Build a raw inbound envelope (server/mobile → desktop) — `Envelope`'s own
/// constructors are outbound-only (desktop → server), so tests build these
/// directly. Mirrors exactly what `apps/backend`'s hub relays.
///
/// `tests/support/mod.rs` is compiled fresh into every test binary that
/// declares `mod support;`, and dead-code analysis runs per binary — a
/// binary whose tests never need to script an inbound envelope (e.g. the
/// pairing-timeout test, which only waits for a timeout with no inbound
/// traffic) will otherwise flag this shared helper as unused.
#[allow(dead_code)]
pub fn inbound(
    msg_type: &str,
    room_id: &str,
    from: DeviceKind,
    payload: serde_json::Value,
) -> Envelope {
    Envelope {
        msg_type: msg_type.to_owned(),
        room_id: room_id.to_owned(),
        from,
        ts: 0,
        payload,
    }
}

/// Await the next envelope of `msg_type` from the desktop, ignoring (but not
/// asserting against) any others in between — e.g. heartbeats interleaved
/// with the message under test. Fails the test on timeout or channel close.
pub async fn expect_outbound(rx: &mut UnboundedReceiver<Envelope>, msg_type: &str) -> Envelope {
    tokio::time::timeout(WAIT, async {
        loop {
            match rx.recv().await {
                Some(env) if env.msg_type == msg_type => return env,
                Some(_) => continue,
                None => panic!("desktop's outbound channel closed before sending '{msg_type}'"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for desktop to send '{msg_type}'"))
}

/// Await the next `SessionEvent` matching `pred`, ignoring others in between
/// (e.g. `ConnectionState` chatter while waiting for `Ended`). Fails the test
/// on timeout or channel close.
pub async fn expect_event(
    rx: &mut UnboundedReceiver<SessionEvent>,
    what: &str,
    pred: impl Fn(&SessionEvent) -> bool,
) -> SessionEvent {
    tokio::time::timeout(WAIT, async {
        loop {
            match rx.recv().await {
                Some(ev) if pred(&ev) => return ev,
                Some(_) => continue,
                None => panic!("session event channel closed before emitting {what}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for session event: {what}"))
}
