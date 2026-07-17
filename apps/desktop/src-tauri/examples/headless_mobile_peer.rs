//! Headless "mobile" peer — speaks real signaling (register/pair-request) AND
//! performs real WebRTC negotiation (answers the desktop's offer, trickles
//! ICE) so the connection actually reaches Connected. Used to drive the real
//! desktop `run_session` (via `headless_offer`) all the way to
//! `start_media_pipeline`, proving the live session's capture-kind selection
//! and permission-error surfacing end-to-end — not just in a unit test.
//!
//!   LILYPAD_SIGNALING=ws://localhost:8080/ws/signal \
//!   LILYPAD_ROOM=<roomId> cargo run --example headless_mobile_peer

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_credential_type::RTCIceCredentialType;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;

#[tokio::main]
async fn main() {
    let signaling = std::env::var("LILYPAD_SIGNALING").expect("LILYPAD_SIGNALING not set");
    let room = std::env::var("LILYPAD_ROOM").expect("LILYPAD_ROOM not set");
    let device = std::env::var("LILYPAD_DEVICE").unwrap_or_else(|_| "mobile-headless".into());

    let (ws, _) = connect_async(&signaling).await.expect("connect signaling");
    let (mut sink, mut stream) = ws.split();

    // One outbound channel; a task owns the sink exclusively (mirrors the
    // real signaling client's architecture).
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        while let Some(v) = out_rx.recv().await {
            if sink.send(Message::Text(v.to_string())).await.is_err() {
                break;
            }
        }
    });

    let send = |v: Value| out_tx.send(v);

    send(json!({"type":"register","roomId":room,"from":"mobile","ts":0,"payload":{"role":"mobile","deviceId":device}})).ok();
    tokio::time::sleep(Duration::from_millis(150)).await;
    send(json!({"type":"pair-request","roomId":room,"from":"mobile","ts":0,"payload":{"deviceId":device,"deviceName":"headless mobile","requestedScopes":["view","control"]}})).ok();
    eprintln!("[mobile] registered + pair-request sent, waiting for session-start...");

    // Wait for session-start to get ICE servers.
    let mut ice_servers: Vec<RTCIceServer> = vec![];
    loop {
        let Some(Ok(Message::Text(txt))) = stream.next().await else {
            continue;
        };
        let v: Value = serde_json::from_str(&txt).unwrap();
        if v["type"] == "session-start" {
            for s in v["payload"]["iceServers"].as_array().unwrap() {
                ice_servers.push(RTCIceServer {
                    urls: vec![s["urls"].as_str().unwrap_or_default().to_string()],
                    username: s["username"].as_str().unwrap_or_default().to_string(),
                    credential: s["credential"].as_str().unwrap_or_default().to_string(),
                    credential_type: RTCIceCredentialType::Password,
                });
            }
            eprintln!(
                "[mobile] session-start received, {} ICE servers",
                ice_servers.len()
            );
            break;
        }
    }

    let mut media = MediaEngine::default();
    media.register_default_codecs().unwrap();
    let mut registry = webrtc::interceptor::registry::Registry::new();
    registry = register_default_interceptors(registry, &mut media).unwrap();
    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build();
    let pc = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers,
            ..Default::default()
        })
        .await
        .unwrap(),
    );

    {
        pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
            eprintln!("[mobile] connection state: {s}");
            Box::pin(async {})
        }));
    }
    // Count real incoming RTP video packets — definitive proof media flows.
    let rtp_count = Arc::new(std::sync::atomic::AtomicU64::new(0));
    {
        let rtp_count = Arc::clone(&rtp_count);
        let pc_for_pli = Arc::clone(&pc);
        pc.on_track(Box::new(move |track, _receiver, _transceiver| {
            let rtp_count = Arc::clone(&rtp_count);
            let pc_for_pli = Arc::clone(&pc_for_pli);
            Box::pin(async move {
                eprintln!("[mobile] on_track fired, reading RTP...");
                // Exercise the desktop's PLI handling: after 4s of stream,
                // send a real PictureLossIndication like a viewer whose
                // decoder lost its reference frame would.
                {
                    let media_ssrc = track.ssrc();
                    let pc2 = Arc::clone(&pc_for_pli);
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(4)).await;
                        let pli = PictureLossIndication {
                            sender_ssrc: 0,
                            media_ssrc,
                        };
                        match pc2.write_rtcp(&[Box::new(pli)]).await {
                            Ok(_) => eprintln!("[mobile] sent PLI for ssrc {media_ssrc}"),
                            Err(e) => eprintln!("[mobile] PLI send failed: {e}"),
                        }
                    });
                }
                tokio::spawn(async move {
                    while let Ok((pkt, _)) = track.read_rtp().await {
                        if !pkt.payload.is_empty() {
                            let n =
                                rtp_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                            if n <= 3 || n % 30 == 0 {
                                eprintln!(
                                    "[mobile] RTP video packet #{n}, {} bytes",
                                    pkt.payload.len()
                                );
                            }
                        }
                    }
                });
            })
        }));
    }
    {
        let room2 = room.clone();
        let out_tx2 = out_tx.clone();
        pc.on_ice_candidate(Box::new(move |c| {
            let room2 = room2.clone();
            let out_tx2 = out_tx2.clone();
            Box::pin(async move {
                if let Some(c) = c {
                    if let Ok(init) = c.to_json() {
                        let msg = json!({"type":"ice-candidate","roomId":room2,"from":"mobile","ts":0,
                            "payload":{"candidate":init.candidate,"sdpMid":init.sdp_mid,"sdpMLineIndex":init.sdp_mline_index}});
                        let _ = out_tx2.send(msg);
                    }
                }
            })
        }));
    }

    // Main receive loop: handle offer/ice-candidate/error/session-end from signaling.
    let run_secs: u64 = std::env::var("LILYPAD_MOBILE_RUN_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    let deadline = tokio::time::sleep(Duration::from_secs(run_secs));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => {
                eprintln!("[mobile] timeout waiting for events");
                break;
            }
            msg = stream.next() => {
                let Some(Ok(Message::Text(txt))) = msg else { break };
                let v: Value = serde_json::from_str(&txt).unwrap();
                match v["type"].as_str().unwrap_or("") {
                    "offer" => {
                        let sdp = v["payload"]["sdp"].as_str().unwrap().to_string();
                        pc.set_remote_description(RTCSessionDescription::offer(sdp).unwrap()).await.unwrap();
                        let answer = pc.create_answer(None).await.unwrap();
                        pc.set_local_description(answer.clone()).await.unwrap();
                        send(json!({"type":"answer","roomId":room,"from":"mobile","ts":0,
                            "payload":{"type":"answer","sdp":answer.sdp}})).ok();
                        eprintln!("[mobile] answer sent");
                    }
                    "ice-candidate" => {
                        let c = &v["payload"];
                        let _ = pc.add_ice_candidate(RTCIceCandidateInit {
                            candidate: c["candidate"].as_str().unwrap_or_default().to_string(),
                            sdp_mid: c["sdpMid"].as_str().map(|s| s.to_string()),
                            sdp_mline_index: c["sdpMLineIndex"].as_u64().map(|n| n as u16),
                            username_fragment: None,
                        }).await;
                    }
                    "error" => {
                        eprintln!("[mobile] signaling error: {}", v["payload"]);
                    }
                    "session-end" | "disconnect" => {
                        eprintln!("[mobile] session ended: {v}");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    tokio::time::sleep(Duration::from_secs(3)).await;
    let total = rtp_count.load(std::sync::atomic::Ordering::Relaxed);
    eprintln!("[mobile] TOTAL RTP VIDEO PACKETS RECEIVED: {total}");

    // A real assertion, not an eyeball check (docs/audit/m3/testing-reliability.md
    // Finding 6, redesign item 1): a companion script can now check this
    // process's exit code instead of a human reading the packet count above.
    const MIN_EXPECTED_RTP_PACKETS: u64 = 10;
    if total < MIN_EXPECTED_RTP_PACKETS {
        eprintln!(
            "[mobile] FAIL: expected at least {MIN_EXPECTED_RTP_PACKETS} real RTP video packets, got {total}"
        );
        std::process::exit(1);
    }
    eprintln!("[mobile] PASS: real media flowed end-to-end ({total} RTP video packets)");
}
