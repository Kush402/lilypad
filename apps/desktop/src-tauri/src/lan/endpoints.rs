//! Detect where this laptop is reachable on the LAN.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::RwLock;

#[derive(Debug, Clone)]
pub struct LanEndpoints {
    pub api_base_url: String,
    pub signaling_url: String,
    pub tls_cert_sha256: String,
    pub lan_ip: Ipv4Addr,
    pub port: u16,
}

pub fn build(lan_ip: Ipv4Addr, port: u16, tls_cert_sha256: &str) -> LanEndpoints {
    let host = lan_ip.to_string();
    LanEndpoints {
        api_base_url: format!("https://{host}:{port}"),
        signaling_url: format!("wss://{host}:{port}/ws/signal"),
        tls_cert_sha256: tls_cert_sha256.to_owned(),
        lan_ip,
        port,
    }
}

/// Where this Mac says it can be reached, for as long as that stays true.
///
/// The LAN address was read once at launch and never revisited. The server
/// binds `0.0.0.0`, so a DHCP lease change never stopped it LISTENING — what
/// broke was everything it said: `api_base_url`, `signaling_url`, the
/// `lan-endpoints` frame the phone caches, and the mDNS record.
/// [NETWORKING.md](../../../../../../docs/NETWORKING.md) §4 nominates mDNS as
/// the mechanism that "recovers the case where DHCP moved the laptop", and the
/// responder republished the same stale address — so the one failure the
/// secondary discovery mechanism exists for was the one it could not recover
/// (kanban L-181).
///
/// Behind a lock rather than passed around by value because two independent
/// readers need the CURRENT answer at unpredictable times: the request handler
/// that tells a phone where to signal, and `spawn_session_runner` deciding
/// whether a room is this desktop's own.
#[derive(Default)]
pub struct LanAdvertisement {
    inner: RwLock<Advertised>,
}

#[derive(Default)]
struct Advertised {
    /// `None` until an address has been detected — the ordinary state of a
    /// launch-at-login app on a cold boot, before Wi-Fi has associated.
    current: Option<LanEndpoints>,
    /// Every signaling URL this process has ever published, oldest first.
    ///
    /// `is_own_signaling_url` decides whether a room is joined in-process or
    /// over a socket, and answering "not mine" about a room that IS mine is the
    /// v0.1.20 failure: the desktop opens a WebSocket to its own self-signed
    /// certificate, cannot verify it, never takes its seat, and the phone waits
    /// on "Waiting for approval…" forever. A room minted moments before the
    /// address changed must still be recognised, so the answer is drawn from
    /// everything this process has advertised rather than only the newest.
    published: Vec<String>,
}

impl LanAdvertisement {
    pub fn new() -> Self {
        Self::default()
    }

    /// The addresses to hand out right now, or `None` if this Mac has no LAN
    /// address yet.
    pub fn snapshot(&self) -> Option<LanEndpoints> {
        self.read().current.clone()
    }

    pub fn publish(&self, endpoints: LanEndpoints) {
        let mut guard = self
            .inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !guard.published.iter().any(|u| *u == endpoints.signaling_url) {
            guard.published.push(endpoints.signaling_url.clone());
        }
        guard.current = Some(endpoints);
    }

    /// Is `url` an endpoint THIS process serves? See `Advertised::published`.
    pub fn is_own_signaling_url(&self, url: &str) -> bool {
        self.read().published.iter().any(|u| u == url)
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Advertised> {
        self.inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// First non-loopback, non-link-local IPv4 on a real interface.
pub fn detect_lan_ipv4() -> Option<Ipv4Addr> {
    local_ip_address::list_afinet_netifas()
        .ok()?
        .into_iter()
        .find_map(|(name, ip)| {
            if name.to_lowercase().contains("lo") {
                return None;
            }
            match ip {
                IpAddr::V4(v4) if v4.is_loopback() || v4.is_link_local() => None,
                IpAddr::V4(v4) => Some(v4),
                _ => None,
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_advertised_before_an_address_is_detected() {
        let ad = LanAdvertisement::new();
        assert!(ad.snapshot().is_none());
        assert!(!ad.is_own_signaling_url("wss://192.168.1.10:8787/ws/signal"));
    }

    /// A DHCP move republishes the new address — and keeps recognising the old
    /// URL as this desktop's own.
    ///
    /// A room minted on the previous address a moment before the lease changed
    /// is still a room on THIS machine's hub, and the only way to join it is
    /// in-process. Forgetting that is the v0.1.20 "Waiting for approval…"
    /// failure, reintroduced by the re-detect loop that fixes L-181.
    #[test]
    fn a_republished_address_does_not_disown_the_room_it_replaced() {
        let ad = LanAdvertisement::new();
        ad.publish(build(Ipv4Addr::new(192, 168, 1, 10), 8787, "ab"));
        ad.publish(build(Ipv4Addr::new(192, 168, 1, 44), 8787, "ab"));

        let now = ad.snapshot().expect("an address is advertised");
        assert_eq!(now.api_base_url, "https://192.168.1.44:8787");
        assert!(ad.is_own_signaling_url("wss://192.168.1.44:8787/ws/signal"));
        assert!(ad.is_own_signaling_url("wss://192.168.1.10:8787/ws/signal"));
        // Another laptop's LAN server, and the cloud, remain someone else's.
        assert!(!ad.is_own_signaling_url("wss://192.168.1.11:8787/ws/signal"));
        assert!(!ad.is_own_signaling_url("wss://api.takedia.com/ws/signal"));
    }
}
