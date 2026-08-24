---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-23
summary: Creating the Apple credentials Lilypad's release pipelines need, and checking them before a release depends on them.
---

# Apple setup

Everything Apple-related in this repository is already written and tested. What
it needs is credentials, and every one of them has to be created by a human with
access to the Apple Developer account — none can be generated from a checkout.

This page is the list, in the order that unblocks the most.

Run `pnpm apple:check` after each step. It validates the same values the
workflows read, in about a second, without printing any of them — the
alternative is finding out twenty minutes into a release, from a message
`codesign` or `notarytool` wrote about something else.

## The Mac app and iOS do not need the same Apple team

Worth knowing before doing any of this, because it decides who you have to wait
for.

A **Developer ID Application** certificate needs no app record, no App Store
Connect listing and no review — it only has to exist in an account whose
**Account Holder you are**. Notarization takes an App Store Connect key from
that same account and nothing else. So the entire Mac pipeline can ship from a
team you control, today, with nobody else involved.

iOS is the opposite: TestFlight needs an app record, and an app record lives in
one specific account.

The two pipelines already read separate App Store Connect keys (`APPLE_API_*`
for the Mac app, `ASC_*` for iOS). Setting **`IOS_TEAM_ID`** splits the last
shared value, and `pnpm apple:check` then asks each lane's key about its own
team:

| Secret          | Used by          | Set it to                                                     |
| --------------- | ---------------- | ------------------------------------------------------------- |
| `APPLE_TEAM_ID` | `release.yml`    | the team holding the Developer ID certificate                 |
| `IOS_TEAM_ID`   | `mobile-ios.yml` | the team holding the app record — omit if it is the same team |

As of 2026-08-24 iOS ships from `AR2Q4Y465L`. If the Developer ID certificate
turns out to be faster to obtain elsewhere, set `APPLE_TEAM_ID` to that team and
`IOS_TEAM_ID` to `AR2Q4Y465L`; nothing else changes.

## What each credential unblocks

| Credential                    | Without it                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Developer ID Application cert | The Mac app is **ad-hoc signed**: Gatekeeper warns on first open, and macOS forgets Screen Recording and Accessibility on every update. |
| App Store Connect API key     | The Mac app is **not notarized**, and no iOS build can reach TestFlight.                                                                |
| A registered iOS app record   | `upload_to_testflight` has nothing to upload to.                                                                                        |

The Team ID is already known and hard-coded as a default: **`AR2Q4Y465L`**
(`Abhinay Pandey`), read from `apps/mobile/ios/LilypadMobile.xcodeproj`. The iOS
bundle identifier is **`com.takedia.lilypad`**, registered in that team as App ID
`C54FRGK4KU` with **Sign in with Apple** enabled — the entitlement the app ships
fails signing without it.

Every credential below must come from **that same account**. Lilypad's code and
this machine's keychain were originally set up against `7TYFS43RR3`
(`Kush Sharma`); the project was re-pointed on 2026-08-24 because the App Store
Connect key and the App ID live in `AR2Q4Y465L`. A build signed by one team
cannot be notarized or uploaded with another team's key, and Apple does not say
so until after the upload.

## 1. Developer ID Application certificate

**Done — 2026-08-24.** Issued by the Account Holder from the CSR in this repo's
owner's keychain, installed, and stored as `APPLE_CERTIFICATE`. Kept here
because it expires 2031-08-25 and will have to be redone then, and because the
type name below is a trap worth remembering.

Apple reports it as **`DEVELOPER_ID_APPLICATION_G2`**, not
`DEVELOPER_ID_APPLICATION` — anything the G2 sub-CA issues carries the suffix.
A check that matches the bare name reports a fully configured account as having
no certificate.

The private key exists in exactly two places: this Mac's login keychain, and
`APPLE_CERTIFICATE`, which GitHub will never hand back. A `.p12` backup lives
outside the repo alongside the iOS one; without it, replacing a lost key means
going back to the Account Holder.

