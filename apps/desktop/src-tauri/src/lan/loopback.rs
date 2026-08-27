//! In-process signaling transport between this desktop and its OWN embedded
//! LAN hub.
//!
//! When a trusted phone rings over the LAN, the embedded control server mints a
//! room and the desktop has to take the desktop seat in it. The obvious way is
//! the way the cloud path already works — open a WebSocket to the signaling URL
//! the room was minted on — and it cannot work here, because that URL is this
//! machine's own `wss://<lan-ip>:8787/ws/signal`, served with the **self-signed**
//! certificate `lan::cert` generates. The desktop's WebSocket client verifies
//! against webpki roots (`tokio-tungstenite`'s `rustls-tls-webpki-roots`), so
//! the handshake fails, the desktop never takes its seat, and the phone's
//! `pair-request` is relayed to nobody: "Waiting for approval…" forever, with
//! the laptop showing no ring at all. Observed on v0.1.20, on the second ring —
//! the first ring went over the cloud, which seeded the phone's LAN cache and
//! sent every later ring down this path.
//!
//! Pinning the desktop's client to its own certificate would fix the handshake
//! and still be the wrong shape: it spends a TLS session, a TCP connection and
//! a listening socket so that a process can talk to itself. This module skips
//! the network entirely — `LanHub` is already an in-process object, so the seat
//! is taken by calling it directly, behind the same `SignalingHandle` +
//! `Envelope` receiver pair `signaling::connect` returns. The session runner
//! cannot tell the difference.
//!
//! It also removes the LAN control plane's last dependency on anything outside
//! this process, which is what [ADR-0006](../../../../../../docs/adr/0006-lan-first-connectivity.md)
//! asks for: a LAN session must work with no internet, and now also with no
//! loopback networking and no certificate trust decision.

use std::sync::Arc;

use tokio::sync::mpsc::{self, UnboundedReceiver};

use crate::signaling::{Envelope, SignalingHandle};

use super::endpoints::LanEndpoints;
use super::hub::{LanHub, Role, SendFn};

/// Is `signaling_url` this desktop's own embedded LAN endpoint?
///
/// The one question that decides which transport a session uses. Getting it
/// wrong in the safe direction (answering `false` for a LAN room) puts the
/// desktop back on the socket that cannot verify its own certificate, so the
/// comparison is kept here, next to the reason, rather than inline at the call
/// site.
pub fn is_own_lan_room(endpoints: Option<&LanEndpoints>, signaling_url: &str) -> bool {
    endpoints.is_some_and(|ep| ep.signaling_url == signaling_url)
}

