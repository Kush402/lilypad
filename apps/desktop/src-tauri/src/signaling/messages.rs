//! Serde types mirroring `@lilypad/protocol` signaling. The envelope keeps a
//! string `type` + a `serde_json::Value` payload so the client can route on
//! type and deserialize the payload it cares about — no giant tagged enum.
//!
//! The inbound payload structs below enforce the same enum/length bounds as
//! the TS/zod schema they mirror (`packages/protocol/src/signaling.ts`) —
//! defense-in-depth so a malformed or hostile value fails to deserialize
//! here too, not just at the backend's own validation boundary. See
//! `docs/audit/m3/protocol-drift-findings.md`'s "Deferred: Rust-side
//! defense-in-depth gaps" section (findings 1-9; finding 10,
//! `device-name-optionality-leniency`, is deliberately NOT fixed — see the
//! note on `PairRequestPayload::device_name`). Bounds are enforced on
//! DESERIALIZATION only (untrusted wire input); the outbound constructors
//! below are unconstrained because they only ever build a message from the
//! desktop's own already-valid local state (its own device id, its own
//! WebRTC engine's SDP/candidates) — there is no untrusted input to bound
//! on the way out.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub const ROLE_DESKTOP: &str = "desktop";

/// Matches `packages/protocol/src/signaling.ts`'s shared envelope's
/// `roomId: z.string().min(1).max(128)` — MAX only, not the min. The
/// `error` message type overrides that shared TS schema with a bare
/// `z.string()` specifically because an error can be sent before a room is
/// even known (empty `roomId`) — and unlike the TS side's per-message-type
/// schemas, `Envelope` here is one shared struct across every message type,
/// so it can only enforce the bound that holds for all of them.
const MAX_ROOM_ID_LEN: usize = 128;
/// `packages/protocol/src/pairing.ts`/`signaling.ts`: device ids are
/// `z.string().min(8).max(128)`.
const MIN_DEVICE_ID_LEN: usize = 8;
const MAX_DEVICE_ID_LEN: usize = 128;
/// `signaling.ts`'s `MAX_SDP_LEN` — a real SDP is a few KB; this is a
/// defense-in-depth cap, not a realistic size.
const MAX_SDP_LEN: usize = 32 * 1024;
/// `signaling.ts`'s `MAX_CANDIDATE_LEN`.
const MAX_CANDIDATE_LEN: usize = 2 * 1024;
/// `signaling.ts`'s `pairRequest.payload.requestedScopes: z.array(...).max(8)`.
const MAX_REQUESTED_SCOPES: usize = 8;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn deserialize_room_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    if s.len() > MAX_ROOM_ID_LEN {
        return Err(serde::de::Error::custom(format!(
            "roomId length {} exceeds max {MAX_ROOM_ID_LEN}",
            s.len()
        )));
    }
    Ok(s)
}

fn deserialize_device_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    if s.len() < MIN_DEVICE_ID_LEN || s.len() > MAX_DEVICE_ID_LEN {
        return Err(serde::de::Error::custom(format!(
            "deviceId length {} out of bounds [{MIN_DEVICE_ID_LEN}, {MAX_DEVICE_ID_LEN}]",
            s.len()
        )));
    }
    Ok(s)
}

fn deserialize_requested_scopes<'de, D>(deserializer: D) -> Result<Vec<SessionScope>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Vec::<SessionScope>::deserialize(deserializer)?;
    if v.len() > MAX_REQUESTED_SCOPES {
        return Err(serde::de::Error::custom(format!(
            "requestedScopes length {} exceeds max {MAX_REQUESTED_SCOPES}",
            v.len()
        )));
    }
    Ok(v)
}

fn deserialize_sdp<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    if s.len() > MAX_SDP_LEN {
        return Err(serde::de::Error::custom(format!(
            "sdp length {} exceeds max {MAX_SDP_LEN}",
            s.len()
        )));
    }
    Ok(s)
}

fn deserialize_candidate<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    if s.len() > MAX_CANDIDATE_LEN {
        return Err(serde::de::Error::custom(format!(
            "candidate length {} exceeds max {MAX_CANDIDATE_LEN}",
            s.len()
        )));
    }
    Ok(s)
}

