use anyhow::{Context, Result};
use base64::Engine;
use ring::signature::{Ed25519KeyPair, KeyPair};

/// This laptop's Ed25519 identity ([ADR-0002](../../../../docs/adr/0002-device-identity.md)).
///
/// The private key is generated once, kept in the OS credential store, and
/// never leaves the machine. It is what proves to the backend that this
/// specific laptop is asking — the `device_id` string next to it is a label,
/// not a credential.
///
/// **Storage is the OS keychain, not the Secure Enclave.** Ed25519 keys cannot
/// live in the Secure Enclave (it is P-256 only), and ADR-0002 records why that
/// trade was accepted rather than switching curve. On macOS the keychain ACL
/// still restricts the item to this signed application, which a plain file
/// beside `device_id` would not.
///
/// Ed25519 comes from `ring`, which is already in the dependency tree via
/// rustls and rcgen — no new crypto dependency, and no hand-rolled anything.
pub struct DeviceIdentity {
    key_pair: Ed25519KeyPair,
}

/// Keychain coordinates. Distinct from any other credential this app stores, so
/// a future entry cannot collide with the device key.
const KEYCHAIN_SERVICE: &str = "com.takedia.lilypad.desktop.device-key";
const KEYCHAIN_ACCOUNT: &str = "ed25519-pkcs8";

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl DeviceIdentity {
    /// Load this device's key, generating and storing one on first run.
    ///
    /// A key that cannot be persisted is an ERROR, not something to paper over
    /// with an ephemeral one: a device whose identity changes every launch
    /// would re-enroll endlessly and orphan its own trust relationships.
    pub fn load_or_create() -> Result<Self> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .context("could not open the OS credential store")?;

        match entry.get_secret() {
            Ok(pkcs8) => Self::from_pkcs8(&pkcs8),
            Err(keyring::Error::NoEntry) => {
                let rng = ring::rand::SystemRandom::new();
                let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng)
                    .map_err(|_| anyhow::anyhow!("could not generate a device key"))?;
                entry
                    .set_secret(pkcs8.as_ref())
                    .context("could not store the device key in the OS credential store")?;
                Self::from_pkcs8(pkcs8.as_ref())
            }
            Err(e) => Err(anyhow::anyhow!("could not read the device key: {e}")),
        }
    }

    fn from_pkcs8(pkcs8: &[u8]) -> Result<Self> {
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8)
            .map_err(|_| anyhow::anyhow!("the stored device key is not a valid Ed25519 key"))?;
        Ok(Self { key_pair })
    }

    /// Build an identity from raw PKCS#8 bytes. Tests use this to exercise
    /// signing without touching the machine's real keychain.
    pub fn from_pkcs8_bytes(pkcs8: &[u8]) -> Result<Self> {
        Self::from_pkcs8(pkcs8)
    }

    /// Generate an unsaved identity — for tests only.
    #[cfg(test)]
    pub fn generate_ephemeral() -> Result<Self> {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng)
            .map_err(|_| anyhow::anyhow!("could not generate a device key"))?;
        Self::from_pkcs8(pkcs8.as_ref())
    }

    /// The raw 32-byte public key, base64url — the exact wire encoding
    /// `packages/protocol/src/identity.ts` specifies.
    pub fn public_key_base64url(&self) -> String {
        b64(self.key_pair.public_key().as_ref())
    }

    /// Sign a server-issued challenge, base64url.
    ///
    /// The domain-separation prefix is not decoration: the same key will bind
    /// this device's LAN TLS certificate (ADR-0006), and without a prefix a
    /// signature made for one purpose would authenticate the other.
    pub fn sign_challenge(&self, challenge: &str) -> String {
        let message = format!("{DEVICE_AUTH_PREFIX}{challenge}");
        b64(self.key_pair.sign(message.as_bytes()).as_ref())
    }
}

/// Mirrors `DEVICE_AUTH_PREFIX` in `packages/protocol/src/identity.ts`. The two
/// are hand-mirrored like the signaling envelopes, and
/// `tests/protocol_contract.rs` is where cross-language drift gets caught.
pub const DEVICE_AUTH_PREFIX: &str = "lilypad-device-auth:v1:";

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature;

    fn verify(public_key_b64: &str, challenge: &str, signature_b64: &str) -> bool {
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let Ok(public_key) = engine.decode(public_key_b64) else {
            return false;
        };
        let Ok(sig) = engine.decode(signature_b64) else {
            return false;
        };
        let message = format!("{DEVICE_AUTH_PREFIX}{challenge}");
        signature::UnparsedPublicKey::new(&signature::ED25519, &public_key)
            .verify(message.as_bytes(), &sig)
            .is_ok()
    }

    #[test]
    fn public_key_is_32_raw_bytes_as_43_base64url_chars() {
        let identity = DeviceIdentity::generate_ephemeral().unwrap();
        // The protocol schema pins this length; a mismatch here means the
        // backend would reject every enrollment this app ever attempts.
        assert_eq!(identity.public_key_base64url().len(), 43);
    }

    #[test]
    fn signature_is_64_raw_bytes_as_86_base64url_chars() {
        let identity = DeviceIdentity::generate_ephemeral().unwrap();
        assert_eq!(identity.sign_challenge("a-challenge").len(), 86);
    }

    #[test]
    fn signs_a_challenge_its_own_public_key_verifies() {
        let identity = DeviceIdentity::generate_ephemeral().unwrap();
        let challenge = "a-server-issued-challenge";
        assert!(verify(
            &identity.public_key_base64url(),
            challenge,
            &identity.sign_challenge(challenge),
        ));
    }

    #[test]
    fn a_signature_does_not_verify_for_a_different_challenge() {
        let identity = DeviceIdentity::generate_ephemeral().unwrap();
        assert!(!verify(
            &identity.public_key_base64url(),
            "challenge-b",
            &identity.sign_challenge("challenge-a"),
        ));
    }

    #[test]
    fn another_device_cannot_produce_this_devices_signature() {
        let identity = DeviceIdentity::generate_ephemeral().unwrap();
        let impostor = DeviceIdentity::generate_ephemeral().unwrap();
        let challenge = "a-server-issued-challenge";
        assert!(!verify(
            &identity.public_key_base64url(),
            challenge,
            &impostor.sign_challenge(challenge),
        ));
    }

    /// The prefix is what keeps a device-auth signature from also being a valid
    /// signature for another use of the same key (ADR-0006's TLS binding).
    #[test]
    fn signing_is_domain_separated() {
        let identity = DeviceIdentity::generate_ephemeral().unwrap();
        let challenge = "a-server-issued-challenge";
        let signed = identity.sign_challenge(challenge);
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let public_key = engine.decode(identity.public_key_base64url()).unwrap();
        let sig = engine.decode(&signed).unwrap();
        // The same signature over the BARE challenge must not verify.
        assert!(
            signature::UnparsedPublicKey::new(&signature::ED25519, &public_key)
                .verify(challenge.as_bytes(), &sig)
                .is_err()
        );
    }

    #[test]
    fn the_same_stored_key_reloads_to_the_same_identity() {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let first = DeviceIdentity::from_pkcs8_bytes(pkcs8.as_ref()).unwrap();
        let second = DeviceIdentity::from_pkcs8_bytes(pkcs8.as_ref()).unwrap();
        assert_eq!(first.public_key_base64url(), second.public_key_base64url());
    }

    #[test]
    fn corrupt_stored_bytes_are_rejected_rather_than_panicking() {
        assert!(DeviceIdentity::from_pkcs8_bytes(b"not a pkcs8 document").is_err());
    }
}
