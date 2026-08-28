mod cert;
mod endpoints;
mod hub;
pub mod loopback;
mod mdns;
pub mod server;

pub use cert::{generate as generate_tls, load_or_generate as load_or_generate_tls};
pub use endpoints::{build as build_lan_endpoints, detect_lan_ipv4, LanAdvertisement, LanEndpoints};
pub use hub::{LanHub, Role as LanRole, SeatToken, SendFn};
pub use loopback::connect as loopback_connect;
pub use mdns::MdnsAdvertiser;
pub use server::{
    fixed_device_id, ConnectNotifier, DeviceIdSource, LanServerState, TauriConnectNotifier,
};
pub use trust_cache::{hash_secret, TrustCache, TrustedMobile};

mod trust_cache;

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tauri::{AppHandle, Manager};

use crate::state::SharedState;

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

/// How often the LAN plane re-checks the two facts it advertises: where this
/// Mac is reachable, and what this Mac is called.
///
/// Both were read once at launch and then assumed fixed for the life of the
/// process, and neither is (L-180, L-181). A poll rather than an event
/// subscription because the check is a `getifaddrs` call and a string compare —
/// cheaper than the plumbing that would tell us when to do it, and it doubles as
/// the retry for a Mac that had no LAN address at all when it launched.
const LAN_REFRESH_INTERVAL: Duration = Duration::from_secs(5);

/// Load trust cache and, when enabled, start the LAN TLS control plane.
///
/// Returns as soon as the supervisor is spawned; the server itself starts the
/// moment this Mac has a LAN address, which may be later than now.
pub fn start(app: &AppHandle, config_dir: &Path) -> Result<Arc<TrustCache>> {
    ensure_crypto_provider();
    let cache = Arc::new(TrustCache::load(config_dir)?);
    if !lan_control_enabled() {
        log::info!(target: "lilypad::lan", "LAN control server disabled");
        return Ok(cache);
    }

    let hub = Arc::new(LanHub::new());
    let advertisement = Arc::new(LanAdvertisement::new());
    // The session runner needs this exact hub to take the desktop seat of a
    // room the LAN server minted — in-process, because it cannot open a TLS
    // socket to its own self-signed certificate. See `lan::loopback`. Both are
    // managed before the supervisor has anything to publish, so a ring that
    // arrives the instant the server binds finds them already in place.
    app.manage(hub.clone());
    app.manage(advertisement.clone());

    // Read from the shared state on every use rather than captured here: see
    // `server::DeviceIdSource`.
    let state_handle = app.clone();
    let device_id: DeviceIdSource = Arc::new(move || {
        let state = state_handle.state::<SharedState>();
        let s = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        s.device_id.clone()
    });

    spawn_supervisor(
        app.clone(),
        config_dir.to_owned(),
        cache.clone(),
        hub,
        advertisement,
        device_id,
    );
    Ok(cache)
}

/// Keep the LAN control plane's view of the network current, forever.
///
/// Three things this loop exists to do, all of them cases the previous
/// start-once code could not recover from within a run:
///
/// 1. **Start late.** `detect_lan_ipv4()` returning `None` at launch used to
///    skip the LAN control plane for the life of the process — routine for a
///    launch-at-login app on a cold boot, where Lilypad is running well before
///    Wi-Fi has associated. Now it is simply a retry.
/// 2. **Follow the address.** A DHCP lease change left every URL this Mac
///    advertised naming the old address, mDNS included (L-181).
/// 3. **Follow the name.** `lib::adopt_device_id` can replace this Mac's wire id
///    after launch, and the mDNS TXT record the phone filters on carried the
///    old one (L-180).
fn spawn_supervisor(
    app: AppHandle,
    config_dir: PathBuf,
    cache: Arc<TrustCache>,
    hub: Arc<LanHub>,
    advertisement: Arc<LanAdvertisement>,
    device_id: DeviceIdSource,
) {
    let port = lan_control_port();
    tauri::async_runtime::spawn(async move {
        // Held here — genuinely, for as long as this task lives, which is the
        // life of the process. See `MdnsAdvertiser`.
        let mut mdns: Option<MdnsAdvertiser> = None;
        let mut announced: Option<(Ipv4Addr, String)> = None;
        let mut serving = false;
        // The certificate's SHA-256, needed to rebuild the endpoints when the
        // address changes. Held because the certificate itself must NOT be
        // regenerated for a new address — see `republish`.
        let mut cert_sha256 = String::new();
        let mut warned_no_ip = false;

        loop {
            let current_id = device_id();
            match detect_lan_ipv4() {
                Some(lan_ip) => {
                    warned_no_ip = false;
                    if !serving {
                        match boot(&app, &config_dir, &cache, &hub, &advertisement, &device_id, &current_id, lan_ip, port) {
                            Ok(sha) => {
                                cert_sha256 = sha;
                                serving = true;
                            }
                            Err(e) => {
                                log::error!(target: "lilypad::lan", "LAN control server could not start: {e:#}");
                            }
                        }
                    } else if advertisement.snapshot().map(|ep| ep.lan_ip) != Some(lan_ip) {
                        republish(&advertisement, lan_ip, port, &cert_sha256);
                    }

                    // Republished on an address change AND on an id change: the
                    // phone filters browse results on the `deviceId` TXT record
                    // and then dials the address, so either being stale hands it
                    // the wrong laptop or a dead one.
                    if serving && announced.as_ref() != Some(&(lan_ip, current_id.clone())) {
                        if mdns.is_none() {
                            match MdnsAdvertiser::start() {
                                Ok(a) => mdns = Some(a),
                                Err(e) => {
                                    log::warn!(target: "lilypad::lan", "mDNS unavailable: {e:#}")
                                }
                            }
                        }
                        if let Some(advertiser) = mdns.as_mut() {
                            match advertiser.publish(&current_id, lan_ip, port) {
                                Ok(()) => announced = Some((lan_ip, current_id.clone())),
                                Err(e) => {
                                    log::warn!(target: "lilypad::lan", "mDNS publish failed: {e:#}")
                                }
                            }
                        }
                    }
                }
                // Once, not every tick: a Mac on Ethernet-only that is
                // unplugged, or one whose Wi-Fi is off, would otherwise write
                // this line twelve times a minute forever.
                None if !warned_no_ip => {
                    warned_no_ip = true;
                    log::info!(
                        target: "lilypad::lan",
                        "no LAN IPv4 yet — the LAN control plane will start when one appears"
                    );
                }
                None => {}
            }
            tokio::time::sleep(LAN_REFRESH_INTERVAL).await;
        }
    });
}

