# Mobile release guide (iOS + Android)

Lilypad mobile is a **bare React Native 0.76.5** app. Releases are driven by
[fastlane](https://fastlane.tools) through two GitHub Actions workflows:

| Platform | Workflow                          | Lane                       | Destination                          |
| -------- | --------------------------------- | -------------------------- | ------------------------------------ |
| iOS      | `.github/workflows/mobile-ios.yml`     | `fastlane ios beta`     | TestFlight                           |
| Android  | `.github/workflows/mobile-android.yml` | `fastlane android beta` | Play internal track + APK artifact   |

Confirmed identifiers (derived from the project files, not guessed):

- **iOS bundle id:** `com.kushsharma.lilypad` (tests: `com.kushsharma.lilypad.tests`)
- **iOS scheme / workspace:** `LilypadMobile` / `LilypadMobile.xcworkspace`
- **iOS team id (default):** `7TYFS43RR3` (overridable via `APPLE_TEAM_ID`)
- **Android applicationId / namespace:** `com.lilypad.mobile`

## How releases trigger

Both workflows run on:

- **`workflow_dispatch`** — manually from the Actions tab, any branch.
- **Push of a `mobile-v*` tag** — e.g. `mobile-v0.1.0`. Mobile tags are
  intentionally separate from the desktop `v*` tags so the two release trains
  are decoupled.

```bash
git tag mobile-v0.1.0
git push origin mobile-v0.1.0
```

## Skip-cleanly behaviour (secrets deferred)

Both workflows are fully written but **skip cleanly** when signing secrets are
absent. A `preflight` step reads the required secrets into env and sets a
boolean output; every build/upload step is gated on it. With no secrets the job
ends **green** with a `skipped: mobile <platform> secrets not configured` log
line. The moment you add the secrets below, the next run builds and uploads
automatically — no workflow edits needed.

(GitHub does not allow `secrets.*` in a job-level `if:`, hence the preflight
step + step-level `if:` pattern.)

---

## iOS secrets

Auth to App Store Connect uses an **App Store Connect API key** (`.p8`) — no
Apple ID password or 2FA session required in CI.

| Secret                | Required | What it is                                                            |
| --------------------- | -------- | --------------------------------------------------------------------- |
| `ASC_KEY_ID`          | ✅       | The API key's Key ID (10 chars).                                      |
| `ASC_ISSUER_ID`       | ✅       | The Issuer ID (UUID) of your App Store Connect team.                  |
| `ASC_KEY_P8`          | ✅       | **base64** of the downloaded `AuthKey_XXXX.p8` file.                  |
| `APPLE_TEAM_ID`       | optional | Overrides the default team id `7TYFS43RR3`.                           |
| `IOS_APP_IDENTIFIER`  | optional | Overrides the default bundle id `com.kushsharma.lilypad`.             |
| `FASTLANE_APPLE_ID`   | optional | Apple ID email, only for username-based flows (not needed for beta).  |
| `MATCH_GIT_URL`       | optional | Git repo URL for [`match`](https://docs.fastlane.tools/actions/match/) certs/profiles. Set this to switch from Xcode-managed automatic signing to `match`. |
| `MATCH_PASSWORD`      | optional | Passphrase for the `match` encrypted repo (required if `MATCH_GIT_URL` is set). |

The three **required** secrets are what the preflight gate checks. Signing
defaults to **Xcode-managed automatic signing** (`-allowProvisioningUpdates`,
matching the checked-in project). Set `MATCH_GIT_URL`/`MATCH_PASSWORD` to use
`match`-managed manual signing instead.

### Obtaining / encoding the iOS key

1. App Store Connect → **Users and Access → Integrations → App Store Connect API**.
2. Create a key with the **App Manager** role. Copy the **Key ID** → `ASC_KEY_ID`
   and the **Issuer ID** (top of the page) → `ASC_ISSUER_ID`.
3. Download the `AuthKey_XXXXXXXXXX.p8` (downloadable **once**). Encode it:

   ```bash
   base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy   # macOS → clipboard
   # or: base64 -w0 AuthKey_XXXXXXXXXX.p8       # Linux, no line wrap
   ```

   Paste the result into the `ASC_KEY_P8` secret. CI decodes it back to
   `ios/fastlane/AuthKey.p8` at runtime.

---

## Android secrets

| Secret                        | Required | What it is                                                          |
| ----------------------------- | -------- | ------------------------------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`     | ✅       | **base64** of your release keystore (`.jks`/`.keystore`).           |
| `ANDROID_KEYSTORE_PASSWORD`   | ✅       | Keystore (store) password.                                          |
| `ANDROID_KEY_ALIAS`           | ✅       | Key alias inside the keystore.                                      |
| `ANDROID_KEY_PASSWORD`        | ✅       | Password for that key alias.                                        |
| `PLAY_SERVICE_ACCOUNT_JSON`   | ✅*      | Full JSON of a Google Play service account (raw JSON, not base64).  |
| `ANDROID_PACKAGE_NAME`        | optional | Overrides the default applicationId `com.lilypad.mobile`.           |

The four keystore secrets are what the preflight gate checks. `PLAY_SERVICE_ACCOUNT_JSON`
is required to actually **upload** — without it (*) the lane still builds a
signed AAB + APK and the APK is uploaded as a workflow artifact, but the Play
upload is skipped.

Signing is injected into Gradle at build time via the AGP
`android.injected.signing.*` properties, so the checked-in
`android/app/build.gradle` (which points release at the debug keystore) is left
untouched — CI overrides it per build.

### Generating / encoding the Android keystore

1. Create a release keystore (once, keep it safe — losing it means you cannot
   update the app):

   ```bash
   keytool -genkeypair -v -keystore lilypad-release.keystore \
     -alias lilypad -keyalg RSA -keysize 2048 -validity 10000
   ```

   The store password → `ANDROID_KEYSTORE_PASSWORD`, alias `lilypad` →
   `ANDROID_KEY_ALIAS`, key password → `ANDROID_KEY_PASSWORD`.

2. base64-encode it into the secret:

   ```bash
   base64 -i lilypad-release.keystore | pbcopy   # macOS
   # or: base64 -w0 lilypad-release.keystore      # Linux
   ```

   → `ANDROID_KEYSTORE_BASE64`.

### Play service account JSON

1. Google Play Console → **Setup → API access** (or Google Cloud IAM) → create a
   service account with the **Release apps to testing tracks** permission.
2. Create a JSON key, download it, and paste the **entire file contents** into
   `PLAY_SERVICE_ACCOUNT_JSON` (raw JSON — the workflow writes it to a file).
3. The very first upload to a brand-new package must sometimes be done manually
   in the Play Console before the API will accept uploads.

The lane uploads the AAB to the **internal** track with `release_status: draft`
by default (override via the `PLAY_RELEASE_STATUS` env if you want `completed`).

---

## Adding the secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**.
Add each secret by the exact name above (repo slug: `Kush402/lilypad`). No
workflow changes are needed afterwards — the preflight gates flip to active on
the next run.

---

## Auto-update story for mobile

Mobile updates ride the **native store channels**, not the desktop updater:

- **iOS:** builds uploaded here land in **TestFlight**. Testers get updates via
  the TestFlight app; production ships by promoting a build to the App Store.
- **Android:** the AAB is uploaded to the Play **internal** track. Internal
  testers update through the Play Store; promote through closed/open/production
  tracks for wider rollout. The APK artifact is for direct sideload only.

There is **no in-app JS OTA layer today**. Because this is a bare RN app, a
JS-only over-the-air update mechanism (e.g. Expo Updates / `expo-dev-client`, or
a self-hosted CodePush-style service) could be layered on later to ship JS
bundle changes without a store review — but that is **out of scope for now**.
Native code changes (anything touching `ios/` or `android/`, or dependency
bumps with native modules) will always require a full store build regardless.