/// Mirrors `packages/protocol`'s `DeviceKindSchema` (`z.enum(['desktop',
/// 'mobile'])`) — was `Envelope.from: String`, unconstrained.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    Desktop,
    Mobile,
}

/// Mirrors `signaling.ts`'s `SdpSchema.type: z.enum(['offer', 'answer'])` —
/// was `SdpPayload.sdp_type: String`, unconstrained.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SdpType {
    Offer,
    Answer,
}

/// Mirrors `@lilypad/protocol`'s `SessionScopeSchema` (`z.enum(['view',
/// 'control'])`) — was `Vec<String>` on both `requestedScopes` and
/// `grantedScopes`, with no per-element constraint. Distinct from
/// `crate::input::Scope`, which is the same two-valued domain concept but
/// owned by the input-gating subsystem; `session::mod`'s session-start
/// handler is the one place that bridges the two (a wire-level type
/// shouldn't require the input module to know about serde, and vice versa).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionScope {
    View,
    Control,
}

impl SessionScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionScope::View => "view",
            SessionScope::Control => "control",
        }
    }
}

/// The wire-level representation of `crate::media::CaptureMode`
/// (`docs/audit/m3/prior-art.md` Finding 2), kept as its own small type here
/// rather than reusing `media::CaptureMode` directly — same rationale as
/// `SessionScope` above: a wire-level type shouldn't require the media module
/// to know about serde, and `session::mod`'s handler is the one place that
/// bridges the two.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode {
    Motion,
    Text,
}

impl CaptureMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            CaptureMode::Motion => "motion",
            CaptureMode::Text => "text",
        }
    }
}

/// One attached display, as the phone's switcher shows it. `id` is the OS's
/// `CGDirectDisplayID`; `name` is ours to write, because neither
/// ScreenCaptureKit nor CoreGraphics hands out the marketing name a person
/// would recognise.
///
/// ponytail: names are positional ("Display 2") rather than the monitor's own
/// EDID name. `NSScreen.localizedName` has the real one, but reading it means
/// an AppKit main-thread hop from a pipeline that runs off-thread — worth
/// doing the day a customer with two identical externals asks which is which.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct DisplayInfo {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Envelope {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(rename = "roomId", deserialize_with = "deserialize_room_id")]
    pub room_id: String,
    pub from: DeviceKind,
    pub ts: u64,
    pub payload: serde_json::Value,
}

impl Envelope {
    fn desktop(msg_type: &str, room_id: &str, payload: serde_json::Value) -> Self {
        Self {
            msg_type: msg_type.to_owned(),
            room_id: room_id.to_owned(),
            from: DeviceKind::Desktop,
            ts: now_ms(),
            payload,
        }
    }

