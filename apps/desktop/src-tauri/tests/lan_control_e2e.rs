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
    build_lan_endpoints, generate_tls as generate_lan_tls, hash_secret, LanHub, LanServerState,
    TrustCache, TrustedMobile,
};
use lilypad_desktop_lib::signaling::messages::ConnectRequestPayload;
use rustls::{ClientConfig, RootCertStore};

struct RecordingNotifier {
    hits: Mutex<Vec<ConnectRequestPayload>>,
}

impl ConnectNotifier for RecordingNotifier {
    fn notify(&self, _signaling_url: &str, payload: ConnectRequestPayload) {
        self.hits.lock().unwrap().push(payload);
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
    let notifier = Arc::new(RecordingNotifier {
        hits: Mutex::new(Vec::new()),
    });
    let state = Arc::new(LanServerState {
        trust_cache: cache,
        device_id: device_id.into(),
        endpoints,
        hub: Arc::new(LanHub::new()),
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
    assert!(json.get("roomId").is_some());
    assert!(json
        .get("signalingUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .contains("/ws/signal"));
    assert_eq!(notifier.hits.lock().unwrap().len(), 1);

    let _ = std::fs::remove_dir_all(dir);
}
mod common;
