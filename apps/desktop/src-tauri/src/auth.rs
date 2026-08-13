use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use crate::identity::DeviceIdentity;

/// This laptop's authenticated relationship with the backend
/// ([ADR-0002](../../../../docs/adr/0002-device-identity.md)).
///
/// Every backend call carries an access token minted from a signed challenge,
/// so the backend authorizes on the token's subject rather than on a device id
/// the request itself supplied.
///
/// **There is no stored refresh token, on purpose.** Renewal re-signs a fresh
/// challenge, which means the only durable credential on this machine is the
/// private key in the OS keychain — not a bearer string that would grant this
/// device's access to anything that copied it.
pub struct DeviceAuth {
    identity: DeviceIdentity,
    base_url: String,
    http: reqwest::Client,
    cached: Mutex<Option<CachedToken>>,
}

struct CachedToken {
    value: String,
    /// When to stop using it. Deliberately EARLIER than the server's expiry —
    /// see `RENEW_MARGIN`.
    renew_after: Instant,
    /// Who the backend says this device belongs to. Kept beside the token so
    /// the dashboard can answer "is this computer linked?" without a network
    /// round trip on every render.
    user_id: String,
    device_id: String,
}

/// Renew this far before the server would expire the token. Without a margin a
/// token that passes the check here can still expire in flight, turning a
/// routine renewal into a user-visible failure.
const RENEW_MARGIN: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
struct ChallengeResponse {
    challenge: String,
}

/// A single-use code a signed-in phone scans to add this laptop to its account
/// ([ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentCode {
    pub code: String,
    pub expires_in_seconds: u64,
    /// The address the PHONE should use — supplied by the backend, because a
    /// laptop configured with `http://localhost:8080` cannot put that in a QR.
    pub api_base_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSession {
    pub access_token: String,
    pub expires_in_seconds: u64,
    pub device_id: String,
    pub user_id: String,
}

/// A backend error that a client should NOT retry blindly, because retrying
/// with the same key will never succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// This device has no enrollment on any account — the user must sign in
    /// and enroll it.
    NotEnrolled,
    /// The device was revoked. Re-enrolling is the deliberate way back.
    Revoked,
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotEnrolled => write!(f, "this device is not enrolled — sign in to enroll it"),
            Self::Revoked => write!(f, "this device was revoked — sign in to enroll it again"),
        }
    }
}

impl std::error::Error for AuthError {}

impl DeviceAuth {
    pub fn new(identity: DeviceIdentity, base_url: String) -> Self {
        Self {
            identity,
            base_url,
            http: reqwest::Client::new(),
            cached: Mutex::new(None),
        }
    }

