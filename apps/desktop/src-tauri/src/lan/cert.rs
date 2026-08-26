//! Self-signed TLS for the LAN control plane, bound to this device identity
//! ([ADR-0002](../../../../../../docs/adr/0002-device-identity.md)).

use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;

use anyhow::{Context, Result};
use rcgen::{CertificateParams, DnType, KeyPair, SanType};
use sha2::{Digest, Sha256};

pub struct LanTlsIdentity {
    pub cert_pem: Vec<u8>,
    pub key_pem: Vec<u8>,
    pub cert_sha256_hex: String,
}

pub fn load_or_generate(
    dir: &Path,
    device_id: &str,
    lan_ips: &[Ipv4Addr],
) -> Result<LanTlsIdentity> {
    fs::create_dir_all(dir).ok();
    let cert_path = dir.join("lan_tls_cert.pem");
    let key_path = dir.join("lan_tls_key.pem");
    if cert_path.is_file() && key_path.is_file() {
        let cert_pem = fs::read(&cert_path).context("read LAN TLS cert")?;
        let key_pem = fs::read(&key_path).context("read LAN TLS key")?;
        let cert_sha256_hex = sha256_hex_der(&cert_pem)?;
        return Ok(LanTlsIdentity {
            cert_pem,
            key_pem,
            cert_sha256_hex,
        });
    }
    let identity = generate(device_id, lan_ips)?;
    fs::write(&cert_path, &identity.cert_pem).context("write LAN TLS cert")?;
    fs::write(&key_path, &identity.key_pem).context("write LAN TLS key")?;
    Ok(identity)
}

fn sha256_hex_der(cert_pem: &[u8]) -> Result<String> {
    let mut reader = std::io::BufReader::new(cert_pem);
    let certs = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .context("parse LAN TLS cert pem")?;
    let der = certs
        .first()
        .ok_or_else(|| anyhow::anyhow!("LAN TLS cert pem empty"))?;
    let mut hasher = Sha256::new();
    hasher.update(der.as_ref());
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

pub fn generate(device_id: &str, lan_ips: &[Ipv4Addr]) -> Result<LanTlsIdentity> {
    let mut params = CertificateParams::default();
    params
        .distinguished_name
        .push(DnType::CommonName, device_id);
    let dns = device_id
        .to_owned()
        .try_into()
        .context("device id DNS SAN")?;
    let mut sans = vec![SanType::DnsName(dns)];
    for ip in lan_ips {
        sans.push(SanType::IpAddress(IpAddr::V4(*ip)));
    }
    params.subject_alt_names = sans;
    let key_pair = KeyPair::generate().context("generate LAN TLS key")?;
    let cert = params.self_signed(&key_pair).context("sign LAN TLS cert")?;
    let cert_pem = cert.pem().into_bytes();
    let key_pem = key_pair.serialize_pem().into_bytes();
    let mut hasher = Sha256::new();
    hasher.update(cert.der());
    let cert_sha256_hex = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(LanTlsIdentity {
        cert_pem,
        key_pem,
        cert_sha256_hex,
    })
}
