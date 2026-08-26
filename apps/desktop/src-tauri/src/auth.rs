use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

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
    /// Serialises the challenge+token exchange so concurrent callers share one.
    ///
    /// Two independent callers race at every launch — the tray's one-shot
    /// `link_state` (`lib.rs`) and the presence loop's `bearer` — and both used
    /// to miss the empty cache and run a full exchange, burning two challenges
    /// and racing to overwrite the cache with whichever finished last (observed
    /// live 2026-08-15 as a steady 2:1 `/devices/challenge` to `/devices/token`
    /// ratio). Whoever loses this lock re-reads the cache the winner just
    /// filled. `apps/mobile/src/lib/auth.ts` solves the same race with an
    /// `inFlight` promise; this is the same fix in the idiom Rust has.
    ///
    /// Async, not `std::sync` — it is held across an `.await`.
    ///
    /// Serialising makes the client's timeout load-bearing: one request that
    /// never completes would now hold every other caller, where before each
    /// hung alone. `http` is built with one for that reason.
    signing_in: tokio::sync::Mutex<()>,
    /// Told the wire id the backend actually knows this computer by, every time
    /// one comes back. See `IdentitySink`.
    sink: Option<IdentitySink>,
}

/// Bound on any single backend call. Matches `account.rs`, and exists here for
/// a sharper reason: the exchange runs under `signing_in`, so an unbounded
/// request would be an unbounded wait for the dashboard's `link_state` poll and
/// the presence loop's `bearer` alike.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

struct CachedToken {
    value: String,
    /// When to stop using it. Deliberately EARLIER than the server's expiry —
    /// see `RENEW_MARGIN`.
    ///
    /// **Wall clock, not `Instant`, and that is the whole point.** `Instant` on
    /// macOS does not advance while the machine is asleep, but the server's
    /// `exp` is wall-clock — so a Mac that slept for forty minutes woke up
    /// believing a ten-minute token was still fresh and presented an expired
    /// one to every call. Observed in production on 2026-08-25: the presence
    /// channel was refused `unauthorized_room` fifteen times over
    /// twenty-four minutes after a wake, with no `/devices/token` request in
    /// between, which is exactly what "the client thinks it is fresh" looks
    /// like from the server's side. The phone showed that Mac as offline the
    /// whole time.
    renew_after: SystemTime,
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
    /// The WIRE id the backend actually knows this computer by, which is not
    /// always the one it just claimed.
    ///
    /// `AppState.device_id` is a uuid in a file under the app's data directory;
    /// the key that proves this machine's identity is in the login keychain.
    /// Clearing one and not the other renames the computer without changing who
    /// it is — and every route that authorizes a device (`/pairing/create`,
    /// `/connect/request`, the presence room) resolves by fingerprint, so the
    /// machine goes quietly unable to do anything.
    ///
    /// The server resolves by key and reports the row's own name here.
    /// `IdentitySink` is what makes that self-healing. `None` from a server too
    /// old to say, which is not evidence of anything.
    pub fingerprint: Option<String>,
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
            Self::NotEnrolled => write!(f, "this device is not enrolled. Sign in to enroll it"),
            Self::Revoked => write!(f, "this device was revoked. Sign in to enroll it again"),
        }
    }
}

impl std::error::Error for AuthError {}

impl DeviceAuth {
    pub fn new(identity: DeviceIdentity, base_url: String) -> Self {
        Self::with_sink(identity, base_url, None)
    }

    pub fn with_sink(
        identity: DeviceIdentity,
        base_url: String,
        sink: Option<IdentitySink>,
    ) -> Self {
        Self {
            identity,
            base_url,
            http: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .unwrap_or_default(),
            cached: Mutex::new(None),
            signing_in: tokio::sync::Mutex::new(()),
            sink,
        }
    }