This is the one that changes what a customer sees. It is **not** the "Apple
Development" or "Apple Distribution" certificate — those cannot sign software
distributed outside the App Store, which is how the Mac app ships.

**Only the Account Holder can create it**, and only in the web UI. Not an
Admin, not an App Manager, and not an App Store Connect API key however
privileged — the API answers a `POST /v1/certificates` for this type with:

```
403 FORBIDDEN_ERROR — This operation can only be performed by the Account Holder.
```

So for team `AR2Q4Y465L` this is Abhinay's step, and nobody else's. Steps 1 and
3–6 belong to whoever will hold the private key; step 2 is his.

The private key never has to travel. Whoever runs step 1 keeps it; the CSR that
comes out of it carries only a public key and can be emailed safely. The `.cer`
that comes back is equally public. That is why the split below works: Abhinay
uploads someone else's CSR and the resulting certificate is usable only on the
machine that made it.

1. Keychain Access → Certificate Assistant → **Request a Certificate From a
   Certificate Authority**. Enter your email, any Common Name, choose **Saved
   to disk**, and save the `.certSigningRequest`. This also creates the key
   pair in your login keychain — the _private_ half never leaves the machine
   and is what makes the certificate usable. Skip if you already have a CSR
   whose key is still in that keychain.
2. **Account Holder only.** Apple Developer → Certificates → **+** →
   **Developer ID Application** → upload that CSR. Sending the `.certSigningRequest`
   to the Account Holder and getting a `.cer` back is the normal way to do this
   when the two are different people.
3. Download the resulting `.cer` and double-click it. macOS pairs it with the
   private key from step 1.
4. Confirm the pairing before going further — this is the step that silently
   fails if the CSR came from a different machine or a stray `openssl` command:

   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```

   No line means the certificate has no private key here and cannot sign. Revoke
   it, redo step 1 on this machine, and issue a new one.

5. `pnpm apple:cert path/to/certificate.cer --set`

   It does steps 3–6 in one go: installs the certificate, **refuses to continue
   if no private key for it is in this keychain**, exports the `.p12` under a
   generated password, and sets `APPLE_CERTIFICATE`,
   `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` and `APPLE_TEAM_ID`.
   Without `--set` it prints the values instead of uploading them. The `.p12`
   is deleted afterwards either way.

   By hand instead: Keychain Access → find
   `Developer ID Application: … (AR2Q4Y465L)` → right click → **Export** →
   `.p12` with a password → `base64 -i cert.p12 | pbcopy`.

Secrets: `APPLE_CERTIFICATE` (that base64), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY` (the full string, exactly as Keychain Access shows it),
`APPLE_TEAM_ID`.

**Why this one matters beyond the warning dialog.** macOS binds a TCC permission
grant to the code signature that asked for it. An ad-hoc signature has a
different cdhash in every build, so a customer who grants Screen Recording and
Accessibility loses both on the next update, while System Settings still shows
the switches on — measured on the 0.1.3 DMG, and the reason `Setup.tsx` carries
a whole recovery flow for it. A Developer ID signature is stable across
versions, and that flow stops being reachable.

## 2. App Store Connect API key

One key covers both notarizing the Mac app and uploading iOS builds.

It must come from **the same Apple Developer account the signing certificate
belongs to** — team `7TYFS43RR3`, the team the Xcode project builds for. A key
from any other account authenticates perfectly and is still useless: a build
signed by one team cannot be notarized or uploaded with another team's key, and
Apple only says so after the upload. Asking a collaborator for "the Issuer ID"
gets you _their_ team's, which is the failure this paragraph exists to prevent.

1. App Store Connect → **Users and Access** → **Integrations** → **App Store
   Connect API** → the **Team Keys** tab → **+**.
   - **Team Keys**, not Individual Keys. An individual key has no Issuer ID and
     identifies itself differently; `notarytool` and `fastlane` only ever send
     the team form of the token, so an individual key fails every workflow with
     a flat `401` that reads like a wrong Issuer ID. The two are
     indistinguishable once downloaded — only the tab you created it under
     tells them apart.
   - Creating team keys requires the **Account Holder** or an **Admin**.