    pub fn public_key(&self) -> String {
        self.identity.public_key_base64url()
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url.trim_end_matches('/'))
    }

    /// Ask the backend for a nonce and sign it. Every authenticated exchange
    /// starts here.
    async fn signed_proof(&self) -> Result<(String, String, String)> {
        let response = self
            .http
            .post(self.url("/devices/challenge"))
            .send()
            .await
            .context("could not reach the backend for a device challenge")?;
        if !response.status().is_success() {
            bail!(
                "backend returned HTTP {} for a device challenge",
                response.status()
            );
        }
        let ChallengeResponse { challenge } = response
            .json()
            .await
            .context("the backend's device challenge was not valid JSON")?;
        let signature = self.identity.sign_challenge(&challenge);
        Ok((challenge, self.identity.public_key_base64url(), signature))
    }

    /// Bind this device to a signed-in account. Requires an ACCOUNT access
    /// token, because enrollment is the moment the device gains an owner.
    pub async fn enroll(
        &self,
        account_access_token: &str,
        fingerprint: &str,
        name: &str,
        platform: &str,
    ) -> Result<DeviceSession> {
        let (challenge, public_key, signature) = self.signed_proof().await?;
        let response = self
            .http
            .post(self.url("/devices/enroll"))
            .bearer_auth(account_access_token)
            .json(&serde_json::json!({
                "challenge": challenge,
                "publicKey": public_key,
                "signature": signature,
                "kind": "desktop",
                "fingerprint": fingerprint,
                "name": name,
                "platform": platform,
            }))
            .send()
            .await
            .context("could not reach the backend to enroll this device")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("enrollment failed (HTTP {status}): {body}");
        }
        let session: DeviceSession = response
            .json()
            .await
            .context("the backend's enrollment response was not valid JSON")?;
        self.cache(&session);
        Ok(session)
    }

    /// Ask for an enrollment code to show as a QR.
    ///
    /// The desktop has no OAuth client of its own: it is enrolled by a phone
    /// that is already signed in. The code is bound server-side to the public
    /// key proved here, so an intercepted code cannot enroll a different
    /// machine — it can only enroll THIS one, onto whichever account scans it.
    ///
    /// After showing the code, poll `sign_in()`: it stops returning
    /// `AuthError::NotEnrolled` the moment a phone approves. That is the whole
    /// completion protocol — no extra endpoint and no push channel.
    ///
    /// **`fingerprint` MUST be `AppState.device_id`**, the same string this app
    /// puts in `/pairing/create` and in its presence room. The backend resolves
    /// ownership by `(kind, fingerprint)`, so enrolling under any other value
    /// creates a second device row: the machine would be linked, yet every
    /// authorization check would still see the unlinked row and the presence
    /// gate would reject it. Same rule for `enroll` above.
    pub async fn request_enrollment_code(
        &self,
        fingerprint: &str,
        name: &str,
        platform: &str,
    ) -> Result<EnrollmentCode> {
        let (challenge, public_key, signature) = self.signed_proof().await?;
        let response = self
            .http
            .post(self.url("/devices/enrollment-code"))
            .json(&serde_json::json!({
                "challenge": challenge,
                "publicKey": public_key,
                "signature": signature,
                "fingerprint": fingerprint,
                "name": name,
                "platform": platform,
            }))
            .send()
            .await
            .context("could not reach the backend for an enrollment code")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("could not start enrollment (HTTP {status}): {body}");
        }
        response
            .json()
            .await
            .context("the backend's enrollment-code response was not valid JSON")
    }

    /// A valid access token, re-authenticating if the cached one is missing or
    /// close to expiry.
    pub async fn access_token(&self) -> Result<String> {
        if let Some(token) = self.cached_token() {
            return Ok(token);
        }
        let session = self.sign_in().await?;
        Ok(session.access_token)
    }

    /// Prove key possession and take a fresh device token. This is how the app
    /// authenticates after a restart, with no user interaction.
    pub async fn sign_in(&self) -> Result<DeviceSession> {
        let (challenge, public_key, signature) = self.signed_proof().await?;
        let response = self
            .http
            .post(self.url("/devices/token"))
            .json(&serde_json::json!({
                "challenge": challenge,
                "publicKey": public_key,
                "signature": signature,
            }))
            .send()
            .await
            .context("could not reach the backend to authenticate this device")?;

        let status = response.status();
        if status == reqwest::StatusCode::FORBIDDEN {
            // 403 means the credential was fine and the DEVICE is not allowed.
            // Retrying cannot help, so this is surfaced as a distinct error the
            // UI can turn into "sign in to enroll" rather than a retry loop.
            let body = response.text().await.unwrap_or_default();
            if body.contains("device_revoked") {
                return Err(AuthError::Revoked.into());
            }
            return Err(AuthError::NotEnrolled.into());
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("device sign-in failed (HTTP {status}): {body}");
        }
        let session: DeviceSession = response
            .json()
            .await
            .context("the backend's device token response was not valid JSON")?;
        self.cache(&session);
        Ok(session)
    }

    fn cached_token(&self) -> Option<String> {
        let guard = self.cached.lock().ok()?;
        let token = guard.as_ref()?;
        (Instant::now() < token.renew_after).then(|| token.value.clone())
    }

    /// The account and device this computer last authenticated as, if that
    /// answer is still fresh. `None` means "ask the backend", never "unlinked".
    fn cached_identity(&self) -> Option<(String, String)> {
        let guard = self.cached.lock().ok()?;
        let token = guard.as_ref()?;
        (Instant::now() < token.renew_after)
            .then(|| (token.user_id.clone(), token.device_id.clone()))
    }

    fn cache(&self, session: &DeviceSession) {
        // A TTL at or below the margin would make `renew_after` land in the
        // past and every call re-authenticate. Keep a floor so a
        // short-TTL server still gets some caching rather than none.
        let ttl = Duration::from_secs(session.expires_in_seconds);
        let renew_after = Instant::now() + ttl.saturating_sub(RENEW_MARGIN).max(ttl / 2);
        if let Ok(mut guard) = self.cached.lock() {
            *guard = Some(CachedToken {
                value: session.access_token.clone(),
                renew_after,
                user_id: session.user_id.clone(),
                device_id: session.device_id.clone(),
            });
        }
    }

    /// Drop the cached token, forcing the next call to re-authenticate. Used
    /// when the backend answers 401 — the token may have been revoked or the
    /// signing key rotated under us.
    pub fn invalidate(&self) {
        if let Ok(mut guard) = self.cached.lock() {
            *guard = None;
        }
    }
}

