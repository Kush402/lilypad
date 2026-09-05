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

use tauri::{AppHandle, Emitter, Manager};

use crate::auth::{DesktopAuth, NoToken};
use crate::lan::{TrustCache, TrustedMobile};
use crate::signaling::{
    connect, messages::ConnectRequestPayload, messages::TrustRecordPayload,
    messages::TrustSyncPayload, Envelope,
};
use crate::state::SharedState;

/// Mirrors `@lilypad/protocol`'s `APP_HEARTBEAT_INTERVAL_MS` (4s), like the
/// session runner does — the hub reaps a presence seat silent for 25s. Each
/// tick sends a `ping` (not a bare heartbeat) so the hub's `pong` gives us a
/// liveness signal.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(4);
/// How a missing token should be reported to the person sitting at the Mac.
///
/// Only one of these is a fault of this machine's, and only one of them is
/// worth a banner at all: a computer nobody has linked yet is in the state
/// every computer starts in, and the dashboard's linking panel is already
/// telling the user what to do about it.
fn presence_for(reason: NoToken) -> crate::state::PresenceState {
    use crate::state::PresenceState as P;
    match reason {
        NoToken::NoIdentity => P::NoIdentity,
        NoToken::NotLinked => P::NotLinked,
        NoToken::Revoked => P::Refused,
        // Network, DNS, a backend blip — the same thing an unreachable hub
        // means, and it clears on its own.
        NoToken::Unavailable => P::Unreachable,
    }
}

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

/// Does this inbound frame prove the backend ACCEPTED our `register`?
///
/// It has to be asked, because a successful register is acknowledged with
/// **silence**: the hub's router treats it as a no-op ack and sends nothing
/// back (`apps/backend/src/signaling/messageRouter.ts`, `case 'register'`).
/// A rejected one is answered with an `error` frame (`unauthorized_room` /
/// `not_registered`) and then close 4403.
///
/// So the only positive evidence available is a NON-error frame: the `pong`
/// our own heartbeat draws, or a `connect-request`. Both require a seated
/// peer. That is what may reset the reconnect backoff.
///
/// Getting this wrong is not cosmetic — it was the bug. The loop used to reset
/// the backoff as soon as `handle.send(register)` returned `Ok`, which only
/// means the frame reached an in-process channel (`SignalingHandle::send`
/// pushes into an unbounded mpsc and cannot know what the backend decided).
/// A laptop the user had revoked from their phone therefore reconnected at the
/// 500ms floor forever: observed live 2026-08-15 at ~2 sockets/sec, holding its
/// own `/devices/challenge` rate limit permanently exceeded (543 × HTTP 429),
/// so it could never recover even after re-linking.
fn proves_registered(msg_type: &str) -> bool {
    msg_type != "error"
}

/// Does this inbound frame prove the hub received something WE sent?
///
/// `pong` is the only such frame: it answers our `ping`. `connect-request`
/// and `trust-sync` prove the hub can still write *to* us, which is the
/// opposite direction. Counting them as liveness was the bug — the stale
/// timer reset, we did not reconnect, and the hub reaped a silent send path.
fn inbound_proves_send_path(msg_type: &str) -> bool {
    msg_type == "pong"
}

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

/// Publish where presence stands, and wake the UI.
///
/// Nothing reported this before, so "your phone cannot reach this Mac" was a
/// fact only the backend's logs held. The event reuses `lilypad://session`
/// because `useAppState` already treats that as "re-fetch the snapshot" — a
/// second channel would be a second thing to keep in sync for no gain.
fn set_presence(app: &AppHandle, next: crate::state::PresenceState) {
    {
        let state = app.state::<SharedState>();
        let mut s = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if s.presence == next {
            return; // Nothing changed; do not wake every window on a retry.
        }
        s.presence = next;
    }
    let _ = app.emit("lilypad://session", ());
}

