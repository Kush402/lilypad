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

type SendFn = Arc<dyn Fn(&str) + Send + Sync>;

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
        let mut rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
        let room = rooms.entry(room_id.to_owned()).or_insert_with(|| Room {
            desktop: None,
            mobile: None,
            session_id: None,
            scopes: vec!["view".into()],
            established: false,
        });
        let seat = Seat { device_id, send };
        match role {
            Role::Desktop => room.desktop = Some(seat),
            Role::Mobile => room.mobile = Some(seat),
        }
        Ok(())
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
        {
            let mut rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
            let Some(room) = rooms.get_mut(room_id) else {
                return;
            };
            if room.session_id.is_some() {
                return;
            }
            if room.desktop.is_none() || room.mobile.is_none() {
                self.reject(
                    Role::Desktop,
                    room_id,
                    "peer_missing",
                    "both peers must be present to approve",
                );
                return;
            }
            room.session_id = Some(session_id.clone());
            room.scopes = granted_scopes.clone();
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
        let rooms = self.rooms.lock().unwrap_or_else(|p| p.into_inner());
        let Some(room) = rooms.get(room_id) else {
            return;
        };
        let seat = match to {
            Role::Desktop => room.desktop.as_ref(),
            Role::Mobile => room.mobile.as_ref(),
        };
        if let Some(seat) = seat {
            (seat.send)(msg.to_string().as_str());
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
