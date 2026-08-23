---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-12
summary: Build, release, auto-update, and disk-reclaim procedures.
---

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

Verify a machine anytime with `pnpm env:check`.

## Off-LAN / cellular testing — the named tunnel

`lilypad.takedia.com` is a **permanent** hostname served by a named cloudflared
tunnel. Use it for anything that has to work off wifi. It is a _development_
hostname: production is the Oracle VM behind its own tunnel, deployed by
`.github/workflows/deploy.yml` and reachable at `https://api.takedia.com` —
**a tunnel is not a deployment.**

```bash
# 1. terminal one — the tunnel (config is versioned in the repo)
cloudflared tunnel --config infra/cloudflared/lilypad.yml run

# 2. terminal two — the backend, BUILT (see the warning below)
pnpm --filter @lilypad/backend build
pnpm --filter @lilypad/backend start

# 3. confirm the public path before touching a phone
curl -s https://lilypad.takedia.com/health
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://lilypad.takedia.com/ws/signal      # must print 101
```

`.env` pins `PUBLIC_BASE_URL`/`SIGNALING_URL` to that hostname, which is what
stops `config.ts` auto-detecting a `192.168.x.x` address no phone on cellular
can reach. Media relays through the configured public TURN (`PUBLIC_TURN_URL`),
since a Cloudflare tunnel carries HTTP and WebSockets only — never TURN's UDP.

Two traps worth knowing:

- **Always pass `--config`.** `~/.cloudflared/config.yml` belongs to a different
  tunnel on this machine and sets its own default `tunnel:`, which silently wins
  over the tunnel named on the command line — including for
  `cloudflared tunnel route dns`, where it will happily point your hostname at
  the wrong tunnel.
- **Port 8080 is contended** — `tokito.takedia.com` forwards there too. Do not
  run both backends at once.

**Quick tunnels (`TUNNEL=1`) — fallback only:** run the backend **built, not
watched** — a `tsx watch` restart mints a fresh Cloudflare quick-tunnel URL,
so the phone that paired seconds ago ends up signaling a dead host (pairs,
connects ~1s, then silence). Use the compiled server instead:

```bash
pnpm --filter @lilypad/backend build
pnpm --filter @lilypad/backend start        # node dist/index.js — no watch
```

`dev` (tsx watch) is fine on LAN, where the QR carries a stable
`192.168.x.x` address that survives restarts. It's specifically the _ephemeral
tunnel URL_ that a restart rotates. Running compiled also cuts the
recompile-restart-reconnect churn: one stable process, one stable URL, sessions
that stay up. (Quick tunnels are still ephemeral — for a URL that never
changes, use a named cloudflared tunnel or deploy the backend.)

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

### Orphaned dev servers

`pnpm dev` outlives the terminal that started it. Four of them were found
running on 2026-08-23, the oldest eight days old and still holding `:8080` —
and since `tsx watch` restarts on change, it had been rebuilding the backend on
every file edited that day. A stale server on the default port answers local
requests with whatever code it started with, which is a bad afternoon.

```bash
ps -Ao pid,ppid,lstart,command | awk '$2==1' | grep -E 'pnpm|vite|metro|tsx'
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(8080|8099|5173|1420|8081) '
```

### Docker Desktop's memory reservation

Docker Desktop reserves its VM's memory from the host whether containers use it
or not. Measured on 2026-08-23: `MemoryMiB: 6656` on an 8 GB Mac, to run three
containers using **56 MB** between them (redis 9, postgres 29, coturn 18).
macOS was left about 1.5 GB and had 15.6 GB of its 16 GB swap in use.

Settings → Resources → Memory. 3 GB is generous for this repo — the containers
need a fraction of it, and the headroom is for `docker build` of the backend
image, where `tsc` is the peak. Restart Docker Desktop for it to take effect;
`lilypad_pgdata` is a volume and survives.

Docker's build cache is not covered by `pnpm clean`, and it grows without
bound:

```bash
docker builder prune -f    # unused build cache only
docker system df           # what is actually held
```

### If the checkout lives in an iCloud-synced folder

`~/Desktop` and `~/Documents` are synced when iCloud Drive's "Desktop &
Documents" is on, and a Rust target directory is the worst possible thing to
put in one. Measured on 2026-08-23 in `~/Desktop/lilypad`: 34 GB of build
artifacts, `fileproviderd` at 67% CPU and `bird` at 33% doing nothing but
trying to sync object files that are regenerated on the next build.

`pnpm clean:cargo` reclaims it, but it grows back. To stop it recurring, put
the build output outside the synced tree:

```bash
export CARGO_TARGET_DIR=~/.cache/lilypad-target   # add to ~/.zshrc
```

Deliberately not committed to `.cargo/config.toml`: the path is per-machine,
and CI's `Swatinem/rust-cache` expects the default location. The same folder is
why iOS codesigning fails from `~/Desktop` — see `apps/mobile/README.md`.

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
`https://lilypadhome.takedia.com/download/latest.json`. On launch it checks
silently; a manual "Check for updates" affordance also exists in Diagnostics.

It used to poll `github.com/Kush402/lilypad/releases/latest/download/latest.json`.
That repository is **private**, so the manifest answered 404 to every installed
copy — updates could never ship, and the launch banner showed "Update check
failed" to anyone who opened the dashboard. The manifest and the archive it
names are served from the site instead; `latest.json` is rewritten at deploy
time to point at the site's own copy, and the minisign signatures still verify
because they cover the archive's bytes, not the address it came from. When a newer signed release is found, the app downloads, verifies
the signature, installs, and relaunches. An update only installs if its signature
matches the embedded public key — an unsigned or tampered artifact is rejected.

**Mobile:** updates arrive through the platform stores (TestFlight / App Store,
Google Play). No custom updater; a JS-only OTA layer (e.g. Expo Updates) is a
possible future addition, out of scope today.

---

## 5. Required GitHub secrets

**Desktop (needed now):**

| Secret                               | Purpose                                                          |
| ------------------------------------ | ---------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Updater signing private key (pairs with the embedded public key) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for that key (empty string if none)                     |
| `APPLE_CERTIFICATE`                  | Base64 of the Developer ID Application `.p12`                    |
| `APPLE_CERTIFICATE_PASSWORD`         | Password for the `.p12`                                          |
| `APPLE_SIGNING_IDENTITY`             | e.g. `Developer ID Application: Name (TEAMID)`                   |
| `APPLE_TEAM_ID`                      | Apple Developer Team ID                                          |
| `APPLE_API_KEY_P8`                   | Base64 of the App Store Connect API key `.p8` (notarization)     |
| `APPLE_API_ISSUER`                   | App Store Connect issuer ID                                      |
| `APPLE_API_KEY`                      | App Store Connect key ID                                         |

**Mobile (needed later):** see
[apps/mobile/docs/RELEASE.md](../apps/mobile/docs/RELEASE.md).

Secrets are added under **repo → Settings → Secrets and variables → Actions**.
Nothing sensitive is ever committed.
