//! Two-peer signaling hub for LAN rooms — mirrors backend `MessageRouter`
//! semantics without Redis, room auth, or multi-tenancy.

use std::collections::HashMap;
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

struct Seat {
    device_id: String,
    send: SendFn,
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
}

impl Default for LanHub {
    fn default() -> Self {
        Self {
            rooms: Mutex::new(HashMap::new()),
        }
    }
}

impl LanHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Attach a WebSocket peer after `register`.
    pub fn attach(
        &self,
        room_id: &str,
        role: Role,
        device_id: String,
        send: SendFn,
    ) -> Result<(), String> {
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
            let seat = Seat { device_id, send };
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
        Ok(())
    }

    /// Whether `role` currently holds a seat in `room_id`.
    pub fn has_seat(&self, room_id: &str, role: Role) -> bool {
        let rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
        rooms.get(room_id).is_some_and(|room| match role {
            Role::Desktop => room.desktop.is_some(),
            Role::Mobile => room.mobile.is_some(),
        })
    }

    pub fn detach(&self, room_id: &str, role: Role) {
        let mut rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(room) = rooms.get_mut(room_id) {
            match role {
                Role::Desktop => room.desktop = None,
                Role::Mobile => room.mobile = None,
            }
            if room.desktop.is_none() && room.mobile.is_none() {
                rooms.remove(room_id);
            }
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

    fn register(hub: &LanHub, room: &str, role: Role, device: &str, send: SendFn) {
        hub.attach(room, role, device.into(), send).unwrap();
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
