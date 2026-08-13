//! WebSocket signaling client for the desktop. Connects to the backend, then
//! runs a writer task (outbound envelopes) and a reader task (inbound envelopes
//! delivered on a channel). Transport-only — the session runner owns the logic.

pub mod messages;

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::header::AUTHORIZATION, Message},
};

pub use messages::Envelope;

/// Handle for sending envelopes to the signaling server.
#[derive(Clone)]
pub struct SignalingHandle {
    out: UnboundedSender<Envelope>,
}

impl SignalingHandle {
    pub fn send(&self, env: Envelope) -> Result<()> {
        self.out
            .send(env)
            .map_err(|e| anyhow!("signaling send failed: {e}"))
    }
}

/// Connect to `url` (e.g. ws://host/ws/signal). Returns a send handle and a
/// receiver of inbound envelopes. Both writer + reader run as background tasks
/// that end when the socket closes.
///
/// `token` identifies this computer to the backend for the whole socket. It is
/// presented on the upgrade request rather than inside a signaling frame,
/// because a WebSocket carries no per-message headers and a bearer token in a
/// routed payload would spread through logs and relay paths.
///
/// Required for the PRESENCE room (M9): that room is claimed by naming a
/// device, with no server-minted record behind it, so the token is what proves
/// the claim. Session rooms pass `None` — the backend authorizes those against
/// a room record it minted itself in response to an already-authorized
/// `/pairing/create` or `/connect/request`.
///
/// NOTE: `wss://` needs a TLS feature on tokio-tungstenite (added for prod).
pub async fn connect(
    url: &str,
    token: Option<&str>,
) -> Result<(SignalingHandle, UnboundedReceiver<Envelope>)> {
    let mut request = url
        .into_client_request()
        .map_err(|e| anyhow!("bad signaling url {url}: {e}"))?;
    if let Some(token) = token {
        let value = format!("Bearer {token}")
            .parse()
            .map_err(|e| anyhow!("device token is not a valid header value: {e}"))?;
        request.headers_mut().insert(AUTHORIZATION, value);
    }
    let (ws, _resp) = connect_async(request)
        .await
        .map_err(|e| anyhow!("signaling connect failed: {e}"))?;
    let (mut sink, mut stream) = ws.split();

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Envelope>();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Envelope>();

    // Writer: serialize outbound envelopes to text frames.
    tokio::spawn(async move {
        while let Some(env) = out_rx.recv().await {
            match serde_json::to_string(&env) {
                Ok(txt) => {
                    if sink.send(Message::Text(txt)).await.is_err() {
                        break;
                    }
                }
                Err(e) => log::warn!("signaling: failed to serialize envelope: {e}"),
            }
        }
    });

    // Reader: parse inbound text frames into envelopes.
    tokio::spawn(async move {
        while let Some(next) = stream.next().await {
            match next {
                Ok(Message::Text(t)) => match serde_json::from_str::<Envelope>(t.as_str()) {
                    Ok(env) => {
                        if in_tx.send(env).is_err() {
                            break;
                        }
                    }
                    Err(e) => log::warn!("signaling: bad inbound frame: {e}"),
                },
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {} // ignore ping/pong/binary
            }
        }
    });

    Ok((SignalingHandle { out: out_tx }, in_rx))
}
