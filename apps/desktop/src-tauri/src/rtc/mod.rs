//! Real WebRTC peer (webrtc-rs). The desktop is the **offerer**: it sends an
//! H.264 video track and opens the `lilypad-input` DataChannel for phone →
//! desktop input. ICE uses the STUN/TURN servers the backend issues in
//! `session-start`.
//!
//! Named `rtc` to avoid clashing with the `webrtc` crate.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use bytes::Bytes;
use tokio::sync::mpsc::UnboundedSender;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264};
use webrtc::api::{APIBuilder, API};
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_credential_type::RTCIceCredentialType;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::offer_answer_options::RTCOfferOptions;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate;
use webrtc::rtcp::receiver_report::ReceiverReport;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

/// Mirrors `@lilypad/protocol`'s `INPUT_MOVE_CHANNEL_LABEL`
/// (`packages/protocol/src/constants.ts`) — Rust can't import that TS
/// constant directly.
const INPUT_MOVE_CHANNEL_LABEL: &str = "lilypad-input-move";

/// ICE server config as delivered by the backend `session-start` message.
#[derive(Debug, Clone)]
pub struct IceServerConfig {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

impl From<IceServerConfig> for RTCIceServer {
    fn from(c: IceServerConfig) -> Self {
        RTCIceServer {
            urls: c.urls,
            username: c.username,
            credential: c.credential,
            // MUST be Password for TURN — the enum's default (Unspecified) makes
            // webrtc-rs reject the server with ErrTurnCredentials.
            credential_type: RTCIceCredentialType::Password,
        }
    }
}

/// Events the peer surfaces to its owner (the session runner).
#[derive(Debug, Clone)]
pub enum PeerEvent {
    /// A locally-gathered ICE candidate to trickle to the other peer.
    IceCandidate {
        candidate: String,
        sdp_mid: Option<String>,
        sdp_mline_index: Option<u16>,
    },
    /// PeerConnection state changed (new/connecting/connected/failed/closed).
    ConnectionState(String),
    /// The input DataChannel opened.
    InputChannelOpen,
    /// The input DataChannel closed (peer gone, renegotiation) — the session
    /// must re-close the injection gate even if the PeerConnection lingers.
    InputChannelClosed,
    /// A raw frame arrived on the input DataChannel (phone → desktop).
    InputMessage(Vec<u8>),
    /// RTCP receiver report: worst `fraction_lost` across reports, in [0, 1].
    /// Drives the adaptive-bitrate controller.
    VideoLossReport { fraction_lost: f64 },
    /// RTCP REMB: the receiver's total estimated available bandwidth (bps).
    VideoRemb { bitrate_bps: u64 },
    /// RTCP PLI/FIR: the viewer's decoder lost its reference frame and needs
    /// an immediate IDR.
    VideoKeyframeRequest,
}

/// A single WebRTC session's peer connection.
pub struct WebRtcPeer {
    pc: Arc<RTCPeerConnection>,
    video_track: Arc<TrackLocalStaticSample>,
    /// Kept alive for the peer's lifetime and used to send the agent step feed
    /// back to the phone (`send_input_data`).
    input_channel: Arc<RTCDataChannel>,
    /// Kept alive for the peer's lifetime, same reason as `input_channel`
    /// above — dropping it would close the channel.
    #[allow(dead_code)]
    move_channel: Arc<RTCDataChannel>,
}

impl WebRtcPeer {
    /// Build a peer connection, attach the H.264 video sender + input channel,
    /// and wire callbacks to `events`.
    pub async fn new(
        ice_servers: Vec<IceServerConfig>,
        events: UnboundedSender<PeerEvent>,
    ) -> Result<Self> {
        let api = build_api()?;
        let config = RTCConfiguration {
            ice_servers: ice_servers.into_iter().map(RTCIceServer::from).collect(),
            ..Default::default()
        };
        let pc = Arc::new(api.new_peer_connection(config).await?);

        // Outgoing H.264 video track (samples fed by the encoder in M3).
        let video_track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_owned(),
                ..Default::default()
            },
            "video".to_owned(),
            "lilypad-video".to_owned(),
        ));
        let rtp_sender = pc
            .add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
            .await?;
        // RTCP from the viewer is the feedback channel for adaptive bitrate
        // (receiver-report loss, REMB) and decoder recovery (PLI/FIR) — parse
        // it and surface as events; the session wires them to the pipeline.
        {
            let ev = events.clone();
            tokio::spawn(async move {
                while let Ok((packets, _)) = rtp_sender.read_rtcp().await {
                    for packet in packets {
                        let any = packet.as_any();
                        if any.downcast_ref::<PictureLossIndication>().is_some()
                            || any.downcast_ref::<FullIntraRequest>().is_some()
                        {
                            let _ = ev.send(PeerEvent::VideoKeyframeRequest);
                        } else if let Some(remb) =
                            any.downcast_ref::<ReceiverEstimatedMaximumBitrate>()
                        {
                            let _ = ev.send(PeerEvent::VideoRemb {
                                bitrate_bps: remb.bitrate as u64,
                            });
                        } else if let Some(rr) = any.downcast_ref::<ReceiverReport>() {
                            if let Some(worst) = rr.reports.iter().map(|r| r.fraction_lost).max() {
                                let _ = ev.send(PeerEvent::VideoLossReport {
                                    fraction_lost: f64::from(worst) / 256.0,
                                });
                            }
                        }
                    }
                }
            });
        }

        // Input DataChannel (phone → desktop).
        let input_channel = pc.create_data_channel("lilypad-input", None).await?;
        {
            let ev = events.clone();
            input_channel.on_open(Box::new(move || {
                let ev = ev.clone();
                Box::pin(async move {
                    let _ = ev.send(PeerEvent::InputChannelOpen);
                })
            }));
        }
        {
            let ev = events.clone();
            input_channel.on_close(Box::new(move || {
                let ev = ev.clone();
                Box::pin(async move {
                    let _ = ev.send(PeerEvent::InputChannelClosed);
                })
            }));
        }
        {
            let ev = events.clone();
            input_channel.on_message(Box::new(move |msg| {
                let ev = ev.clone();
                let data = msg.data.to_vec();
                Box::pin(async move {
                    let _ = ev.send(PeerEvent::InputMessage(data));
                })
            }));
        }

        // Second, unreliable input channel for disposable pointer-move/scroll
        // traffic (`maxRetransmits: 0`) — see
        // `docs/audit/m3/input-touch.md` Finding 2. Its open/close state
        // deliberately gates nothing here: `InputGate` continues to key
        // injection off the critical channel alone (see that module's doc
        // comment). Decoded messages funnel into the SAME `PeerEvent::
        // InputMessage` as the critical channel — the dispatcher only sees
        // decoded `InputEvent`s, never which transport delivered them, so no
        // new event variant is needed for this channel's traffic. If this
        // channel never opens (a peer that failed to negotiate it, or a
        // future older client), the mobile sender falls back to the critical
        // channel — pointer moves still work, just without the loss
        // tolerance.
        let move_channel = pc
            .create_data_channel(
                INPUT_MOVE_CHANNEL_LABEL,
                Some(RTCDataChannelInit {
                    ordered: Some(true),
                    max_retransmits: Some(0),
                    ..Default::default()
                }),
            )
            .await?;
        {
            let ev = events.clone();
            move_channel.on_message(Box::new(move |msg| {
                let ev = ev.clone();
                let data = msg.data.to_vec();
                Box::pin(async move {
                    let _ = ev.send(PeerEvent::InputMessage(data));
                })
            }));
        }

        // Trickle local ICE candidates out to the signaling channel.
        {
            let ev = events.clone();
            pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
                let ev = ev.clone();
                Box::pin(async move {
                    if let Some(c) = c {
                        if let Ok(init) = c.to_json() {
                            let _ = ev.send(PeerEvent::IceCandidate {
                                candidate: init.candidate,
                                sdp_mid: init.sdp_mid,
                                sdp_mline_index: init.sdp_mline_index,
                            });
                        }
                    }
                })
            }));
        }

        // Surface connection state changes.
        {
            let ev = events.clone();
            pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
                let ev = ev.clone();
                Box::pin(async move {
                    let _ = ev.send(PeerEvent::ConnectionState(s.to_string()));
                })
            }));
        }

        Ok(Self {
            pc,
            video_track,
            input_channel,
            move_channel,
        })
    }

    /// Create + set the local offer, returning its SDP for signaling.
    pub async fn create_offer(&self) -> Result<String> {
        let offer = self.pc.create_offer(None).await?;
        self.pc.set_local_description(offer.clone()).await?;
        Ok(offer.sdp)
    }

    /// ICE restart: new offer with fresh ICE credentials, for recovering a
    /// `failed` connection (e.g. the network path changed mid-session). The
    /// returned SDP must be re-signaled; the remote answers like any offer.
    pub async fn restart_ice(&self) -> Result<String> {
        let offer = self
            .pc
            .create_offer(Some(RTCOfferOptions {
                ice_restart: true,
                ..Default::default()
            }))
            .await?;
        self.pc.set_local_description(offer.clone()).await?;
        Ok(offer.sdp)
    }

    /// Apply the remote answer SDP.
    pub async fn set_answer(&self, sdp: String) -> Result<()> {
        let answer = RTCSessionDescription::answer(sdp)?;
        self.pc.set_remote_description(answer).await?;
        Ok(())
    }

    /// Add a remote ICE candidate (trickle).
    pub async fn add_ice_candidate(
        &self,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_mline_index: Option<u16>,
    ) -> Result<()> {
        self.pc
            .add_ice_candidate(RTCIceCandidateInit {
                candidate,
                sdp_mid,
                sdp_mline_index,
                username_fragment: None,
            })
            .await?;
        Ok(())
    }

    /// Feed one encoded H.264 access unit to the video track (M3 encoder → here).
    pub async fn send_video_sample(&self, data: Bytes, duration: Duration) -> Result<()> {
        self.video_track
            .write_sample(&Sample {
                data,
                duration,
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    /// Send a frame to the phone over the reliable `lilypad-input` DataChannel
    /// (desktop → phone). Used for the AI agent's step feed — the same channel
    /// the phone sends input/agent frames on, in the reverse direction.
    pub async fn send_input_data(&self, data: Vec<u8>) -> Result<()> {
        self.input_channel.send(&Bytes::from(data)).await?;
        Ok(())
    }

    pub async fn close(&self) -> Result<()> {
        self.pc.close().await?;
        Ok(())
    }
}

fn build_api() -> Result<API> {
    let mut media = MediaEngine::default();
    media.register_default_codecs()?;
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media)?;
    Ok(APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build())
}
