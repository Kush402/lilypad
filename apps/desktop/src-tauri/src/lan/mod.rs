mod cert;
mod endpoints;
mod hub;
mod mdns;
pub mod server;

pub use cert::{generate as generate_tls, load_or_generate as load_or_generate_tls};
pub use endpoints::{build as build_lan_endpoints, detect_lan_ipv4, LanEndpoints};
pub use hub::LanHub;
pub use server::{ConnectNotifier, LanServerState, TauriConnectNotifier};
pub use trust_cache::{hash_secret, TrustCache, TrustedMobile};

mod trust_cache;

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use tauri::AppHandle;

/// TCP port for the embedded LAN control server (`packages/protocol/src/lan.ts`).
pub fn lan_control_port() -> u16 {
    std::env::var("LILYPAD_LAN_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8787)
}

pub const LAN_CONTROL_PORT: u16 = 8787;

/// Rustls 0.23 requires an explicit crypto provider when both `ring` and
/// `aws-lc-rs` are in the dependency tree (reqwest/axum-server pull both).
pub fn ensure_crypto_provider() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        rustls::crypto::ring::default_provider()
            .install_default()
            .expect("install rustls ring crypto provider");
    });
}

/// Whether the embedded LAN control plane should start. Default on for macOS;
/// set `LILYPAD_LAN_CONTROL=0` to disable.
pub fn lan_control_enabled() -> bool {
    match std::env::var("LILYPAD_LAN_CONTROL").as_deref() {
        Ok("0") | Ok("false") | Ok("FALSE") => false,
        Ok("1") | Ok("true") | Ok("TRUE") => true,
        _ => cfg!(target_os = "macos"),
    }
}

/// Load trust cache and, when enabled, start the LAN TLS control server.
pub fn start(
    app: &AppHandle,
    config_dir: &Path,
    device_id: &str,
) -> Result<(Arc<TrustCache>, Option<Arc<LanEndpoints>>)> {
    ensure_crypto_provider();
    let cache = Arc::new(TrustCache::load(config_dir)?);
    if !lan_control_enabled() {
        log::info!(target: "lilypad::lan", "LAN control server disabled");
        return Ok((cache, None));
    }
    let Some(lan_ip) = detect_lan_ipv4() else {
        log::warn!(
            target: "lilypad::lan",
            "no LAN IPv4 detected — control server not started"
        );
        return Ok((cache, None));
    };

    let tls = load_or_generate_tls(config_dir, device_id, std::slice::from_ref(&lan_ip))?;
    let port = lan_control_port();
    let endpoints = build_lan_endpoints(lan_ip, port, &tls.cert_sha256_hex);
    let hub = Arc::new(LanHub::new());
    let notifier: Arc<dyn ConnectNotifier> = Arc::new(TauriConnectNotifier { app: app.clone() });
    let state = Arc::new(LanServerState {
        trust_cache: cache.clone(),
        device_id: device_id.to_owned(),
        endpoints: endpoints.clone(),
        hub,
        notifier,
        port,
    });

    let cert_pem = tls.cert_pem.clone();
    let key_pem = tls.key_pem.clone();
    let _mdns = mdns::advertise(device_id, lan_ip, port).ok();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server::run(state, cert_pem, key_pem).await {
            log::error!(target: "lilypad::lan", "LAN control server failed: {e:#}");
        }
    });

    log::info!(
        target: "lilypad::lan",
        "LAN control server started at {}",
        endpoints.api_base_url
    );
    Ok((cache, Some(Arc::new(endpoints))))
}