2. Role: **App Manager** (Developer is enough for notarization alone, not for
   TestFlight uploads).
3. Download the `.p8`. **It downloads once.** Losing it means revoking and
   starting again.
4. Note the **Key ID** next to it and the **Issuer ID** at the top of the page.
5. `base64 -i AuthKey_XXXXXXXX.p8 | pbcopy`

`pnpm apple:check` verifies the account matches before anything is built: it
reads the team id out of the account's own certificates and compares it to
`APPLE_TEAM_ID`, and it reports an individual key as an individual key rather
than as a bad Issuer ID.

The two release pipelines read the same key under different names, so set all
six:

| Desktop (`release.yml`) | iOS (`mobile-ios.yml`) | Value               |
| ----------------------- | ---------------------- | ------------------- |
| `APPLE_API_KEY_P8`      | `ASC_KEY_P8`           | base64 of the `.p8` |
| `APPLE_API_KEY`         | `ASC_KEY_ID`           | the Key ID          |
| `APPLE_API_ISSUER`      | `ASC_ISSUER_ID`        | the Issuer ID       |

`pnpm apple:check` fails if the two halves disagree, because a key that works
for one pipeline and is missing from the other is the likeliest way to end up
with half a release.

## 3. The iOS app record

**Done — 2026-08-24.** App Store Connect record `6804827369`, named **Lilypad
RC** because "Lilypad" was already taken App Store–wide, SKU `lilypad-ios`,
bundle id `com.takedia.lilypad`. Build 1 uploaded and VALID; an internal
TestFlight group named "Internal" has access to all builds.

Its primary language came out as **English (Australia)** from the New App form's
default. Changing it now returns `409 — you must first provide all the required
screenshots for each version`, so it has to wait until store screenshots exist.
TestFlight is unaffected.

Two steps, in this order — App Store Connect's New App form only offers bundle
ids that are already registered as App IDs, so doing them the other way round
dead-ends on an empty dropdown.

1. ~~Apple Developer → **Identifiers** → **+**~~ — **done.** Registered
   through the API on 2026-08-24 as App ID `C54FRGK4KU`, with **Sign in with
   Apple** enabled. That capability is not optional:
   `LilypadMobile.entitlements` ships `com.apple.developer.applesignin`, and
   signing fails with a provisioning-profile mismatch without it. Nothing else
   needs enabling — no push, no iCloud, no App Groups.
2. App Store Connect → **Apps** → **+** → **New App** → iOS, select that bundle
   id, pick a name and an SKU (the SKU is internal and never shown to anyone —
   `lilypad-ios` is fine). Nothing uploads until this record exists.

The **name is public and must be unique across the App Store** — but that is
not why this step is manual. It cannot be automated at all. Three routes, all
closed:

| Route                | Answer                                                        |
| -------------------- | ------------------------------------------------------------- |
| `POST /v1/apps`      | `403 — the resource 'apps' does not allow 'CREATE'`           |
| `POST /iris/v1/apps` | `404` — the web UI's route is not served on the API host      |
| `fastlane produce`   | `--username` is its only credential; no API-key option exists |

So an app record needs a human signed into the browser. As of 2026-08-24
`kushsharma024@gmail.com` is an **Admin** of `AR2Q4Y465L` with all apps
visible, which is enough to create one.

The macOS side needs neither: a Developer ID build is distributed outside the
App Store, so it has no App ID and no App Store Connect record.

The bundle already answers the two questions that otherwise stop every build:

- `ITSAppUsesNonExemptEncryption` is `false` in `Info.plist`, so no upload waits
  on the export-compliance form. Accurate for this app: HTTPS to the control
  plane, DTLS-SRTP for media, Ed25519 for device identity, and no proprietary
  cryptography anywhere in it.
- `PrivacyInfo.xcprivacy` declares what the backend schema proves is stored —
  email address, name, device identifier, and the IP in security audit rows —
  none of it linked to tracking, because there is no analytics or advertising
  SDK in the bundle.