/// Take the desktop seat in a room on this desktop's own LAN hub.
///
/// The seat is attached before returning, so a `pair-request` the phone has
/// already sent is delivered (from the hub's pending buffer) as soon as the
/// caller starts reading the receiver.
///
/// The seat is released when the returned `SignalingHandle` and all its clones
/// are dropped — i.e. when the session runner ends, exactly like a socket
/// closing.
pub fn connect(
    hub: Arc<LanHub>,
    room_id: &str,
    device_id: &str,
) -> (SignalingHandle, UnboundedReceiver<Envelope>) {
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Envelope>();
    let send: SendFn = Arc::new(
        move |raw: &str| match serde_json::from_str::<Envelope>(raw) {
            Ok(env) => {
                let _ = in_tx.send(env);
            }
            Err(e) => {
                log::warn!(target: "lilypad::lan", "loopback: undecodable frame from hub: {e}")
            }
        },
    );
    // Infallible today (`attach` creates the room when absent), and a failure
    // to seat would be reported by the session runner timing out on approval
    // rather than by this call.
    let _ = hub.attach(room_id, Role::Desktop, device_id.to_owned(), send);

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Envelope>();
    let room = room_id.to_owned();
    tokio::spawn(async move {
        while let Some(env) = out_rx.recv().await {
            match serde_json::to_string(&env) {
                Ok(txt) => hub.handle(Role::Desktop, &txt),
                Err(e) => {
                    log::warn!(target: "lilypad::lan", "loopback: unserializable envelope: {e}")
                }
            }
        }
        hub.detach(&room, Role::Desktop);
        log::debug!(target: "lilypad::lan", "loopback seat released for room {room}");
    });

    (SignalingHandle::from_sender(out_tx), in_rx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    use std::sync::Mutex;

    /// A cloud room must NOT be routed in-process, and this desktop's own LAN
    /// room must be.
    #[test]
    fn only_this_desktops_own_lan_room_is_routed_in_process() {
        let ep = crate::lan::build_lan_endpoints(Ipv4Addr::new(192, 168, 1, 10), 8787, "ab");
        assert!(is_own_lan_room(
            Some(&ep),
            "wss://192.168.1.10:8787/ws/signal"
        ));
        assert!(!is_own_lan_room(
            Some(&ep),
            "wss://api.takedia.com/ws/signal"
        ));
        // Another laptop's LAN server, reached over the network like any peer.
        assert!(!is_own_lan_room(
            Some(&ep),
            "wss://192.168.1.11:8787/ws/signal"
        ));
        // No LAN server running at all: every room is a cloud room.
        assert!(!is_own_lan_room(None, "wss://192.168.1.10:8787/ws/signal"));
    }

    /// A phone seat, so the hub has someone to relay to.
    fn seat_mobile(hub: &LanHub, room: &str) -> Arc<Mutex<Vec<serde_json::Value>>> {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let b2 = buf.clone();
        let send: SendFn = Arc::new(move |s: &str| {
            if let Ok(v) = serde_json::from_str(s) {
                b2.lock().unwrap().push(v);
            }
        });
        hub.attach(room, Role::Mobile, "mobile-12345678".into(), send)
            .unwrap();
        buf
    }

    /// The bug this module exists for, end to end and with no socket: a phone
    /// rings, the desktop takes its seat in-process, and the approval it sends
    /// mints `session-start` for both peers.
    #[tokio::test]
    async fn the_desktop_can_pair_over_its_own_hub_without_a_socket() {
        let hub = Arc::new(LanHub::new());
        let room = "room-lan-1";
        let mobile = seat_mobile(&hub, room);

        let (sig, mut inbound) = connect(hub.clone(), room, "desktop-12345678");

        hub.handle(
            Role::Mobile,
            r#"{"type":"pair-request","roomId":"room-lan-1","from":"mobile","ts":0,"payload":{"deviceId":"mobile-12345678","deviceName":"phone","requestedScopes":["view","control"]}}"#,
        );

        let env = inbound.recv().await.expect("desktop receives the ring");
        assert_eq!(env.msg_type, "pair-request");

        let scopes = vec!["view".to_owned(), "control".to_owned()];
        sig.send(Envelope::pair_approved(room, &scopes, false))
            .unwrap();

        // The approval crosses a spawned task, so give it a turn.
        for _ in 0..50 {
            if mobile
                .lock()
                .unwrap()
                .iter()
                .any(|v| v["type"] == "session-start")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            mobile
                .lock()
                .unwrap()
                .iter()
                .any(|v| v["type"] == "session-start"),
            "the phone must be told the session started, got {:?}",
            mobile.lock().unwrap()
        );
        let start = inbound.recv().await.expect("desktop's own session-start");
        assert_eq!(start.msg_type, "session-start");
    }

    /// The phone reaches the room first — it has the room id the moment
    /// `/connect/request` returns, while the desktop is still tearing down any
    /// previous session. Its `pair-request` must survive the gap.
    #[tokio::test]
    async fn a_ring_that_arrives_before_the_desktop_is_seated_is_still_delivered() {
        let hub = Arc::new(LanHub::new());
        let room = "room-lan-2";
        let _mobile = seat_mobile(&hub, room);

        hub.handle(
            Role::Mobile,
            r#"{"type":"pair-request","roomId":"room-lan-2","from":"mobile","ts":0,"payload":{"deviceId":"mobile-12345678","deviceName":"phone","requestedScopes":["view"]}}"#,
        );

        let (_sig, mut inbound) = connect(hub.clone(), room, "desktop-12345678");
        let env = inbound.recv().await.expect("buffered ring is replayed");
        assert_eq!(env.msg_type, "pair-request");
    }

    /// Dropping the handle releases the seat, so the next ring on a new room
    /// does not inherit a dead one.
    #[tokio::test]
    async fn dropping_the_handle_releases_the_seat() {
        let hub = Arc::new(LanHub::new());
        let room = "room-lan-3";
        let (sig, inbound) = connect(hub.clone(), room, "desktop-12345678");
        drop(sig);
        drop(inbound);
        for _ in 0..50 {
            if !hub.has_seat(room, Role::Desktop) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the desktop seat was never released");
    }
}
