//! Local cache of trusted phones for offline `POST /connect/request`
//! ([ADR-0006](../../../../../../docs/adr/0006-lan-first-connectivity.md)).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedMobile {
    pub mobile_device_id: String,
    pub connect_secret_hash: String,
    pub auto_approve: bool,
    pub display_name: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    mobiles: HashMap<String, TrustedMobile>,
}

pub struct TrustCache {
    path: PathBuf,
    inner: Mutex<Store>,
}

impl TrustCache {
    pub fn load(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir).ok();
        let path = dir.join("lan_trust_cache.json");
        let store = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Ok(Self {
            path,
            inner: Mutex::new(store),
        })
    }

    pub fn upsert(&self, row: TrustedMobile) -> Result<()> {
        {
            let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            guard.mobiles.insert(row.mobile_device_id.clone(), row);
        }
        self.persist()
    }

    /// Drop one phone. Used when the desktop itself revokes a pair and already
    /// knows the mobile id — the cloud path also pushes a full `trust-sync`,
    /// but local removal must not wait on that round-trip.
    pub fn remove(&self, mobile_device_id: &str) -> Result<()> {
        {
            let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            guard.mobiles.remove(mobile_device_id);
        }
        self.persist()
    }

    /// Replace the entire cache with an authoritative list from the backend.
    /// Omissions are revocations: the cloud communicates "no longer trusted"
    /// by leaving a phone out of the re-sync, and an append-only cache cannot
    /// see an omission.
    pub fn replace_all(&self, rows: Vec<TrustedMobile>) -> Result<()> {
        {
            let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            guard.mobiles.clear();
            for row in rows {
                guard.mobiles.insert(row.mobile_device_id.clone(), row);
            }
        }
        self.persist()
    }

    pub fn get(&self, mobile_device_id: &str) -> Option<TrustedMobile> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .mobiles
            .get(mobile_device_id)
            .cloned()
    }

    pub fn authorize_connect(
        &self,
        mobile_device_id: &str,
        pair_secret: Option<&str>,
    ) -> Option<TrustedMobile> {
        let row = self.get(mobile_device_id)?;
        let presented = pair_secret?;
        let hash = hash_secret(presented);
        if !constant_time_eq(&hash, &row.connect_secret_hash) {
            return None;
        }
        Some(row)
    }

    fn persist(&self) -> Result<()> {
        let json =
            serde_json::to_string_pretty(&*self.inner.lock().unwrap_or_else(|p| p.into_inner()))
                .context("serialize lan trust cache")?;
        fs::write(&self.path, json).context("write lan trust cache")
    }
}

pub fn hash_secret(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hex_lower(&hasher.finalize())
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let ba = a.as_bytes();
    let bb = b.as_bytes();
    ba.len() == bb.len() && ba.iter().zip(bb).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_requires_matching_secret_hash() {
        let dir = std::env::temp_dir().join(format!("lilypad-lan-trust-{}", uuid::Uuid::new_v4()));
        let cache = TrustCache::load(&dir).unwrap();
        let secret = "abcdefghijklmnop";
        cache
            .upsert(TrustedMobile {
                mobile_device_id: "mobile-12345678".into(),
                connect_secret_hash: hash_secret(secret),
                auto_approve: true,
                display_name: None,
            })
            .unwrap();
        assert!(cache
            .authorize_connect("mobile-12345678", Some(secret))
            .is_some());
        assert!(cache
            .authorize_connect("mobile-12345678", Some("wrong"))
            .is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn replace_all_prunes_phones_omitted_from_the_resync() {
        let dir = std::env::temp_dir().join(format!("lilypad-lan-trust-{}", uuid::Uuid::new_v4()));
        let cache = TrustCache::load(&dir).unwrap();
        let secret = "abcdefghijklmnop";
        cache
            .upsert(TrustedMobile {
                mobile_device_id: "mobile-keep".into(),
                connect_secret_hash: hash_secret(secret),
                auto_approve: true,
                display_name: None,
            })
            .unwrap();
        cache
            .upsert(TrustedMobile {
                mobile_device_id: "mobile-gone".into(),
                connect_secret_hash: hash_secret(secret),
                auto_approve: true,
                display_name: None,
            })
            .unwrap();

        cache
            .replace_all(vec![TrustedMobile {
                mobile_device_id: "mobile-keep".into(),
                connect_secret_hash: hash_secret(secret),
                auto_approve: true,
                display_name: Some("Phone".into()),
            }])
            .unwrap();

        assert!(cache.get("mobile-keep").is_some());
        assert!(cache.get("mobile-gone").is_none());
        assert!(cache
            .authorize_connect("mobile-gone", Some(secret))
            .is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn replace_all_with_empty_list_clears_the_cache() {
        let dir = std::env::temp_dir().join(format!("lilypad-lan-trust-{}", uuid::Uuid::new_v4()));
        let cache = TrustCache::load(&dir).unwrap();
        cache
            .upsert(TrustedMobile {
                mobile_device_id: "mobile-only".into(),
                connect_secret_hash: hash_secret("abcdefghijklmnop"),
                auto_approve: true,
                display_name: None,
            })
            .unwrap();
        cache.replace_all(vec![]).unwrap();
        assert!(cache.get("mobile-only").is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn remove_drops_one_phone() {
        let dir = std::env::temp_dir().join(format!("lilypad-lan-trust-{}", uuid::Uuid::new_v4()));
        let cache = TrustCache::load(&dir).unwrap();
        cache
            .upsert(TrustedMobile {
                mobile_device_id: "mobile-a".into(),
                connect_secret_hash: hash_secret("abcdefghijklmnop"),
                auto_approve: true,
                display_name: None,
            })
            .unwrap();
        cache.remove("mobile-a").unwrap();
        assert!(cache.get("mobile-a").is_none());
        let _ = fs::remove_dir_all(dir);
    }
}