async fn run(app: AppHandle) {
    let base_url = {
        let state = app.state::<SharedState>();
        let s = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        s.backend_base_url.clone()
    };
    let url = ws_url_from_base(&base_url);

    let mut attempt: usize = 0;
    loop {
        // Re-read per attempt, like the token below, and for a related reason:
        // this computer's wire id can CHANGE under us. The first token exchange
        // is the one that discovers a drifted `device_id` and adopts the
        // backend's name (`lib::adopt_device_id`), and that exchange happens
        // inside this loop. Read once above it, this task would spend the whole
        // session registering a room nobody is looking for, and the phone would
        // report the Mac offline until it was relaunched.
        let device_id = {
            let state = app.state::<SharedState>();
            let s = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            s.device_id.clone()
        };
        let room = presence_room_id(&device_id);

        // Freshly per attempt: the backend gates presence on proving this
        // computer is the one it names (M9/SEC-4), and a token minted for an
        // earlier attempt may well have expired during a long backoff. `None`
        // is normal for a computer no account has linked yet — the backend
        // still admits it, on the same terms it always has.
        let token = match app.state::<Arc<DesktopAuth>>().bearer_result().await {
            Ok(token) => {
                set_presence(&app, crate::state::PresenceState::Connecting);
                token
            }
            // Connecting without a token used to be normal — the backend
            // admitted an unowned computer on the same terms it always had. It
            // is not normal any more: under account → devices the hub refuses
            // a presence register it cannot attribute, so this would spend a
            // connection to earn a 4403 and then do it again forever. Report
            // it and back off instead; `DesktopAuth` retries on the next call.
            //
            // WHICH reason gets reported is the part that had been wrong: all
            // four said "no saved key — macOS may have denied Lilypad access
            // to the keychain", including the two that are ordinary.
            Err(reason) => {
                set_presence(&app, presence_for(reason));
                log::warn!(
                    target: "lilypad::presence",
                    "no device token ({reason:?}) — this Mac cannot be reached by a phone until it has one",
                );
                // Back off WITHOUT opening a socket. The comment above has said
                // this since the day the hub started refusing unattributed
                // registers; the code did it anyway, because the `None` fell
                // through into `connect` below. Production paid for it: on
                // 2026-08-26 one Mac whose device row had been deleted spent
                // ten minutes opening a connection every fifteen seconds,
                // sending a register the hub could only refuse, and then
                // holding the dead socket open until the hub's 10s
                // no-register timer closed it — 95 refused registers and 98
                // reaped sockets, none of which could ever have succeeded.
                //
                // Worse than the waste: the refused register overwrote the
                // presence state this arm had just set, so an unlinked Mac
                // reported "Lilypad's server won't accept this Mac" instead of
                // "not linked yet" — the wrong one of the two, on every first
                // run.
                backoff(&mut attempt).await;
                continue;
            }
        };

        match connect(&url, Some(token.as_str())).await {
            Ok((handle, mut inbound)) => {
                if handle.send(Envelope::register(&room, &device_id)).is_ok() {
                    // NOT "online" yet, and NOT grounds to reset the backoff —
                    // see `proves_registered`. Both wait for the hub to answer.
                    log::debug!(target: "lilypad::presence", "presence registering ({room})");
                    let mut hb = tokio::time::interval(HEARTBEAT_INTERVAL);
                    // Flips once, on the hub's first non-error frame.
                    let mut registered = false;
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
                                // Only a `pong` proves the hub received a ping
                                // we sent. `connect-request` / `trust-sync`
                                // prove the *other* direction — hub can still
                                // write to us — and treating them as liveness
                                // kept a half-open send path looking alive
                                // until the hub's 25s reap. Observed
                                // 2026-08-31: enrollment trust-sync then a
                                // ring 4s later, then `heartbeat timeout`
                                // `desktop_offline` while the Mac was still up.
                                if inbound_proves_send_path(&env.msg_type) {
                                    last_inbound = tokio::time::Instant::now();
                                }
                                if !registered && proves_registered(&env.msg_type) {
                                    registered = true;
                                    attempt = 0;
                                    set_presence(&app, crate::state::PresenceState::Online);
                                    log::info!(target: "lilypad::presence", "presence online ({room})");
                                }
                                let ring = env.msg_type == "connect-request";
                                handle_inbound(&app, &url, env);
                                // If the send path still works, bump hub
                                // lastSeen before the 25s reap. Harmless if
                                // it doesn't — the stale timer is what
                                // reconnects.
                                if ring {
                                    let _ = handle.send(Envelope::ping(&room));
                                }
                            }
                        }
                    }
                    if registered {
                        set_presence(&app, crate::state::PresenceState::Connecting);
                        log::info!(target: "lilypad::presence", "presence socket closed — reconnecting");
                    } else {
                        // Seated by nobody. `Refused` rather than
                        // `Unreachable`: the socket opened, so the network is
                        // fine and the hub said no — which is a different
                        // problem with a different remedy.
                        set_presence(&app, crate::state::PresenceState::Refused);
                        // The hub never seated us. Distinguished in the log
                        // because the two cases have different causes: a closed
                        // socket is the network, an unseated one is almost
                        // always this computer not being (or no longer being)
                        // authorized for its own presence room.
                        log::warn!(
                            target: "lilypad::presence",
                            "presence socket closed before the hub accepted the register — \
                             backing off (attempt {attempt})"
                        );
                    }
                }
            }
            Err(e) => {
                // Quiet in the log: an offline backend at launch is normal and
                // the loop keeps trying at the capped cadence. Not quiet in
                // the UI, because from the phone's side this is indistinguishable
                // from the Mac being switched off.
                set_presence(&app, crate::state::PresenceState::Unreachable);
                log::debug!(target: "lilypad::presence", "presence connect failed: {e}");
            }
        }
        backoff(&mut attempt).await;
    }
}

