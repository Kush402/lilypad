//! Characterization test for `run_session`'s full connect path: register →
//! pair-request → approve → session-start → offer/answer → trickle ICE →
//! `ConnectionState("connected")` → `InputChannelOpen` → disconnect. This is
//! the single most refactor-risky path in the M3 architecture audit's target
//! for decomposition (it's the reason `peer`/`pipeline`/`abr`/`ice_restarts`
//! all live in one `select!` loop today) — real ICE/DTLS, not a stub, exactly
//! like `tests/rtc_media_e2e.rs` proves the media pipeline itself.
//!
//! Its own test binary: sets `LILYPAD_CAPTURE_KIND`/`LILYPAD_ENCODER_KIND` so
//! the media pipeline `run_session` starts on "connected" uses the synthetic/
//! software backends (deterministic, no Screen-Recording permission, no
//! hardware dependency) instead of the real macOS capture path.

mod support;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use lilypad_desktop_lib::session::{run_session, Control, SessionEvent};
use lilypad_desktop_lib::signaling::messages::DeviceKind;
use lilypad_desktop_lib::signaling::Envelope;
use support::{expect_event, expect_outbound, fake_signaling_server, inbound};
use tokio::sync::mpsc::{self, unbounded_channel, UnboundedReceiver, UnboundedSender};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

/// How long to wait for the unreliable move channel, in 50 ms ticks — ten
/// seconds. Generous on purpose: the loop exits the moment the channel opens,
/// so the budget costs a healthy run nothing and only bounds the failure.
const MOVE_CHANNEL_POLLS: usize = 200;

const ROOM: &str = "room-1";
const DEVICE: &str = "desktop-01";

/// Drain `from_desktop_rx` for the lifetime of the test: forward every
/// "ice-candidate" envelope straight into the (fake mobile) answerer, and
/// re-emit everything else on a fresh channel so the main test flow can still
/// `expect_outbound` on message types it cares about (offer, disconnect, ...).
/// A single `UnboundedReceiver` can only have one consumer, and the test needs
/// to react to two different concerns (ICE relay vs. assertions) on the same
/// stream of outbound envelopes — this is the seam that reconciles them.
fn spawn_ice_forwarder(
    mut from_desktop_rx: UnboundedReceiver<Envelope>,
    answerer: Arc<RTCPeerConnection>,
) -> UnboundedReceiver<Envelope> {
    let (tx, rx) = mpsc::unbounded_channel::<Envelope>();
    tokio::spawn(async move {
        while let Some(env) = from_desktop_rx.recv().await {
            if env.msg_type == "ice-candidate" {
                let candidate = env.payload["candidate"].as_str().unwrap_or("").to_owned();
                let sdp_mid = env.payload["sdpMid"].as_str().map(str::to_owned);
                let sdp_mline_index = env.payload["sdpMLineIndex"].as_u64().map(|v| v as u16);
                let _ = answerer
                    .add_ice_candidate(RTCIceCandidateInit {
                        candidate,
                        sdp_mid,
                        sdp_mline_index,
                        username_fragment: None,
                    })
                    .await;
            } else if tx.send(env).is_err() {
                break;
            }
        }
    });
    rx
}

/// Everything a test needs once a session has reached `connected`, media is
/// flowing, and both input channels are open — shared by every test in this
/// file so each one only has to script what's specific to it.
struct ConnectedSession {
    handle: tokio::task::JoinHandle<anyhow::Result<()>>,
    control_tx: UnboundedSender<Control>,
    event_rx: UnboundedReceiver<SessionEvent>,
    /// Push an envelope here to have the desktop receive it as an inbound
    /// signaling message (role-playing the backend relaying a mobile
    /// message) — e.g. a `set-capture-mode` request.
    to_desktop: UnboundedSender<Envelope>,
    from_desktop: UnboundedReceiver<Envelope>,
    answerer: Arc<RTCPeerConnection>,
    rtp_count: Arc<AtomicU64>,
}

