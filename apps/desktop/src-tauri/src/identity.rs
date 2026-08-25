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
            Err(e) => {
                // The keychain's own words ("Platform secure storage failure:
                // Keychain error: -25300") end up on the dashboard's linking
                // card, which is the least useful place for them.
                log::warn!(target: "lilypad::identity", "keychain read failed: {e}");
                Err(anyhow::anyhow!(
                    "macOS would not let Lilypad read this computer’s key. If a keychain \
                     permission box appeared, allow it and try again."
                ))
            }
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
    pub fn sign_challenge(&self, challenge: &str, origin: Option<&str>) -> String {
        let message = device_proof_message(challenge, origin);
        b64(self.key_pair.sign(message.as_bytes()).as_ref())
    }
}

/// Mirrors `DEVICE_AUTH_PREFIX` in `packages/protocol/src/identity.ts`. The two
/// are hand-mirrored like the signaling envelopes, and
/// `tests/protocol_contract.rs` is where cross-language drift gets caught.
pub const DEVICE_AUTH_PREFIX: &str = "lilypad-device-auth:v1:";

/// Mirrors `DEVICE_AUTH_PREFIX_V2`. A v2 proof names the server it is for, so
/// a signature obtained by a hostile host cannot be replayed at the real one.
pub const DEVICE_AUTH_PREFIX_V2: &str = "lilypad-device-auth:v2:";

/// Exactly the bytes a device signs — the Rust half of `deviceProofMessage`
/// in `packages/protocol/src/identity.ts`. The host is length-prefixed so the
/// encoding is canonical whatever it contains.
pub fn device_proof_message(challenge: &str, origin: Option<&str>) -> String {
    match origin {
        Some(origin) => format!(
            "{DEVICE_AUTH_PREFIX_V2}{}:{origin}:{challenge}",
            origin.len()
        ),
        None => format!("{DEVICE_AUTH_PREFIX}{challenge}"),
    }
}

/// The host to sign, from a base URL — the Rust half of `proofOriginOf`.
///
/// Hand-written rather than pulling in the `url` crate for one field, and
/// written to match `new URL(...).host` where it matters: userinfo dropped,
/// path/query/fragment cut, lowercased, and **the default port removed**,
/// because `https://h:443` and `https://h` are the same host to the server and
/// a disagreement here means every signature is rejected.
///
/// `None` when there is no host to speak of; the caller then sends no
/// `proofOrigin` and signs the v1 message, which a server still accepts.
pub fn proof_origin_of(api_base_url: &str) -> Option<String> {
    let rest = api_base_url.split_once("://")?.1;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        // Userinfo, if any, is not part of the host.
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if authority.is_empty() {
        return None;
    }
    let scheme = api_base_url
        .split_once("://")
        .map(|(s, _)| s.to_ascii_lowercase())
        .unwrap_or_default();
    let default_port = match scheme.as_str() {
        "https" | "wss" => ":443",
        "http" | "ws" => ":80",
        _ => "",
    };
    let host = match authority.strip_suffix(default_port) {
        Some(stripped) if !default_port.is_empty() && !stripped.is_empty() => stripped.to_owned(),
        _ => authority,
    };
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// What this computer calls itself, for the name a phone sees.
///
/// Every desktop used to enroll as the literal string `"macos desktop"`, which
/// is also what every OTHER Mac enrolled as — so "Your devices" on the phone
/// listed three rows with identical names and no way to tell which was which
/// (reported with a screenshot, 2026-08-24). `scutil --get ComputerName` is
/// the name macOS itself shows in Sharing settings and AirDrop, so it is the
/// name its owner already knows the machine by.
///
/// Falls back through `hostname` to a generic string, because a name is a label
/// and nothing authorizes on it: failing to read one must never fail the
/// pairing it is attached to.
pub(crate) fn device_name() -> String {
    // Read once. This now rides along on `/devices/token`, which every client
    // calls on launch and every ten minutes after — and each read spawns a
    // process, on a thread the async runtime wanted for something else. A
    // computer that is renamed picks the new name up on its next launch, which
    // is soon enough for a label.
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        #[cfg(target_os = "macos")]
        if let Some(name) = command_line("scutil", &["--get", "ComputerName"]) {
            return name;
        }
        command_line("hostname", &[]).unwrap_or_else(|| "This computer".to_string())
    })
    .clone()
}

/// One line of a command's stdout, cleaned for use as a device name, or `None`
/// if it produced nothing usable.
fn command_line(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    clean_device_name(&String::from_utf8_lossy(&out.stdout))
}

/// Trim, drop the `.local` that `hostname` appends on macOS, and refuse an
/// empty result. Capped at the 120 characters the rename endpoint accepts, so
/// a hostile hostname cannot make enrollment fail validation.
fn clean_device_name(raw: &str) -> Option<String> {
    let name = raw.trim().trim_end_matches(".local").trim();
    if name.is_empty() {
        return None;
    }
    Some(name.chars().take(120).collect())
}

#[cfg(test)]
mod tests {

    /// The name a phone will show for this computer.
    ///
    /// Three Macs on one account all enrolled as `"macos desktop"`, so "Your
    /// devices" was three identical rows. These pin the cleanup, which is the
    /// only part that can turn a machine's real name into an unusable one.
    #[test]
    fn a_computer_name_is_cleaned_before_it_becomes_a_label() {
        assert_eq!(
            clean_device_name("  Kush's MacBook Pro\n").as_deref(),
            Some("Kush's MacBook Pro")
        );
        // `hostname` appends this on macOS; the phone should not see it.
        assert_eq!(
            clean_device_name("Kushs-MacBook-Pro.local\n").as_deref(),
            Some("Kushs-MacBook-Pro")
        );
        // Nothing usable is NOT a name — the caller falls back instead.
        assert_eq!(clean_device_name("   \n"), None);
        assert_eq!(clean_device_name(""), None);
        assert_eq!(clean_device_name(".local"), None);
        // `/devices/:id` accepts 120 characters. A hostname longer than that
        // must not make enrollment fail validation.
        let long = clean_device_name(&"n".repeat(500)).unwrap();
        assert_eq!(long.chars().count(), 120);
    }