    /// Hand the wire id the backend actually knows this computer by to whoever
    /// owns the local copy.
    ///
    /// Called from BOTH token exchanges, not only from enrollment. The token
    /// exchange is the one that matters: it authenticates by key alone, so a
    /// machine whose local id has drifted still gets a valid answer, and this is
    /// what turns that answer into a repair. Enrollment would otherwise be the
    /// only cure, and enrollment is exactly the call a customer has no reason to
    /// make again.
    fn adopt(&self, session: &DeviceSession) {
        if let (Some(sink), Some(canonical)) = (self.sink.as_ref(), session.fingerprint.as_deref())
        {
            sink(canonical);
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
    /// Returns `(challenge, public key, signature, proof origin)`.
    ///
    /// The origin is the host this app is configured to talk to, signed along
    /// with the challenge so the proof cannot be replayed at another server
    /// (L-30). `None` when the base URL has no parseable host — the v1 message
    /// is signed instead, which a server still accepts, rather than leaving
    /// the app unable to authenticate at all.
    async fn signed_proof(&self) -> Result<(String, String, String, Option<String>)> {
        let response = self
            .http
            .post(self.url("/devices/challenge"))
            .send()
            .await
            .context("could not reach the backend for a device challenge")?;
        if !response.status().is_success() {
            // Same reasoning as `enrollment_code_failure`: this surfaces
            // through `start_enrollment` onto the dashboard, so it is written
            // for the person reading it. The status goes to the log.
            log::warn!(
                target: "lilypad::auth",
                "device challenge refused (HTTP {})",
                response.status(),
            );
            bail!("Lilypad’s server isn’t responding properly. Try again in a moment.");
        }
        let ChallengeResponse { challenge } = response
            .json()
            .await
            .context("the backend's device challenge was not valid JSON")?;
        let origin = crate::identity::proof_origin_of(&self.base_url);
        let signature = self.identity.sign_challenge(&challenge, origin.as_deref());
        Ok((
            challenge,
            self.identity.public_key_base64url(),
            signature,
            origin,
        ))
    }

    /// Put this Mac on the account that just signed in
    /// ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)).
    ///
    /// Called once, straight after a successful sign-in, with an account access
    /// token that lives in a local variable and is never stored. Signing in is
    /// what makes a machine yours — on a phone it always was, and a Mac that
    /// behaved differently is why a customer who had signed in on both saw one
    /// device in "Your devices".
    ///
    /// **`fingerprint` MUST be `AppState.device_id`.** The backend resolves
    /// ownership by `(kind, fingerprint)`, so enrolling under any other value
    /// creates a second device row: the machine would be owned, and every
    /// authorization check would still see the unowned one.
    ///
    /// Failure IS fatal to the sign-in, and the caller rolls the local session
    /// back so the screen and the keychain agree. Under
    /// [ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md) this
    /// call is not a bonus step after signing in — it is the half of signing in
    /// that puts the Mac on the account, and a sign-in that skipped it leaves a
    /// customer looking at their own email address above a computer that
    /// belongs to nobody. The enrollment-code QR is still there as a recovery
    /// route, which is a different thing from a silent fallback.
    pub async fn enroll(
        &self,
        account_token: &str,
        fingerprint: &str,
        name: &str,
        platform: &str,
    ) -> Result<DeviceSession> {
        let (challenge, public_key, signature, proof_origin) = self.signed_proof().await?;
        let response = self
            .http
            .post(self.url("/devices/enroll"))
            .bearer_auth(account_token)
            .json(&serde_json::json!({
                "challenge": challenge,
                "publicKey": public_key,
                "signature": signature,
                "proofOrigin": proof_origin,
                "kind": "desktop",
                "fingerprint": fingerprint,
                "name": name,
                "platform": platform,
                "appVersion": env!("CARGO_PKG_VERSION"),
            }))
            .send()
            .await
            .context("Couldn’t reach Lilypad. Check your internet connection and try again.")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            log::warn!(
                target: "lilypad::auth",
                "enrollment refused (HTTP {status}): {body}",
            );
            // Typed, not stringified, because this is the one refusal the
            // caller can do something about rather than only report. See
            // `commands::sign_in_and_enrol`.
            if status == reqwest::StatusCode::FORBIDDEN && body.contains("device_revoked") {
                return Err(AuthError::Revoked.into());
            }
            bail!("{}", enroll_failure(status.as_u16(), &body));
        }
        let session: DeviceSession = response
            .json()
            .await
            .context("Lilypad’s server sent something this app didn’t understand.")?;
        // Seed the cache from the response instead of making the next caller
        // re-authenticate. It is the same token `/devices/token` would mint,
        // and skipping it removes the one window where a Mac is owned and the
        // dashboard still says it is not.
        self.cache(&session);
        self.adopt(&session);
        Ok(session)
    }

    /// Take this computer back OFF the account it is on.
    ///
    /// The inverse of `enroll`, and the reason sign-out is not a local act.
    /// Under [ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)
    /// signing in is what puts this Mac on the account, so signing out has to
    /// be what takes it off — otherwise "sign out" means "hide the email
    /// address", which is what it meant until now: the device key stayed valid,
    /// the presence seat stayed occupied, every pair stayed connectable, and a
    /// session already running kept running.
    ///
    /// `DELETE /devices/{id}` presented with this device's OWN token does all
    /// three things at once, server-side: it revokes the row, it ends every
    /// live room the device holds (its session AND its presence seat), and it
    /// revokes the account's refresh tokens.
    ///
    /// **Reversible on purpose.** `trusted_devices` rows and their per-pair
    /// secrets survive, and signing in again re-enrols this same keypair —
    /// `DeviceRegistry::claim` clears `revoked_at` — so the phones that were
    /// paired reconnect without another QR. Sign-out is a door, not a demolition.
    pub async fn release(&self) -> Result<()> {
        let token = match self.access_token().await {
            Ok(token) => token,
            // Already off the account. Both of these ARE the outcome this
            // function exists to produce, so neither is a failure to report.
            Err(e)
                if matches!(
                    e.downcast_ref::<AuthError>(),
                    Some(AuthError::NotEnrolled) | Some(AuthError::Revoked)
                ) =>
            {
                return Ok(())
            }
            Err(e) => return Err(e),
        };
        // Populated by the `access_token` above, which caches whatever it
        // minted. The uuid is `devices.id`, not the wire fingerprint — the
        // route is keyed on the row.
        let Some((_, device_id)) = self.cached_identity() else {
            bail!("Lilypad couldn’t confirm which computer this is. Try again in a moment.");
        };
        let response = self
            .http
            .delete(self.url(&format!("/devices/{device_id}")))
            .bearer_auth(&token)
            .send()
            .await
            .context("Couldn’t reach Lilypad. Check your internet connection and try again.")?;

        let status = response.status();
        // 404 is the goal already holding: the account does not have this
        // device, which is exactly where sign-out is trying to leave it.
        if !status.is_success() && status != reqwest::StatusCode::NOT_FOUND {
            let body = response.text().await.unwrap_or_default();
            log::warn!(
                target: "lilypad::auth",
                "device release refused (HTTP {status}): {body}",
            );
            bail!(
                "Lilypad couldn’t remove this computer from your account. Try again in a moment."
            );
        }
        // The cached token outlives the revocation by up to its TTL and every
        // route would refuse it anyway; dropping it is what makes the presence
        // loop re-authenticate and discover the truth on its next attempt.
        self.invalidate();
        Ok(())
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
        let (challenge, public_key, signature, proof_origin) = self.signed_proof().await?;
        let response = self
            .http
            .post(self.url("/devices/enrollment-code"))
            .json(&serde_json::json!({
                "challenge": challenge,
                "publicKey": public_key,
                "signature": signature,
                "proofOrigin": proof_origin,
                "fingerprint": fingerprint,
                "name": name,
                "platform": platform,
            }))
            .send()
            .await
            // Reaches the dashboard verbatim: `start_enrollment` stringifies
            // this and `AccountPanel` renders it. Written for the person who is
            // offline, not for the person reading the stack.
            .context("Couldn’t reach Lilypad. Check your internet connection and try again.")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            // The raw status and body go to the log, not to the dashboard.
            // `start_enrollment` turns this error into a string with
            // `e.to_string()` and `AccountPanel` renders it verbatim, so
            // whatever is written here is what a person reads on the one
            // screen that makes their computer theirs. It used to be
            // `could not start enrollment (HTTP 429): {"statusCode":429,…}`.
            log::warn!(
                target: "lilypad::auth",
                "enrollment code refused (HTTP {status}): {body}",
            );
            bail!("{}", enrollment_code_failure(status.as_u16()));
        }
        response.json().await.context(
            "Lilypad’s server sent something this app didn’t understand. Please update the app.",
        )
    }