Both are asserted by `apps/mobile/src/lib/__tests__/iosBundle.test.ts`, since
nothing in the JavaScript imports them and nothing else would notice them
going missing.

## 4. The iOS distribution identity

**Done — 2026-08-24**, and the three secrets are set. Only needed because Xcode's **managed cloud signing** is refused for this App
Store Connect key:

```
error: exportArchive Cloud signing permission error
error: exportArchive No signing certificate "iOS Distribution" found
```

That is a role the key does not have, and no repository change fixes it. It is
also the wrong mechanism for CI regardless: an ephemeral runner cannot reuse a
certificate whose private key it does not hold, so cloud-less automatic signing
would mint a fresh certificate every run until the account hit its limit.

Instead the certificate and profile are created once, through the API, with a
private key we keep — created on 2026-08-24 as certificate `88YSPR2XJM` and
profile **Lilypad App Store**, and handed to CI as three secrets:

| Secret                     | What                             |
| -------------------------- | -------------------------------- |
| `IOS_DIST_CERT_P12`        | base64 of the `.p12`             |
| `IOS_DIST_CERT_PASSWORD`   | its password                     |
| `IOS_PROVISIONING_PROFILE` | base64 of the `.mobileprovision` |

`mobile-ios.yml` imports them into a keychain it creates and deletes, runs
`security set-key-partition-list` so `codesign` does not block on a GUI prompt
no runner can answer, and derives the identity and profile names rather than
storing them as further secrets. Omit all three and the lane falls back to
automatic signing, which is correct for an account whose key _may_ create cloud
certificates.

The **archive** still signs automatically — Xcode resolves a development
identity from the same API key — and only the **export** is manual. That is the
combination verified end to end: `ARCHIVE SUCCEEDED`, a 24 MB IPA signed by
`iPhone Distribution: … (AR2Q4Y465L)`, and `altool --validate-app` reaching
Apple and stopping only at

```
Cannot determine the Apple ID from Bundle ID 'com.takedia.lilypad'
```

— which is the missing app record from §3, and nothing else.

## Adding the secrets

Repo → Settings → Secrets and variables → Actions. Or:

```
gh secret set APPLE_CERTIFICATE < <(base64 -i cert.p12)
gh secret set APPLE_SIGNING_IDENTITY --body "Developer ID Application: … (AR2Q4Y465L)"
```

Then, with the same values exported locally:

```
pnpm apple:check
```

Once the Issuer ID is set it does more than check shapes: it signs an ES256 JWT
with the `.p8` exactly the way `notarytool` and fastlane do and calls the live
App Store Connect API. That distinguishes the three failures that otherwise all
surface twenty minutes into a release run as something else — a wrong Issuer ID
(401), a key without the App Manager role (403), and an account with no app
record yet (which blocks TestFlight but not notarization).

## Shipping

Versions are deliberately not named here — a document that hard-codes the next
tag goes stale the moment one is cut, which is the same drift `pnpm release`
had against the website (L-74).

- **Mac:** `pnpm release <next>` then push the `v<next>` tag → `release.yml`
  builds a universal bundle, signs, notarizes, staples, publishes the GitHub
  release, and `site.yml` picks up the assets and serves them from
  `lilypadhome.takedia.com`. Customers download and update from the site, never
  from GitHub — see the note in `site.yml`.
- **iOS:** tag `mobile-v<next>`, or dispatch `Mobile — iOS (TestFlight)`. It
  fails loudly if any credential is missing, rather than reporting success
  while uploading nothing.

Every release up to and including **v0.1.5 is ad-hoc signed**: enough for macOS
to bind a TCC grant, not enough for Gatekeeper. The first release cut after
`APPLE_CERTIFICATE` exists is the first one a customer can open without the
unidentified-developer dialog — and the first whose Screen Recording and
Accessibility grants survive an update, because an ad-hoc cdhash changes every
build and TCC binds a grant to the exact signature.
