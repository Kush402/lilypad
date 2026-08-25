//! This laptop's ACCOUNT session — who is signed in
//! ([ADR-0012](../../../../docs/adr/0012-password-authentication.md)).
//!
//! Deliberately separate from `auth.rs`, which holds the DEVICE session. The
//! two answer different questions and neither implies the other:
//!
//! - **Account** — who the human is. Established here, by email + password.
//! - **Device** — whether an account owns this machine. Established only by a
//!   phone approving an enrollment code
//!   ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
//!
//! Signing in on this Mac therefore does NOT link this Mac, and the backend
//! enforces that rather than trusting this client to: `/devices/enroll` refuses
//! `kind: "desktop"` outright. That refusal is what makes it safe for a desktop
//! to hold an account token at all.
//!
//! **No credential is stored here — only a label.** This module keeps the
//! signed-in email and user id so the dashboard can say who is signed in
//! without a network round trip, and nothing else.
//!
//! It used to store the account's refresh token, on the reasoning that access
//! tokens expire and a rotating single-use refresh token is detectable if
//! stolen. Both halves of that were true and the conclusion was still wrong,
//! for a reason the comment itself hid: **nothing here ever presented it.**
//! There is no call to `/auth/refresh` in this crate, because the desktop acts
//! as the DEVICE for every request it makes and never as the account. So the
//! token's single-use property could never fire — it sat in the login keychain
//! as a plain thirty-day bearer credential, doing nothing, on the one machine
//! whose theft is the whole reason "revoke this device" exists.
//!
//! It was worth more to an attacker than to us: an account session is enough
//! to call `/devices/enroll`, and enrolment clears `revoked_at`, so whoever
//! held it could undo the revocation of the very laptop they had stolen.
//! Storing nothing is the fix; the backend closed the other half by revoking
//! the account's refresh tokens whenever a device is revoked.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "com.takedia.lilypad.desktop.account";
// Kept at its original name on purpose. Renaming it would leave the old entry
// — the one that still holds a real refresh token — sitting in the keychain
// untouched forever. Reusing the name means the next sign-in overwrites that
// secret with a blob that has none.
const KEYCHAIN_ACCOUNT: &str = "refresh-token";

const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// What the backend returns from every sign-in.
///
/// `refreshToken` and `expiresInSeconds` are deliberately dropped on the floor:
/// nothing here renews an account session, so each would be a credential with
/// no caller, and a credential with no caller is only ever a liability.
///
/// `accessToken` is captured, and has exactly one caller: enrolling this Mac on
/// the account that just signed in
/// ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)). It
/// lives in a local variable for the length of that one request. **It is never
/// stored** — `StoredAccount` below is what reaches the keychain, and it holds
/// two labels and no secret.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthSession {
    user_id: String,
    access_token: String,
}

/// The access token, captured transiently by `Account::delete` and by nothing
/// else. Separate from `AuthSession` on purpose: that type drops the token
/// deliberately, and widening it would hand every sign-in path a credential
/// none of them has a use for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccessToken {
    access_token: String,
}

/// A completed sign-in, before the account token is spent.
///
/// Not `Serialize`, and never returned to the webview: the token in it is the
/// one thing on this machine that can act AS the account, and it exists only
/// long enough for `commands::account_sign_in` to enrol this Mac with it.
pub struct SignedIn {
    pub state: AccountState,
    pub access_token: String,
}

/// What the UI needs to render the account section.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    pub signed_in: bool,
    pub email: Option<String>,
    pub user_id: Option<String>,
}

