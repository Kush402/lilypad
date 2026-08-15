use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// This laptop's ACCOUNT session — who is signed in
/// ([ADR-0012](../../../../docs/adr/0012-password-authentication.md)).
///
/// Deliberately separate from `auth.rs`, which holds the DEVICE session. The
/// two answer different questions and neither implies the other:
///
/// - **Account** — who the human is. Established here, by email + password.
/// - **Device** — whether an account owns this machine. Established only by a
///   phone approving an enrollment code
///   ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
///
/// Signing in on this Mac therefore does NOT link this Mac, and the backend
/// enforces that rather than trusting this client to: `/devices/enroll` refuses
/// `kind: "desktop"` outright. That refusal is what makes it safe for a desktop
/// to hold an account token at all.
///
/// **What is stored is the refresh token, and nothing else.** Access tokens
/// live ten minutes and are re-minted from it; storing one would be storing a
/// copy of something that expires anyway. The refresh token is rotating and
/// single-use, so a stolen copy is detectable — presenting a retired one
/// revokes the whole family, which is the property that makes it storable in
/// the first place.

const KEYCHAIN_SERVICE: &str = "com.takedia.lilypad.desktop.account";
const KEYCHAIN_ACCOUNT: &str = "refresh-token";

const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// What the backend returns from every sign-in and refresh.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthSession {
    refresh_token: String,
    user_id: String,
    // `accessToken` and `expiresInSeconds` are deliberately not captured.
    // Nothing on the desktop acts as the ACCOUNT — every call it makes is
    // authorised by the device key — so a ten-minute account token would be a
    // credential with no user.
}

/// What the UI needs to render the account section.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    pub signed_in: bool,
    pub email: Option<String>,
    pub user_id: Option<String>,
}

/// The stored half. The email is kept alongside the token purely so the UI can
/// say who is signed in without a network round trip — it is a label, and
/// nothing authorises on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAccount {
    refresh_token: String,
    email: String,
    user_id: String,
}

pub struct Account {
    base_url: String,
    http: reqwest::Client,
}

impl Account {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            http: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .unwrap_or_default(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    fn entry() -> Result<keyring::Entry> {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .context("could not open the OS credential store")
    }

    fn store(session: &AuthSession, email: &str) -> Result<()> {
        let stored = StoredAccount {
            refresh_token: session.refresh_token.clone(),
            email: email.to_owned(),
            user_id: session.user_id.clone(),
        };
        let json = serde_json::to_vec(&stored)?;
        Self::entry()?
            .set_secret(&json)
            .context("could not store the account session")
    }

    fn stored() -> Option<StoredAccount> {
        let entry = Self::entry().ok()?;
        let secret = entry.get_secret().ok()?;
        serde_json::from_slice(&secret).ok()
    }

    /// Who is signed in on this machine, from local storage only.
    ///
    /// No network call on purpose: this renders the dashboard's account section
    /// on every open, and a laptop that is offline is not a laptop whose user
    /// signed out.
    pub fn state() -> AccountState {
        match Self::stored() {
            Some(stored) => AccountState {
                signed_in: true,
                email: Some(stored.email),
                user_id: Some(stored.user_id),
            },
            None => AccountState::default(),
        }
    }

    /// Forget the account session on this machine.
    ///
    /// Does NOT unlink the computer or revoke its device key: those are
    /// account-level acts performed from a phone, and conflating them would
    /// mean signing out of the app silently destroyed every pairing.
    pub fn sign_out() -> Result<()> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => bail!("could not clear the stored account session: {e}"),
        }
    }

    async fn post(&self, path: &str, body: serde_json::Value) -> Result<(u16, String)> {
        let response = self
            .http
            .post(self.url(path))
            .json(&body)
            .send()
            .await
            .context("could not reach Lilypad’s server")?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        Ok((status, text))
    }

    /// Create an account, then remember it.
    pub async fn sign_up(&self, name: &str, email: &str, password: &str) -> Result<AccountState> {
        let (status, text) = self
            .post(
                "/auth/signup",
                serde_json::json!({ "name": name, "email": email, "password": password }),
            )
            .await?;
        match status {
            201 => self.remember(&text, email),
            409 => bail!("An account already exists for that email. Sign in instead."),
            400 => bail!("Use at least 12 characters, and a valid email address."),
            _ => bail!("That account could not be created."),
        }
    }

    /// Sign in, then remember it.
    pub async fn sign_in(&self, email: &str, password: &str) -> Result<AccountState> {
        let (status, text) = self
            .post(
                "/auth/password",
                serde_json::json!({ "email": email, "password": password }),
            )
            .await?;
        match status {
            200 => self.remember(&text, email),
            // One message for every rejection, matching the backend: it answers
            // `invalid_credentials` for an unknown address, a wrong password,
            // and an account with no password alike, and a client that guessed
            // between them would rebuild the oracle the backend refuses to be.
            401 => bail!("That email and password do not match an account."),
            _ => bail!("Sign-in could not be completed."),
        }
    }

    /// Ask for a password-reset email. Resolves the same way whether or not the
    /// address has an account.
    pub async fn request_password_reset(&self, email: &str) -> Result<()> {
        let (status, _) = self
            .post(
                "/auth/password/reset/request",
                serde_json::json!({ "email": email }),
            )
            .await?;
        match status {
            202 => Ok(()),
            503 => bail!("Password reset is not available on this server."),
            _ => bail!("That address could not be used."),
        }
    }

    /// Spend a reset code on a new password, and sign in.
    pub async fn confirm_password_reset(
        &self,
        email: &str,
        code: &str,
        password: &str,
    ) -> Result<AccountState> {
        let (status, text) = self
            .post(
                "/auth/password/reset/confirm",
                serde_json::json!({ "token": code, "password": password }),
            )
            .await?;
        match status {
            200 => self.remember(&text, email),
            400 => bail!("Use at least 12 characters for the new password."),
            _ => bail!("That reset code has expired or was already used."),
        }
    }

    fn remember(&self, body: &str, email: &str) -> Result<AccountState> {
        let session: AuthSession =
            serde_json::from_str(body).context("the server’s sign-in response was not valid")?;
        let email = email.trim().to_lowercase();
        Self::store(&session, &email)?;
        Ok(AccountState {
            signed_in: true,
            email: Some(email),
            user_id: Some(session.user_id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_is_signed_out_when_nothing_is_stored() {
        // Reads the real keychain, so it asserts only the shape that holds
        // either way: a machine with no entry must report signed out, and a
        // developer machine with one must never report a session with no email.
        let state = Account::state();
        if state.signed_in {
            assert!(state.email.is_some(), "a stored session must know its email");
            assert!(state.user_id.is_some());
        } else {
            assert!(state.email.is_none());
        }
    }

    #[test]
    fn urls_join_without_doubling_the_slash() {
        let account = Account::new("https://example.com/".to_owned());
        assert_eq!(account.url("/auth/password"), "https://example.com/auth/password");
    }
}
