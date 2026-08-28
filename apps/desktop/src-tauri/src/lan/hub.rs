//! Two-peer signaling hub for LAN rooms — mirrors backend `MessageRouter`
//! semantics without Redis, room auth, or multi-tenancy.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Desktop,
    Mobile,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Desktop => "desktop",
            Role::Mobile => "mobile",
        }
    }

    fn other(self) -> Role {
        match self {
            Role::Desktop => Role::Mobile,
            Role::Mobile => Role::Desktop,
        }
    }
}

pub type SendFn = Arc<dyn Fn(&str) + Send + Sync>;

/// Cap on frames held for a seat that has not attached yet. A handful of
/// signaling frames is all the join race can produce; anything beyond that is
/// a peer that is never coming, and the queue must not grow without bound.
const MAX_PENDING_FRAMES: usize = 32;

/// Proof that a particular TRANSPORT — not merely a particular role — holds a
/// seat, handed out by `attach` and required by `detach`.
///
/// `attach` overwrites a seat unconditionally, which is correct: a peer that
/// re-registers is reclaiming its own place. What was wrong is that `detach`
/// then cleared the seat by role alone, so the teardown of the transport a peer
/// had just REPLACED deleted the replacement. Two ways in, both on the ring
/// path, both shipped in v0.1.21 (kanban L-182):
///
/// * a phone whose signaling socket flaps re-registers over the new socket, and
///   then the dying one reaches the end of `handle_ws` and evicts the fresh
///   mobile seat;
/// * worse, on this desktop's own side: `SignalingClient::begin_reconnect`
///   re-seats through `lan::loopback`, and the moment `next_event` installs the
///   new handle the OLD one is dropped — its `out_rx` closes and its spawned
///   task detaches the seat the reconnect had just taken. Both seats then being
///   empty, the room is deleted, the new inbound channel closes, `Closed` fires
///   again, and the desktop spins there instead of holding a session.
///
/// The cloud hub answers the same question with a reregister grace keyed on
/// `deviceId` (`apps/backend/src/signaling/hub.ts`), because there it has to
/// hold a seat open across a real network round trip. Nothing here crosses a
/// network, so there is nothing to wait for and a monotonic epoch is enough:
/// whoever holds the current one owns the seat, and every other `detach` is a
/// no-op.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeatToken(u64);

struct Seat {
    device_id: String,
    send: SendFn,
    epoch: u64,
}

struct Room {
    desktop: Option<Seat>,
    mobile: Option<Seat>,
    session_id: Option<String>,
    scopes: Vec<String>,
    established: bool,
    /// Frames addressed to a seat that had not attached yet, replayed the
    /// moment it does.
    ///
    /// The two peers race: the phone has the room id the instant
    /// `/connect/request` returns, while the desktop still has to tear down any
    /// previous session before taking its seat. Dropping the frames that land
    /// in that window silently loses the phone's `pair-request` — and since
    /// nothing re-sends it, the phone waits on "Waiting for approval…" until
    /// the user gives up.
    pending_desktop: Vec<String>,
    pending_mobile: Vec<String>,
}

pub struct LanHub {
    rooms: Mutex<HashMap<String, Room>>,
    /// Source of `SeatToken`s. Hub-wide rather than per-seat so a token can
    /// never be mistaken for a later one after a room has been deleted and
    /// recreated under the same id — which is exactly what a supersession
    /// between two rings does.
    next_epoch: AtomicU64,
}

impl Default for LanHub {
    fn default() -> Self {
        Self {
            rooms: Mutex::new(HashMap::new()),
            next_epoch: AtomicU64::new(1),
        }
    }
}