/// Wait out one attempt and advance the schedule.
///
/// Jittered, because this loop retries FOREVER at a capped cadence: every
/// desktop that was connected when the backend restarted would otherwise
/// re-knock in lockstep, every 15 seconds, indefinitely. A deploy makes that a
/// routine event. See `session::reconnect::jitter`.
async fn backoff(attempt: &mut usize) {
    let delay = BACKOFF_MS.get(*attempt).copied().unwrap_or(BACKOFF_CAP_MS);
    *attempt = attempt.saturating_add(1);
    tokio::time::sleep(crate::session::reconnect::jitter(Duration::from_millis(
        delay,
    )))
    .await;
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
            // Off the ping loop. `spawn_session_runner` is sync besides a
            // mutex, but starting a session must not delay the next ping —
            // that delay is exactly how a live app looks `desktop_offline`.
            let app = app.clone();
            let signaling_url = signaling_url.to_owned();
            tauri::async_runtime::spawn(async move {
                dispatch_connect_request(&app, &signaling_url, payload);
            });
        }
        "trust-record" => {
            let payload: TrustRecordPayload = match serde_json::from_value(env.payload) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!(target: "lilypad::presence", "bad trust-record payload: {e}");
                    return;
                }
            };
            if let Some(cache) = app.try_state::<std::sync::Arc<TrustCache>>() {
                if let Err(e) = cache.upsert(TrustedMobile {
                    mobile_device_id: payload.mobile_device_id,
                    connect_secret_hash: payload.connect_secret_hash,
                    auto_approve: payload.auto_approve,
                    display_name: payload.display_name,
                }) {
                    log::warn!(target: "lilypad::lan", "trust-record cache write failed: {e}");
                }
            }
        }
        "trust-sync" => {
            let payload: TrustSyncPayload = match serde_json::from_value(env.payload) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!(target: "lilypad::presence", "bad trust-sync payload: {e}");
                    return;
                }
            };
            if let Some(cache) = app.try_state::<std::sync::Arc<TrustCache>>() {
                let rows: Vec<TrustedMobile> = payload
                    .records
                    .into_iter()
                    .map(|r| TrustedMobile {
                        mobile_device_id: r.mobile_device_id,
                        connect_secret_hash: r.connect_secret_hash,
                        auto_approve: r.auto_approve,
                        display_name: r.display_name,
                    })
                    .collect();
                let count = rows.len();
                if let Err(e) = cache.replace_all(rows) {
                    log::warn!(target: "lilypad::lan", "trust-sync cache replace failed: {e}");
                } else {
                    log::info!(
                        target: "lilypad::lan",
                        "LAN trust cache replaced ({count} phone{})",
                        if count == 1 { "" } else { "s" }
                    );
                }
            }
        }
        // Why this device was refused its own presence room is the single most
        // useful line in a "my laptop is offline in the app" report, and it was
        // being dropped on the floor. `LinkState` (polled by the dashboard) is
        // what TELLS the user; this is what tells us.
        "error" => {
            log::warn!(
                target: "lilypad::presence",
                "hub refused the presence channel: {}", env.payload
            );
            // `unauthorized_room` on a presence register almost always means
            // the token this socket presented was not accepted, and the
            // commonest reason is that it had expired — the backend gates
            // presence on proving this computer is the one it names, so an
            // unauthenticated socket is refused exactly like an impostor.
            //
            // Throwing the cached token away makes the NEXT attempt mint a
            // fresh one. Without this the loop reconnects with the same dead
            // credential until the cache decides on its own that it is stale,
            // which after a sleep took twenty-four minutes on 2026-08-25 — the
            // phone showing that Mac offline throughout. The wall-clock fix in
            // `auth.rs` closes the usual cause; this closes the loop for every
            // other cause, including a rotated signing key.
            if env.payload.get("code").and_then(|c| c.as_str()) == Some("unauthorized_room") {
                app.state::<Arc<DesktopAuth>>().inner().invalidate();
            }
        }
        // `session-end` here means the hub closed the presence room (e.g.
        // graceful shutdown) — the socket close that follows drives the
        // reconnect loop; nothing to do per-message.
        "session-end" | "pong" => {}
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
/// Shared by cloud presence and the embedded LAN control plane.
pub(crate) fn dispatch_connect_request(
    app: &AppHandle,
    signaling_url: &str,
    payload: ConnectRequestPayload,
) {
    on_connect_request(app, signaling_url, payload);
}

