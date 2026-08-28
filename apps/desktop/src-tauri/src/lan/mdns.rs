//! mDNS advertisement for secondary LAN discovery (NETWORKING.md §4).

use std::collections::HashMap;
use std::net::Ipv4Addr;

use anyhow::{Context, Result};
use mdns_sd::ServiceDaemon;

/// The mDNS responder, and whatever it is currently saying.
///
/// **This must be held, and until L-181 it was not.** `lan::start` wrote
/// `let _mdns = mdns::advertise(...)`, which drops the value at the end of the
/// statement — despite the doc comment on this type claiming it was kept for the
/// process lifetime. LAN discovery survived only because mdns-sd 0.11.5 happens
/// to have no `Drop` impl, so the daemon's threads outlived the handle. A
/// routine crate upgrade that added one would have silently killed the mDNS half
/// of LAN discovery, with nothing failing and no log line to find it by.
///
/// Kept mutable rather than fire-and-forget because what it says can change:
/// this Mac's LAN address moves with a DHCP lease (L-181) and its device id can
/// be replaced by the backend's canonical one (L-180). The phone filters browse
/// results on the `deviceId` TXT record and dials the address, so a responder
/// that cannot be updated is a responder that hands the phone the wrong laptop.
pub struct MdnsAdvertiser {
    daemon: ServiceDaemon,
    /// The fullname currently registered, needed to withdraw it before
    /// registering a replacement.
    registered: Option<String>,
}

impl MdnsAdvertiser {
    pub fn start() -> Result<Self> {
        Ok(Self {
            daemon: ServiceDaemon::new().context("start mDNS daemon")?,
            registered: None,
        })
    }

    /// Advertise `device_id` at `lan_ip:port`, replacing any earlier record.
    pub fn publish(&mut self, device_id: &str, lan_ip: Ipv4Addr, port: u16) -> Result<()> {
        if let Some(previous) = self.registered.take() {
            // Withdrawn rather than left to expire: a browsing phone that keeps
            // the stale record dials an address this Mac no longer answers on,
            // and its LAN attempt fails silently before falling back to cloud.
            if let Err(e) = self.daemon.unregister(&previous) {
                log::warn!(target: "lilypad::lan", "could not withdraw mDNS record {previous}: {e}");
            }
        }
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
        let fullname = info.get_fullname().to_owned();
        self.daemon
            .register(info)
            .context("register mDNS service")?;
        self.registered = Some(fullname);
        log::info!(
            target: "lilypad::lan",
            "mDNS advertising {service_type} on {lan_ip}:{port} as {instance} (deviceId {device_id})"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan::LAN_CONTROL_PORT;

    #[test]
    fn advertise_does_not_panic_on_loopback() {
        // Registration may fail on CI without multicast; we only require it not to crash.
        let Ok(mut advertiser) = MdnsAdvertiser::start() else {
            return;
        };
        let _ = advertiser.publish(
            "desktop-12345678",
            Ipv4Addr::new(127, 0, 0, 1),
            LAN_CONTROL_PORT,
        );
    }

    /// Republishing must withdraw what it replaces, so a browsing phone is not
    /// left choosing between two records for the same Mac — one of which names
    /// an address it no longer answers on (L-181) or an id it no longer has
    /// (L-180).
    #[test]
    fn republishing_replaces_the_previous_record() {
        let Ok(mut advertiser) = MdnsAdvertiser::start() else {
            return;
        };
        if advertiser
            .publish(
                "desktop-12345678",
                Ipv4Addr::new(127, 0, 0, 1),
                LAN_CONTROL_PORT,
            )
            .is_err()
        {
            return; // no multicast on this host — nothing to assert about
        }
        let first = advertiser.registered.clone();
        assert!(first.is_some(), "a successful publish records its fullname");
        let _ = advertiser.publish(
            "desktop-87654321",
            Ipv4Addr::new(127, 0, 0, 1),
            LAN_CONTROL_PORT,
        );
        assert_ne!(
            advertiser.registered, first,
            "a new device id must be advertised under its own record"
        );
    }
}