    /// A valid access token, re-authenticating if the cached one is missing or
    /// close to expiry.
    pub async fn access_token(&self) -> Result<String> {
        if let Some(token) = self.cached_token() {
            return Ok(token);
        }
        // Re-check after waiting: the caller that held `signing_in` may have
        // just cached exactly what we were about to ask for. See the field.
        let _exchange = self.signing_in.lock().await;
        if let Some(token) = self.cached_token() {
            return Ok(token);
        }
        let session = self.sign_in().await?;
        Ok(session.access_token)
    }

    /// Prove key possession and take a fresh device token. This is how the app
    /// authenticates after a restart, with no user interaction.
    pub async fn sign_in(&self) -> Result<DeviceSession> {
        let (challenge, public_key, signature, proof_origin) = self.signed_proof().await?;
        let response = self
            .http
            .post(self.url("/devices/token"))
            .json(&serde_json::json!({
                "challenge": challenge,
                "publicKey": public_key,
                "signature": signature,
                // Names the server this proof is for. Its presence is what
                // selects the origin-bound form; omitted, the server checks
                // the older message instead.
                "proofOrigin": proof_origin,
                // Bookkeeping, not part of the signed proof. This call happens
                // on every launch and every token renewal, which makes it the
                // one place `devices.app_version` can stay current without a
                // heartbeat of its own — and the only way to answer "which
                // build is this customer running?" at all.
                "appVersion": env!("CARGO_PKG_VERSION"),
                // Same ride, same reasoning: this Mac's real name, kept
                // current without a heartbeat. The server applies it only over
                // the placeholder every desktop used to enroll under, so a
                // name the owner typed in "Your devices" is never overwritten.
                "deviceName": crate::identity::device_name(),
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
            // Same rule as `request_enrollment_code` above, for the same
            // reason: this string can reach the dashboard, and a status code
            // with a JSON body pasted after it names the one thing a person
            // cannot act on and none of the things they can.
            log::warn!(
                target: "lilypad::auth",
                "device sign-in refused (HTTP {status}): {body}",
            );
            bail!("Lilypad couldn’t confirm this computer with the server. Try again in a moment.");
        }
        let session: DeviceSession = response
            .json()
            .await
            .context("the backend's device token response was not valid JSON")?;
        self.cache(&session);
        self.adopt(&session);
        Ok(session)
    }

    fn cached_token(&self) -> Option<String> {
        self.cached_token_at(SystemTime::now())
    }

    /// `now` is a parameter so a test can express the case that produced the
    /// bug: wall-clock time moving while this process was suspended.
    fn cached_token_at(&self, now: SystemTime) -> Option<String> {
        let guard = self.cached.lock().ok()?;
        let token = guard.as_ref()?;
        (now < token.renew_after).then(|| token.value.clone())
    }

    /// The account and device this computer last authenticated as, if that
    /// answer is still fresh. `None` means "ask the backend", never "unlinked".
    fn cached_identity(&self) -> Option<(String, String)> {
        let guard = self.cached.lock().ok()?;
        let token = guard.as_ref()?;
        (SystemTime::now() < token.renew_after)
            .then(|| (token.user_id.clone(), token.device_id.clone()))
    }

    fn cache(&self, session: &DeviceSession) {
        // A TTL at or below the margin would make `renew_after` land in the
        // past and every call re-authenticate. Keep a floor so a
        // short-TTL server still gets some caching rather than none.
        let ttl = Duration::from_secs(session.expires_in_seconds);
        let renew_after = SystemTime::now() + ttl.saturating_sub(RENEW_MARGIN).max(ttl / 2);
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

/// Where `DesktopAuth` reports the wire id the backend actually knows this
/// computer by.
///
/// A callback rather than a direct write because the two halves live in
/// different worlds: the answer arrives inside an HTTP response in this module,
/// which knows nothing about Tauri, while the local copy lives in `AppState`
/// and in a file under the app's data directory. `lib.rs` owns both and wires
/// them together at startup.
pub type IdentitySink = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

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
    ///
    /// Only ever populated on SUCCESS. See `device_auth`.
    inner: OnceLock<Option<DeviceAuth>>,
    /// How the key is obtained. A plain function pointer so tests can inject a
    /// keychain that fails once and then works — the behaviour below exists for
    /// exactly that case and is otherwise unobservable.
    load: fn() -> Result<DeviceIdentity>,
    /// Serialises retries. Two threads that both found no entry would each
    /// GENERATE and store a key, and the loser would be left holding one the
    /// keychain no longer has — a machine that silently changes identity. The
    /// old `get_or_init` gave this for free; retrying means providing it.
    retry: Mutex<()>,
    /// Told the wire id the backend actually knows this computer by, every time
    /// one comes back. See `IdentitySink`.
    sink: Option<IdentitySink>,
}

impl DesktopAuth {
    pub fn new(base_url: String) -> Self {
        Self::with_sink(base_url, None)
    }

    /// As `new`, plus somewhere to report the canonical wire id.
    ///
    /// Separate constructor rather than a setter: the sink has to be in place
    /// before the first backend call, and a setter invites the version where it
    /// is not.
    pub fn with_sink(base_url: String, sink: Option<IdentitySink>) -> Self {
        Self {
            base_url,
            inner: OnceLock::new(),
            load: DeviceIdentity::load_or_create,
            retry: Mutex::new(()),
            sink,
        }
    }

    /// Load the identity, retrying on a later call if this one fails.
    ///
    /// It used to be `get_or_init`, which stores whatever the first attempt
    /// produced — including a failure. One unlucky keychain read therefore
    /// disabled the app for the whole process: `link_state` answers
    /// `NoIdentity`, and the dashboard says "this computer has no secure
    /// identity, so it cannot be linked" and hides the linking UI entirely.
    /// There is no retry in that screen, so the only way out was to quit and
    /// reopen, which the screen does not say either.
    ///
    /// Keychain failures here are transient and ordinary: a login keychain not
    /// yet unlocked, a first-unlock race, or an access prompt dismissed by
    /// accident. (It reappeared on every update while the app was ad-hoc
    /// signed, because the code requirement changed with the cdhash; v0.1.7's
    /// Developer ID signature made that stable, which makes this rarer rather
    /// than impossible.)
    /// `identity.ts` on the phone already refuses to memoize a failure for
    /// these exact reasons; this is the same rule on the other client.
    fn device_auth(&self) -> Option<&DeviceAuth> {
        if let Some(cached) = self.inner.get() {
            return cached.as_ref();
        }
        let _serialised = self.retry.lock().unwrap_or_else(|e| e.into_inner());
        // Re-read: a racer may have succeeded while this thread waited.
        if let Some(cached) = self.inner.get() {
            return cached.as_ref();
        }
        match (self.load)() {
            Ok(identity) => {
                let _ = self.inner.set(Some(DeviceAuth::with_sink(
                    identity,
                    self.base_url.clone(),
                    self.sink.clone(),
                )));
                self.inner.get().and_then(Option::as_ref)
            }
            Err(e) => {
                log::warn!(
                    target: "lilypad::auth",
                    "no durable device identity ({e}) — backend calls will be unauthenticated, \
                     and the next call will try again",
                );
                None
            }
        }
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
        // The second racer at launch (the first is the presence loop's
        // `bearer`). Same gate, same re-check: `cached_identity` is exactly
        // what this needs, so a caller that waited answers from the winner's
        // exchange instead of running its own. See `DeviceAuth::signing_in`.
        let _exchange = auth.signing_in.lock().await;
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

    /// Throw away the cached device token, so the next call mints a fresh one.
    ///
    /// The presence loop calls this when the hub answers `unauthorized_room`:
    /// the commonest reason a register is refused is a token the server
    /// considers expired, and reconnecting with the same one cannot fix that.
    /// A no-op on a machine with no identity, which has nothing cached.
    pub fn invalidate(&self) {
        if let Some(auth) = self.device_auth() {
            auth.invalidate();
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

    /// Put this Mac on the account that just signed in. See `DeviceAuth::enroll`.
    ///
    /// The `no durable identity` case is the same one `request_enrollment_code`
    /// hits and reads the same way: without a keypair in the login keychain
    /// there is nothing to enrol, and the sentence has to say so rather than
    /// fail as a network error.
    pub async fn enroll(
        &self,
        account_token: &str,
        fingerprint: &str,
        name: &str,
        platform: &str,
    ) -> Result<DeviceSession> {
        let auth = self.device_auth().ok_or_else(|| {
            anyhow::anyhow!(
                "Lilypad couldn’t save this computer’s key to the macOS keychain, so it can’t \
                 join your account. If a keychain permission box appeared, allow it and sign in \
                 again."
            )
        })?;
        auth.enroll(account_token, fingerprint, name, platform)
            .await
    }

    /// Take this Mac off the account. See `DeviceAuth::release`.
    ///
    /// No durable identity means it was never enrolled, so there is nothing to
    /// give back and nothing to report — the caller's goal already holds.
    pub async fn release(&self) -> Result<()> {
        match self.device_auth() {
            Some(auth) => auth.release().await,
            None => Ok(()),
        }
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
        self.bearer_result().await.ok()
    }

    /// A token, or WHY there is not one. The distinction is the difference
    /// between an accurate banner and a keychain scare — see `NoToken`.
    pub async fn bearer_result(&self) -> Result<String, NoToken> {
        let Some(auth) = self.device_auth() else {
            return Err(NoToken::NoIdentity);
        };
        match auth.access_token().await {
            Ok(token) => Ok(token),
            Err(e) => {
                log::debug!(target: "lilypad::auth", "no device token available: {e}");
                Err(match e.downcast_ref::<AuthError>() {
                    Some(AuthError::NotEnrolled) => NoToken::NotLinked,
                    Some(AuthError::Revoked) => NoToken::Revoked,
                    None => NoToken::Unavailable,
                })
            }
        }
    }
}

/// Why there is no device token to present.
///
/// `bearer()` collapsed all of these into `None`, and the presence loop then
/// reported every one of them as "this Mac has no saved key — macOS may have
/// denied Lilypad access to the keychain". That message is right for exactly
/// one of them. It was shown on the dashboard of every computer that had not
/// been linked yet — which is every computer, on its first run — and again for
/// thirty seconds after each wake, when the real cause was that the network
/// had not come back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoToken {
    /// The keychain would not produce a durable identity. Local, and the one
    /// case where telling the user about the keychain is correct.
    NoIdentity,
    /// No account owns this computer yet. Ordinary, and not a fault at all:
    /// the dashboard's linking panel is already saying what to do about it.
    NotLinked,
    /// It was linked and is not any more.
    Revoked,
    /// The exchange itself failed — network, DNS, backend. Clears on its own.
    Unavailable,
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

/// What to tell someone whose "Link this computer" just failed.
///
/// One sentence about what happened and one about what to do, per status. The
/// two that are actually reachable in ordinary use are 429 — the panel mints a
/// fresh code on every "New code" press, against a route budgeted at 20 a
/// minute — and 401, which is what a proof this server will not accept looks
/// like.
fn enrollment_code_failure(status: u16) -> &'static str {
    match status {
        429 => "Too many attempts just now. Wait a minute, then try again.",
        401 | 403 => {
            // Two literals concatenated rather than one long line: rustfmt
            // wrapped this and left fourteen spaces INSIDE the string, which
            // is what a person read on the screen that makes their computer
            // theirs. `every_message_reads_like_a_sentence` below is the guard.
            "This computer couldn’t prove its identity to Lilypad’s server. \
             Try again in a moment."
        }
        400 => "Lilypad’s server rejected this request. Please update the app.",
        _ => "Lilypad’s server couldn’t give out a code right now. Try again in a moment.",
    }
}

/// What a person reads when signing in worked but putting this Mac on the
/// account did not.
///
/// The 409 is the one worth spelling out: one machine has one owner, so the
/// second account to sign in on a shared Mac is refused, and the remedy —
/// remove it from the first account's "Your devices" — is not guessable. The
/// server sends that sentence; it is preferred over anything written here so
/// the wording lives in one place.
fn enroll_failure(status: u16, body: &str) -> String {
    if status == 409 {
        if let Some(message) = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v["message"].as_str().map(str::to_owned))
        {
            return message;
        }
        return "This computer already belongs to a different Lilypad account.".to_owned();
    }
    match status {
        429 => "Too many attempts just now. Wait a minute, then try again.",
        401 | 403 => {
            "This computer couldn’t prove its identity to Lilypad’s server. \
             Try again in a moment."
        }
        400 => "Lilypad’s server rejected this request. Please update the app.",
        _ => "Lilypad couldn’t add this computer to your account right now. Try again in a moment.",
    }
    .to_owned()
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
    /// The copy a customer reads when linking fails.
    ///
    /// `AccountPanel` renders whatever `start_enrollment` stringifies, so these
    /// four strings ARE the product's words on the screen that makes a computer
    /// yours. One of them shipped as "…to Lilypad’s server.              Try
    /// again in a moment." — rustfmt wrapped the literal and left fourteen
    /// spaces inside it. Nothing failed; it just looked broken.
    #[test]
    fn every_message_reads_like_a_sentence() {
        for status in [400_u16, 401, 403, 404, 429, 500, 503] {
            let message = super::enrollment_code_failure(status);
            assert!(
                !message.contains("  "),
                "{status}: doubled spacing inside the message: {message:?}"
            );
            assert!(
                !message.contains('\n'),
                "{status}: newline in a UI string: {message:?}"
            );
            assert!(
                message.ends_with('.'),
                "{status}: not a finished sentence: {message:?}"
            );
            // No status codes, no JSON, no internal nouns.
            for leak in ["HTTP", "{", "statusCode", "backend", "endpoint", "null"] {
                assert!(
                    !message.contains(leak),
                    "{status}: {leak:?} leaked into a customer message: {message:?}"
                );
            }
        }
    }

    /// The same rule for the sentences a failed enrollment produces, plus the
    /// one thing that is specific to this path: the 409.
    ///
    /// A machine has one owner, so signing in on a Mac that already belongs to
    /// somebody else is refused — and it is the only failure here whose remedy
    /// is a thing the customer must go and do somewhere else. The server writes
    /// that sentence, and this asserts the client actually SHOWS it rather than
    /// replacing it with a generic one.
    #[test]
    fn an_enrollment_failure_names_the_remedy_the_server_named() {
        let body = r#"{"error":"device_in_use","message":"this device already belongs to a different Lilypad account. Remove it from that account first, then sign in again here."}"#;
        assert!(super::enroll_failure(409, body).contains("Remove it from that account first"));

        // A 409 whose body is not the shape we expect must still say the true
        // thing, not fall through to "try again in a moment" — retrying is
        // exactly what will not help.
        for junk in ["", "not json", "{}"] {
            let message = super::enroll_failure(409, junk);
            assert!(
                message.contains("already belongs to a different"),
                "409 with body {junk:?} lost the reason: {message:?}"
            );
        }
    }

    #[test]
    fn every_enrollment_failure_reads_like_a_sentence() {
        for status in [400_u16, 401, 403, 404, 409, 429, 500, 503] {
            let message = super::enroll_failure(status, "{}");
            assert!(
                !message.contains("  "),
                "{status}: doubled spacing inside the message: {message:?}"
            );
            assert!(
                !message.contains('\n'),
                "{status}: newline in a UI string: {message:?}"
            );
            assert!(
                message.ends_with('.'),
                "{status}: not a finished sentence: {message:?}"
            );
            for leak in ["HTTP", "{", "statusCode", "backend", "endpoint", "null"] {
                assert!(
                    !message.contains(leak),
                    "{status}: {leak:?} leaked into a customer message: {message:?}"
                );
            }
        }
    }

    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A stub backend that counts challenges and answers the two endpoints
    /// `sign_in` uses. Real HTTP on a real socket, because the race being
    /// tested lives between the cache check and the network call — a fake that
    /// replaced `sign_in` itself would pass with or without the fix.
    async fn stub_backend(challenges: Arc<AtomicUsize>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let challenges = challenges.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let body = if req.contains("/devices/challenge") {
                        challenges.fetch_add(1, Ordering::SeqCst);
                        // Long enough that a second caller reaches the gate
                        // while this exchange is still in flight.
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        r#"{"challenge":"nonce-abcdefgh"}"#.to_owned()
                    } else {
                        r#"{"accessToken":"tok","expiresInSeconds":600,"deviceId":"d-1","userId":"u-1"}"#.to_owned()
                    };
                    let res = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(res.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }

    /// The regression for `DeviceAuth::signing_in`.
    ///
    /// Every launch races the tray's `link_state` against the presence loop's
    /// `bearer`. Unguarded, both miss the empty cache and run a full
    /// challenge+token exchange — the 2:1 challenge-to-token ratio observed
    /// live on 2026-08-15. Remove the lock from `access_token` and this asserts
    /// 8 instead of 1.
    #[tokio::test]
    async fn concurrent_callers_share_one_challenge_exchange() {
        let challenges = Arc::new(AtomicUsize::new(0));
        let base = stub_backend(challenges.clone()).await;
        let auth = Arc::new(DeviceAuth::new(
            DeviceIdentity::generate_ephemeral().unwrap(),
            base,
        ));

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let auth = auth.clone();
            tasks.push(tokio::spawn(async move { auth.access_token().await }));
        }
        for t in tasks {
            assert_eq!(t.await.unwrap().unwrap(), "tok");
        }

        assert_eq!(
            challenges.load(Ordering::SeqCst),
            1,
            "8 concurrent callers must burn ONE challenge, not one each"
        );
    }

    /// A stub that records every request line it is sent and answers
    /// `DELETE /devices/*` with whatever status the test asked for.
    async fn stub_backend_release(
        delete_status: &'static str,
        seen: Arc<std::sync::Mutex<Vec<String>>>,
    ) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let seen = seen.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    if let Ok(mut guard) = seen.lock() {
                        guard.push(req.clone());
                    }
                    let (status, body) = if req.starts_with("DELETE ") {
                        (delete_status, r#"{"ok":true}"#.to_owned())
                    } else if req.contains("/devices/challenge") {
                        ("200 OK", r#"{"challenge":"nonce-abcdefgh"}"#.to_owned())
                    } else {
                        (
                            "200 OK",
                            r#"{"accessToken":"tok","expiresInSeconds":600,"deviceId":"d-1","userId":"u-1"}"#.to_owned(),
                        )
                    };
                    let res = format!(
                        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        status,
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(res.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn auth_for(base: String) -> DeviceAuth {
        DeviceAuth::new(DeviceIdentity::generate_ephemeral().unwrap(), base)
    }

    /// Sign-out has to reach the SERVER, or it is not a sign-out.
    ///
    /// The old `account_sign_out` deleted a keychain entry and stopped. This
    /// asserts the request that makes the difference: the device's own row,
    /// deleted with the device's own token — which is what ends its live rooms,
    /// vacates its presence seat, and stops every paired phone from ringing it.
    #[tokio::test]
    async fn release_deletes_this_devices_own_row() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let base = stub_backend_release("200 OK", seen.clone()).await;
        let auth = auth_for(base);

        auth.release().await.expect("release should succeed");

        let requests = seen.lock().unwrap().clone();
        let delete = requests
            .iter()
            .find(|r| r.starts_with("DELETE "))
            .expect("release must send a DELETE");
        // `d-1` is `devices.id` from the token exchange — the row, not the wire
        // fingerprint. Enrolment resolves by (kind, fingerprint); this route
        // does not, and deleting the wrong identifier would answer 404 and look
        // like it had worked.
        assert!(
            delete.starts_with("DELETE /devices/d-1 "),
            "released the wrong identifier: {delete:?}"
        );
        assert!(
            delete.contains("authorization: Bearer tok"),
            "release must present this device's own token: {delete:?}"
        );
    }

    /// A cached token outlives the revocation by up to its TTL. Keeping it
    /// would leave the presence loop reconnecting with a credential every route
    /// now refuses, and reporting the refusal as an unexplained failure rather
    /// than as what it is.
    #[tokio::test]
    async fn release_drops_the_cached_token() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let base = stub_backend_release("200 OK", seen.clone()).await;
        let auth = auth_for(base);

        auth.access_token().await.unwrap();
        auth.release().await.unwrap();

        assert!(
            auth.cached_token().is_none(),
            "the token that authenticated the release must not survive it"
        );
    }

    /// 404 means the account does not have this device — which is exactly where
    /// sign-out is trying to leave it. Reporting it as a failure would strand a
    /// customer signed in to a Mac that is already off their account.
    #[tokio::test]
    async fn release_treats_an_absent_device_as_done() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let base = stub_backend_release("404 Not Found", seen).await;
        assert!(auth_for(base).release().await.is_ok());
    }

    /// The other direction, and the one that matters more: a release the server
    /// REFUSED must fail loudly, because `account_sign_out` is what turns that
    /// error into "you are still signed in". A Mac that says signed out while
    /// still answering to every paired phone is the state this whole path
    /// exists to prevent.
    #[tokio::test]
    async fn release_reports_a_refusal_in_words() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let base = stub_backend_release("500 Internal Server Error", seen).await;
        let err = auth_for(base)
            .release()
            .await
            .expect_err("a refused release must not report success");
        let message = err.to_string();
        for leak in ["HTTP", "500", "{", "null"] {
            assert!(
                !message.contains(leak),
                "{leak:?} leaked into a customer message: {message:?}"
            );
        }
        assert!(
            message.ends_with('.'),
            "not a finished sentence: {message:?}"
        );
    }

    /// A stub that answers the token exchange with a fingerprint of its own —
    /// the shape of a backend telling a client it is calling itself the wrong
    /// thing.
    async fn stub_backend_named(canonical: Option<&'static str>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let body = if req.contains("/devices/challenge") {
                        r#"{"challenge":"nonce-abcdefgh"}"#.to_owned()
                    } else {
                        match canonical {
                            Some(fp) => format!(
                                r#"{{"accessToken":"tok","expiresInSeconds":600,"deviceId":"d-1","userId":"u-1","fingerprint":"{fp}"}}"#
                            ),
                            // An older backend, which cannot say.
                            None => r#"{"accessToken":"tok","expiresInSeconds":600,"deviceId":"d-1","userId":"u-1"}"#.to_owned(),
                        }
                    };
                    let res = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(res.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }

    /// The repair for kanban L-153.
    ///
    /// `device_id` is a file under the app's data directory and the key is in
    /// the login keychain, so clearing one and not the other renames this
    /// computer without changing who it is. The backend resolves by key and
    /// reports the row's own wire id; this is the client half that hears it.
    #[tokio::test]
    async fn a_drifted_computer_is_told_what_it_is_really_called() {
        let heard: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_target = heard.clone();
        let auth = DeviceAuth::with_sink(
            DeviceIdentity::generate_ephemeral().unwrap(),
            stub_backend_named(Some("desktop-canonical")).await,
            Some(Arc::new(move |canonical: &str| {
                sink_target.lock().unwrap().push(canonical.to_owned());
            })),
        );

        assert_eq!(auth.access_token().await.unwrap(), "tok");
        assert_eq!(heard.lock().unwrap().as_slice(), ["desktop-canonical"]);
    }

    /// A server too old to name the device must not be read as naming it
    /// nothing. Adopting an empty id would rename a working computer to garbage
    /// — strictly worse than the drift this exists to fix.
    #[tokio::test]
    async fn a_silent_backend_renames_nothing() {
        let heard: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_target = heard.clone();
        let auth = DeviceAuth::with_sink(
            DeviceIdentity::generate_ephemeral().unwrap(),
            stub_backend_named(None).await,
            Some(Arc::new(move |canonical: &str| {
                sink_target.lock().unwrap().push(canonical.to_owned());
            })),
        );

        assert_eq!(auth.access_token().await.unwrap(), "tok");
        assert!(heard.lock().unwrap().is_empty());
    }

    /// What "Link this computer" says when it fails.
    ///
    /// `start_enrollment` stringifies this error and `AccountPanel` renders it
    /// verbatim, so these ARE the product's words. The old text was
    /// `could not start enrollment (HTTP 429): {"statusCode":429,…}` on the
    /// one screen that turns a laptop into the user's own — and 429 is not
    /// exotic: the panel mints a fresh code on every "New code" press against
    /// a route budgeted at 20 a minute.
    #[test]
    fn a_failed_linking_attempt_is_explained_in_words() {
        for status in [400u16, 401, 403, 429, 500, 502, 503] {
            let message = enrollment_code_failure(status);
            assert!(
                !message.contains("HTTP")
                    && !message.contains('{')
                    && !message.contains(&status.to_string()),
                "HTTP {status} leaks implementation: {message}"
            );
            assert!(
                message.ends_with('.') && message.chars().next().unwrap().is_uppercase(),
                "HTTP {status} is not a sentence: {message}"
            );
        }

        // The two that actually happen say what to do about them.
        assert!(enrollment_code_failure(429).contains("Wait a minute"));
        assert!(enrollment_code_failure(401).contains("Try again"));
        // A client too old for the server is the one case where retrying is
        // not the answer, so it must not say "try again".
        assert!(!enrollment_code_failure(400).contains("Try again"));
    }

    /// Which build is this customer running?
    ///
    /// Unanswerable until 2026-08-22: no client sent a version at all. It
    /// rides on the token exchange because that is the one request the app
    /// makes on every launch and every renewal — so the stored value stays
    /// current without a heartbeat of its own. This asserts it is actually on
    /// the wire, not merely in the source.
    #[tokio::test]
    async fn the_token_request_says_which_build_is_asking() {
        let bodies = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = bodies.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let seen = seen.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let body = if req.contains("/devices/challenge") {
                        r#"{"challenge":"nonce-abcdefgh"}"#.to_owned()
                    } else {
                        seen.lock().unwrap().push(req);
                        r#"{"accessToken":"tok","expiresInSeconds":600,"deviceId":"d-1","userId":"u-1"}"#.to_owned()
                    };
                    let res = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(res.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });

        let auth = DeviceAuth::new(
            DeviceIdentity::generate_ephemeral().unwrap(),
            format!("http://{addr}"),
        );
        assert_eq!(auth.access_token().await.unwrap(), "tok");

        let sent = bodies.lock().unwrap().join("\n");
        assert!(
            sent.contains(&format!(r#""appVersion":"{}""#, env!("CARGO_PKG_VERSION"))),
            "the token request must carry this build's version; sent: {sent}"
        );
    }

    /// The gate must not outlive its purpose: once the token is cached, callers
    /// take the fast path and never queue behind the mutex at all.
    #[tokio::test]
    async fn a_cached_token_is_served_without_touching_the_network() {
        let challenges = Arc::new(AtomicUsize::new(0));
        let base = stub_backend(challenges.clone()).await;
        let auth = DeviceAuth::new(DeviceIdentity::generate_ephemeral().unwrap(), base);

        assert_eq!(auth.access_token().await.unwrap(), "tok");
        assert_eq!(challenges.load(Ordering::SeqCst), 1);
        // Second call: cache hit, no exchange.
        assert_eq!(auth.access_token().await.unwrap(), "tok");
        assert_eq!(challenges.load(Ordering::SeqCst), 1);
    }

    fn session(expires_in_seconds: u64) -> DeviceSession {
        DeviceSession {
            access_token: "a-token".to_owned(),
            expires_in_seconds,
            device_id: "device-uuid".to_owned(),
            user_id: "user-uuid".to_owned(),
            fingerprint: None,
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

    /// The bug this file's clock choice exists to prevent.
    ///
    /// A Mac sleeps. `Instant` does not advance while it is asleep; the
    /// server's `exp` does. On 2026-08-25 a laptop woke holding a
    /// ten-minute token minted forty-nine minutes earlier, believed it fresh,
    /// and was refused `unauthorized_room` on every presence register for
    /// twenty-four minutes — during which the phone showed it as offline and
    /// no `/devices/token` request was made at all.
    ///
    /// Expressing that case requires a clock the test can move independently
    /// of the process, which is precisely what `Instant` cannot be.
    #[test]
    fn a_token_is_stale_after_the_machine_sleeps_through_its_lifetime() {
        let auth = auth();
        auth.cache(&session(600));
        // Awake: still good.
        assert!(auth.cached_token_at(SystemTime::now()).is_some());
        // Woken forty minutes later. The process did not run; the world moved.
        let after_sleep = SystemTime::now() + Duration::from_secs(40 * 60);
        assert!(
            auth.cached_token_at(after_sleep).is_none(),
            "a token the server expired half an hour ago must not be presented"
        );
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

    /// A keychain read that fails must not disable the app for the whole
    /// process.
    ///
    /// `get_or_init` stored whatever the first attempt produced, failure
    /// included — so one dismissed access prompt left the dashboard saying
    /// "this computer has no secure identity, so it cannot be linked", with
    /// the linking UI hidden and no retry anywhere on screen. The prompt
    /// reappeared on every update while the app was ad-hoc signed; a stable
    /// Developer ID signature made that rare, not impossible, and a locked
    /// keychain never needed an update to happen.
    #[test]
    fn a_failed_keychain_read_is_retried_rather_than_remembered() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

        fn flaky() -> Result<DeviceIdentity> {
            // Fails once, then works — a locked login keychain, or a prompt
            // the user dismissed and then allowed.
            if ATTEMPTS.fetch_add(1, Ordering::SeqCst) == 0 {
                anyhow::bail!("the keychain is locked");
            }
            DeviceIdentity::generate_ephemeral()
        }

        ATTEMPTS.store(0, Ordering::SeqCst);
        let mut auth = DesktopAuth::new("http://localhost:8080".to_owned());
        auth.load = flaky;

        assert!(
            auth.device_auth().is_none(),
            "the first read failed, so there is no identity yet"
        );
        assert!(
            auth.device_auth().is_some(),
            "the second read succeeds — a transient failure must not be permanent"
        );
        assert_eq!(ATTEMPTS.load(Ordering::SeqCst), 2);

        // And once it HAS succeeded, it is cached: no further keychain reads.
        assert!(auth.device_auth().is_some());
        assert_eq!(ATTEMPTS.load(Ordering::SeqCst), 2);
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
