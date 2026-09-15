//! WebSocket signaling client for the desktop. Connects to the backend, then
//! runs a writer task (outbound envelopes) and a reader task (inbound envelopes
//! delivered on a channel). Transport-only — the session runner owns the logic.

pub mod messages;

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::header::AUTHORIZATION, Message},
};

pub use messages::Envelope;

/// A WebSocket that never finishes TCP/TLS/HTTP negotiation must not own a
/// session forever. Mirrors `SIGNALING_OPEN_TIMEOUT_MS` in
/// `packages/protocol/src/constants.ts` / the mobile client.
const SIGNALING_OPEN_TIMEOUT: Duration = Duration::from_secs(10);

/// Handle for sending envelopes to the signaling server.
#[derive(Clone)]
pub struct SignalingHandle {
    out: UnboundedSender<Envelope>,
}

impl SignalingHandle {
    /// Wrap an already-owned outbound channel. Exists for the LAN loopback
    /// transport (`lan::loopback`), which carries envelopes to the embedded hub
    /// in-process instead of over a socket — see that module for why a socket
    /// is the wrong transport for a desktop talking to its own LAN server.
    pub fn from_sender(out: UnboundedSender<Envelope>) -> Self {
        Self { out }
    }

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
    connect_with_timeout(url, token, SIGNALING_OPEN_TIMEOUT).await
}

async fn connect_with_timeout(
    url: &str,
    token: Option<&str>,
    timeout: Duration,
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
    let (ws, _resp) = tokio::time::timeout(timeout, connect_async(request))
        .await
        .map_err(|_| {
            anyhow!(
                "signaling connect timed out after {}ms",
                timeout.as_millis()
            )
        })?
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Hardware evidence, 2026-09-14: a trusted ring sat inside
    /// `connect_async` for 59 seconds and could neither register nor fail back
    /// to a retry. The phone's equivalent has had a 10-second bound since
    /// v0.1.21; the desktop must make the same guarantee.
    #[tokio::test]
    async fn a_server_that_accepts_tcp_but_never_finishes_the_handshake_is_bounded() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });

        let error = match connect_with_timeout(
            &format!("ws://{addr}/ws/signal"),
            None,
            Duration::from_millis(40),
        )
        .await
        {
            Ok(_) => panic!("an unfinished handshake unexpectedly connected"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("timed out after 40ms"),
            "unexpected error: {error:#}"
        );
        server.abort();
    }
}
