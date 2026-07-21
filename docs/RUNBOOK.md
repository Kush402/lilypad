# Lilypad Runbook — build, release, update, reclaim

This is the operational companion to the [README](../README.md). It covers the
full lifecycle: taking a **fresh clone** to a running app, cutting **signed
releases**, how **automatic updates** reach installed apps, and how to **reclaim
disk** and later rebuild from scratch.

---

## 1. Fresh clone → running

Everything needed to rebuild is committed (source, all lockfiles —
`pnpm-lock.yaml`, `Cargo.lock`, `Podfile.lock`, the Gradle wrapper). Heavy,
regenerable artifacts (`node_modules/`, Rust `target/`, iOS `Pods/`, Android
`build/`, Tauri `gen/`) are git-ignored and rebuilt on demand.

```bash
git clone https://github.com/Kush402/lilypad.git
cd lilypad
corepack enable          # pins pnpm from package.json#packageManager
pnpm bootstrap           # verifies Node/Rust, installs deps, seeds .env,
                         # starts infra, migrates, verifies the build
```

`pnpm bootstrap` is idempotent and self-heals the common blockers (rustup PATH
invisible to zsh; missing `.env` — seeded from `.env.example`). If Docker isn't
installed it skips infra with a warning rather than failing.

**Launch:**

```bash
pnpm --filter @lilypad/backend dev                 # signaling + REST
pnpm --filter @lilypad/desktop tauri dev           # desktop bubble
cd apps/mobile && pnpm pods && pnpm ios            # mobile (needs full Xcode)
```

Verify a machine anytime with `pnpm doctor`.

---

## 2. Reclaim disk, then rebuild later

The scaffolding (deps + build output) is large and fully regenerable. To free
space after installing the apps:

```bash
pnpm clean:all      # removes node_modules, target/, Pods/, build dirs, caches
                    # (preserves source, config, migrations, lockfiles, .env)
```

Targeted variants: `pnpm clean:build`, `pnpm clean:cargo`, `pnpm clean:mobile`,
`pnpm clean:deps`.

To resume development on the same or a new machine, just re-run the **section 1**
steps. Because the lockfiles are committed, the rebuilt dependency tree is
byte-for-byte the versions the release was cut from.

---

## 3. Cutting a release

Versions are kept in sync by `pnpm release` (`scripts/release.mjs`), which bumps
`apps/desktop/src-tauri/tauri.conf.json`, its `Cargo.toml`, and
`apps/desktop/package.json` together.

### Desktop (macOS)

```bash
pnpm release <new-version>     # e.g. 0.2.0 — bumps the three files in sync
git commit -am "chore(release): v0.2.0"
git tag v0.2.0
git push && git push --tags
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`:

1. builds the app on `macos-latest`,
2. **signs** it with the Developer ID cert and **notarizes + staples** via the
   App Store Connect API key,
3. produces the `.dmg` plus the updater artifact (`.app.tar.gz` + `.sig`),
4. publishes a GitHub Release and uploads `latest.json` (the update feed).

Can also be run manually via **workflow_dispatch**.

### Mobile

Mobile releases are decoupled — tag `mobile-v*` to trigger
`.github/workflows/mobile-ios.yml` and `mobile-android.yml`. These build via
fastlane and ship to **TestFlight** / **Play internal**. See
[apps/mobile/docs/RELEASE.md](../apps/mobile/docs/RELEASE.md) for the mobile
secrets and setup. Until those secrets are configured the workflows **skip
cleanly** (green, with a "not configured" log line) rather than failing.

---

## 4. How automatic updates work

**Desktop:** the app embeds the updater's public key and polls
`https://github.com/Kush402/lilypad/releases/latest/download/latest.json`. On
launch it checks silently; a manual "Check for updates" affordance also exists
in Diagnostics. When a newer signed release is found, the app downloads, verifies
the signature, installs, and relaunches. An update only installs if its signature
matches the embedded public key — an unsigned or tampered artifact is rejected.

**Mobile:** updates arrive through the platform stores (TestFlight / App Store,
Google Play). No custom updater; a JS-only OTA layer (e.g. Expo Updates) is a
possible future addition, out of scope today.

---

## 5. Required GitHub secrets

**Desktop (needed now):**

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Updater signing private key (pairs with the embedded public key) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for that key (empty string if none) |
| `APPLE_CERTIFICATE` | Base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_API_KEY_P8` | Base64 of the App Store Connect API key `.p8` (notarization) |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_API_KEY` | App Store Connect key ID |

**Mobile (needed later):** see
[apps/mobile/docs/RELEASE.md](../apps/mobile/docs/RELEASE.md).

Secrets are added under **repo → Settings → Secrets and variables → Actions**.
Nothing sensitive is ever committed.
