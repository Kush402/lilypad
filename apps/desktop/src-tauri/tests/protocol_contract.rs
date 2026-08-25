//! Cross-language protocol contract: reads the SAME fixture file
//! `apps/backend/src/protocol.contract.test.ts` validates against the zod
//! schema, and deserializes every entry through this crate's hand-mirrored
//! serde types instead. A fixture that fails here but passes there (or vice
//! versa) is real, actionable drift between the two independently-maintained
//! protocol implementations — see the M3 architecture audit's Finding F4.
//!
//! Only message types with a dedicated Rust payload struct get a
//! field-level cross-check beyond "the envelope itself deserializes" — the
//! others (register/pair-approved/pair-denied/session-end/error/ping/pong/
//! heartbeat/pause/resume/renegotiate/disconnect/frame-size/clipboard-update)
//! are handled by the desktop purely as a generic `Envelope` with ad hoc
//! `payload` field access (frame-size and clipboard-update are desktop→mobile
//! only, so the desktop only ever constructs them — it never deserializes
//! one), so there is no dedicated struct for them to drift out of sync with.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use lilypad_desktop_lib::signaling::messages::{
    CaptureMode, IceCandidatePayload, PairRequestPayload, SdpPayload, SdpType, SessionScope,
    SessionStartPayload, SetCaptureModePayload, SetDisplayPayload,
};
use lilypad_desktop_lib::signaling::Envelope;
use serde_json::Value;

const ALL_MESSAGE_TYPES: &[&str] = &[
    "register",
    "pair-request",
    "pair-approved",
    "pair-denied",
    "offer",
    "answer",
    "ice-candidate",
    "session-start",
    "session-end",
    "error",
    "ping",
    "pong",
    "heartbeat",
    "pause",
    "resume",
    "renegotiate",
    "disconnect",
    "frame-size",
    "clipboard-update",
    "set-capture-mode",
    "set-display",
];

fn load_fixtures() -> HashMap<String, Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/protocol/fixtures/signaling-messages.json");
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read fixture file at {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("fixture file is not valid JSON")
}

#[test]
fn fixture_file_has_exactly_one_entry_per_declared_message_type() {
    let fixtures = load_fixtures();
    let mut fixture_types: Vec<&str> = fixtures.keys().map(String::as_str).collect();
    fixture_types.sort_unstable();
    let mut expected: Vec<&str> = ALL_MESSAGE_TYPES.to_vec();
    expected.sort_unstable();
    assert_eq!(
        fixture_types, expected,
        "fixture file's keys must match the full message-type list exactly"
    );
}

#[test]
fn every_fixture_deserializes_as_a_valid_envelope() {
    let fixtures = load_fixtures();
    for msg_type in ALL_MESSAGE_TYPES {
        let fixture = fixtures
            .get(*msg_type)
            .unwrap_or_else(|| panic!("no fixture found for message type '{msg_type}'"));
        let raw = serde_json::to_string(fixture).unwrap();
        let env: Envelope = serde_json::from_str(&raw).unwrap_or_else(|e| {
            panic!("fixture '{msg_type}' failed to deserialize as Envelope: {e}")
        });
        assert_eq!(env.msg_type, *msg_type);
    }
}

#[test]
fn pair_request_payload_matches_the_fixture_field_for_field() {
    let fixtures = load_fixtures();
    let env: Envelope = serde_json::from_value(fixtures["pair-request"].clone()).unwrap();
    let payload: PairRequestPayload = serde_json::from_value(env.payload).unwrap();
    assert_eq!(payload.device_id, "mobile-fixture-01");
    assert_eq!(payload.device_name.as_deref(), Some("Fixture iPhone"));
    assert_eq!(
        payload.requested_scopes,
        vec![SessionScope::View, SessionScope::Control]
    );
}

#[test]
fn offer_and_answer_payloads_match_the_fixtures() {
    let fixtures = load_fixtures();

    let offer_env: Envelope = serde_json::from_value(fixtures["offer"].clone()).unwrap();
    let offer: SdpPayload = serde_json::from_value(offer_env.payload).unwrap();
    assert_eq!(offer.sdp_type, SdpType::Offer);
    assert!(offer.sdp.starts_with("v=0"));

    let answer_env: Envelope = serde_json::from_value(fixtures["answer"].clone()).unwrap();
    let answer: SdpPayload = serde_json::from_value(answer_env.payload).unwrap();
    assert_eq!(answer.sdp_type, SdpType::Answer);
    assert!(answer.sdp.starts_with("v=0"));
}

#[test]
fn ice_candidate_payload_matches_the_fixture_including_the_now_bounded_sdp_mline_index() {
    let fixtures = load_fixtures();
    let env: Envelope = serde_json::from_value(fixtures["ice-candidate"].clone()).unwrap();
    let payload: IceCandidatePayload = serde_json::from_value(env.payload).unwrap();
    assert!(payload.candidate.starts_with("candidate:"));
    assert_eq!(payload.sdp_mid.as_deref(), Some("0"));
    assert_eq!(payload.sdp_mline_index, Some(0));
}

#[test]
fn session_start_payload_matches_the_fixture_including_ice_servers() {
    let fixtures = load_fixtures();
    let env: Envelope = serde_json::from_value(fixtures["session-start"].clone()).unwrap();
    let payload: SessionStartPayload = serde_json::from_value(env.payload).unwrap();
    assert_eq!(payload.session_id, "session-fixture-01");
    assert_eq!(
        payload.granted_scopes,
        vec![SessionScope::View, SessionScope::Control]
    );
    assert_eq!(payload.ice_servers.len(), 2);
    assert_eq!(
        payload.ice_servers[0].url_list(),
        vec!["stun:stun.fixture.example:3478"]
    );
    assert_eq!(
        payload.ice_servers[1].url_list(),
        vec!["turn:turn.fixture.example:3478"]
    );
    assert_eq!(
        payload.ice_servers[1].username.as_deref(),
        Some("fixture-user")
    );
}

#[test]
fn set_capture_mode_payload_matches_the_fixture() {
    let fixtures = load_fixtures();
    let env: Envelope = serde_json::from_value(fixtures["set-capture-mode"].clone()).unwrap();
    let payload: SetCaptureModePayload = serde_json::from_value(env.payload).unwrap();
    assert_eq!(payload.mode, CaptureMode::Text);
}

#[test]
fn set_display_payload_matches_the_fixture() {
    let fixtures = load_fixtures();
    let env: Envelope = serde_json::from_value(fixtures["set-display"].clone()).unwrap();
    let payload: SetDisplayPayload = serde_json::from_value(env.payload).unwrap();
    assert_eq!(payload.display_id, 2);
}
