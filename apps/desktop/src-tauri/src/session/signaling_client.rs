//! Signaling transport + reconnect, as one owned unit. Previously
//! `run_session` carried the `inbound: Option<UnboundedReceiver<Envelope>>` /
//! `reconnecting: bool` / `recon_tx` / `recon_rx` quadruplet as four
//! independent locals, whose only purpose was making sure the `select!` loop
//! never polled a dead receiver and never double-spawned the background
//! reconnect task — exactly the bookkeeping a dedicated type absorbs for
//! free. `SignalingClient` is that type; the *decision* to attempt a
//! reconnect (vs. treat the drop as fatal) still belongs to the caller, since
//! it depends on whether a WebRTC peer is already up — this type only knows
//! about the signaling socket.

use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc::{self, UnboundedReceiver};

use super::reconnect::ReconnectPolicy;
use crate::lan::LanHub;
use crate::signaling::{self, Envelope, SignalingHandle};

type ReconnectResult = Result<(SignalingHandle, UnboundedReceiver<Envelope>)>;

/// Await the next inbound envelope, or pend forever when there is no live
/// receiver (a reconnect is in flight). Lets `next_event`'s `select!` keep
/// the inbound arm present without polling a dead/absent receiver.
async fn recv_next(rx: &mut Option<UnboundedReceiver<Envelope>>) -> Option<Envelope> {
    match rx {
        Some(r) => r.recv().await,
        None => std::future::pending().await,
    }
}

/// Events `next_event` surfaces to the orchestrator.
pub enum SignalingClientEvent {
    Message(Envelope),
    /// The transport closed. The caller decides what this means: if a peer
    /// connection is already up, call `begin_reconnect` (media/input keep
    /// flowing peer-to-peer meanwhile); otherwise, before a peer exists,
    /// signaling IS the session, so this is fatal.
    Closed,
    /// A background reconnect succeeded; the transport is live again.
    Reconnected,
    /// A background reconnect exhausted its attempt budget — unrecoverable.
    Lost(anyhow::Error),
}

pub struct SignalingClient {
    sig: SignalingHandle,
    inbound: Option<UnboundedReceiver<Envelope>>,
    reconnecting: bool,
    recon_tx: mpsc::Sender<ReconnectResult>,
    recon_rx: mpsc::Receiver<ReconnectResult>,
    url: String,
    room_id: String,
    device_id: String,
    /// Set when this room lives on this desktop's OWN embedded LAN hub, which
    /// is reached in-process rather than over a socket — see `lan::loopback`.
    loopback: Option<Arc<LanHub>>,
}

impl SignalingClient {
    /// Connect and register as the desktop seat.
    pub async fn connect(
        url: String,
        room_id: String,
        device_id: String,
        loopback: Option<Arc<LanHub>>,
    ) -> Result<Self> {
        let (sig, inbound) = match &loopback {
            Some(hub) => crate::lan::loopback_connect(hub.clone(), &room_id, &device_id),
            // No token: a session room is authorized by the room record the
            // backend minted for this exact pairing, not by a device claim.
            // See `signaling::connect`.
            None => signaling::connect(&url, None).await?,
        };
        // Sent on both transports: the LAN hub already seated us in
        // `loopback_connect` and treats this as the no-op the cloud hub does,
        // so the two paths stay one code path.
        sig.send(Envelope::register(&room_id, &device_id))?;
        let (recon_tx, recon_rx) = mpsc::channel::<ReconnectResult>(1);
        Ok(Self {
            sig,
            inbound: Some(inbound),
            reconnecting: false,
            recon_tx,
            recon_rx,
            url,
            room_id,
            device_id,
            loopback,
        })
    }

    pub fn send(&self, env: Envelope) -> Result<()> {
        self.sig.send(env)
    }

    pub fn is_reconnecting(&self) -> bool {
        self.reconnecting
    }

    /// Kick off a background reconnect. Idempotent — a no-op if one is
    /// already in flight (mirrors the original `!reconnecting` guard before
    /// spawning). Reuses the same bounded (capacity-1) result channel across
    /// the client's whole lifetime, since only one reconnect is ever in
    /// flight at a time.
    pub fn begin_reconnect(&mut self) {
        if self.reconnecting {
            return;
        }
        self.reconnecting = true;
        let (url, room, dev) = (
            self.url.clone(),
            self.room_id.clone(),
            self.device_id.clone(),
        );
        let tx = self.recon_tx.clone();
        let loopback = self.loopback.clone();
        tokio::spawn(async move {
            let r = match loopback {
                // Re-seating on an in-process hub cannot fail and needs no
                // backoff — there is no network to wait for.
                Some(hub) => {
                    let (sig, inbound) = crate::lan::loopback_connect(hub, &room, &dev);
                    sig.send(Envelope::register(&room, &dev))
                        .map(|()| (sig, inbound))
                }
                None => ReconnectPolicy::new().reconnect(&url, &room, &dev).await,
            };
            let _ = tx.send(r).await;
        });
    }

    /// Await the next event: an inbound message, the transport closing, or
    /// (only while a reconnect is in flight) that reconnect's outcome.
    pub async fn next_event(&mut self) -> SignalingClientEvent {
        tokio::select! {
            msg = recv_next(&mut self.inbound) => {
                match msg {
                    Some(env) => SignalingClientEvent::Message(env),
                    None => {
                        self.inbound = None;
                        SignalingClientEvent::Closed
                    }
                }
            }
            recon = self.recon_rx.recv(), if self.reconnecting => {
                self.reconnecting = false;
                match recon {
                    Some(Ok((new_sig, new_inbound))) => {
                        self.sig = new_sig;
                        self.inbound = Some(new_inbound);
                        SignalingClientEvent::Reconnected
                    }
                    Some(Err(e)) => SignalingClientEvent::Lost(e),
                    // `recon_tx` is held by `self` for the client's whole
                    // lifetime — a spawned reconnect task's clone is the only
                    // other holder, so this channel never closes out from
                    // under an in-flight reconnect. Pend rather than treat a
                    // channel-API technicality as a real session-ending event.
                    None => std::future::pending().await,
                }
            }
        }
    }
}