fn on_connect_request(app: &AppHandle, signaling_url: &str, payload: ConnectRequestPayload) {
    // Same-room detection, old-runner disconnect, consent and task publication
    // belong to commands' single claim transaction. Dispatches run concurrently;
    // taking a sender here could disconnect another dispatch's newly seated peer.
    let (device_id, offered_scopes) = {
        let state = app.state::<SharedState>();
        let s = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (s.device_id.clone(), s.offered_scopes.clone())
    };
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
        payload.auto_approve,
    );
}

#[cfg(test)]
mod tests {

    /// What the person at the Mac is told when there is no device token.
    ///
    /// All four reasons used to produce the same banner: "This Mac can't prove
    /// who it is — macOS may have denied Lilypad access to the keychain."
    /// Two of the four are ordinary, and one of those two is the state every
    /// Mac is in on its first run, so that scare was on the first screen of
    /// the product.
    #[test]
    fn a_missing_token_is_reported_as_the_reason_it_is_missing() {
        use crate::state::PresenceState as P;
        assert_eq!(presence_for(NoToken::NoIdentity), P::NoIdentity);
        // Not a fault. The dashboard renders no banner for this one at all.
        assert_eq!(presence_for(NoToken::NotLinked), P::NotLinked);
        // "If you removed it from your account, link it again above" — which
        // is exactly what happened.
        assert_eq!(presence_for(NoToken::Revoked), P::Refused);
        // A wake with the network not yet back. Clears on its own, and the
        // copy for this one says so.
        assert_eq!(presence_for(NoToken::Unavailable), P::Unreachable);
    }
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

