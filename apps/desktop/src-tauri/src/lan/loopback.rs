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

use super::endpoints::LanAdvertisement;
use super::hub::{LanHub, Role, SendFn};

/// Is `signaling_url` this desktop's own embedded LAN endpoint?
///
/// The one question that decides which transport a session uses. Getting it
/// wrong in the safe direction (answering `false` for a LAN room) puts the
/// desktop back on the socket that cannot verify its own certificate, so the
/// comparison is kept here, next to the reason, rather than inline at the call
/// site.
///
/// Asked of the whole advertisement rather than only its current address: this
/// Mac's LAN address can change while the process runs (L-181), and a room
/// minted on the address it had a moment ago is still a room on this hub.
pub fn is_own_lan_room(advertisement: Option<&LanAdvertisement>, signaling_url: &str) -> bool {
    advertisement.is_some_and(|ad| ad.is_own_signaling_url(signaling_url))
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
    let token = hub.attach(room_id, Role::Desktop, device_id.to_owned(), send);

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
        // Only the seat THIS call took, which is not necessarily the one the
        // room holds now. `SignalingClient::begin_reconnect` calls back in here
        // for the same room and the old handle is dropped straight afterwards,
        // so an unqualified release deleted the seat the reconnect had just
        // taken and left the desktop spinning on a room it kept re-emptying.
        // See `hub::SeatToken`.
        if let Ok(token) = token {
            hub.detach(&room, Role::Desktop, token);
        }
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
        let ad = LanAdvertisement::new();
        ad.publish(crate::lan::build_lan_endpoints(
            Ipv4Addr::new(192, 168, 1, 10),
            8787,
            "ab",
        ));
        assert!(is_own_lan_room(
            Some(&ad),
            "wss://192.168.1.10:8787/ws/signal"
        ));
        assert!(!is_own_lan_room(
            Some(&ad),
            "wss://api.takedia.com/ws/signal"
        ));
        // Another laptop's LAN server, reached over the network like any peer.
        assert!(!is_own_lan_room(
            Some(&ad),
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

    /// L-182, trigger 2, at this module's own boundary: a second `connect` for
    /// the same room, then the first handle going away — which is precisely
    /// what `SignalingClient::begin_reconnect` does, since `next_event` drops
    /// the superseded `SignalingHandle` the instant it installs the new one.
    ///
    /// Before the seat carried a token, the dropped handle's task detached the
    /// seat the reconnect had just taken. The room emptied, was deleted, the
    /// fresh inbound channel closed, and the session runner read that as one
    /// more transport drop — so it reconnected into the same trap, forever.
    #[tokio::test]
    async fn a_reconnect_keeps_the_seat_when_the_superseded_handle_drops() {
        let hub = Arc::new(LanHub::new());
        let room = "room-lan-4";
        let mobile = seat_mobile(&hub, room);

        let (first_sig, first_inbound) = connect(hub.clone(), room, "desktop-12345678");
        let (_sig, mut inbound) = connect(hub.clone(), room, "desktop-12345678");
        drop(first_sig);
        drop(first_inbound);

        // The release runs on a spawned task, so let it happen before asking.
        for _ in 0..50 {
            if !hub.has_seat(room, Role::Desktop) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            hub.has_seat(room, Role::Desktop),
            "the reconnected desktop seat must survive the old handle's release"
        );

        // And the seat must still be WIRED, not merely present: the phone's
        // next frame has to reach the new inbound channel.
        hub.handle(
            Role::Mobile,
            r#"{"type":"pair-request","roomId":"room-lan-4","from":"mobile","ts":0,"payload":{"deviceId":"mobile-12345678","deviceName":"phone","requestedScopes":["view"]}}"#,
        );
        let env = tokio::time::timeout(std::time::Duration::from_secs(5), inbound.recv())
            .await
            .expect("the reconnected seat must still receive frames")
            .expect("ring envelope");
        assert_eq!(env.msg_type, "pair-request");
        drop(mobile);
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