    // ── Outbound (desktop → server) ─────────────────────────────────────────
    pub fn register(room_id: &str, device_id: &str) -> Self {
        Self::desktop(
            "register",
            room_id,
            serde_json::json!({ "role": ROLE_DESKTOP, "deviceId": device_id }),
        )
    }
    /// `trust`: the user also checked "Trust this device" — the backend
    /// records a persistent pair enabling the no-QR reconnect (M5.4).
    pub fn pair_approved(room_id: &str, granted_scopes: &[String], trust: bool) -> Self {
        Self::desktop(
            "pair-approved",
            room_id,
            serde_json::json!({ "grantedScopes": granted_scopes, "trust": trust }),
        )
    }
    pub fn pair_denied(room_id: &str, reason: Option<&str>) -> Self {
        Self::desktop(
            "pair-denied",
            room_id,
            serde_json::json!({ "reason": reason }),
        )
    }
    pub fn offer(room_id: &str, sdp: &str) -> Self {
        Self::desktop(
            "offer",
            room_id,
            serde_json::json!({ "type": "offer", "sdp": sdp }),
        )
    }
    pub fn ice_candidate(
        room_id: &str,
        candidate: &str,
        sdp_mid: Option<String>,
        sdp_mline_index: Option<u16>,
    ) -> Self {
        Self::desktop(
            "ice-candidate",
            room_id,
            serde_json::json!({
                "candidate": candidate,
                "sdpMid": sdp_mid,
                "sdpMLineIndex": sdp_mline_index,
            }),
        )
    }
    pub fn disconnect(room_id: &str, reason: Option<&str>) -> Self {
        Self::desktop(
            "disconnect",
            room_id,
            serde_json::json!({ "reason": reason }),
        )
    }
    pub fn heartbeat(room_id: &str) -> Self {
        Self::desktop("heartbeat", room_id, serde_json::json!({}))
    }
    /// A `ping` elicits a `pong` from the hub — used by the presence channel
    /// as an application-level liveness probe (a heartbeat alone gets no
    /// reply, so a half-open socket after sleep/wake is undetectable).
    pub fn ping(room_id: &str) -> Self {
        Self::desktop("ping", room_id, serde_json::json!({}))
    }
    /// Desktop → mobile: current capture resolution and mode, so the phone
    /// can map touches onto the letterboxed video content rect rather than
    /// the whole view (`docs/audit/m3/input-touch.md` Finding 1) and show
    /// which capture mode is active (`docs/audit/m3/prior-art.md` Finding 2).
    pub fn frame_size(
        room_id: &str,
        width: u32,
        height: u32,
        mode: CaptureMode,
        displays: &[DisplayInfo],
        active_display_id: Option<u32>,
    ) -> Self {
        Self::desktop(
            "frame-size",
            room_id,
            serde_json::json!({
                "width": width,
                "height": height,
                "mode": mode.as_str(),
                "displays": displays,
                "activeDisplayId": active_display_id,
            }),
        )
    }
    /// Desktop → mobile: the desktop's OS clipboard changed. See
    /// `docs/audit/m3/prior-art.md` Finding 6.
    pub fn clipboard_update(room_id: &str, text: &str) -> Self {
        Self::desktop(
            "clipboard-update",
            room_id,
            serde_json::json!({ "text": text }),
        )
    }

    /// Desktop → mobile: cached LAN control-plane URLs (NETWORKING §3).
    pub fn lan_endpoints(
        room_id: &str,
        api_base_url: &str,
        signaling_url: &str,
        tls_cert_sha256: &str,
    ) -> Self {
        Self::desktop(
            "lan-endpoints",
            room_id,
            serde_json::json!({
                "apiBaseUrl": api_base_url,
                "signalingUrl": signaling_url,
                "tlsCertSha256": tls_cert_sha256,
            }),
        )
    }
}

// ── Inbound payloads (server/mobile → desktop) ──────────────────────────────

#[derive(Deserialize, Debug, Clone)]
pub struct PairRequestPayload {
    #[serde(rename = "deviceId", deserialize_with = "deserialize_device_id")]
    pub device_id: String,
    // Finding 10 (`device-name-optionality-leniency`, LOW severity) is
    // deliberately NOT fixed: zod requires this key to be present (nullable,
    // not optional), while serde's built-in `Option<T>` field handling
    // treats an omitted key the same as an explicit `null`. Closing that gap
    // precisely requires a custom struct-level `Deserialize` (or a crate
    // like `serde_with`'s `double_option`) to distinguish "key absent" from
    // "key present with null" — real complexity for a field that's purely
    // informational (shown in the approve/deny UI) and where the asymmetry
    // runs in the SAFE direction: Rust accepting a wire shape zod would
    // reject is strictly more permissive, never less, so it cannot itself
    // enable anything zod's own validation boundary already blocks.
    #[serde(rename = "deviceName")]
    pub device_name: Option<String>,
    #[serde(
        rename = "requestedScopes",
        deserialize_with = "deserialize_requested_scopes"
    )]
    pub requested_scopes: Vec<SessionScope>,
}