    /// The regression this module's `proves_registered` exists for.
    ///
    /// A rejected register arrives as an `error` frame, which must NOT count as
    /// proof that the hub seated us — otherwise the backoff resets and the loop
    /// hammers the backend at its 500ms floor forever (observed live
    /// 2026-08-15: ~2 sockets/sec after the laptop was revoked from the phone).
    #[test]
    fn an_error_frame_is_not_proof_of_registration() {
        assert!(!proves_registered("error"));
    }

    /// The other half: a successful register is acked with silence, so the only
    /// positive evidence is a non-error frame. Both of these require a seated
    /// peer — a `pong` answers our heartbeat, a `connect-request` is routed to
    /// the room's desktop seat.
    #[test]
    fn a_pong_or_a_ring_proves_registration() {
        assert!(proves_registered("pong"));
        assert!(proves_registered("connect-request"));
    }

    /// A ring or a trust-sync is not proof our *pings* arrived. Resetting
    /// last_inbound on those frames is what left an observed Mac seated for
    /// a connect 200 and then reaped 4s later.
    #[test]
    fn only_a_pong_proves_the_send_path_is_alive() {
        assert!(inbound_proves_send_path("pong"));
        assert!(!inbound_proves_send_path("connect-request"));
        assert!(!inbound_proves_send_path("trust-sync"));
        assert!(!inbound_proves_send_path("trust-record"));
        assert!(!inbound_proves_send_path("error"));
    }

    /// Reconnect must beat the hub's 25s reap. A ring at T+20s used to reset
    /// last_inbound, so we sat still and were reaped at T+25. Now we notice
    /// at 16s and have ~9s to re-seat.
    #[test]
    fn send_path_stale_reconnects_before_the_hub_reaps() {
        assert!(
            PRESENCE_STALE_AFTER.as_secs() + 5 < 25,
            "client must notice a dead send path with time to reconnect before the 25s reap"
        );
    }

    /// The livelock itself, as arithmetic on the backoff schedule.
    ///
    /// Replays "every attempt is rejected" through both policies. The old one
    /// reset `attempt` the moment the register was ENQUEUED, so every delay was
    /// `BACKOFF_MS[0]`; the fixed one only resets on proof, so the schedule
    /// escalates to the cap. Over a 60s outage that is the difference between
    /// ~120 reconnects and single digits.
    #[test]
    fn a_permanently_rejected_presence_backs_off_instead_of_hammering() {
        fn delay(attempt: usize) -> u64 {
            BACKOFF_MS.get(attempt).copied().unwrap_or(BACKOFF_CAP_MS)
        }
        // Sockets opened within 60s when every register is refused.
        fn sockets_in_60s(reset_on_enqueue: bool) -> usize {
            let (mut elapsed, mut attempt, mut sockets) = (0u64, 0usize, 0usize);
            while elapsed < 60_000 {
                sockets += 1;
                elapsed += delay(attempt);
                // The bug: an enqueued register was taken as success.
                attempt = if reset_on_enqueue { 0 } else { attempt + 1 };
            }
            sockets
        }
        let old = sockets_in_60s(true);
        let fixed = sockets_in_60s(false);
        assert_eq!(old, 120, "the old policy pinned the 500ms floor");
        assert!(
            fixed <= 8,
            "a refused presence must escalate to the cap, got {fixed} sockets in 60s"
        );
    }

    /// Recovery must not be sacrificed to fix the storm. A laptop that IS
    /// seated, then drops (wifi blip, sleep/wake), has had `attempt` reset by
    /// the hub's frames, so it reconnects at the 500ms floor — not at the cap.
    #[test]
    fn a_healthy_socket_that_drops_still_reconnects_immediately() {
        let mut attempt = 3usize; // took a while to come up
        if proves_registered("pong") {
            attempt = 0;
        }
        assert_eq!(BACKOFF_MS.get(attempt).copied().unwrap(), 500);
    }
}
