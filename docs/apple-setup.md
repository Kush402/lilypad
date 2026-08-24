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

## What each credential unblocks

| Credential                    | Without it                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Developer ID Application cert | The Mac app is **ad-hoc signed**: Gatekeeper warns on first open, and macOS forgets Screen Recording and Accessibility on every update. |
| App Store Connect API key     | The Mac app is **not notarized**, and no iOS build can reach TestFlight.                                                                |
| A registered iOS app record   | `upload_to_testflight` has nothing to upload to.                                                                                        |

The Team ID is already known and hard-coded as a default: **`7TYFS43RR3`**
(`Kush Sharma`), read from `apps/mobile/ios/LilypadMobile.xcodeproj`. The iOS
bundle identifier is **`com.takedia.lilypad`**.

## 1. Developer ID Application certificate

This is the one that changes what a customer sees. It is **not** the "Apple
Development" or "Apple Distribution" certificate — those cannot sign software
distributed outside the App Store, which is how the Mac app ships.

1. Keychain Access → Certificate Assistant → **Request a Certificate From a
   Certificate Authority**. Enter your email, any Common Name, choose **Saved
   to disk**, and save the `.certSigningRequest`. This also creates the key
   pair in your login keychain — the _private_ half never leaves the machine
   and is what makes the certificate usable. Skip if you already have a CSR
   whose key is still in that keychain.
2. Apple Developer → Certificates → **+** → **Developer ID Application** →
   upload that CSR.
3. Download the resulting `.cer` and double-click it. macOS pairs it with the
   private key from step 1.
4. Confirm the pairing before going further — this is the step that silently
   fails if the CSR came from a different machine or a stray `openssl` command:

   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```

   No line means the certificate has no private key here and cannot sign. Revoke
   it, redo step 1 on this machine, and issue a new one.

5. Keychain Access → find `Developer ID Application: … (7TYFS43RR3)` → right
   click → **Export** → `.p12`, with a password.
6. `base64 -i cert.p12 | pbcopy`

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

1. App Store Connect → **Users and Access** → **Integrations** → **App Store
   Connect API** → **+**.
2. Role: **App Manager** (Developer is enough for notarization alone, not for
   TestFlight uploads).
3. Download the `.p8`. **It downloads once.** Losing it means revoking and
   starting again.
4. Note the **Key ID** next to it and the **Issuer ID** at the top of the page.
5. `base64 -i AuthKey_XXXXXXXX.p8 | pbcopy`

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

Two steps, in this order — App Store Connect's New App form only offers bundle
ids that are already registered as App IDs, so doing them the other way round
dead-ends on an empty dropdown.

1. Apple Developer → **Identifiers** → **+** → **App IDs** → **App** →
   description `Lilypad`, Bundle ID **Explicit** = `com.takedia.lilypad`. No
   capabilities need enabling: the app uses no push, no iCloud, no App Groups.
2. App Store Connect → **Apps** → **+** → **New App** → iOS, select that bundle
   id, pick a name and an SKU (the SKU is internal and never shown to anyone —
   `lilypad-ios` is fine). Nothing uploads until this record exists.

The **name is public and must be unique across the App Store**, which is why
this step is not automated here even though `fastlane produce` could do it.

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

## Adding the secrets

Repo → Settings → Secrets and variables → Actions. Or:

```
gh secret set APPLE_CERTIFICATE < <(base64 -i cert.p12)
gh secret set APPLE_SIGNING_IDENTITY --body "Developer ID Application: … (7TYFS43RR3)"
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
