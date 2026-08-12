---
status: In Progress
owner: @kushsharma024
last-verified: 2026-08-12
summary: Exactly which OAuth clients to create and where each value goes.
---

# OAuth setup — Google and Apple

Everything here is derived from the code, not from provider documentation
templates. The authority for each value is cited so it can be re-checked.

## The one architectural fact that determines everything

**Lilypad's backend never performs an authorization-code exchange.**
[`POST /auth/oauth`](../apps/backend/src/routes/auth.ts) accepts
`{ provider, idToken }` and verifies an ID token the client already obtained.

Three consequences, and they are what make this setup unusually short:

- **No client secrets.** Not for Google, not for Apple. No `.p8` key, no
  `APPLE_KEY_ID`, no signed client-secret JWT.
- **No backend redirect URI.** There is no `/auth/callback` route and no code
  that could consume one.
- **The only thing the backend checks about a client id is that it appears in
  the `aud` allowlist** ([`providers.ts`](../apps/backend/src/auth/providers.ts)).

That audience check is the entire defence against an ID token minted for someone
else's app being replayed here to sign its bearer into Lilypad. It is the reason
these values must be exact.

## App identifiers (final, as of M8)

| Target     | Identifier                    |
| ---------- | ----------------------------- |
| iOS        | `com.takedia.lilypad`         |
| Android    | `com.takedia.lilypad`         |
| Desktop    | `com.takedia.lilypad.desktop` |
| Apple team | `7TYFS43RR3`                  |

An iOS OAuth client's bundle id and an Android package name are **immutable once
created**. These were unified before any client was created for that reason.

## Google — what to create

Google Cloud Console → APIs & Services → Credentials.

### 1. OAuth consent screen

Required before any client can be created. User type **External**; scopes
`openid`, `email`, `profile` only — Lilypad reads nothing else.

### 2. Web application client — **the one that matters**

This is the counter-intuitive part.
[`@react-native-google-signin/google-signin`](../apps/mobile/src/lib/signIn.ts)
mints the ID token with `aud` set to **`webClientId`** on _both_ platforms when
one is supplied — and on Android it is _required_ in order to get an ID token at
all. So the web client id, not the iOS or Android one, is what the backend
normally receives and must accept.

- Type: **Web application**
- Authorised redirect URIs: **none needed.** This client is used purely as the
  token's audience. Add one only if you later build browser sign-in.
- Its id goes in **two** places — see the table at the end.

### 3. iOS client

- Type: **iOS**
- Bundle ID: **`com.takedia.lilypad`**
- No redirect URI field exists for this type. It uses a URL scheme instead: the
  **reversed client id**, e.g. `com.googleusercontent.apps.123456-abcdef`.

That scheme must be added to
[`Info.plist`](../apps/mobile/ios/LilypadMobile/Info.plist), where a commented
block is already waiting with the exact shape. It is commented rather than
filled with a placeholder because a _wrong_ URL scheme fails at runtime with an
opaque error, whereas an absent one keeps the (hidden) Google button honestly
unavailable.

### 4. Android client

- Type: **Android**
- Package name: **`com.takedia.lilypad`**
- SHA-1 certificate fingerprint: of the **release upload keystore**.

The debug-key fallback that made this unsafe is **fixed**: release builds now
produce an unsigned APK unless real credentials are supplied, so there is no
longer a debug-signed artefact that could be mistaken for shippable. See
[RELEASE.md](../apps/mobile/docs/RELEASE.md) for generating the upload keystore,
then read the fingerprint the OAuth client is registered against:

```bash
keytool -list -v -keystore lilypad-upload.jks -alias upload | grep SHA1
```

> **If Play App Signing is enabled**, Google re-signs uploads with its own key
> and the fingerprint OAuth actually sees is **Play's app signing certificate**
> (Play Console → Setup → App signing), not the upload key's. Register both, or
> sign-in works in your local build and fails for every Play install.

A debug-key SHA-1 can be registered as well if you want Google sign-in to work
in local debug builds — separate fingerprint entries on the same client.

## Apple — what to create

Apple Developer portal.

### 1. App ID capability

Enable **Sign in with Apple** on the App ID `com.takedia.lilypad`. The matching
entitlement is already committed at
[`LilypadMobile.entitlements`](../apps/mobile/ios/LilypadMobile/LilypadMobile.entitlements)
and wired to the app target (not the test target) via `CODE_SIGN_ENTITLEMENTS`.
Signing fails with a provisioning-profile mismatch if the portal side is missing.

Apple **requires** Sign in with Apple to be offered once any other third-party
sign-in exists, so adding Google made this mandatory rather than optional.

