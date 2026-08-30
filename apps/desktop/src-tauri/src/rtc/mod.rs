//! Real WebRTC peer (webrtc-rs). The desktop is the **offerer**: it sends an
//! H.264 video track and opens the `lilypad-input` DataChannel for phone →
//! desktop input. ICE uses the STUN/TURN servers the backend issues in
//! `session-start`.
//!
//! Named `rtc` to avoid clashing with the `webrtc` crate.

use std::sync::atomic::{AtomicU64, Ordering};
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
use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
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

/// Which ICE candidates this peer is allowed to use. `All` is normal ICE
/// (host/srflx/relay). `Relay` is the fallback when a "direct" pair carries
/// RTP but never opens the input DataChannel — SCTP over some CGNAT/srflx
/// pairs is a known WebRTC failure mode; TURN UDP already gathered in those
/// sessions and is what actually delivers control.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IcePolicy {
    #[default]
    All,
    Relay,
}

/// One-line diagnostic form of an SDP candidate string: its type (host/
/// srflx/relay), transport, and address — enough to tell whether a relay
/// path exists without logging the full attribute soup.
fn summarize_candidate(candidate: &str) -> String {
    let fields: Vec<&str> = candidate.split_whitespace().collect();
    let transport = fields.get(2).copied().unwrap_or("?");
    let addr = fields.get(4).copied().unwrap_or("?");
    let port = fields.get(5).copied().unwrap_or("?");
    let typ = fields
        .windows(2)
        .find(|w| w[0] == "typ")
        .and_then(|w| w.get(1).copied())
        .unwrap_or("?");
    format!("typ {typ} {transport} {addr}:{port}")
}

/// Which way the media is actually travelling, once ICE has settled.
///
/// This is the question every connectivity report has to answer and that no
/// amount of candidate logging does: candidates are what each side *offered*,
/// and a session that offered a relay candidate may well have ended up direct
/// (or the reverse). Only the selected pair says what happened.
///
/// The three values are the three cases that mean something different to a
/// person and to the cost model: on the same network, over the internet
/// directly, and through the TURN relay — the last being the one that costs
/// bandwidth and adds latency.
pub const PATH_LAN: &str = "lan";
pub const PATH_DIRECT: &str = "direct";
pub const PATH_RELAY: &str = "relay";

/// Classify a selected candidate pair, as printed by `RTCIceCandidatePair`'s
/// `Display`: `(local) udp host 10.0.0.2:54321 <-> (remote) udp srflx …`.
///
/// Formatted text rather than the typed fields because the pair's `local` and
/// `remote` are private in webrtc-0.11 and `Display` is the only accessor it
/// offers. The parse is correspondingly defensive: an unrecognised shape
/// reports `direct` rather than guessing `lan`, because claiming a session is
/// local when it might be relayed is the wrong way to be wrong.
pub fn classify_candidate_pair(pair: &str) -> &'static str {
    if pair.contains("relay") {
        return PATH_RELAY;
    }
    // `host` on BOTH sides is the only combination that means "neither side
    // needed to go outside its own network". One host plus one server-reflexive
    // is an ordinary internet connection.
    let sides: Vec<&str> = pair.split("<->").collect();
    if sides.len() == 2 && sides.iter().all(|side| side.contains("host")) {
        return PATH_LAN;
    }
    PATH_DIRECT
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

/// Generation counter so a replaced PeerConnection cannot kill the session
/// that superseded it. `next()` before `close()` of the old peer: its
/// `ConnectionState("closed")` / DataChannel-closed events are dropped at
/// send and never reach the runner. Proven 2026-08-30T16:57:31Z, room
/// `4c8d1ca3` — a LAN rejoin `session-start` closed the live peer, the
/// queued `closed` ended the runner, phone stuck on Negotiating….
#[derive(Clone, Default)]
pub struct PeerEventGate {
    live: Arc<AtomicU64>,
}

