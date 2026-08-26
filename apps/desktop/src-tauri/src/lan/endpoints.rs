//! Detect where this laptop is reachable on the LAN.

use std::net::{IpAddr, Ipv4Addr};

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
