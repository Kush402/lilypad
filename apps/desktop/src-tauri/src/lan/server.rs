//! Embedded TLS control plane on the LAN ([ADR-0006](../../../../../../docs/adr/0006-lan-first-connectivity.md)).

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_server::tls_rustls::RustlsConfig;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;
use uuid::Uuid;

use crate::presence;
use crate::signaling::messages::{ConnectRequestPayload, SessionScope};

use super::endpoints::LanAdvertisement;
use super::hub::{LanHub, Role, SeatToken};
use super::trust_cache::TrustCache;

pub trait ConnectNotifier: Send + Sync {
    fn notify(&self, signaling_url: &str, payload: ConnectRequestPayload);
}

pub struct TauriConnectNotifier {
    pub app: AppHandle,
}

impl ConnectNotifier for TauriConnectNotifier {
    fn notify(&self, signaling_url: &str, payload: ConnectRequestPayload) {
        let app = self.app.clone();
        let app2 = app.clone();
        let url = signaling_url.to_owned();
        let _ = app.run_on_main_thread(move || {
            presence::dispatch_connect_request(&app2, &url, payload);
        });
    }
}

/// How the LAN plane learns this Mac's wire id: a live read, never a copy.
///
/// `device_id` was captured when the server started, and it is the ONLY gate on
/// a LAN ring — but `lib::adopt_device_id` can change this computer's id later,
/// when the first token exchange discovers the backend knows it by another
/// name. `presence.rs` was explicitly taught to re-read the id on every attempt
/// for exactly this reason (see the comment in its reconnect loop); the LAN
/// plane never was, so a drifted install answered every ring with a 404 and the
/// LAN was unreachable for the life of the install. mDNS could not rescue it
/// either, because the advertisement carried the same stale id the phone
/// filters on. Kanban L-180.
pub type DeviceIdSource = Arc<dyn Fn() -> String + Send + Sync>;

/// A device id that cannot change — for tests, and for callers that genuinely
/// have a fixed one.
pub fn fixed_device_id(device_id: &str) -> DeviceIdSource {
    let id = device_id.to_owned();
    Arc::new(move || id.clone())
}

pub struct LanServerState {
    pub trust_cache: Arc<TrustCache>,
    pub device_id: DeviceIdSource,
    pub advertisement: Arc<LanAdvertisement>,
    pub hub: Arc<LanHub>,
    pub notifier: Arc<dyn ConnectNotifier>,
    pub port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectRequestBody {
    desktop_device_id: String,
    mobile_device_id: String,
    mobile_device_name: Option<String>,
    pair_secret: Option<String>,
    resume: Option<bool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResponseBody {
    room_id: String,
    signaling_url: String,
    scopes: Vec<String>,
    desktop_device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resumed: Option<bool>,
}

pub async fn run(state: Arc<LanServerState>, cert_pem: Vec<u8>, key_pem: Vec<u8>) -> Result<()> {
    let app = Router::new()
        .route("/health", get(health))
        .route("/connect/request", post(connect_request))
        .route("/ws/signal", get(ws_upgrade))
        .with_state(state.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], state.port));
    let tls = RustlsConfig::from_pem(cert_pem, key_pem)
        .await
        .context("load LAN TLS config")?;

    log::info!(
        target: "lilypad::lan",
        "LAN control server listening on 0.0.0.0:{} (advertising {})",
        state.port,
        state
            .advertisement
            .snapshot()
            .map(|ep| ep.api_base_url)
            .unwrap_or_else(|| "no LAN address yet".to_owned())
    );

    axum_server::bind_rustls(addr, tls)
        .serve(app.into_make_service())
        .await
        .context("LAN control server exited")
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok", "lan": true }))
}