/// The app-wide handle every backend call reaches for, managed by Tauri.
///
/// The identity is loaded on FIRST USE, not at startup. Opening the OS
/// credential store can block on a user prompt, and doing that from Tauri's
/// `setup` hook would hold the whole launch — tray included — behind a dialog.
/// Nothing needs the key until a backend call happens anyway.
pub struct DesktopAuth {
    base_url: String,
    /// `None` inside means the keychain could not produce a durable keypair, so
    /// this machine has no stable identity to prove. Calls then go out
    /// unauthenticated, which the backend accepts only for a computer no
    /// account owns — the honest outcome, and better than enrolling under an
    /// ephemeral key that the next launch would lose, orphaning the device row.
    inner: OnceLock<Option<DeviceAuth>>,
}

impl DesktopAuth {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            inner: OnceLock::new(),
        }
    }

    fn device_auth(&self) -> Option<&DeviceAuth> {
        self.inner
            .get_or_init(|| match DeviceIdentity::load_or_create() {
                Ok(identity) => Some(DeviceAuth::new(identity, self.base_url.clone())),
                Err(e) => {
                    log::warn!(
                        target: "lilypad::auth",
                        "no durable device identity ({e}) — backend calls will be unauthenticated",
                    );
                    None
                }
            })
            .as_ref()
    }

    /// Whether an account has linked this computer, for the dashboard to
    /// render honestly ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
    ///
    /// Signing in is NOT what makes this `Linked` — a phone approving this
    /// machine is. The desktop must never imply it is available before that has
    /// happened, which is the whole reason this is a state and not a boolean.
    ///
    /// A network failure answers `Unknown`, deliberately distinct from
    /// `Unlinked`: telling a linked user their computer is not linked because
    /// the wifi dropped would invite them to redo a ceremony they already
    /// completed.
    pub async fn link_state(&self) -> LinkState {
        let Some(auth) = self.device_auth() else {
            return LinkState::NoIdentity;
        };
        if let Some((user_id, device_id)) = auth.cached_identity() {
            return LinkState::Linked { user_id, device_id };
        }
        match auth.sign_in().await {
            Ok(session) => LinkState::Linked {
                user_id: session.user_id,
                device_id: session.device_id,
            },
            Err(e) => match e.downcast_ref::<AuthError>() {
                Some(AuthError::NotEnrolled) => LinkState::Unlinked,
                Some(AuthError::Revoked) => LinkState::Revoked,
                None => LinkState::Unknown(e.to_string()),
            },
        }
    }

    /// Mint an enrollment code for this computer to show as a QR.
    pub async fn request_enrollment_code(
        &self,
        fingerprint: &str,
        name: &str,
        platform: &str,
    ) -> Result<EnrollmentCode> {
        let auth = self
            .device_auth()
            .ok_or_else(|| anyhow::anyhow!("this computer has no durable identity to link"))?;
        auth.request_enrollment_code(fingerprint, name, platform)
            .await
    }

    /// A bearer token for a backend call, or `None` when this computer is not
    /// linked to an account yet.
    ///
    /// Best-effort ON PURPOSE. Pairing a computer no account owns must keep
    /// working exactly as it always has, so a missing token is a normal state
    /// and not an error to surface. The backend applies the mirror-image rule:
    /// it demands a token only for a device an account owns, so the two halves
    /// meet without a flag day — the moment a phone links this machine, these
    /// calls start carrying a token and the backend starts requiring one.
    pub async fn bearer(&self) -> Option<String> {
        let auth = self.device_auth()?;
        match auth.access_token().await {
            Ok(token) => Some(token),
            Err(e) => {
                log::debug!(target: "lilypad::auth", "no device token available: {e}");
                None
            }
        }
    }
}