### 2. Client id

Native Sign in with Apple mints an identity token whose `aud` is the app's
**bundle id**, supplied by the OS. There is nothing to configure in the app and
**no Services ID is needed** for the phone.

Create a **Services ID** only when adding web or desktop browser sign-in; that
is also the only path that would require a `.p8` client secret, which this
architecture otherwise avoids entirely.

## Where every value goes

| Value                        | Goes in                                                  | Also in                                                                           |
| ---------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Google **Web** client id     | `GOOGLE_CLIENT_IDS` (backend `.env`)                     | `GOOGLE_WEB_CLIENT_ID` in [`config/oauth.ts`](../apps/mobile/src/config/oauth.ts) |
| Google **iOS** client id     | `GOOGLE_IOS_CLIENT_ID` in `config/oauth.ts`              | reversed, as a URL scheme in `Info.plist`                                         |
| Google **Android** client id | nowhere — registration alone is what authorises the app  | —                                                                                 |
| `com.takedia.lilypad`        | `APPLE_CLIENT_IDS` (backend `.env`)                      | —                                                                                 |
| Apple Services ID            | `APPLE_CLIENT_IDS`, only if web/desktop sign-in is added | —                                                                                 |

`GOOGLE_CLIENT_IDS` and `APPLE_CLIENT_IDS` are **comma-separated, trimmed, and
order-independent** — the backend passes them to `jose` as an audience array and
a token passes if its `aud` matches any entry
([`providers.ts`](../apps/backend/src/auth/providers.ts)). An empty value means
that provider is unconfigured and its route answers `503
provider_not_configured` rather than pretending to work.

```bash
# backend .env
GOOGLE_CLIENT_IDS=123456-web.apps.googleusercontent.com
APPLE_CLIENT_IDS=com.takedia.lilypad
AUTH_TOKEN_SECRET=$(openssl rand -hex 32)
```

## Desktop sign-in — a constraint worth deciding before building

The brief asks for Google **and** Apple sign-in on the desktop while keeping the
backend free of authorization-code exchanges and client secrets. Those two goals
collide on Google, and the collision is Google's, not ours:

- **Google removed the implicit ID-token flow for installed apps.** A desktop
  app can only obtain an ID token via `response_type=code` plus PKCE, exchanged
  at Google's token endpoint. There is no configuration that avoids it.
- Google issues a "client secret" for Desktop-app clients but documents it as
  **not confidential** — it ships inside the binary and PKCE is what actually
  protects the exchange.

Three options, none of them invented:

1. **Desktop performs the PKCE exchange locally.** The backend still only ever
   receives an ID token, so the architecture in ADR-0001 is untouched — the
   exchange happens in the Tauri app against Google, not in our server. Needs a
   Google **Desktop app** client and a loopback redirect
   (`http://127.0.0.1:<random port>`).
2. **Sign the desktop in from the phone** — the QR-as-sign-in model already
   chosen in [ADR-0003](adr/0003-same-account-device-visibility.md) for M9. No
   desktop OAuth client at all, no exchange, no browser. The phone is already
   signed in and authorises the laptop.
3. **Apple-only on macOS.** Native `ASAuthorizationAppleIDProvider` works on
   macOS and returns an identity token directly with no exchange, but calling it
   from Rust needs Objective-C interop.

Option 2 is the smallest and the one the roadmap already implies. **Not yet
implemented; awaiting a decision.**

## Status — what is built and what is not

| Piece                           | State                                              |
| ------------------------------- | -------------------------------------------------- |
| Backend ID-token verification   | **Implemented**, 15 tests                          |
| Mobile Google sign-in           | **Implemented**, 6 tests; unverified on device     |
| Mobile Apple sign-in            | **Implemented**, 4 tests; unverified on device     |
| Mobile magic link               | **Implemented**, 4 tests; dev-only delivery        |
| iOS entitlement + target wiring | **Implemented**, plists validated                  |
| iOS Google URL scheme           | **Waiting on the client id**                       |
| Android release signing         | **Fixed** — fails closed; verified in a Gradle run |
| Android OAuth client            | **Waiting on the upload keystore's SHA-1**         |
| Desktop sign-in                 | **Not started** — see the decision above           |

"Unverified on device" is literal: the sign-in modules typecheck against the real
SDK type definitions and their logic is unit-tested against mocked SDKs, but no
iOS or Android build has been run. Native module linking, the entitlement, and
the URL scheme cannot be proven by any test in this repository.

Mobile gained native modules, so **iOS needs `pnpm pods` and Android a clean
rebuild** before either will launch.