/// Why a LAN `/connect/request` was refused, on the wire.
///
/// All three refusals used to be a bare `StatusCode::NOT_FOUND` with **no body
/// at all**, and the phone's classifier looks for `not_trusted` in the BODY
/// (`classifyConnectStatus`, `apps/mobile/src/lib/api.ts`). Finding an empty
/// string, it fell through to the status-only path, where 404 means
/// `token_expired` — so a phone whose LAN authorization had drifted told the
/// user "This QR code has expired" about a laptop sitting in their own paired
/// list, with no QR anywhere in the story. Kanban L-185.
///
/// Statuses and codes are the cloud route's
/// (`apps/backend/src/routes/signaling.ts`) so one taxonomy covers both control
/// planes and the phone needs no per-plane special case.
enum ConnectRefusal {
    /// This is not the Mac the phone asked for. With the device id now read per
    /// request (L-180) this no longer means "our own id drifted"; what is left
    /// is a cached LAN address that DHCP has since handed to another machine.
    WrongDesktop,
    /// No trust record for that phone, or its connect secret does not match.
    ///
    /// Deliberately one code for both, exactly as the cloud route masks
    /// `bad_secret` — and the masking is kept here after weighing that this
    /// endpoint is not internet-exposed. It is still reachable by anything on
    /// the same network (a café, a guest SSID, a compromised smart plug), the
    /// two facts have the identical remedy — pair again with a QR — so telling
    /// them apart buys the legitimate user nothing, and an attacker who can
    /// distinguish them gains an oracle for which phones a Mac knows. Which of
    /// the two it actually was is logged locally, where the person diagnosing
    /// is already looking and where it crosses no network.
    NotTrusted,
    /// `resume: true` and there is no live room for this pair.
    SessionGone,
}

