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

use super::endpoints::LanEndpoints;
use super::hub::{LanHub, Role};
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

pub struct LanServerState {
    pub trust_cache: Arc<TrustCache>,
    pub device_id: String,
    pub endpoints: LanEndpoints,
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
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResponseBody {
    room_id: String,
    signaling_url: String,
    scopes: Vec<String>,
    desktop_device_name: Option<String>,
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
        "LAN control server listening on https://{}:{}",
        state.endpoints.lan_ip,
        state.port
    );

    axum_server::bind_rustls(addr, tls)
        .serve(app.into_make_service())
        .await
        .context("LAN control server exited")
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok", "lan": true }))
}

async fn connect_request(
    State(state): State<Arc<LanServerState>>,
    Json(body): Json<ConnectRequestBody>,
) -> Result<Json<ConnectResponseBody>, StatusCode> {
    if body.desktop_device_id != state.device_id {
        return Err(StatusCode::NOT_FOUND);
    }
    let trusted = state
        .trust_cache
        .authorize_connect(&body.mobile_device_id, body.pair_secret.as_deref())
        .ok_or(StatusCode::NOT_FOUND)?;

    let room_id = Uuid::new_v4().to_string();
    let scopes = vec![SessionScope::View, SessionScope::Control];
    let payload = ConnectRequestPayload {
        session_room_id: room_id.clone(),
        mobile_device_id: body.mobile_device_id,
        mobile_device_name: body.mobile_device_name,
        requested_scopes: scopes.clone(),
        auto_approve: trusted.auto_approve,
    };
    let signaling_url = state.endpoints.signaling_url.clone();
    state.notifier.notify(&signaling_url, payload);

    Ok(Json(ConnectResponseBody {
        room_id,
        signaling_url: state.endpoints.signaling_url.clone(),
        scopes: vec!["view".into(), "control".into()],
        desktop_device_name: trusted.display_name,
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

    let mut registered: Option<(String, Role)> = None;
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
                        if state.hub.attach(&room_id, role, device_id, send).is_ok() {
                            registered = Some((room_id, role));
                        }
                    }
                }
            }
            continue;
        }
        if let Some((_, role)) = registered {
            state.hub.handle(role, &txt);
        }
    }

    if let Some((room_id, role)) = registered {
        state.hub.detach(&room_id, role);
    }
    writer.abort();
}
