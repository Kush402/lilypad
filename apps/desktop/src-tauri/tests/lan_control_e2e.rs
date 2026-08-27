//! LAN control plane end-to-end: trust cache + TLS server, no cloud
//! ([NETWORKING.md](../../../../docs/NETWORKING.md) M9.5 DoD).

use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::{Arc, Mutex};

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Method, Request, StatusCode};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use lilypad_desktop_lib::lan::server::{run as run_lan_server, ConnectNotifier};
use lilypad_desktop_lib::lan::{
    build_lan_endpoints, generate_tls as generate_lan_tls, hash_secret, loopback_connect, LanHub,
    LanServerState, TrustCache, TrustedMobile,
};
use lilypad_desktop_lib::signaling::messages::ConnectRequestPayload;
use lilypad_desktop_lib::signaling::{Envelope, SignalingHandle};
use rustls::{ClientConfig, RootCertStore};
use tokio::sync::mpsc::UnboundedReceiver;

/// What the desktop does for real when a trusted phone rings over the LAN:
/// record the ring, then take the desktop seat of the freshly minted room on
/// its own hub — in-process, because a socket to its own self-signed
/// certificate cannot be verified (`lan::loopback`).
///
/// The previous version of this notifier only recorded. That is why the DoD
/// this file claims to prove passed while the product was broken: the phone
/// could get a room out of `/connect/request` and then wait on "Waiting for
/// approval…" forever, because nothing ever joined it.
struct DesktopNotifier {
    hub: Arc<LanHub>,
    device_id: String,
    hits: Mutex<Vec<ConnectRequestPayload>>,
    seats: tokio::sync::mpsc::UnboundedSender<(SignalingHandle, UnboundedReceiver<Envelope>)>,
}

impl ConnectNotifier for DesktopNotifier {
    fn notify(&self, signaling_url: &str, payload: ConnectRequestPayload) {
        assert!(
            signaling_url.starts_with("wss://"),
            "the phone must be handed a TLS signaling URL, got {signaling_url}"
        );
        let seat = loopback_connect(self.hub.clone(), &payload.session_room_id, &self.device_id);
        self.hits.lock().unwrap().push(payload);
        let _ = self.seats.send(seat);
    }
}