/// Where this computer stands with respect to an account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    /// No account owns this machine. Signing in does not change this — only a
    /// phone approving it does.
    Unlinked,
    Linked {
        user_id: String,
        device_id: String,
    },
    /// Ownership was withdrawn. Re-linking is the deliberate way back.
    Revoked,
    /// The keychain could not produce a durable identity, so this computer
    /// cannot be linked at all until that is fixed.
    NoIdentity,
    /// The backend could not be reached. NOT `Unlinked` — see `link_state`.
    Unknown(String),
}

/// Attach a bearer token to a request when there is one to attach.
pub fn with_bearer(req: reqwest::RequestBuilder, token: Option<String>) -> reqwest::RequestBuilder {
    match token {
        Some(t) => req.bearer_auth(t),
        None => req,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(expires_in_seconds: u64) -> DeviceSession {
        DeviceSession {
            access_token: "a-token".to_owned(),
            expires_in_seconds,
            device_id: "device-uuid".to_owned(),
            user_id: "user-uuid".to_owned(),
        }
    }

    fn auth() -> DeviceAuth {
        DeviceAuth::new(
            DeviceIdentity::generate_ephemeral().unwrap(),
            "http://localhost:8080".to_owned(),
        )
    }

    #[test]
    fn a_fresh_token_is_reused() {
        let auth = auth();
        auth.cache(&session(600));
        assert_eq!(auth.cached_token().as_deref(), Some("a-token"));
    }

    #[test]
    fn no_token_cached_means_no_token_returned() {
        assert!(auth().cached_token().is_none());
    }

    #[test]
    fn invalidate_forces_a_re_authentication() {
        let auth = auth();
        auth.cache(&session(600));
        auth.invalidate();
        assert!(auth.cached_token().is_none());
    }

    /// A TTL shorter than the renewal margin must still cache SOMETHING —
    /// otherwise `renew_after` lands in the past and every single call performs
    /// a full challenge round-trip.
    #[test]
    fn a_very_short_ttl_still_caches() {
        let auth = auth();
        auth.cache(&session(10));
        assert_eq!(auth.cached_token().as_deref(), Some("a-token"));
    }

    #[test]
    fn a_token_past_its_renewal_point_is_not_reused() {
        let auth = auth();
        auth.cache(&session(0));
        assert!(auth.cached_token().is_none());
    }

    /// A computer with no durable identity must degrade to "unauthenticated",
    /// never to a panic or a blocking error — that is exactly the state a
    /// freshly-installed, unlinked machine is in. Seeded directly so the test
    /// never touches this machine's real keychain.
    #[tokio::test]
    async fn no_identity_means_no_token_and_no_failure() {
        let auth = DesktopAuth::new("http://localhost:8080".to_owned());
        auth.inner.set(None).ok();
        assert!(auth.bearer().await.is_none());
    }

    /// The keychain must not be opened until something actually needs a token —
    /// doing it from Tauri's `setup` hook would hold the launch behind a prompt.
    #[test]
    fn constructing_it_touches_no_credential_store() {
        let auth = DesktopAuth::new("http://localhost:8080".to_owned());
        assert!(auth.inner.get().is_none());
    }

    #[test]
    fn with_bearer_is_a_no_op_without_a_token() {
        let client = reqwest::Client::new();
        let req = with_bearer(client.get("http://localhost:8080/devices/pairs"), None)
            .build()
            .unwrap();
        assert!(req.headers().get(reqwest::header::AUTHORIZATION).is_none());
    }

    #[test]
    fn with_bearer_sets_the_authorization_header() {
        let client = reqwest::Client::new();
        let req = with_bearer(
            client.get("http://localhost:8080/devices/pairs"),
            Some("a-token".to_owned()),
        )
        .build()
        .unwrap();
        assert_eq!(
            req.headers().get(reqwest::header::AUTHORIZATION).unwrap(),
            "Bearer a-token"
        );
    }

    #[test]
    fn urls_join_cleanly_whatever_the_base_looks_like() {
        for base in ["http://localhost:8080", "http://localhost:8080/"] {
            let auth = DeviceAuth::new(
                DeviceIdentity::generate_ephemeral().unwrap(),
                base.to_owned(),
            );
            assert_eq!(
                auth.url("/devices/token"),
                "http://localhost:8080/devices/token"
            );
        }
    }
}
