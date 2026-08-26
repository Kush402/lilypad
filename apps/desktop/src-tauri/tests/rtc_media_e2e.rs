//! Gold-standard media E2E: the desktop pipeline streams real H.264 that a
//! second WebRTC peer actually receives as RTP. Proves synthetic capture →
//! convert → openh264 → track → RTP packetize → ICE/DTLS/SRTP → remote receipt,
//! entirely in-process (loopback ICE, no device).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use lilypad_desktop_lib::media::{EncodedSample, MediaPipeline, PipelineConfig};
use lilypad_desktop_lib::rtc::{PeerEvent, WebRtcPeer};

use tokio::sync::mpsc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_streams_real_rtp_to_receiving_peer() {
    // ── Offerer: our production WebRtcPeer (adds the H.264 track + DataChannel).
    let (off_ev_tx, mut off_ev_rx) = mpsc::unbounded_channel::<PeerEvent>();
    let offerer = Arc::new(
        WebRtcPeer::new(vec![], off_ev_tx)
            .await
            .expect("offerer peer"),
    );

    // ── Answerer: a plain webrtc-rs peer that receives the video track.
    let mut media = MediaEngine::default();
    media.register_default_codecs().unwrap();
    let mut registry = webrtc::interceptor::registry::Registry::new();
    registry = register_default_interceptors(registry, &mut media).unwrap();
    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build();
    let answerer = Arc::new(
        api.new_peer_connection(RTCConfiguration::default())
            .await
            .unwrap(),
    );

    // Count RTP packets received on the incoming track.
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

    // Answerer's local ICE candidates → offerer.
    let (ans_cand_tx, mut ans_cand_rx) = mpsc::unbounded_channel::<RTCIceCandidateInit>();
    answerer.on_ice_candidate(Box::new(move |c| {
        let tx = ans_cand_tx.clone();
        Box::pin(async move {
            if let Some(c) = c {
                if let Ok(init) = c.to_json() {
                    let _ = tx.send(init);
                }
            }
        })
    }));

    // ── Negotiate.
    let offer_sdp = offerer.create_offer().await.expect("offer");
    answerer
        .set_remote_description(RTCSessionDescription::offer(offer_sdp).unwrap())
        .await
        .unwrap();
    let answer = answerer.create_answer(None).await.unwrap();
    answerer
        .set_local_description(answer.clone())
        .await
        .unwrap();
    offerer.set_answer(answer.sdp).await.expect("set answer");

    // ── Trickle ICE both ways.
    {
        let answerer2 = Arc::clone(&answerer);
        tokio::spawn(async move {
            while let Some(ev) = off_ev_rx.recv().await {
                if let PeerEvent::IceCandidate {
                    candidate,
                    sdp_mid,
                    sdp_mline_index,
                } = ev
                {
                    let _ = answerer2
                        .add_ice_candidate(RTCIceCandidateInit {
                            candidate,
                            sdp_mid,
                            sdp_mline_index,
                            username_fragment: None,
                        })
                        .await;
                }
            }
        });
    }
    {
        let offerer2 = Arc::clone(&offerer);
        tokio::spawn(async move {
            while let Some(init) = ans_cand_rx.recv().await {
                let _ = offerer2
                    .add_ice_candidate(init.candidate, init.sdp_mid, init.sdp_mline_index)
                    .await;
            }
        });
    }

    // ── Feed the offerer's track from the media pipeline.
    let mut cfg = PipelineConfig::default();
    cfg.capture.width = 320;
    cfg.capture.height = 240;
    cfg.encoder.width = 320;
    cfg.encoder.height = 240;
    let (tx, mut rx) = mpsc::channel::<EncodedSample>(30);
    let mut pipeline = MediaPipeline::start(cfg, tx).expect("pipeline");
    {
        let offerer3 = Arc::clone(&offerer);
        tokio::spawn(async move {
            let dur = Duration::from_millis(33);
            while let Some(s) = rx.recv().await {
                if offerer3.send_video_sample(s.data, dur).await.is_err() {
                    break;
                }
            }
        });
    }

    // ── Wait for RTP to arrive (loopback ICE + DTLS + SRTP typically < 5s).
    let mut received = 0;
    for _ in 0..150 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        received = rtp_count.load(Ordering::Relaxed);
        if received > 10 {
            break;
        }
    }

    pipeline.stop();
    let _ = offerer.close().await;
    let _ = answerer.close().await;

    assert!(
        received > 0,
        "the receiving peer got no RTP video packets — media did not flow"
    );
    eprintln!("✓ receiver got {received} RTP video packets over real WebRTC");
}
mod common;
