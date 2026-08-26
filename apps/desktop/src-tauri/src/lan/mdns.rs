//! mDNS advertisement for secondary LAN discovery (NETWORKING.md §4).

use std::collections::HashMap;
use std::net::Ipv4Addr;

use anyhow::{Context, Result};
use mdns_sd::ServiceDaemon;

/// Keeps the mDNS daemon alive for the process lifetime.
pub struct MdnsAdvertiser {
    _daemon: ServiceDaemon,
}

pub fn advertise(device_id: &str, lan_ip: Ipv4Addr, port: u16) -> Result<MdnsAdvertiser> {
    let daemon = ServiceDaemon::new().context("start mDNS daemon")?;
    let service_type = "_lilypad._tcp.local.";
    let suffix = device_id
        .chars()
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    let instance = format!("lilypad-{suffix}");
    let host = format!("{instance}.local.");
    let mut props = HashMap::new();
    props.insert("deviceId".to_owned(), device_id.to_owned());
    let info = mdns_sd::ServiceInfo::new(
        service_type,
        &instance,
        &host,
        std::net::IpAddr::from(lan_ip),
        port,
        Some(props),
    )
    .context("build mDNS service info")?;
    daemon.register(info).context("register mDNS service")?;
    log::info!(
        target: "lilypad::lan",
        "mDNS advertising {service_type} on {lan_ip}:{port} as {instance}"
    );
    Ok(MdnsAdvertiser { _daemon: daemon })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan::LAN_CONTROL_PORT;

    #[test]
    fn advertise_does_not_panic_on_loopback() {
        // Registration may fail on CI without multicast; we only require it not to crash.
        let _ = advertise(
            "desktop-12345678",
            Ipv4Addr::new(127, 0, 0, 1),
            LAN_CONTROL_PORT,
        );
    }
}