impl LanHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Attach a peer after `register`, returning the token that transport must
    /// present to vacate the seat again. See `SeatToken`.
    pub fn attach(
        &self,
        room_id: &str,
        role: Role,
        device_id: String,
        send: SendFn,
    ) -> Result<SeatToken, String> {
        let epoch = self.next_epoch.fetch_add(1, Ordering::Relaxed);
        let replay: Vec<String>;
        {
            let mut rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
            let room = rooms.entry(room_id.to_owned()).or_insert_with(|| Room {
                desktop: None,
                mobile: None,
                session_id: None,
                scopes: vec!["view".into()],
                established: false,
                pending_desktop: Vec::new(),
                pending_mobile: Vec::new(),
            });
            let seat = Seat {
                device_id,
                send,
                epoch,
            };
            match role {
                Role::Desktop => {
                    room.desktop = Some(seat);
                    replay = std::mem::take(&mut room.pending_desktop);
                }
                Role::Mobile => {
                    room.mobile = Some(seat);
                    replay = std::mem::take(&mut room.pending_mobile);
                }
            }
        }
        // Outside the lock: `send` reaches a socket writer or the loopback
        // channel, neither of which may be entered while the room map is held.
        for frame in &replay {
            self.send_raw(role, room_id, frame);
        }
        if !replay.is_empty() {
            log::debug!(
                target: "lilypad::lan",
                "replayed {} buffered frame(s) to the {} seat of room {room_id}",
                replay.len(),
                role.as_str()
            );
        }
        Ok(SeatToken(epoch))
    }

    /// Whether `role` currently holds a seat in `room_id`.
    pub fn has_seat(&self, room_id: &str, role: Role) -> bool {
        let rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
        rooms.get(room_id).is_some_and(|room| match role {
            Role::Desktop => room.desktop.is_some(),
            Role::Mobile => room.mobile.is_some(),
        })
    }

    /// Vacate the seat `token` was issued for.
    ///
    /// A no-op when the seat has since been re-taken by another transport: the
    /// departing one is finishing a teardown that the peer has already moved
    /// on from, and clearing the seat there is the L-182 eviction. See
    /// `SeatToken`.
    pub fn detach(&self, room_id: &str, role: Role, token: SeatToken) {
        let mut rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
        let Some(room) = rooms.get_mut(room_id) else {
            return;
        };
        let seat = match role {
            Role::Desktop => &mut room.desktop,
            Role::Mobile => &mut room.mobile,
        };
        match seat {
            Some(current) if current.epoch != token.0 => {
                log::debug!(
                    target: "lilypad::lan",
                    "ignoring a stale detach of the {} seat of room {room_id} — \
                     {} re-took it since",
                    role.as_str(),
                    current.device_id
                );
                return;
            }
            _ => *seat = None,
        }
        if room.desktop.is_none() && room.mobile.is_none() {
            rooms.remove(room_id);
        }
    }

    pub fn handle(&self, from: Role, raw: &str) {
        let Ok(v) = serde_json::from_str::<Value>(raw) else {
            return;
        };
        let Some(msg_type) = v.get("type").and_then(Value::as_str) else {
            return;
        };
        let room_id = v
            .get("roomId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();

        match msg_type {
            "register" | "heartbeat" | "ping" => {
                if msg_type == "ping" {
                    self.send_to(from, &room_id, "pong", json!({}));
                }
            }
            "pair-request" => {
                if from != Role::Mobile {
                    self.reject(from, &room_id, "forbidden", "only the mobile may send this");
                    return;
                }
                self.relay(from, &room_id, &v);
            }
            "pair-approved" => {
                if from != Role::Desktop {
                    self.reject(
                        from,
                        &room_id,
                        "forbidden",
                        "only the desktop may send this",
                    );
                    return;
                }
                let granted = v
                    .pointer("/payload/grantedScopes")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_else(|| vec!["view".into()]);
                self.approve(&room_id, granted);
            }
            "pair-denied" => {
                if from != Role::Desktop {
                    self.reject(
                        from,
                        &room_id,
                        "forbidden",
                        "only the desktop may send this",
                    );
                    return;
                }
                self.relay(from, &room_id, &v);
                self.end_room(&room_id, "denied by desktop");
            }
            "offer" => {
                if from != Role::Desktop {
                    self.reject(
                        from,
                        &room_id,
                        "forbidden",
                        "only the desktop may send this",
                    );
                    return;
                }
                self.relay(from, &room_id, &v);
            }
            "answer" => {
                if from != Role::Mobile {
                    self.reject(from, &room_id, "forbidden", "only the mobile may send this");
                    return;
                }
                {
                    let mut rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(room) = rooms.get_mut(&room_id) {
                        room.established = true;
                    }
                }
                self.relay(from, &room_id, &v);
            }
            "ice-candidate" => self.relay(from, &room_id, &v),
            "frame-size" | "clipboard-update" | "lan-endpoints" => {
                if from != Role::Desktop {
                    self.reject(
                        from,
                        &room_id,
                        "forbidden",
                        "only the desktop may send this",
                    );
                    return;
                }
                self.relay(from, &room_id, &v);
            }
            "set-capture-mode" | "set-display" | "pause" | "resume" => {
                if from != Role::Mobile {
                    self.reject(from, &room_id, "forbidden", "only the mobile may send this");
                    return;
                }
                self.relay(from, &room_id, &v);
            }
            "renegotiate" => {
                self.relay_to(Role::Desktop, &room_id, &v);
            }
            "disconnect" => {
                self.relay(from, &room_id, &v);
                self.end_room(&room_id, &format!("{} disconnected", from.as_str()));
            }
            _ => self.reject(
                from,
                &room_id,
                "unexpected_type",
                &format!("'{msg_type}' not accepted from a client"),
            ),
        }
    }

    fn approve(&self, room_id: &str, granted_scopes: Vec<String>) {
        let session_id = Uuid::new_v4().to_string();
        // `peer_missing` is decided under the lock but reported after it is
        // released: `reject` re-enters `relay_to`, which takes this same
        // non-reentrant mutex, so rejecting in place deadlocked the whole LAN
        // hub — every room on this desktop, for the rest of the process.
        let mut peer_missing = false;
        {
            let mut rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
            let Some(room) = rooms.get_mut(room_id) else {
                return;
            };
            if room.session_id.is_some() {
                return;
            }
            if room.desktop.is_none() || room.mobile.is_none() {
                peer_missing = true;
            } else {
                room.session_id = Some(session_id.clone());
                room.scopes = granted_scopes.clone();
            }
        }
        if peer_missing {
            self.reject(
                Role::Desktop,
                room_id,
                "peer_missing",
                "both peers must be present to approve",
            );
            return;
        }

        let start = json!({
            "sessionId": session_id,
            "grantedScopes": granted_scopes,
            "iceServers": [],
            "iceTransportPolicy": "all",
        });
        for role in [Role::Desktop, Role::Mobile] {
            self.send_to(role, room_id, "session-start", start.clone());
        }
    }

    fn relay(&self, from: Role, room_id: &str, msg: &Value) {
        self.relay_to(from.other(), room_id, msg);
    }

    fn relay_to(&self, to: Role, room_id: &str, msg: &Value) {
        let raw = msg.to_string();
        let seat_send = {
            let mut rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
            let Some(room) = rooms.get_mut(room_id) else {
                return;
            };
            let seat = match to {
                Role::Desktop => room.desktop.as_ref(),
                Role::Mobile => room.mobile.as_ref(),
            };
            match seat {
                Some(seat) => Some(seat.send.clone()),
                None => {
                    let pending = match to {
                        Role::Desktop => &mut room.pending_desktop,
                        Role::Mobile => &mut room.pending_mobile,
                    };
                    if pending.len() < MAX_PENDING_FRAMES {
                        pending.push(raw.clone());
                    } else {
                        log::warn!(
                            target: "lilypad::lan",
                            "dropping frame for the unseated {} of room {room_id} — buffer full",
                            to.as_str()
                        );
                    }
                    None
                }
            }
        };
        if let Some(send) = seat_send {
            send(&raw);
        }
    }

    /// Send an already-serialized frame to a seated peer.
    fn send_raw(&self, to: Role, room_id: &str, raw: &str) {
        let seat_send = {
            let rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
            let room = rooms.get(room_id);
            room.and_then(|room| match to {
                Role::Desktop => room.desktop.as_ref(),
                Role::Mobile => room.mobile.as_ref(),
            })
            .map(|seat| seat.send.clone())
        };
        if let Some(send) = seat_send {
            send(raw);
        }
    }

    fn send_to(&self, to: Role, room_id: &str, msg_type: &str, payload: Value) {
        let from = to.other();
        let msg = json!({
            "type": msg_type,
            "roomId": room_id,
            "from": from.as_str(),
            "ts": now_ms(),
            "payload": payload,
        });
        self.relay_to(to, room_id, &msg);
    }

    fn reject(&self, to: Role, room_id: &str, code: &str, message: &str) {
        self.send_to(
            to,
            room_id,
            "error",
            json!({ "code": code, "message": message }),
        );
    }

    fn end_room(&self, room_id: &str, reason: &str) {
        let seats;
        {
            let mut rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
            let Some(room) = rooms.remove(room_id) else {
                return;
            };
            seats = (room.desktop, room.mobile);
        }
        let end = |role: Role, seat: &Seat| {
            let msg = json!({
                "type": "session-end",
                "roomId": room_id,
                "from": role.other().as_str(),
                "ts": now_ms(),
                "payload": { "reason": reason },
            });
            (seat.send)(msg.to_string().as_str());
        };
        if let Some(d) = seats.0.as_ref() {
            end(Role::Desktop, d);
        }
        if let Some(m) = seats.1.as_ref() {
            end(Role::Mobile, m);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn capture_send() -> (SendFn, Arc<StdMutex<Vec<String>>>) {
        let buf = Arc::new(StdMutex::new(Vec::new()));
        let b2 = buf.clone();
        let send: SendFn = Arc::new(move |s| {
            b2.lock().unwrap().push(s.to_owned());
        });
        (send, buf)
    }

    fn register(hub: &LanHub, room: &str, role: Role, device: &str, send: SendFn) -> SeatToken {
        hub.attach(room, role, device.into(), send).unwrap()
    }

    #[test]
    fn pair_approved_mints_session_start_for_both_peers() {
        let hub = LanHub::new();
        let (d_send, d_out) = capture_send();
        let (m_send, m_out) = capture_send();
        register(&hub, "room-1", Role::Desktop, "desktop-12345678", d_send);
        register(&hub, "room-1", Role::Mobile, "mobile-12345678", m_send);

        hub.handle(
            Role::Desktop,
            r#"{"type":"pair-approved","roomId":"room-1","from":"desktop","ts":0,"payload":{"grantedScopes":["view","control"],"trust":false}}"#,
        );

        let mobile_frames: Vec<Value> = m_out
            .lock()
            .unwrap()
            .iter()
            .filter_map(|s| serde_json::from_str(s).ok())
            .collect();
        assert!(mobile_frames.iter().any(|v| v["type"] == "session-start"));
        let desktop_frames: Vec<Value> = d_out
            .lock()
            .unwrap()
            .iter()
            .filter_map(|s| serde_json::from_str(s).ok())
            .collect();
        assert!(desktop_frames.iter().any(|v| v["type"] == "session-start"));
    }

    /// Approving with only one seat filled must report `peer_missing` — and
    /// must RETURN. `reject` re-enters `relay_to`, which takes the same
    /// non-reentrant mutex `approve` was holding, so this used to deadlock the
    /// hub: not just this room, every room on the desktop, for the life of the
    /// process. Reachable from the ordinary case of a phone that closed its
    /// socket while the user was looking at the approve prompt.
    #[test]
    fn approving_without_a_peer_reports_it_instead_of_deadlocking() {
        let hub = LanHub::new();
        let (d_send, d_out) = capture_send();
        register(&hub, "room-1", Role::Desktop, "desktop-12345678", d_send);

        hub.handle(
            Role::Desktop,
            r#"{"type":"pair-approved","roomId":"room-1","from":"desktop","ts":0,"payload":{"grantedScopes":["view"],"trust":false}}"#,
        );

        let frames: Vec<Value> = d_out
            .lock()
            .unwrap()
            .iter()
            .filter_map(|s| serde_json::from_str(s).ok())
            .collect();
        assert!(
            frames
                .iter()
                .any(|v| v["type"] == "error" && v["payload"]["code"] == "peer_missing"),
            "expected a peer_missing error, got {frames:?}"
        );
        assert!(
            !frames.iter().any(|v| v["type"] == "session-start"),
            "a session must not start with one seat empty"
        );
    }

    /// A frame for a seat that has not attached yet is held, not dropped: the
    /// phone gets the room id the instant `/connect/request` returns and can
    /// ring before the desktop has finished taking its seat.
    #[test]
    fn frames_for_an_unseated_peer_are_replayed_on_attach() {
        let hub = LanHub::new();
        let (m_send, _) = capture_send();
        register(&hub, "room-1", Role::Mobile, "mobile-12345678", m_send);

        hub.handle(
            Role::Mobile,
            r#"{"type":"pair-request","roomId":"room-1","from":"mobile","ts":0,"payload":{"deviceId":"mobile-12345678","deviceName":"phone","requestedScopes":["view"]}}"#,
        );

        let (d_send, d_out) = capture_send();
        register(&hub, "room-1", Role::Desktop, "desktop-12345678", d_send);

        let frames: Vec<Value> = d_out
            .lock()
            .unwrap()
            .iter()
            .filter_map(|s| serde_json::from_str(s).ok())
            .collect();
        assert!(
            frames.iter().any(|v| v["type"] == "pair-request"),
            "the buffered ring must reach the desktop, got {frames:?}"
        );
    }

    /// L-182, trigger 1: a phone whose signaling socket flaps.
    ///
    /// The phone re-registers over a fresh socket, and only then does the dying
    /// one reach the end of `handle_ws` and release "the mobile seat". Released
    /// by role, that teardown deleted the seat the phone had just taken: the
    /// desktop's `session-start` was relayed to nobody and the ring died with
    /// the phone still showing "Waiting for approval…".
    #[test]
    fn a_flapping_phone_is_not_evicted_by_the_socket_it_replaced() {
        let hub = LanHub::new();
        let (d_send, _) = capture_send();
        register(&hub, "room-1", Role::Desktop, "desktop-12345678", d_send);

        let (old_send, _) = capture_send();
        let old = register(&hub, "room-1", Role::Mobile, "mobile-12345678", old_send);
        let (new_send, new_out) = capture_send();
        register(&hub, "room-1", Role::Mobile, "mobile-12345678", new_send);

        hub.detach("room-1", Role::Mobile, old);

        assert!(
            hub.has_seat("room-1", Role::Mobile),
            "the re-registered phone must keep the seat its own dead socket vacated"
        );
        hub.handle(
            Role::Desktop,
            r#"{"type":"pair-approved","roomId":"room-1","from":"desktop","ts":0,"payload":{"grantedScopes":["view"],"trust":false}}"#,
        );
        let frames: Vec<Value> = new_out
            .lock()
            .unwrap()
            .iter()
            .filter_map(|s| serde_json::from_str(s).ok())
            .collect();
        assert!(
            frames.iter().any(|v| v["type"] == "session-start"),
            "the phone's live socket must receive the approval, got {frames:?}"
        );
    }

    /// L-182, trigger 2, reduced to the hub: re-taking a seat and then
    /// releasing the previous claim must not empty — and so delete — the room.
    ///
    /// This is the shape `lan::loopback` produces when the desktop reconnects:
    /// a second `attach` for the same room and role, then the first claim's
    /// release. Deleting the room here closed the desktop's brand-new inbound
    /// channel, which its session runner reads as another transport drop, and
    /// it reconnected into the same trap forever.
    #[test]
    fn re_taking_a_seat_survives_the_previous_claims_release() {
        let hub = LanHub::new();
        let (first, _) = capture_send();
        let first_token = register(&hub, "room-1", Role::Desktop, "desktop-12345678", first);
        let (second, _) = capture_send();
        register(&hub, "room-1", Role::Desktop, "desktop-12345678", second);

        hub.detach("room-1", Role::Desktop, first_token);

        assert!(
            hub.has_seat("room-1", Role::Desktop),
            "the reconnected desktop must still hold its seat"
        );
    }

    /// The other half of the guarantee: the transport that DOES still own the
    /// seat releases it, and an empty room is still cleaned up. Without this
    /// the epoch check would be a memory leak dressed as a fix.
    #[test]
    fn the_current_holder_can_still_vacate_and_empty_the_room() {
        let hub = LanHub::new();
        let (send, _) = capture_send();
        let token = register(&hub, "room-1", Role::Desktop, "desktop-12345678", send);

        hub.detach("room-1", Role::Desktop, token);

        assert!(!hub.has_seat("room-1", Role::Desktop));
        assert!(
            hub.rooms.lock().unwrap().is_empty(),
            "a room with no peers left must be dropped"
        );
    }

    #[test]
    fn offer_relays_mobile_bound() {
        let hub = LanHub::new();
        let (d_send, d_out) = capture_send();
        let (m_send, _) = capture_send();
        register(&hub, "r", Role::Desktop, "desktop-12345678", d_send);
        register(&hub, "r", Role::Mobile, "mobile-12345678", m_send);

        hub.handle(
            Role::Desktop,
            r#"{"type":"offer","roomId":"r","from":"desktop","ts":0,"payload":{"type":"offer","sdp":"v=0"}}"#,
        );

        let frames: Vec<Value> = d_out
            .lock()
            .unwrap()
            .iter()
            .filter_map(|s| serde_json::from_str(s).ok())
            .collect();
        assert!(frames.is_empty());
        // offer goes to mobile — check via m_out would need separate capture; re-wire:
        let hub2 = LanHub::new();
        let (_ds, _) = capture_send();
        let (ms, m_out2) = capture_send();
        register(&hub2, "r", Role::Desktop, "desktop-12345678", _ds);
        register(&hub2, "r", Role::Mobile, "mobile-12345678", ms);
        hub2.handle(
            Role::Desktop,
            r#"{"type":"offer","roomId":"r","from":"desktop","ts":0,"payload":{"type":"offer","sdp":"v=0"}}"#,
        );
        let mobile: Vec<Value> = m_out2
            .lock()
            .unwrap()
            .iter()
            .filter_map(|s| serde_json::from_str(s).ok())
            .collect();
        assert_eq!(mobile[0]["type"], "offer");
    }
}