impl PeerEventGate {
    pub fn new() -> Self {
        Self {
            live: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Invalidate every earlier generation and return the id the next peer
    /// must stamp.
    pub fn next(&self) -> u64 {
        self.live.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn allows(&self, mine: u64) -> bool {
        // SeqCst to match `next()`: a webrtc callback on another thread
        // must not observe a stale generation after the runner has bumped.
        self.live.load(Ordering::SeqCst) == mine
    }
}

#[derive(Clone)]
struct EventSink {
    tx: UnboundedSender<PeerEvent>,
    gate: PeerEventGate,
    mine: u64,
}

impl EventSink {
    fn send(&self, ev: PeerEvent) {
        if self.gate.allows(self.mine) {
            let _ = self.tx.send(ev);
            return;
        }
        // Death-shaped events are the ones that used to kill the runner.
        // Log them so a kill→reopen retest shows the gate, not silence.
        match &ev {
            PeerEvent::ConnectionState(s) => {
                log::info!(
                    target: "lilypad::rtc",
                    "dropping superseded peer ConnectionState({s})"
                );
            }
            PeerEvent::InputChannelClosed => {
                log::info!(
                    target: "lilypad::rtc",
                    "dropping superseded peer InputChannelClosed"
                );
            }
            _ => {}
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
    /// back to the phone (`send_input_text`).
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
        Self::with_ice_policy(ice_servers, events, IcePolicy::All).await
    }

    pub async fn with_ice_policy(
        ice_servers: Vec<IceServerConfig>,
        events: UnboundedSender<PeerEvent>,
        policy: IcePolicy,
    ) -> Result<Self> {
        let gate = PeerEventGate::new();
        let mine = gate.next();
        Self::with_gated_events(ice_servers, events, policy, gate, mine).await
    }

    pub async fn with_gated_events(
        ice_servers: Vec<IceServerConfig>,
        events: UnboundedSender<PeerEvent>,
        policy: IcePolicy,
        gate: PeerEventGate,
        mine: u64,
    ) -> Result<Self> {
        let events = EventSink {
            tx: events,
            gate,
            mine,
        };
        let api = build_api()?;
        let config = RTCConfiguration {
            ice_servers: ice_servers.into_iter().map(RTCIceServer::from).collect(),
            ice_transport_policy: match policy {
                IcePolicy::All => RTCIceTransportPolicy::All,
                IcePolicy::Relay => RTCIceTransportPolicy::Relay,
            },
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
                            ev.send(PeerEvent::VideoKeyframeRequest);
                        } else if let Some(remb) =
                            any.downcast_ref::<ReceiverEstimatedMaximumBitrate>()
                        {
                            ev.send(PeerEvent::VideoRemb {
                                bitrate_bps: remb.bitrate as u64,
                            });
                        } else if let Some(rr) = any.downcast_ref::<ReceiverReport>() {
                            if let Some(worst) = rr.reports.iter().map(|r| r.fraction_lost).max() {
                                ev.send(PeerEvent::VideoLossReport {
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
                    ev.send(PeerEvent::InputChannelOpen);
                })
            }));
        }
        {
            let ev = events.clone();
            input_channel.on_close(Box::new(move || {
                let ev = ev.clone();
                Box::pin(async move {
                    ev.send(PeerEvent::InputChannelClosed);
                })
            }));
        }
        {
            let ev = events.clone();
            input_channel.on_message(Box::new(move |msg| {
                let ev = ev.clone();
                let data = msg.data.to_vec();
                Box::pin(async move {
                    ev.send(PeerEvent::InputMessage(data));
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
                    ev.send(PeerEvent::InputMessage(data));
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
                            // Candidate-type visibility (host/srflx/relay) is the
                            // load-bearing diagnostic for "why did cellular ICE
                            // fail" — a session with no relay candidate on either
                            // side can only ride fragile direct pairs.
                            log::info!(
                                target: "lilypad::rtc",
                                "local candidate: {}", summarize_candidate(&init.candidate)
                            );
                            ev.send(PeerEvent::IceCandidate {
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
                    ev.send(PeerEvent::ConnectionState(s.to_string()));
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

    /// The path the connection actually settled on, or `None` while ICE is
    /// still choosing. See `classify_candidate_pair`.
    pub async fn connection_path(&self) -> Option<&'static str> {
        let pair = self
            .pc
            .sctp()
            .transport()
            .ice_transport()
            .get_selected_candidate_pair()
            .await?;
        let described = pair.to_string();
        log::info!(target: "lilypad::rtc", "selected candidate pair: {described}");
        Some(classify_candidate_pair(&described))
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
        log::info!(
            target: "lilypad::rtc",
            "remote candidate: {}", summarize_candidate(&candidate)
        );
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
    /// Send a UTF-8 text frame to the phone on the reliable input channel
    /// (desktop → phone agent step feed). TEXT, not binary: react-native-
    /// webrtc delivers binary frames as ArrayBuffer, and the phone's
    /// agent-frame parser (JSON) accepts only strings — binary frames were
    /// silently dropped, leaving the phone stuck on "Thinking…" forever.
    pub async fn send_input_text(&self, data: String) -> Result<()> {
        self.input_channel.send_text(data).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_sides_on_their_own_network_is_lan() {
        assert_eq!(
            classify_candidate_pair(
                "(local) udp host 10.0.0.2:54321 <-> (remote) udp host 10.0.0.7:51000"
            ),
            PATH_LAN
        );
    }

    #[test]
    fn a_reflexive_side_means_the_internet_not_the_lan() {
        assert_eq!(
            classify_candidate_pair(
                "(local) udp host 10.0.0.2:54321 <-> (remote) udp srflx 203.0.113.9:51000"
            ),
            PATH_DIRECT
        );
    }

    #[test]
    fn a_relay_on_either_side_is_a_relayed_session() {
        assert_eq!(
            classify_candidate_pair(
                "(local) udp relay 198.51.100.4:49200 <-> (remote) udp srflx 203.0.113.9:51000"
            ),
            PATH_RELAY
        );
        assert_eq!(
            classify_candidate_pair(
                "(local) udp host 10.0.0.2:54321 <-> (remote) udp relay 198.51.100.4:49200"
            ),
            PATH_RELAY
        );
    }

    #[test]
    fn an_unrecognised_pair_reports_direct_rather_than_lan() {
        assert_eq!(classify_candidate_pair(""), PATH_DIRECT);
        assert_eq!(
            classify_candidate_pair("something else entirely"),
            PATH_DIRECT
        );
    }

    #[test]
    fn bumping_the_gate_drops_the_previous_generation() {
        let gate = PeerEventGate::new();
        let first = gate.next();
        assert!(gate.allows(first));
        let second = gate.next();
        assert!(!gate.allows(first));
        assert!(gate.allows(second));
    }

    #[test]
    fn superseded_peer_events_never_reach_the_runner() {
        // The 16:57:31 stall: bump, then close() of the live peer. Its
        // ConnectionState("closed") / DataChannel-closed / ICE-failed must
        // not land — those are what `handle_peer_event` treats as runner
        // death. The new generation still delivers, including a later
        // closed that MUST end the session (in-app hangup, ICE actually
        // dead, counterpart gone via the PC).
        let gate = PeerEventGate::new();
        let old = gate.next();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let old_sink = EventSink {
            tx: tx.clone(),
            gate: gate.clone(),
            mine: old,
        };
        old_sink.send(PeerEvent::ConnectionState("connected".into()));

        let live = gate.next();
        let live_sink = EventSink {
            tx: tx.clone(),
            gate: gate.clone(),
            mine: live,
        };

        old_sink.send(PeerEvent::ConnectionState("failed".into()));
        old_sink.send(PeerEvent::ConnectionState("closed".into()));
        old_sink.send(PeerEvent::InputChannelClosed);

        live_sink.send(PeerEvent::ConnectionState("connecting".into()));
        live_sink.send(PeerEvent::IceCandidate {
            candidate: "candidate:1".into(),
            sdp_mid: Some("0".into()),
            sdp_mline_index: Some(0),
        });
        live_sink.send(PeerEvent::ConnectionState("closed".into()));
        live_sink.send(PeerEvent::InputChannelClosed);

        match rx.try_recv() {
            Ok(PeerEvent::ConnectionState(s)) => assert_eq!(s, "connected"),
            other => panic!("expected the pre-bump connected, got {other:?}"),
        }
        match rx.try_recv() {
            Ok(PeerEvent::ConnectionState(s)) => assert_eq!(s, "connecting"),
            other => panic!("expected the new generation connecting, got {other:?}"),
        }
        match rx.try_recv() {
            Ok(PeerEvent::IceCandidate { candidate, .. }) => {
                assert_eq!(candidate, "candidate:1")
            }
            other => panic!("expected the new generation ICE, got {other:?}"),
        }
        match rx.try_recv() {
            Ok(PeerEvent::ConnectionState(s)) => assert_eq!(s, "closed"),
            other => panic!("expected the live generation closed, got {other:?}"),
        }
        match rx.try_recv() {
            Ok(PeerEvent::InputChannelClosed) => {}
            other => panic!("expected the live generation DC closed, got {other:?}"),
        }
        assert!(
            rx.try_recv().is_err(),
            "old-generation death events must not have landed"
        );
    }
}