impl IntoResponse for ConnectRefusal {
    fn into_response(self) -> axum::response::Response {
        let (code, message) = match self {
            ConnectRefusal::WrongDesktop => (
                "wrong_desktop",
                "this is not the computer that was asked for",
            ),
            ConnectRefusal::NotTrusted => (
                "not_trusted",
                "no trust relationship — pair with a QR first",
            ),
            ConnectRefusal::SessionGone => (
                "session_gone",
                "there is no live session to resume — ring the laptop to start a new one",
            ),
        };
        let status = match self {
            ConnectRefusal::SessionGone => StatusCode::CONFLICT,
            _ => StatusCode::NOT_FOUND,
        };
        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}

async fn connect_request(
    State(state): State<Arc<LanServerState>>,
    Json(body): Json<ConnectRequestBody>,
) -> Result<Json<ConnectResponseBody>, ConnectRefusal> {
    let device_id = (state.device_id)();
    if body.desktop_device_id != device_id {
        log::warn!(
            target: "lilypad::lan",
            "LAN connect/request addressed to {} — this computer is {device_id}",
            body.desktop_device_id
        );
        return Err(ConnectRefusal::WrongDesktop);
    }
    let trusted = state
        .trust_cache
        .authorize_connect(&body.mobile_device_id, body.pair_secret.as_deref())
        .ok_or_else(|| {
            // The distinction the wire deliberately withholds — see
            // `ConnectRefusal::NotTrusted`.
            let known = state.trust_cache.get(&body.mobile_device_id).is_some();
            log::warn!(
                target: "lilypad::lan",
                "LAN connect/request rejected for mobile {} ({})",
                body.mobile_device_id,
                if known { "connect secret does not match the cached hash" } else { "no trust-record for this phone" }
            );
            ConnectRefusal::NotTrusted
        })?;

    // The address this Mac answers on can change mid-process (L-181), so the
    // URL the phone is handed is read now, once, and the SAME value is given to
    // the session runner — a room must never be minted on one URL and joined
    // on another.
    let Some(endpoints) = state.advertisement.snapshot() else {
        // Unreachable in practice: nothing can have reached this handler unless
        // the server was started, and it is only started once an address has
        // been published. Refused rather than unwrapped, because a panic here
        // would take the whole LAN control plane down with it.
        log::error!(
            target: "lilypad::lan",
            "LAN connect/request arrived before any address was advertised"
        );
        return Err(ConnectRefusal::WrongDesktop);
    };

    let scopes = vec![SessionScope::View, SessionScope::Control];

    if body.resume == Some(true) {
        return match state
            .hub
            .find_resumable_room(&device_id, &body.mobile_device_id)
        {
            Some(room_id) => Ok(Json(ConnectResponseBody {
                room_id,
                signaling_url: endpoints.signaling_url,
                scopes: vec!["view".into(), "control".into()],
                desktop_device_name: trusted.display_name,
                resumed: Some(true),
            })),
            None => Err(ConnectRefusal::SessionGone),
        };
    }

    let room_id = Uuid::new_v4().to_string();
    // Bind both WebSocket seats before either peer learns the room id. The
    // request has already proved the desktop id and the phone's pair secret.
    state
        .hub
        .authorize_room(&room_id, device_id.clone(), body.mobile_device_id.clone());
    let payload = ConnectRequestPayload {
        session_room_id: room_id.clone(),
        mobile_device_id: body.mobile_device_id,
        mobile_device_name: body.mobile_device_name,
        requested_scopes: scopes.clone(),
        auto_approve: trusted.auto_approve,
    };
    state.notifier.notify(&endpoints.signaling_url, payload);

    Ok(Json(ConnectResponseBody {
        room_id,
        signaling_url: endpoints.signaling_url,
        scopes: vec!["view".into(), "control".into()],
        desktop_device_name: trusted.display_name,
        resumed: None,
    }))
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<LanServerState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(socket: WebSocket, state: Arc<LanServerState>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let writer = tokio::spawn(async move {
        while let Some(txt) = rx.recv().await {
            if sink.send(Message::Text(txt)).await.is_err() {
                break;
            }
        }
    });

    // The seat token is carried alongside the room and role so this socket's
    // teardown can only vacate the seat it is still holding. A phone whose
    // socket flaps re-registers over a NEW one, and this one then reaches the
    // bottom of the function — see `hub::SeatToken`.
    let mut registered: Option<(String, Role, SeatToken)> = None;
    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(txt) = msg else {
            continue;
        };
        if registered.is_none() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                if v.get("type").and_then(|t| t.as_str()) == Some("register") {
                    let room_id = v
                        .get("roomId")
                        .and_then(|r| r.as_str())
                        .unwrap_or_default()
                        .to_owned();
                    let role = v
                        .pointer("/payload/role")
                        .and_then(|r| r.as_str())
                        .and_then(|r| match r {
                            "desktop" => Some(Role::Desktop),
                            "mobile" => Some(Role::Mobile),
                            _ => None,
                        });
                    let device_id = v
                        .pointer("/payload/deviceId")
                        .and_then(|d| d.as_str())
                        .unwrap_or_default()
                        .to_owned();
                    if let Some(role) = role {
                        let send = {
                            let tx = tx.clone();
                            Arc::new(move |s: &str| {
                                let _ = tx.send(s.to_owned());
                            })
                        };
                        match state.hub.attach(&room_id, role, device_id, send) {
                            Ok(token) => {
                                registered = Some((room_id.clone(), role, token));
                                let rejoin = v
                                    .pointer("/payload/rejoin")
                                    .and_then(|x| x.as_bool())
                                    .unwrap_or(false);
                                if rejoin && role == Role::Mobile {
                                    state.hub.reissue_session_start(&room_id);
                                }
                            }
                            Err(code) => {
                                log::warn!(
                                    target: "lilypad::lan",
                                    "LAN register refused for room {room_id}: {code}"
                                );
                                let _ = tx.send(LanHub::refusal_frame(
                                    role,
                                    &room_id,
                                    &code,
                                    "registration refused",
                                ));
                                break;
                            }
                        }
                    }
                }
            }
            continue;
        }
        if let Some((_, role, _)) = registered {
            state.hub.handle(role, &txt);
        }
    }

    if let Some((room_id, role, token)) = registered {
        state.hub.detach(&room_id, role, token);
    }
    writer.abort();
}
