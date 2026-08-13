//! Desktop presence channel (M5.4) — the standing signaling connection that
//! makes the desktop reachable for no-QR reconnects from trusted phones.
//!
//! On launch the desktop registers into its reserved presence room
//! (`presence:<deviceId>`) over the SAME `/ws/signal` endpoint sessions use —
//! reusing the hub's heartbeats, reaping, guards, and zombie-socket eviction
//! wholesale rather than introducing a parallel subsystem (decision recorded
//! in `docs/m5.4-trusted-devices-audit.md` §6). The connection exists only to
//! receive `connect-request` frames; each accepted request spawns the normal
//! session runner on the fresh room the backend minted, and everything
//! downstream (pair-request, ring UI or auto-approve, offer/answer) is the
//! existing pairing flow.
//!
//! Reconnects forever with capped backoff: presence is availability, not a
//! session — there is no budget after which giving up is correct.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::auth::DesktopAuth;
use crate::signaling::{connect, messages::ConnectRequestPayload, Envelope};
use crate::state::SharedState;

/// Mirrors `@lilypad/protocol`'s `APP_HEARTBEAT_INTERVAL_MS` (4s), like the
/// session runner does — the hub reaps a presence seat silent for 25s. Each
/// tick sends a `ping` (not a bare heartbeat) so the hub's `pong` gives us a
/// liveness signal.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(4);
/// If the hub hasn't sent ANY frame (pong or connect-request) in this long,
/// the socket is presumed dead and we reconnect. This is the load-bearing
/// fix for sleep/wake: a suspended-then-resumed Mac leaves the TCP connection
/// half-open — writes appear to succeed (they queue into a dead socket's
/// buffer) so nothing else notices, and trusted rings silently never arrive
/// until the app is restarted. 16s = 4 missed pings.
const PRESENCE_STALE_AFTER: Duration = Duration::from_secs(16);
/// Mirrors `RECONNECT_BACKOFF_MS`, then holds at a steady retry cadence —
/// unlike a session, presence never runs out of attempts.
const BACKOFF_MS: [u64; 4] = [500, 1000, 2000, 4000];
const BACKOFF_CAP_MS: u64 = 15_000;

/// Mirrors `@lilypad/protocol`'s `presenceRoomId` (`presence:<deviceId>`).
fn presence_room_id(device_id: &str) -> String {
    format!("presence:{device_id}")
}

/// Derive the signaling WS URL from the backend base URL the desktop already
/// talks REST to. The desktop deliberately does NOT use the tunnel URL the
/// backend advertises to phones — its own path to the backend is the direct
/// one it was configured with.
fn ws_url_from_base(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    let ws = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        trimmed.to_owned()
    };
    format!("{ws}/ws/signal")
}

/// Spawn the forever-running presence loop. Call once at app setup.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run(app).await;
    });
}