/// The stored half: two labels, no secret. Nothing authorises on either of
/// them, and the app is no more capable for having them than a sticky note is.
///
/// Older installs have a `refreshToken` field here from before this changed.
/// Serde ignores unknown fields, so those entries still read correctly, and the
/// stale token stops mattering the first time anything revokes a device — which
/// now revokes the account's refresh tokens with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAccount {
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
            email: email.to_owned(),
            user_id: session.user_id.clone(),
        };
        let json = serde_json::to_vec(&stored).context("could not prepare the account session")?;
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
        Self::state_of(Self::stored())
    }

    /// The mapping, split out from the keychain read so a test can exercise it
    /// without one.
    ///
    /// Not a gratuitous seam. `state()` opens the login keychain, and opening
    /// it can block on an OS prompt that a headless `cargo test` cannot answer
    /// — which is exactly what happened on 2026-08-25: the whole suite sat on
    /// `state_is_signed_out_when_nothing_is_stored` past sixty seconds with no
    /// dialog anyone could see. A rebuilt binary has a new code signature, so
    /// the prompt can return on any build. The keychain read has no assertion
    /// worth making anyway; the mapping does.
    fn state_of(stored: Option<StoredAccount>) -> AccountState {
        match stored {
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
            Err(e) => {
                // Every string an account command returns is rendered verbatim
                // by the sign-in form (`setError(String(err))`), so the
                // keychain's own words would go on screen — a customer signing
                // out would read "Platform secure storage failure: Keychain
                // error: -25300". The reason belongs in the log, where whoever
                // has to diagnose it will actually look.
                log::warn!(target: "lilypad::account", "keychain delete failed: {e}");
                bail!("macOS would not let Lilypad clear the saved sign-in. Try again in a moment.")
            }
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

    /// Whether this backend can send mail.
    ///
    /// Password reset is the only account flow on this Mac that needs one, and
    /// production has never had a sender — so "Forgot password" led to a 503
    /// every time it was pressed. `GET /auth/methods` reports it, and the
    /// dashboard hides the link when the answer is a definite no.
    ///
    /// **Fails open.** Any error at all answers `true`, because hiding a
    /// working recovery path because a request timed out is a worse outcome
    /// than the dead end this removes.
    pub async fn email_available(&self) -> bool {
        let Ok(response) = self.http.get(self.url("/auth/methods")).send().await else {
            return true;
        };
        let Ok(body) = response.json::<serde_json::Value>().await else {
            return true;
        };
        body.get("email")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true)
    }

    /// Create an account, then remember it.
    pub async fn sign_up(&self, name: &str, email: &str, password: &str) -> Result<SignedIn> {
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
    pub async fn sign_in(&self, email: &str, password: &str) -> Result<SignedIn> {
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
            401 => bail!("That email and password do not match an account. Check the password, or create an account."),
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
    ) -> Result<SignedIn> {
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

    /// Delete the account this Mac is signed in to, permanently.
    ///
    /// Two things are asked for, and neither is optional.
    ///
    /// The **password** is asked for because this machine holds no account
    /// credential at all — see `AuthSession`, which drops the tokens on the
    /// floor. That is normally a limitation; for the one irreversible call in
    /// the product it is exactly right. A stolen laptop cannot delete its
    /// owner's account, because the laptop was never able to act as the
    /// account in the first place. The token minted here lives in a local
    /// variable for the length of one request and is never stored.
    ///
    /// The **typed address** is passed through to the server verbatim rather
    /// than filled in from the keychain. Filling it in would satisfy the
    /// server's confirmation check without a human ever confirming anything,
    /// which is the one thing that check exists to prevent.
    ///
    /// Requiring a password locks out an account that has never had one —
    /// Apple, Google and magic-link sign-ins all produce those. That is not a
    /// dead end here, because such an account can never be signed in on this
    /// Mac in the first place: `AccountSignIn` offers email + password and
    /// nothing else (ADR-0012). Deleting a passwordless account is done from
    /// the phone, which authenticates with its device key instead.
    pub async fn delete(&self, confirm_email: &str, password: &str) -> Result<()> {
        let stored = Self::stored().context("No account is signed in on this computer.")?;

        let (status, text) = self
            .post(
                "/auth/password",
                serde_json::json!({ "email": stored.email, "password": password }),
            )
            .await?;
        if status != 200 {
            bail!("That password does not match this account.");
        }
        let session: AccessToken =
            serde_json::from_str(&text).context("the server’s sign-in response was not valid")?;

        let response = self
            .http
            .delete(self.url("/account"))
            .bearer_auth(&session.access_token)
            .json(&serde_json::json!({ "confirmEmail": confirm_email }))
            .send()
            .await
            .context("could not reach Lilypad’s server")?;

        match response.status().as_u16() {
            200 => {}
            400 => bail!("Type the email address on this account to confirm."),
            401 | 404 => bail!("That account could not be deleted — sign in again."),
            _ => bail!("That account could not be deleted."),
        }

        // The account is gone; the local record of it must go too, or the
        // dashboard keeps claiming a signed-in account that no longer exists.
        Self::sign_out()
    }

    fn remember(&self, body: &str, email: &str) -> Result<SignedIn> {
        let session: AuthSession =
            serde_json::from_str(body).context("the server’s sign-in response was not valid")?;
        let email = email.trim().to_lowercase();
        Self::store(&session, &email)?;
        Ok(SignedIn {
            state: AccountState {
                signed_in: true,
                email: Some(email),
                user_id: Some(session.user_id),
            },
            access_token: session.access_token,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stored_session_carries_no_credential() {
        // The regression this guards: a thirty-day account refresh token used
        // to live in this blob, and nothing ever presented it. An account
        // session is enough to call `/devices/enroll`, and enrolment clears
        // `revoked_at` — so whoever pulled it out of a stolen laptop's keychain
        // could undo the revocation of that same laptop.
        let stored = StoredAccount {
            email: "someone@example.com".to_owned(),
            user_id: "user-1".to_owned(),
        };
        let json = serde_json::to_string(&stored).expect("serialises");
        assert!(
            !json.contains("refresh") && !json.contains("token"),
            "the stored account session must hold no credential, got {json}"
        );
    }

    #[test]
    fn an_older_entry_that_still_has_a_token_reads_back_as_a_label() {
        // Installs from before the field was removed still have it. Their entry
        // must keep rendering "signed in as" rather than failing to parse and
        // silently signing the user out.
        let legacy = r#"{"refresh_token":"leftover","email":"a@b.co","user_id":"user-1"}"#;
        let parsed: StoredAccount = serde_json::from_str(legacy).expect("legacy entry still reads");
        assert_eq!(parsed.email, "a@b.co");
        assert_eq!(parsed.user_id, "user-1");
    }

    #[test]
    fn a_sign_in_response_is_read_without_capturing_its_tokens() {
        let body =
            r#"{"accessToken":"a","refreshToken":"r","expiresInSeconds":600,"userId":"user-1"}"#;
        let session: AuthSession = serde_json::from_str(body).expect("parses");
        assert_eq!(session.user_id, "user-1");
    }

    #[test]
    fn the_delete_path_reads_the_access_token_and_nothing_else() {
        // `Account::delete` needs a token for exactly one request, so it reads
        // the sign-in response a second way. This asserts it reads the real
        // shape — and, by having only the one field, that the refresh token in
        // the same body still goes nowhere.
        let body =
            r#"{"accessToken":"a","refreshToken":"r","expiresInSeconds":600,"userId":"user-1"}"#;
        let token: AccessToken = serde_json::from_str(body).expect("parses");
        assert_eq!(token.access_token, "a");
    }

    #[test]
    fn state_is_signed_out_when_nothing_is_stored() {
        let state = Account::state_of(None);
        assert!(!state.signed_in);
        assert!(state.email.is_none());
        assert!(state.user_id.is_none());
    }

    /// The invariant the dashboard depends on: signed in is never signed in
    /// as nobody. A card that says "Signed in as" with nothing after it is
    /// worse than one that says signed out.
    #[test]
    fn a_stored_session_always_knows_who_it_is() {
        let state = Account::state_of(Some(StoredAccount {
            email: "ada@example.com".to_owned(),
            user_id: "user-1".to_owned(),
        }));
        assert!(state.signed_in);
        assert_eq!(state.email.as_deref(), Some("ada@example.com"));
        assert_eq!(state.user_id.as_deref(), Some("user-1"));
    }

    #[test]
    fn urls_join_without_doubling_the_slash() {
        let account = Account::new("https://example.com/".to_owned());
        assert_eq!(
            account.url("/auth/password"),
            "https://example.com/auth/password"
        );
    }
}