/// Bind the control server, once, on the first address this Mac has.
///
/// Binding `0.0.0.0` is what makes this a one-off: the listener survives every
/// later address change, so only what the server SAYS has to be revisited.
#[allow(clippy::too_many_arguments)]
fn boot(
    app: &AppHandle,
    config_dir: &Path,
    cache: &Arc<TrustCache>,
    hub: &Arc<LanHub>,
    advertisement: &Arc<LanAdvertisement>,
    device_id: &DeviceIdSource,
    current_id: &str,
    lan_ip: Ipv4Addr,
    port: u16,
) -> Result<String> {
    let tls = load_or_generate_tls(config_dir, current_id, std::slice::from_ref(&lan_ip))?;
    advertisement.publish(build_lan_endpoints(lan_ip, port, &tls.cert_sha256_hex));

    let notifier: Arc<dyn ConnectNotifier> = Arc::new(TauriConnectNotifier { app: app.clone() });
    let state = Arc::new(LanServerState {
        trust_cache: cache.clone(),
        device_id: device_id.clone(),
        advertisement: advertisement.clone(),
        hub: hub.clone(),
        notifier,
        port,
    });

    let (cert_pem, key_pem) = (tls.cert_pem.clone(), tls.key_pem.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server::run(state, cert_pem, key_pem).await {
            log::error!(target: "lilypad::lan", "LAN control server failed: {e:#}");
        }
    });
    log::info!(
        target: "lilypad::lan",
        "LAN control server started at https://{lan_ip}:{port}"
    );
    Ok(tls.cert_sha256_hex)
}

/// Advertise a new address on the SAME certificate.
///
/// The certificate carries the address in its SAN, so a moved laptop leaves a
/// certificate that does not name where it now is — and regenerating is the
/// wrong trade. The phone pins the SHA-256 of the leaf certificate and compares
/// only that hash (`PinningDelegate` in `apps/mobile/ios/LilypadMobile/
/// LilypadLanTls.swift` accepts on hash match, evaluating neither the chain nor
/// the SAN), so the pin is bound to the certificate rather than to the address
/// and a stale SAN costs the phone nothing. Regenerating, by contrast,
/// invalidates every paired phone's pin at once, and a phone can only re-learn
/// the new hash from a `lan-endpoints` frame on its next CLOUD session — which
/// would trade a recoverable stale address for an unreachable LAN plane at
/// exactly the moment the network changed, and on a Mac with no internet it
/// would never be recoverable at all.
///
/// This is also already the state of every install past its first lease change:
/// `cert::load_or_generate` reuses the persisted certificate and ignores the
/// addresses it is handed, so a SAN that does not match has been the normal case
/// across restarts all along. Nothing on the LAN path authenticates this Mac by
/// its SAN, and the desktop no longer opens a socket to its own server
/// (`lan::loopback`), so the one client that would have checked is gone.
fn republish(
    advertisement: &Arc<LanAdvertisement>,
    lan_ip: Ipv4Addr,
    port: u16,
    cert_sha256: &str,
) {
    let previous = advertisement.snapshot().map(|ep| ep.lan_ip);
    advertisement.publish(build_lan_endpoints(lan_ip, port, cert_sha256));
    log::info!(
        target: "lilypad::lan",
        "LAN address changed ({} → {lan_ip}) — republished on the same certificate",
        previous.map(|ip| ip.to_string()).unwrap_or_else(|| "none".to_owned())
    );
}