async fn run(app: AppHandle) {
    let (device_id, base_url) = {
        let state = app.state::<SharedState>();
        let s = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (s.device_id.clone(), s.backend_base_url.clone())
    };
    let url = ws_url_from_base(&base_url);
    let room = presence_room_id(&device_id);

    let mut attempt: usize = 0;
    loop {
        // Freshly per attempt: the backend gates presence on proving this
        // computer is the one it names (M9/SEC-4), and a token minted for an
        // earlier attempt may well have expired during a long backoff. `None`
        // is normal for a computer no account has linked yet — the backend
        // still admits it, on the same terms it always has.
        let token = app.state::<Arc<DesktopAuth>>().bearer().await;
        match connect(&url, token.as_deref()).await {
            Ok((handle, mut inbound)) => {
                if handle.send(Envelope::register(&room, &device_id)).is_ok() {
                    log::info!(target: "lilypad::presence", "presence online ({room})");
                    attempt = 0;
                    let mut hb = tokio::time::interval(HEARTBEAT_INTERVAL);
                    // Any inbound frame (the register ack path, a pong, a
                    // connect-request) proves the socket is alive; the register
                    // just went out, so seed liveness at "now".
                    let mut last_inbound = tokio::time::Instant::now();
                    loop {
                        tokio::select! {
                            _ = hb.tick() => {
                                // A dead writer task surfaces as a send error;
                                // a half-open socket (post-wake) does not, so
                                // the staleness check below is the real guard.
                                if handle.send(Envelope::ping(&room)).is_err() {
                                    break;
                                }
                                if last_inbound.elapsed() >= PRESENCE_STALE_AFTER {
                                    log::warn!(
                                        target: "lilypad::presence",
                                        "presence stale ({}s with no hub response) — reconnecting",
                                        PRESENCE_STALE_AFTER.as_secs()
                                    );
                                    break;
                                }
                            }
                            env = inbound.recv() => {
                                let Some(env) = env else { break };
                                last_inbound = tokio::time::Instant::now();
                                handle_inbound(&app, &url, env);
                            }
                        }
                    }
                    log::info!(target: "lilypad::presence", "presence socket closed — reconnecting");
                }
            }
            Err(e) => {
                // Quiet: an offline backend at launch is normal; the loop
                // keeps trying at the capped cadence.
                log::debug!(target: "lilypad::presence", "presence connect failed: {e}");
            }
        }
        let delay = BACKOFF_MS.get(attempt).copied().unwrap_or(BACKOFF_CAP_MS);
        attempt = attempt.saturating_add(1);
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

fn handle_inbound(app: &AppHandle, signaling_url: &str, env: Envelope) {
    match env.msg_type.as_str() {
        "connect-request" => {
            let payload: ConnectRequestPayload = match serde_json::from_value(env.payload) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!(target: "lilypad::presence", "bad connect-request payload: {e}");
                    return;
                }
            };
            on_connect_request(app, signaling_url, payload);
        }
        // `session-end` here means the hub closed the presence room (e.g.
        // graceful shutdown) — the socket close that follows drives the
        // reconnect loop; nothing to do per-message.
        "session-end" | "error" | "pong" => {}
        other => {
            log::debug!(target: "lilypad::presence", "ignoring '{other}' on presence channel");
        }
    }
}

/// A trusted phone rang: spawn the normal session runner on the fresh room
/// the backend minted. A trusted connect ALWAYS supersedes whatever session
/// state exists — a leftover QR-pairing runner (the Pair window left open),
/// a negotiation that never completed, even a live session (the phone's own
/// zombie, or a deliberate takeover). Silently ignoring the ring left the
/// phone hanging on "Waiting for approval…" forever (observed live); a
/// takeover is visible (session indicator, audit log) and the superseded
/// runner ends cleanly through its normal Disconnect path.
fn on_connect_request(app: &AppHandle, signaling_url: &str, payload: ConnectRequestPayload) {
    let (old_tx, device_id, offered_scopes) = {
        let state = app.state::<SharedState>();
        let mut s = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if payload.auto_approve {
            // Consumed by `apply_session_event`'s PairRequested arm: the ring
            // is skipped and the approval fires through the normal control
            // path the instant the phone's pair-request arrives.
            s.auto_approve_room = Some(payload.session_room_id.clone());
        }
        (
            s.control_tx.take(),
            s.device_id.clone(),
            s.offered_scopes.clone(),
        )
    };
    if let Some(tx) = old_tx {
        log::info!(
            target: "lilypad::audit",
            "superseding existing session — trusted device takeover"
        );
        let _ = tx.send(crate::session::Control::Disconnect);
    }
    log::info!(
        target: "lilypad::audit",
        "connect_request — trusted device {} ringing (auto_approve={})",
        payload.mobile_device_name.as_deref().unwrap_or("(unnamed)"),
        payload.auto_approve,
    );
    crate::commands::spawn_session_runner(
        app,
        payload.session_room_id,
        signaling_url.to_owned(),
        device_id,
        offered_scopes,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_derivation_covers_http_https_and_passthrough() {
        assert_eq!(
            ws_url_from_base("http://localhost:8080"),
            "ws://localhost:8080/ws/signal"
        );
        assert_eq!(
            ws_url_from_base("https://lilypad.example.com/"),
            "wss://lilypad.example.com/ws/signal"
        );
        // Already a ws URL (unusual config) — only the path is appended.
        assert_eq!(
            ws_url_from_base("ws://10.0.0.2:8080"),
            "ws://10.0.0.2:8080/ws/signal"
        );
    }

    #[test]
    fn presence_room_id_matches_the_protocol_namespace() {
        assert_eq!(
            presence_room_id("desktop-abc123"),
            "presence:desktop-abc123"
        );
    }
}