/// `urls` may be a single string or an array of strings on the wire —
/// mirrors `signaling.ts`'s `IceServerSchema.urls: z.union([z.string(),
/// z.array(z.string())])` exactly. Previously `serde_json::Value`, which
/// deserialized successfully for ANY JSON shape and silently degraded to an
/// empty list via `url_list()` for anything zod would reject outright
/// (a number, an object, an array of numbers, ...) instead of failing loudly.
#[derive(Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum UrlsField {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize, Debug, Clone)]
pub struct IceServerJson {
    pub urls: UrlsField,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

impl IceServerJson {
    /// Normalize `urls` (string | string[]) into a Vec<String>.
    pub fn url_list(&self) -> Vec<String> {
        match &self.urls {
            UrlsField::One(s) => vec![s.clone()],
            UrlsField::Many(a) => a.clone(),
        }
    }
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IceTransportPolicy {
    #[default]
    #[serde(rename = "all")]
    All,
    #[serde(rename = "relay")]
    Relay,
}

#[derive(Deserialize, Debug, Clone)]
pub struct SessionStartPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "grantedScopes")]
    pub granted_scopes: Vec<SessionScope>,
    #[serde(rename = "iceServers")]
    pub ice_servers: Vec<IceServerJson>,
    /// Omitted by older hubs and by the LAN hub; `All` is normal ICE.
    #[serde(rename = "iceTransportPolicy", default)]
    pub ice_transport_policy: IceTransportPolicy,
}

#[derive(Deserialize, Debug, Clone)]
pub struct SdpPayload {
    #[serde(rename = "type")]
    pub sdp_type: SdpType,
    #[serde(deserialize_with = "deserialize_sdp")]
    pub sdp: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct IceCandidatePayload {
    #[serde(deserialize_with = "deserialize_candidate")]
    pub candidate: String,
    #[serde(rename = "sdpMid")]
    pub sdp_mid: Option<String>,
    #[serde(rename = "sdpMLineIndex")]
    pub sdp_mline_index: Option<u16>,
}

/// Server → desktop (mid-session): the phone's SIGNALING transport dropped
/// (`online: false`) or came back (`online: true`). Sent the moment the
/// phone's signaling socket drops mid-session, and again if it re-registers
/// within the grace period. Distinct from peer-to-peer media liveness (RTCP/
/// input, tracked independently via `last_peer_traffic`) — this is purely
/// "does the backend still see the phone's signaling connection", which
/// `session::mod`'s heartbeat tick combines with media liveness to
/// distinguish a genuinely gone phone (app killed / network dead: neither
/// signal present) from a cellular signaling blip with media still flowing.
#[derive(Deserialize, Debug, Clone, Copy)]
pub struct PeerStatusPayload {
    pub online: bool,
}

/// Mobile → desktop: request a capture/encode mode switch. See
/// `docs/audit/m3/prior-art.md` Finding 2.
#[derive(Deserialize, Debug, Clone, Copy)]
pub struct SetCaptureModePayload {
    pub mode: CaptureMode,
}

/// Mobile → desktop: show a different display. The id is checked against the
/// displays actually attached when the switch happens — an unplugged one
/// falls back to the main display rather than failing the request.
#[derive(Deserialize, Debug, Clone, Copy)]
pub struct SetDisplayPayload {
    #[serde(rename = "displayId")]
    pub display_id: u32,
}

/// Server → desktop (presence room, M5.4): a trusted phone asked to connect
/// without a QR. `session_room_id` is the fresh, room-auth-bound room the
/// desktop's session runner should join; `auto_approve` reflects the pair's
/// desktop-side "Always allow" setting. Mirrors `signaling.ts`'s
/// `connect-request` with the same defense-in-depth bounds.
#[derive(Deserialize, Debug, Clone)]
pub struct ConnectRequestPayload {
    #[serde(rename = "sessionRoomId", deserialize_with = "deserialize_room_id")]
    pub session_room_id: String,
    #[serde(rename = "mobileDeviceId", deserialize_with = "deserialize_device_id")]
    pub mobile_device_id: String,
    #[serde(rename = "mobileDeviceName")]
    pub mobile_device_name: Option<String>,
    #[serde(
        rename = "requestedScopes",
        deserialize_with = "deserialize_requested_scopes"
    )]
    pub requested_scopes: Vec<SessionScope>,
    #[serde(rename = "autoApprove")]
    pub auto_approve: bool,
}

/// Server → desktop (presence room): cache a trusted phone for the LAN
/// control plane ([ADR-0006](../../../../../../docs/adr/0006-lan-first-connectivity.md)).
#[derive(Deserialize, Debug, Clone)]
pub struct TrustRecordPayload {
    #[serde(rename = "mobileDeviceId", deserialize_with = "deserialize_device_id")]
    pub mobile_device_id: String,
    #[serde(rename = "connectSecretHash")]
    pub connect_secret_hash: String,
    #[serde(rename = "autoApprove")]
    pub auto_approve: bool,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
}