    /// Whatever the machine is called, enrollment gets SOMETHING to send.
    #[test]
    fn a_device_always_has_a_name() {
        assert!(!device_name().is_empty());
    }
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
        let message = device_proof_message(challenge, None);
        signature::UnparsedPublicKey::new(&signature::ED25519, &public_key)
            .verify(message.as_bytes(), &sig)
            .is_ok()
    }

    /// `proof_origin_of` must agree with `new URL(...).host` on the phone and
    /// the server, byte for byte. A disagreement is not a subtle bug: the
    /// server refuses a host it does not recognise, so every signature this
    /// app makes would be rejected and the Mac could never sign in.
    #[test]
    fn proof_origin_matches_what_new_url_would_produce() {
        let cases = [
            ("https://api.takedia.com", Some("api.takedia.com")),
            ("https://api.takedia.com/", Some("api.takedia.com")),
            (
                "https://api.takedia.com/v1/path?q=1#f",
                Some("api.takedia.com"),
            ),
            ("http://192.168.1.50:8080", Some("192.168.1.50:8080")),
            ("http://localhost:8080/", Some("localhost:8080")),
            // Case folded: DNS does not care, and the two sides must match.
            ("HTTPS://API.Takedia.COM", Some("api.takedia.com")),
            // Default ports are dropped by `new URL`, so they must be here too.
            ("https://api.takedia.com:443", Some("api.takedia.com")),
            ("http://api.takedia.com:80", Some("api.takedia.com")),
            // ...but a non-default port is part of the host.
            ("https://api.takedia.com:8443", Some("api.takedia.com:8443")),
            // Userinfo is not part of the host.
            ("https://user:pw@api.takedia.com", Some("api.takedia.com")),
            // Nothing to name: sign the older message rather than nonsense.
            ("not a url", None),
            ("", None),
            ("https://", None),
            ("https:///path", None),
        ];
        for (input, expected) in cases {
            assert_eq!(
                proof_origin_of(input).as_deref(),
                expected,
                "proof_origin_of({input:?})"
            );
        }
    }

    /// The exact bytes, pinned. `packages/protocol/src/identity.ts` builds the
    /// same string, and `tests/protocol_contract.rs` is where drift is caught.
    #[test]
    fn the_signed_message_is_length_prefixed_and_version_tagged() {
        assert_eq!(
            device_proof_message("nonce", None),
            "lilypad-device-auth:v1:nonce"
        );
        assert_eq!(
            device_proof_message("nonce", Some("h.example")),
            "lilypad-device-auth:v2:9:h.example:nonce"
        );
        // The length prefix is what stops one signature meaning two things.
        assert_ne!(
            device_proof_message("n", Some("a:1")),
            device_proof_message("1:n", Some("a"))
        );
    }

    /// A signature made for one server must not verify at another — the whole
    /// point of naming the host inside it.
    #[test]
    fn a_proof_made_for_one_host_does_not_verify_at_another() {
        let identity = DeviceIdentity::generate_ephemeral().unwrap();
        let challenge = "a-server-issued-nonce";

        fn verify_with(public_key_b64: &str, message: &str, signature_b64: &str) -> bool {
            let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
            let (Ok(public_key), Ok(sig)) =
                (engine.decode(public_key_b64), engine.decode(signature_b64))
            else {
                return false;
            };
            signature::UnparsedPublicKey::new(&signature::ED25519, &public_key)
                .verify(message.as_bytes(), &sig)
                .is_ok()
        }

        let signed_for_evil = identity.sign_challenge(challenge, Some("evil.example"));
        let key = identity.public_key_base64url();

        assert!(verify_with(
            &key,
            &device_proof_message(challenge, Some("evil.example")),
            &signed_for_evil
        ));
        // Replayed at the real backend:
        assert!(!verify_with(
            &key,
            &device_proof_message(challenge, Some("api.takedia.com")),
            &signed_for_evil
        ));
        // And it is not a valid v1 proof either, so it cannot be downgraded.
        assert!(!verify_with(
            &key,
            &device_proof_message(challenge, None),
            &signed_for_evil
        ));
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
        assert_eq!(identity.sign_challenge("a-challenge", None).len(), 86);
    }

    #[test]
    fn signs_a_challenge_its_own_public_key_verifies() {
        let identity = DeviceIdentity::generate_ephemeral().unwrap();
        let challenge = "a-server-issued-challenge";
        assert!(verify(
            &identity.public_key_base64url(),
            challenge,
            &identity.sign_challenge(challenge, None),
        ));
    }

    #[test]
    fn a_signature_does_not_verify_for_a_different_challenge() {
        let identity = DeviceIdentity::generate_ephemeral().unwrap();
        assert!(!verify(
            &identity.public_key_base64url(),
            "challenge-b",
            &identity.sign_challenge("challenge-a", None),
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
            &impostor.sign_challenge(challenge, None),
        ));
    }

    /// The prefix is what keeps a device-auth signature from also being a valid
    /// signature for another use of the same key (ADR-0006's TLS binding).
    #[test]
    fn signing_is_domain_separated() {
        let identity = DeviceIdentity::generate_ephemeral().unwrap();
        let challenge = "a-server-issued-challenge";
        let signed = identity.sign_challenge(challenge, None);
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