fn pick_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn tls_get(
    port: u16,
    path: &str,
    cert_pem: &[u8],
    method: Method,
    body: Option<String>,
) -> (StatusCode, String) {
    let mut roots = RootCertStore::empty();
    let mut reader = std::io::BufReader::new(cert_pem);
    let cert = rustls_pemfile::certs(&mut reader)
        .next()
        .expect("cert")
        .expect("parse cert");
    roots.add(cert).expect("add cert");
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(config)
        .https_or_http()
        .enable_http1()
        .build();
    let client = Client::builder(TokioExecutor::new()).build(https);
    let uri: hyper::Uri = format!("https://127.0.0.1:{port}{path}").parse().unwrap();
    let req = if let Some(b) = body {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(b)))
            .unwrap()
    } else {
        Request::builder()
            .method(method)
            .uri(uri)
            .body(Full::new(Bytes::new()))
            .unwrap()
    };
    let res = client.request(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn lan_connect_request_works_without_cloud() {
    let dir = std::env::temp_dir().join(format!("lilypad-lan-e2e-{}", uuid::Uuid::new_v4()));
    let cache = Arc::new(TrustCache::load(&dir).unwrap());
    let secret = "abcdefghijklmnop";
    cache
        .upsert(TrustedMobile {
            mobile_device_id: "mobile-12345678".into(),
            connect_secret_hash: hash_secret(secret),
            auto_approve: true,
            display_name: Some("Test Phone".into()),
        })
        .unwrap();

    let device_id = "desktop-12345678";
    let port = pick_port();
    let ip = Ipv4Addr::LOCALHOST;
    let tls = generate_lan_tls(device_id, &[ip]).unwrap();
    let endpoints = build_lan_endpoints(ip, port, &tls.cert_sha256_hex);
    let hub = Arc::new(LanHub::new());
    let (seat_tx, mut seat_rx) = tokio::sync::mpsc::unbounded_channel();
    let notifier = Arc::new(DesktopNotifier {
        hub: hub.clone(),
        device_id: device_id.into(),
        hits: Mutex::new(Vec::new()),
        seats: seat_tx,
    });
    let state = Arc::new(LanServerState {
        trust_cache: cache,
        device_id: device_id.into(),
        endpoints,
        hub,
        notifier: notifier.clone(),
        port,
    });

    let cert_pem = tls.cert_pem.clone();
    let key_pem = tls.key_pem.clone();
    let server_cert = cert_pem.clone();
    let server_state = state.clone();
    tokio::spawn(async move {
        let _ = run_lan_server(server_state, cert_pem, key_pem).await;
    });

    for _ in 0..50 {
        if TcpListener::bind(SocketAddr::from((ip, port))).is_err() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    let (health_status, _) = tls_get(port, "/health", &server_cert, Method::GET, None).await;
    assert_eq!(health_status, StatusCode::OK);

    let body = serde_json::json!({
        "desktopDeviceId": device_id,
        "mobileDeviceId": "mobile-12345678",
        "mobileDeviceName": "phone",
        "pairSecret": secret,
    });
    let (status, text) = tls_get(
        port,
        "/connect/request",
        &server_cert,
        Method::POST,
        Some(body.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    let room_id = json
        .get("roomId")
        .and_then(|v| v.as_str())
        .expect("roomId")
        .to_owned();
    assert!(json
        .get("signalingUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .contains("/ws/signal"));
    assert_eq!(notifier.hits.lock().unwrap().len(), 1);

    // ── The half that was never tested: the session actually starting ───────
    //
    // A room and a URL are not a session. The phone still has to reach the
    // signaling endpoint over pinned TLS, ask to pair, and be told the session
    // started — with the desktop seated on the other side. Everything below
    // runs against 127.0.0.1 with a self-signed certificate and no network
    // beyond this machine: this is the "works with no internet at all"
    // requirement in NETWORKING.md, proven rather than asserted.
    let (desktop_sig, mut desktop_inbound) = seat_rx.recv().await.expect("desktop took its seat");

    let mut phone = phone_socket(port, &server_cert).await;
    send_frame(
        &mut phone,
        &serde_json::json!({
            "type": "register",
            "roomId": room_id,
            "from": "mobile",
            "ts": 0,
            "payload": { "role": "mobile", "deviceId": "mobile-12345678" },
        }),
    )
    .await;
    send_frame(
        &mut phone,
        &serde_json::json!({
            "type": "pair-request",
            "roomId": room_id,
            "from": "mobile",
            "ts": 0,
            "payload": {
                "deviceId": "mobile-12345678",
                "deviceName": "phone",
                "requestedScopes": ["view", "control"],
            },
        }),
    )
    .await;

    let ring = tokio::time::timeout(std::time::Duration::from_secs(5), desktop_inbound.recv())
        .await
        .expect("the desktop must be rung within 5s")
        .expect("ring envelope");
    assert_eq!(
        ring.msg_type, "pair-request",
        "the desktop's seat must receive the phone's request to pair"
    );

    let scopes = vec!["view".to_owned(), "control".to_owned()];
    desktop_sig
        .send(Envelope::pair_approved(&room_id, &scopes, false))
        .unwrap();

    let start = expect_frame(&mut phone, "session-start").await;
    assert_eq!(
        start["payload"]["grantedScopes"],
        serde_json::json!(["view", "control"]),
        "the phone must be granted what the desktop approved"
    );
    assert!(
        start["payload"]["sessionId"]
            .as_str()
            .is_some_and(|s| !s.is_empty()),
        "a LAN session still needs an id, minted with no cloud involved"
    );

    let _ = std::fs::remove_dir_all(dir);
}

/// A WebSocket to the embedded server that trusts ONLY its certificate — the
/// same posture `PinnedWebSocket` gives the phone (`apps/mobile/src/lib/lanTls.ts`).
async fn phone_socket(
    port: u16,
    cert_pem: &[u8],
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let mut roots = RootCertStore::empty();
    let mut reader = std::io::BufReader::new(cert_pem);
    let cert = rustls_pemfile::certs(&mut reader)
        .next()
        .expect("cert")
        .expect("parse cert");
    roots.add(cert).expect("add cert");
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let (socket, _) = tokio_tungstenite::connect_async_tls_with_config(
        format!("wss://127.0.0.1:{port}/ws/signal"),
        None,
        false,
        Some(tokio_tungstenite::Connector::Rustls(Arc::new(config))),
    )
    .await
    .expect("the phone must reach the embedded signaling endpoint over pinned TLS");
    socket
}

async fn send_frame<S>(socket: &mut S, frame: &serde_json::Value)
where
    S: futures_util::SinkExt<tokio_tungstenite::tungstenite::Message> + Unpin,
    <S as futures_util::Sink<tokio_tungstenite::tungstenite::Message>>::Error: std::fmt::Debug,
{
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            frame.to_string(),
        ))
        .await
        .expect("send frame");
}

/// Read until `msg_type` arrives, failing the test rather than hanging.
async fn expect_frame<S>(socket: &mut S, msg_type: &str) -> serde_json::Value
where
    S: futures_util::StreamExt<
            Item = Result<
                tokio_tungstenite::tungstenite::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    let deadline = std::time::Duration::from_secs(5);
    let seen = tokio::time::timeout(deadline, async {
        let mut seen = Vec::new();
        while let Some(Ok(msg)) = socket.next().await {
            let tokio_tungstenite::tungstenite::Message::Text(txt) = msg else {
                continue;
            };
            let v: serde_json::Value = serde_json::from_str(&txt).expect("json frame");
            if v["type"] == msg_type {
                return Ok(v);
            }
            seen.push(v);
        }
        Err(seen)
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for '{msg_type}'"));
    seen.unwrap_or_else(|seen| panic!("socket closed before '{msg_type}'; saw {seen:?}"))
}
mod common;