/// Drive a real session from scratch through pair-request → approve →
/// session-start → offer/answer → ICE → `connected`, with real media
/// flowing — the exact sequence `full_handshake_reaches_connected_and_opens_input_channel`
/// used to inline directly; extracted so a second test (the capture-mode
/// switch) doesn't have to duplicate the whole handshake to get to the same
/// starting point.
async fn connect_and_stream() -> ConnectedSession {
    std::env::set_var("LILYPAD_CAPTURE_KIND", "synthetic");
    std::env::set_var("LILYPAD_ENCODER_KIND", "software");

    let (url, to_desktop, from_desktop) = fake_signaling_server().await;
    let (control_tx, control_rx) = unbounded_channel::<Control>();
    let (event_tx, mut event_rx) = unbounded_channel::<SessionEvent>();

    let handle = tokio::spawn(run_session(
        url,
        ROOM.to_owned(),
        DEVICE.to_owned(),
        control_rx,
        event_tx,
    ));

    // ── Fake mobile answerer: plain webrtc-rs, no app code — exactly the
    // shape `examples/headless_mobile_peer.rs` uses to prove real negotiation.
    let mut media = MediaEngine::default();
    media.register_default_codecs().expect("register codecs");
    let mut registry = webrtc::interceptor::registry::Registry::new();
    registry = register_default_interceptors(registry, &mut media).expect("interceptors");
    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build();
    let answerer = Arc::new(
        api.new_peer_connection(RTCConfiguration::default())
            .await
            .expect("answerer pc"),
    );

    let rtp_count = Arc::new(AtomicU64::new(0));
    {
        let rtp_count = Arc::clone(&rtp_count);
        answerer.on_track(Box::new(move |track, _receiver, _transceiver| {
            let rtp_count = Arc::clone(&rtp_count);
            Box::pin(async move {
                tokio::spawn(async move {
                    while let Ok((pkt, _)) = track.read_rtp().await {
                        if !pkt.payload.is_empty() {
                            rtp_count.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                });
            })
        }));
    }

    // The desktop (offerer) creates both the critical and the unreliable
    // move input channel up front (`rtc/mod.rs`) — proves the second channel
    // negotiates end to end through the REAL session runner, not just the
    // bare `WebRtcPeer` (already covered by `rtc_media_e2e.rs`/
    // `rtc_abr_e2e.rs`). See docs/audit/m3/input-touch.md Finding 2.
    let saw_move_channel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let saw_move_channel = Arc::clone(&saw_move_channel);
        answerer.on_data_channel(Box::new(move |dc| {
            if dc.label() == "lilypad-input-move" {
                saw_move_channel.store(true, Ordering::Relaxed);
            }
            Box::pin(async {})
        }));
    }

    // Answerer's local ICE candidates → the desktop, via the fake signaling
    // server (as the real backend would relay them from the mobile seat).
    {
        let to_desktop = to_desktop.clone();
        answerer.on_ice_candidate(Box::new(move |c| {
            let to_desktop = to_desktop.clone();
            Box::pin(async move {
                if let Some(c) = c {
                    if let Ok(init) = c.to_json() {
                        let _ = to_desktop.send(inbound(
                            "ice-candidate",
                            ROOM,
                            DeviceKind::Mobile,
                            serde_json::json!({
                                "candidate": init.candidate,
                                "sdpMid": init.sdp_mid,
                                "sdpMLineIndex": init.sdp_mline_index,
                            }),
                        ));
                    }
                }
            })
        }));
    }

    // Desktop's ICE candidates arrive as outbound envelopes on `from_desktop`;
    // split that stream so ICE relay and test assertions don't fight over the
    // one receiver.
    let mut from_desktop = spawn_ice_forwarder(from_desktop, Arc::clone(&answerer));

    // ── Drive the pairing handshake exactly like a real phone would.
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
    expect_event(&mut event_rx, "PairRequested", |e| {
        matches!(e, SessionEvent::PairRequested { .. })
    })
    .await;

    control_tx
        .send(Control::Approve {
            scopes: vec!["view".into(), "control".into()],
            trust: false,
        })
        .expect("send approve");
    expect_outbound(&mut from_desktop, "pair-approved").await;

    // Real backend behavior: approval triggers `session-start` with fresh ICE
    // servers (empty here — loopback connects fine on host candidates alone,
    // exactly as `tests/rtc_media_e2e.rs` already proves for the raw peers).
    to_desktop
        .send(inbound(
            "session-start",
            ROOM,
            // The real backend relays `session-start` to the desktop
            // "as" the mobile counterpart (`SignalingHub.send`'s
            // `from: to === 'desktop' ? 'mobile' : 'desktop'`) — there
            // is no third "server" role on the wire.
            DeviceKind::Mobile,
            serde_json::json!({
                "sessionId": "test-session-1",
                "grantedScopes": ["view", "control"],
                "iceServers": [],
            }),
        ))
        .expect("send session-start");

    // ── Negotiate: desktop is the offerer (per rtc/mod.rs), our fake mobile
    // answers.
    let offer_env = expect_outbound(&mut from_desktop, "offer").await;
    let offer_sdp = offer_env.payload["sdp"]
        .as_str()
        .expect("offer sdp")
        .to_owned();

    answerer
        .set_remote_description(RTCSessionDescription::offer(offer_sdp).unwrap())
        .await
        .expect("set remote offer");
    let answer = answerer.create_answer(None).await.expect("create answer");
    answerer
        .set_local_description(answer.clone())
        .await
        .expect("set local answer");

    to_desktop
        .send(inbound(
            "answer",
            ROOM,
            DeviceKind::Mobile,
            serde_json::json!({ "type": "answer", "sdp": answer.sdp }),
        ))
        .expect("send answer");

    // ── The payoff: real ICE + DTLS + SRTP bring the desktop's own peer to
    // `connected`, and its input DataChannel (offerer-created) opens.
    expect_event(
        &mut event_rx,
        "ConnectionState(connected)",
        |e| matches!(e, SessionEvent::ConnectionState { state } if state == "connected"),
    )
    .await;
    expect_event(&mut event_rx, "InputChannelOpen", |e| {
        matches!(e, SessionEvent::InputChannelOpen)
    })
    .await;

    // The unreliable move channel is negotiated in the same SDP as the
    // critical channel, so it should already have arrived by the time the
    // critical one has opened; a poll absorbs any residual scheduling slack
    // instead of asserting on an exact ordering guarantee.
    //
    // The budget was twenty ticks — one second — and one second is a statement
    // about the machine, not about the code. This test drives a real ICE, DTLS
    // and SRTP handshake, and it failed once on a CI runner with
    //
    //   the desktop never opened the unreliable move input channel
    //
    // on a commit that changed nothing but a markdown file. The loop breaks the
    // instant the flag is set, so a healthy run is exactly as fast as before
    // and only a channel that genuinely never opens pays the full wait. Same
    // reasoning as `input_worker.rs`'s twenty-second deadlines.
    let mut saw_move = false;
    for _ in 0..MOVE_CHANNEL_POLLS {
        if saw_move_channel.load(Ordering::Relaxed) {
            saw_move = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        saw_move,
        "the desktop never opened the unreliable move input channel (lilypad-input-move)"
    );

    // Media really flows once connected — the same proof rtc_media_e2e.rs
    // gives the raw pipeline, now exercised through the actual session FSM's
    // `start_media_pipeline` wiring (peer-connected → pipeline start → ABR
    // controller created → samples sent).
    let mut received = 0;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        received = rtp_count.load(Ordering::Relaxed);
        if received > 5 {
            break;
        }
    }
    assert!(
        received > 0,
        "connected session produced no RTP video — start_media_pipeline wiring regressed"
    );

    ConnectedSession {
        handle,
        control_tx,
        event_rx,
        to_desktop,
        from_desktop,
        answerer,
        rtp_count,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_handshake_reaches_connected_and_opens_input_channel() {
    let ConnectedSession {
        handle,
        control_tx,
        mut event_rx,
        mut from_desktop,
        answerer,
        ..
    } = connect_and_stream().await;

    // ── Teardown: explicit Disconnect ends the runner and tells the peer.
    control_tx
        .send(Control::Disconnect)
        .expect("send disconnect");
    expect_outbound(&mut from_desktop, "disconnect").await;
    let ended = expect_event(&mut event_rx, "Ended", |e| {
        matches!(e, SessionEvent::Ended { .. })
    })
    .await;
    match ended {
        SessionEvent::Ended { reason } => assert_eq!(reason, "disconnected"),
        _ => unreachable!(),
    }

    let _ = answerer.close().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
}

/// A mobile-initiated `set-capture-mode` request forces a real capture+
/// encoder rebuild — this is the one behavior `MediaController::set_mode`
/// added that no existing test exercised (stopping and immediately
/// restarting the pipeline while a live `WebRtcPeer`/video track is running).
/// Proves: the desktop doesn't crash/hang across the rebuild, sends a fresh
/// `frame-size` reflecting the new mode/dimensions, and RTP keeps flowing
/// afterward. See `docs/audit/m3/prior-art.md` Finding 2.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_capture_mode_request_rebuilds_the_pipeline_and_keeps_streaming() {
    let ConnectedSession {
        handle,
        control_tx,
        mut event_rx,
        to_desktop,
        mut from_desktop,
        answerer,
        rtp_count,
    } = connect_and_stream().await;

    // Drain the frame-size the initial connect already sent (Motion mode,
    // synthetic capture's 1280x720 default) — the fixture under test is the
    // fresh one the mode switch below sends.
    expect_outbound(&mut from_desktop, "frame-size").await;

    // ── Mobile requests Text mode.
    to_desktop
        .send(inbound(
            "set-capture-mode",
            ROOM,
            DeviceKind::Mobile,
            serde_json::json!({ "mode": "text" }),
        ))
        .expect("send set-capture-mode");

    // A fresh frame-size reflecting the new mode/dimensions proves the
    // rebuild actually happened — synthetic capture has no real display to
    // query, so it falls back to Text mode's literal 1920x1080 fixture (see
    // `media::mode::CaptureMode::fallback_dimensions`).
    let frame_size_env = expect_outbound(&mut from_desktop, "frame-size").await;
    assert_eq!(frame_size_env.payload["mode"], "text");
    assert_eq!(frame_size_env.payload["width"], 1920);
    assert_eq!(frame_size_env.payload["height"], 1080);

    // The pipeline survived the rebuild and kept producing RTP — require the
    // count to climb further from wherever it already was rather than
    // asserting an absolute floor, since stopping and restarting the
    // pipeline doesn't reset the encoder's own running RTP sequence.
    let baseline = rtp_count.load(Ordering::Relaxed);
    let mut climbed = false;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if rtp_count.load(Ordering::Relaxed) > baseline {
            climbed = true;
            break;
        }
    }
    assert!(
        climbed,
        "no RTP video after the capture-mode switch — the rebuilt pipeline never started streaming"
    );

    // ── Teardown.
    control_tx
        .send(Control::Disconnect)
        .expect("send disconnect");
    expect_outbound(&mut from_desktop, "disconnect").await;
    expect_event(&mut event_rx, "Ended", |e| {
        matches!(e, SessionEvent::Ended { .. })
    })
    .await;

    let _ = answerer.close().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
}
