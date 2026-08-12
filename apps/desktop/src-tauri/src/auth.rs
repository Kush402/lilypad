use std::sync::Mutex;
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