/// Server → desktop (presence room): authoritative LAN trust-cache replacement.
/// Omissions are revocations — see `TrustCache::replace_all`.
#[derive(Deserialize, Debug, Clone)]
pub struct TrustSyncPayload {
    pub records: Vec<TrustRecordPayload>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_matches_protocol_shape() {
        let env = Envelope::register("room-1", "desktop-abc");
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["type"], "register");
        assert_eq!(v["roomId"], "room-1");
        assert_eq!(v["from"], "desktop");
        assert_eq!(v["payload"]["role"], "desktop");
        assert_eq!(v["payload"]["deviceId"], "desktop-abc");
    }

    #[test]
    fn offer_payload_shape() {
        let v = serde_json::to_value(Envelope::offer("r", "v=0\r\n")).unwrap();
        assert_eq!(v["type"], "offer");
        assert_eq!(v["payload"]["type"], "offer");
        assert_eq!(v["payload"]["sdp"], "v=0\r\n");
    }

    #[test]
    fn ice_candidate_payload_shape() {
        let v = serde_json::to_value(Envelope::ice_candidate(
            "r",
            "cand",
            Some("0".into()),
            Some(0),
        ))
        .unwrap();
        assert_eq!(v["type"], "ice-candidate");
        assert_eq!(v["payload"]["candidate"], "cand");
        assert_eq!(v["payload"]["sdpMid"], "0");
        assert_eq!(v["payload"]["sdpMLineIndex"], 0);
    }

    #[test]
    fn clipboard_update_payload_shape() {
        let v = serde_json::to_value(Envelope::clipboard_update("r", "copied text")).unwrap();
        assert_eq!(v["type"], "clipboard-update");
        assert_eq!(v["payload"]["text"], "copied text");
    }

    #[test]
    fn frame_size_payload_shape() {
        let displays = vec![DisplayInfo {
            id: 7,
            name: "Built-in Display".to_owned(),
            width: 2560,
            height: 1600,
        }];
        let v = serde_json::to_value(Envelope::frame_size(
            "r",
            1920,
            1080,
            CaptureMode::Text,
            &displays,
            Some(7),
        ))
        .unwrap();
        assert_eq!(v["type"], "frame-size");
        assert_eq!(v["payload"]["width"], 1920);
        assert_eq!(v["payload"]["height"], 1080);
        assert_eq!(v["payload"]["mode"], "text");
        assert_eq!(v["payload"]["displays"][0]["id"], 7);
        assert_eq!(v["payload"]["displays"][0]["name"], "Built-in Display");
        assert_eq!(v["payload"]["activeDisplayId"], 7);
    }

    #[test]
    fn set_display_payload_parses_the_wire_camel_case_name() {
        let payload: SetDisplayPayload =
            serde_json::from_value(serde_json::json!({ "displayId": 42 })).unwrap();
        assert_eq!(payload.display_id, 42);
    }

    #[test]
    fn set_capture_mode_payload_parses_from_the_wire_lowercase_names() {
        let payload: SetCaptureModePayload =
            serde_json::from_value(serde_json::json!({ "mode": "text" })).unwrap();
        assert_eq!(payload.mode, CaptureMode::Text);

        let payload: SetCaptureModePayload =
            serde_json::from_value(serde_json::json!({ "mode": "motion" })).unwrap();
        assert_eq!(payload.mode, CaptureMode::Motion);
    }

    #[test]
    fn set_capture_mode_rejects_an_unknown_mode_string() {
        let result: Result<SetCaptureModePayload, _> =
            serde_json::from_value(serde_json::json!({ "mode": "cinematic" }));
        assert!(result.is_err());
    }

    #[test]
    fn parses_session_start_from_backend() {
        // Mirrors what the backend's session-start payload looks like.
        let json = serde_json::json!({
            "sessionId": "sess-1",
            "grantedScopes": ["view", "control"],
            "iceServers": [
                { "urls": "stun:localhost:3478" },
                { "urls": ["turn:localhost:3478"], "username": "1700:sess", "credential": "abc=" }
            ]
        });
        let p: SessionStartPayload = serde_json::from_value(json).unwrap();
        assert_eq!(p.session_id, "sess-1");
        assert_eq!(
            p.granted_scopes,
            vec![SessionScope::View, SessionScope::Control]
        );
        assert_eq!(p.ice_servers.len(), 2);
        assert_eq!(p.ice_servers[0].url_list(), vec!["stun:localhost:3478"]);
        assert_eq!(p.ice_servers[1].url_list(), vec!["turn:localhost:3478"]);
        assert_eq!(p.ice_servers[1].username.as_deref(), Some("1700:sess"));
        assert_eq!(p.ice_transport_policy, IceTransportPolicy::All);
    }

    #[test]
    fn session_start_honours_relay_ice_transport_policy() {
        let json = serde_json::json!({
            "sessionId": "sess-1",
            "grantedScopes": ["view"],
            "iceServers": [],
            "iceTransportPolicy": "relay"
        });
        let p: SessionStartPayload = serde_json::from_value(json).unwrap();
        assert_eq!(p.ice_transport_policy, IceTransportPolicy::Relay);
    }

    #[test]
    fn pair_approved_carries_the_trust_flag() {
        let v = serde_json::to_value(Envelope::pair_approved(
            "r",
            &["view".to_owned(), "control".to_owned()],
            true,
        ))
        .unwrap();
        assert_eq!(v["type"], "pair-approved");
        assert_eq!(v["payload"]["grantedScopes"][1], "control");
        assert_eq!(v["payload"]["trust"], true);
    }

    #[test]
    fn parses_connect_request_and_bounds_its_fields() {
        let json = serde_json::json!({
            "sessionRoomId": "room-fresh",
            "mobileDeviceId": "mobile-01x",
            "mobileDeviceName": "Kush's iPhone",
            "requestedScopes": ["view", "control"],
            "autoApprove": true,
        });
        let p: ConnectRequestPayload = serde_json::from_value(json).unwrap();
        assert_eq!(p.session_room_id, "room-fresh");
        assert_eq!(p.mobile_device_id, "mobile-01x");
        assert!(p.auto_approve);

        // Same defense-in-depth bounds as every other inbound payload.
        let bad = serde_json::json!({
            "sessionRoomId": "r",
            "mobileDeviceId": "short",
            "mobileDeviceName": null,
            "requestedScopes": [],
            "autoApprove": false,
        });
        assert!(serde_json::from_value::<ConnectRequestPayload>(bad).is_err());
    }

    #[test]
    fn parses_pair_request() {
        let json = serde_json::json!({
            "deviceId": "mobile-1",
            "deviceName": "iPhone",
            "requestedScopes": ["view", "control"]
        });
        let p: PairRequestPayload = serde_json::from_value(json).unwrap();
        assert_eq!(p.device_id, "mobile-1");
        assert_eq!(p.device_name.as_deref(), Some("iPhone"));
        assert_eq!(p.requested_scopes.len(), 2);
    }

    #[test]
    fn parses_peer_status() {
        let online: PeerStatusPayload =
            serde_json::from_value(serde_json::json!({ "online": true })).unwrap();
        assert!(online.online);

        let offline: PeerStatusPayload =
            serde_json::from_value(serde_json::json!({ "online": false })).unwrap();
        assert!(!offline.online);
    }

    #[test]
    fn envelope_round_trips() {
        let env = Envelope::heartbeat("room-9");
        let s = serde_json::to_string(&env).unwrap();
        let back: Envelope = serde_json::from_str(&s).unwrap();
        assert_eq!(back.msg_type, "heartbeat");
        assert_eq!(back.room_id, "room-9");
    }

    // ── defense-in-depth: enums + length bounds
    // (docs/audit/m3/protocol-drift-findings.md) ────────────────────────────

    #[test]
    fn envelope_from_rejects_a_role_outside_the_enum() {
        let json = serde_json::json!({
            "type": "heartbeat", "roomId": "r", "from": "admin", "ts": 0, "payload": {}
        });
        assert!(serde_json::from_value::<Envelope>(json).is_err());
    }

    #[test]
    fn envelope_room_id_rejects_over_max_length_but_allows_empty() {
        let too_long = "x".repeat(MAX_ROOM_ID_LEN + 1);
        let over = serde_json::json!({
            "type": "heartbeat", "roomId": too_long, "from": "desktop", "ts": 0, "payload": {}
        });
        assert!(serde_json::from_value::<Envelope>(over).is_err());

        // The `error` message type's legitimate empty-roomId case must still work.
        let empty = serde_json::json!({
            "type": "error", "roomId": "", "from": "desktop", "ts": 0,
            "payload": { "code": "bad_message", "message": "x" }
        });
        assert!(serde_json::from_value::<Envelope>(empty).is_ok());
    }

    #[test]
    fn sdp_type_rejects_anything_outside_offer_or_answer() {
        let json = serde_json::json!({ "type": "garbage", "sdp": "v=0" });
        assert!(serde_json::from_value::<SdpPayload>(json).is_err());
    }

    #[test]
    fn sdp_rejects_over_max_length() {
        let json = serde_json::json!({ "type": "offer", "sdp": "x".repeat(MAX_SDP_LEN + 1) });
        assert!(serde_json::from_value::<SdpPayload>(json).is_err());
    }

    #[test]
    fn sdp_at_exactly_max_length_is_accepted() {
        let json = serde_json::json!({ "type": "offer", "sdp": "x".repeat(MAX_SDP_LEN) });
        assert!(serde_json::from_value::<SdpPayload>(json).is_ok());
    }

    #[test]
    fn ice_candidate_rejects_over_max_length() {
        let json = serde_json::json!({
            "candidate": "x".repeat(MAX_CANDIDATE_LEN + 1),
            "sdpMid": null,
            "sdpMLineIndex": null,
        });
        assert!(serde_json::from_value::<IceCandidatePayload>(json).is_err());
    }

    #[test]
    fn pair_request_device_id_rejects_too_short() {
        let json = serde_json::json!({
            "deviceId": "short", // < 8 chars
            "deviceName": null,
            "requestedScopes": [],
        });
        assert!(serde_json::from_value::<PairRequestPayload>(json).is_err());
    }

    #[test]
    fn pair_request_device_id_rejects_too_long() {
        let json = serde_json::json!({
            "deviceId": "x".repeat(MAX_DEVICE_ID_LEN + 1),
            "deviceName": null,
            "requestedScopes": [],
        });
        assert!(serde_json::from_value::<PairRequestPayload>(json).is_err());
    }

    #[test]
    fn pair_request_requested_scopes_rejects_an_unknown_scope_value() {
        let json = serde_json::json!({
            "deviceId": "mobile-01",
            "deviceName": null,
            "requestedScopes": ["view", "admin"],
        });
        assert!(serde_json::from_value::<PairRequestPayload>(json).is_err());
    }

    #[test]
    fn pair_request_requested_scopes_rejects_over_max_length() {
        let scopes: Vec<&str> = std::iter::repeat_n("view", MAX_REQUESTED_SCOPES + 1).collect();
        let json = serde_json::json!({
            "deviceId": "mobile-01",
            "deviceName": null,
            "requestedScopes": scopes,
        });
        assert!(serde_json::from_value::<PairRequestPayload>(json).is_err());
    }

    #[test]
    fn session_start_granted_scopes_rejects_an_unknown_scope_value() {
        let json = serde_json::json!({
            "sessionId": "s1",
            "grantedScopes": ["view", "superuser"],
            "iceServers": [],
        });
        assert!(serde_json::from_value::<SessionStartPayload>(json).is_err());
    }

    #[test]
    fn ice_server_urls_rejects_a_shape_that_is_neither_string_nor_string_array() {
        let json = serde_json::json!({ "urls": 12345 });
        assert!(serde_json::from_value::<IceServerJson>(json).is_err());

        let json_mixed = serde_json::json!({ "urls": ["ok", 42] });
        assert!(serde_json::from_value::<IceServerJson>(json_mixed).is_err());
    }

    #[test]
    fn ice_server_urls_accepts_both_the_string_and_array_forms() {
        let single: IceServerJson =
            serde_json::from_value(serde_json::json!({ "urls": "stun:x" })).unwrap();
        assert_eq!(single.url_list(), vec!["stun:x"]);

        let many: IceServerJson =
            serde_json::from_value(serde_json::json!({ "urls": ["a", "b"] })).unwrap();
        assert_eq!(many.url_list(), vec!["a", "b"]);
    }
}
