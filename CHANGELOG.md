# Changelog

All notable changes to Lilypad are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### P1 — the account layer is connected on both ends

Closes PROD-1. A user could previously install Lilypad, grant permissions and
pair a phone without ever having an account: the desktop had no enrollment UI,
`SignInScreen.tsx` had no route, and `approveDesktopEnrollment()`'s only caller
was a test.

- **Desktop "This computer" panel.** Shows `Not linked` until a phone has
  actually approved this machine, mints an enrollment QR, and polls for the
  approval — which happens on the phone, so there is nothing local to react to.
  It distinguishes `unknown` (backend unreachable) from `not linked`: telling a
  linked user their computer is not linked because the wifi dropped would invite
  them to redo a ceremony they had already completed.
- **One camera, two codes.** The phone's scanner now classifies a **pair** code
  and a **link** code and confirms them in deliberately different words —
  "Pair with…" versus "Add … to your account?". Pairing starts one session;
  linking hands a computer to an account permanently, and presenting them
  identically would be the product's most consequential ambiguity.
- Linking stores the one-time connect secret, so a linked computer is
  **reachable**, not merely owned — and it does **not** start a session, because
  owning a computer and choosing to control it are separate acts.
- **`POST /devices/enrollment-code` now returns `apiBaseUrl`.** The QR schema
  already required it and the desktop had no way to obtain it; a laptop talking
  to `http://localhost:8080` cannot ask a phone to reach that. It comes from the
  same `advertisedUrls()` seam `/pairing/create` uses.
- **Sign-in is reached from the act that needs it.** Verified in the repo: the
  phone ships no default backend address, so "sign in, then find your computer"
  cannot exist. Scanning a link code without an account routes to sign-in at the
  address that code named, and returns to the still-mounted card to finish.
- `SignInScreen`'s subtitle promised "your laptops appear here once you sign in
  on both devices" — the ADR-0003 behaviour ADR-0010 reversed. Corrected.

### Roadmap — a separate product completion track (P1–P6)

The consumer-product plan and the platform milestones had begun claiming the
same numbers for different work: `milestones.md` had M10 as desktop security
hardening while the product plan had M10 as the auth UI. Rather than renumber
either, the product work now runs as **P1–P6** on its own axis.

- **P1** account-connected clients · **P2** device management · **P3** design
  system · **P4** `lilypad.takedia.com` · **P5** Ask productisation ·
  **P6** entitlements (blocked on pricing).
- **Nothing was deleted or renumbered.** M14 (Consumer UX) and M18's Ask half
  are marked superseded in place and say which P-milestone took them; M13 keeps
  DNS, TLS and hosting, and P4 is only the site's content and build.
- New gap **PROD-1** records what P1 closes: the account layer is built on both
  ends and connected on neither, so a user can install Lilypad, grant
  permissions and pair a phone without ever having an account.
- Pricing stays `$XXXX`. The repository contains three tier names and two
  principles — LAN is never paywalled, only relay minutes and managed AI are
  metered — and no price point, quota or allowance anywhere. That is a product
  decision, recorded as an open one rather than guessed.

### Security — ownership authorization on every route (M9, SEC-3/4/7)

Knowing a device id, a pair id, or a room id is no longer worth anything.
See [ADR-0010](docs/adr/0010-explicit-device-linking.md).

- **One rule, two questions** (`auth/authorize.ts`, pure and DB-free). _Acting
  as_ a device — `/pairing/create`, `/pairing/redeem`, `/connect/request`,
  `/devices/unpair`, presence `register` — requires **that device's own
  token**; owning it is not enough, or one compromised device could impersonate
  every sibling. _Managing_ a device or pair — the three `/devices/pairs`
  routes — requires **owning** it, which is what will let a phone manage its
  laptop's pairs.
- **Presence rooms need a token now (SEC-4).** `presence:<deviceId>` was
  authorized by a suffix match alone, so knowing a laptop's device id was
  enough to take its presence seat — evicting the real machine as a
  "same-device reconnect" and receiving every ring meant for it. The claim must
  now be backed by a device token on the WebSocket upgrade. Session rooms are
  unchanged: they were already bound to a server-minted room record.
- **Denials answer 404, never 403**, so "not yours" cannot be told apart from
  "does not exist". A present-but-invalid token is still a 401 — silently
  downgrading an expired token to anonymous would tell a client its device had
  vanished when its session had merely lapsed.
- **Both clients send a device token whenever they can mint one.** The desktop
  attaches one to all four backend calls and to its presence socket; the phone
  attaches one to redeem, connect and unpair. Neither treats its absence as an
  error — a computer no account owns has nothing to prove, and pairing one
  works exactly as before.
- **The gate keys on the resource, not the route.** A device row with no owner
  keeps its pre-accounts behaviour, so nothing breaks for existing installs
  while the sign-in UI is still P1. Both halves meet per-device with no flag
  day; when enrolment becomes mandatory the unowned branch is deleted.
- **SEC-7 is answered by tests, not by assertion:** a table of every actor Bob
  can be against every resource Alice owns on every gated route
  (`auth/authorize.test.ts`), plus a per-route wiring suite that catches the
  failure a rule test cannot — a route that simply forgot its `preHandler`
  (`routes/authorization.test.ts`).
- The phone now memoizes "this device has no account" so pairing does not pay
  for a challenge and a rejection on every scan.
- **Pre-secret trust pairs are refused (SEC-5).** A pair with no
  `connect_secret_hash` predates per-pair secrets and used to be admitted with
  no secret whatsoever, so knowing two device ids was enough to ring a
  laptop — on exactly the pairs whose owners never had a chance to opt in.
  Migration `0005` revokes them (revoked, not deleted, so the row stays an
  audit trail) and `authorizeConnect` refuses a null hash outright. Verified
  against a live Postgres: one seeded legacy row revoked, two secret-bearing
  pairs untouched. Affected phones re-pair once with a QR, which issues a
  secret and un-revokes the row.

### Deployment — control plane artifacts (not yet deployed)

- **Production image.** `apps/backend/Dockerfile`, multi-stage, non-root,
  `linux/amd64` + `linux/arm64` (the $0 tier is ARM, the paid tier is x86).
  Verified locally: boots under real production configuration and reports
  `{"status":"ok","checks":{"postgres":"up","redis":"up"}}`.
- **Production stack.** `infra/production/docker-compose.yml` — backend,
  Postgres, Redis and a Cloudflare tunnel on one VM. Nothing is published to
  the host; cloudflared dials outward, so the VM opens **no inbound ports**.
- **Deploy pipeline.** `.github/workflows/deploy.yml`: gate (test, typecheck,
  lint, build, docs, format, audit) → multi-arch image → migrate → deploy →
  health-check → automatic rollback on failure.
- **Documentation.** [`docs/deployment.md`](docs/deployment.md) and
  [ADR-0009](docs/adr/0009-control-plane-deployment.md) record the staged
  $0 → ~€9/mo → scale path, a cost model from 0 to 100,000 users, and recovery
  procedures. Egress pricing is the deciding factor: 1 TB of TURN relay is €0
  on Hetzner, $20 on Fly, ~$90 on AWS.
- **Verified security posture** on the image: the production guard refuses dev
  defaults, short secrets, a passwordless Redis and non-HTTPS public URLs;
  `/metrics` answers 401 without a bearer token; CORS fails closed.
- **Not deployed.** No VM, no `api.takedia.com`, no TURN host. Route
  authorization (SEC-3) has since landed — see the security entry above.

Cellular-stability hardening on top of 1.0.0 driven by live-hardware findings
(2026-07-19 → 2026-07-20), plus the release-engineering pass that makes the
apps shippable and self-updating.

### Architecture — LAN-first, cloud as control plane only

Two hard requirements were adopted and the architecture and roadmap revised
around them: **a LAN session must work with no internet at all**, and **cloud
spend must be minimized aggressively**.

- **Audit finding that changed the plan.** The media path is already LAN-direct
  (host ICE candidates win on-LAN), but the _control_ path is not: a session
  cannot start without the backend. It works offline today only because the
  backend runs on the laptop — a development artifact, not a designed
  capability. There is **no LAN discovery of any kind** in the codebase. Most
  importantly, the previous roadmap's plan to move signaling to
  `signal.takedia.com` **would have regressed LAN capability**, making every
  same-room session depend on the public internet.
- **New milestone M9.5 — LAN-direct connectivity**, sequenced _before_ the cloud
  deployment milestone so the cloud is added beside a working local path rather
  than in front of it. The desktop gains an embedded signaling server (TLS bound
  to its Ed25519 identity, pinned at pairing), and discovery is a cached
  last-known address first, then native mDNS — no new wire protocol and no iOS
  multicast entitlement. Release-blocking DoD: an automated cloud-unreachable
  scenario proving discovery, video, input, and clipboard all work with **zero
  cloud requests**.
- **New docs:** [NETWORKING.md](docs/NETWORKING.md) (connection algorithm,
  discovery decision, failure modes, privacy boundary),
  [INFRASTRUCTURE-COST-MODEL.md](docs/INFRASTRUCTURE-COST-MODEL.md) (cost drivers
  and per-scale estimates), [REUSE-INVENTORY.md](docs/REUSE-INVENTORY.md)
  (build-vs-buy with costs at 1K/10K/100K users).
- **New ADRs:** [ADR-0006](docs/adr/0006-lan-first-connectivity.md) (the laptop
  is its own control plane) and
  [ADR-0007](docs/adr/0007-cloud-is-control-plane-only.md) (the cloud never
  carries the data plane).
- **M13 revised for cost.** Self-hosted coturn on bandwidth-inclusive VPS is
  roughly **1000× cheaper** than managed TURN at scale (~€36/mo vs ~$59,000/mo of
  relay at 100k users) — the difference between a sustainable free tier and none.
  Phase 1 targets a footprint under €30/month with no Redis, no Kubernetes, and
  no managed observability.

### Fixed — desktop crash

- **`NSPasteboard` data race that killed the app mid-session.** The clipboard
  watcher polls the OS clipboard every 750ms on the session tick, while the
  `InputWorker` writes it whenever the phone pastes — two threads, neither the
  main one, both constructing their own `arboard::Clipboard`. `NSPasteboard` is
  not thread-safe: concurrent access corrupted AppKit's internal type cache and
  aborted the process inside `-[NSPasteboard _updateTypeCacheIfNeeded]`. It
  reproduced as a SIGSEGV in roughly **one run in three** of the
  `session_connect_lifecycle` integration test, which drives exactly that pair
  of threads, and would have crashed the desktop app whenever a real poll raced
  a real paste.

  All clipboard access now funnels through a new `clipboard` module that owns a
  process-wide lock and exposes `read_text`/`write_text` **rather than the lock**
  — handing callers a mutex they must remember to take would leave the same bug
  one forgotten line away. `arboard` is referenced nowhere else in the crate;
  that is the invariant to preserve. New regression test
  `tests/clipboard_race.rs` hammers both paths concurrently, and was verified to
  kill the process when the lock is neutered. The previously-flaky binary now
  passes 12/12.

### Security — dependencies

- **Cleared every high and critical dependency advisory** (19 findings) and made
  the CI audit **blocking**. Direct bumps: `drizzle-orm` 0.38.4 → 0.45.2 and
  `fastify` 5.2 → 5.11.3 (both backend **runtime**), `vitest` 2.1.9 → 3.2.7
  (clears a critical), `vite` 6.0.7 → 6.4.3, `drizzle-kit` 0.30 → 0.31.10.
  Transitives that their parents already permit — `find-my-way`, `fast-uri`,
  `postcss`, `nanoid`, `js-yaml`, `brace-expansion`, `esbuild`,
  `fast-xml-parser` — are pinned via `pnpm.overrides` rather than waiting on a
  parent re-release. Versions were chosen as the **minimum that clears the
  advisory within the existing major**, not "latest", to keep the change
  reviewable. All 537 JS/TS tests, typecheck, lint, build, and format pass
  unchanged.
- Two `image-size` advisories (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq) are
  explicitly ignored with the reasoning recorded in `ci.yml`: no patched release
  exists, and it reaches us only through React Native's bundler at build time.

### Engineering process

- **Documentation is now enforced by CI** (`pnpm docs:check`). It fails the build
  on three specific drifts, each of which had already happened in this repo:
  a doc under `docs/` without `status`/`owner`/`last-verified` frontmatter, a
  broken relative link, or an HTTP route that exists in the backend but not in
  `docs/api.md` (or the reverse). Rules and the what-to-update-when table are in
  `CONTRIBUTING.md`.
- **Architecture Decision Records** (`docs/adr/`). ADR-0001..0007 record the
  decisions behind the consumer-product track: OAuth-with-no-passwords account
  auth, Ed25519 device identity, replacing same-account QR pairing with account
  ownership, scaling signaling via Redis pub/sub while keeping rooms in memory,
  running TURN on dedicated regional VMs rather than Kubernetes, LAN-first
  connectivity, and the cloud as a control plane only.
- **Security scanning in CI**: CodeQL plus a dependency audit (now blocking —
  see "Security — dependencies" above).
- `docs/PROJECT-INDEX.md` gained a verified gap register (`SEC-*`, `OPS-*`,
  `NET-*`, `OBS-*`, `DEP-*`) and a roadmap position, and `docs/milestones.md`
  gained the M7–M18 consumer-product track.

### Distribution & CI/CD

- **Desktop auto-update**: the Tauri v2 updater plugin checks a signed
  `latest.json` published to GitHub Releases (minisign pubkey pinned in
  `tauri.conf.json`). The client lifecycle is one explicit state machine
  (`useUpdater.ts`: idle → checking → available → downloading → ready →
  relaunch), surfaced as a "check now" panel in Diagnostics.
- **Signed + notarized macOS release pipeline** (`.github/workflows/release.yml`):
  pushing a `v*` tag builds a universal (aarch64 + x86_64) `.app`/`.dmg`,
  Developer-ID signs, notarizes, staples, and publishes the GitHub Release with
  the updater artifacts. `pnpm release` cuts the tag.
- **Mobile CI/CD**: `mobile-ios.yml` (fastlane → TestFlight) and
  `mobile-android.yml` (fastlane → Play internal track + APK artifact).
  `Gemfile.lock` is committed multi-platform so fastlane resolves identically
  on a developer Mac and on CI Linux.
- **CI** (`ci.yml`): TypeScript (lint + typecheck + test) and Rust (fmt +
  clippy + test) jobs, plus nightly and weekly soak runs. Two flaky media tests
  were made deterministic (an unmocked promise, and a one-frame
  recovery-keyframe race in the drop test) rather than retried.
- **Reproducible fresh clone**: `pnpm bootstrap` now seeds `.env` from
  `.env.example`, and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) documents the full
  lifecycle — fresh clone → running, cutting releases, how updates reach
  installed apps, and reclaiming disk.

### Desktop

- Single-instance guard (`flock`-based advisory lock): the launch-at-login
  LaunchAgent and a manual/dev launch could previously both register the same
  presence room and fight over it, producing a phone-visible ~1 Hz
  "reconnecting" churn. The second instance now exits quietly at startup.
- Tray gains an "Open Dashboard" entry; `show_qr` is now also disabled while
  a session is `Connecting`, not just `Active`.
- Traffic-liveness window widened 22s → 34s: a live cellular capture showed
  the phone's RTCP/REMB return path go silent for ~30s while forward video
  kept flowing — the old window tripped an unnecessary ICE restart on a
  stream that never actually stopped.
- ABR and session-runner resilience refinements from the same cellular
  capture session.

### Backend

- Self-hosted TURN relay support (`infra/coturn-prod/`): coturn behind
  `use-auth-secret`, sharing `TURN_SECRET` with the backend so
  `PUBLIC_TURN_URL` can be advertised with HMAC-derived credentials instead
  of only static ones — fixes the free-tier `metered.ca` relay collapsing
  under a sustained 1–3 Mbps desktop stream. `FORCE_RELAY` forces
  `iceTransportPolicy: relay` once the dedicated relay is deployed.
- `quickTunnel` (dev `TUNNEL=1` cloudflared wrapper) now health-probes its
  own HTTPS origin every 15s and force-restarts after 8 consecutive failures
  (~2 min), catching a "zombie" tunnel (process alive, edge connection dead)
  that previously required a manual restart. Also reaps a cloudflared
  orphaned by a hard-killed (`kill -9`) backend before its first launch.
- `SignalingHub` construction extracted into `createSignalingHubBundle`
  (`signaling/hubBundle.ts`) so `signalingRoutes` and `deviceRoutes` share
  one hub instance instead of risking a second, divergent one.

## [1.0.0] — 2026-07-18

First feature-complete release. The full remote-control loop is verified
end-to-end on real hardware (iPhone ↔ MacBook): pairing, approval, live
streaming, input, clipboard, reconnect.

### Desktop (macOS · Tauri v2 + Rust)

- Floating always-on-top pairing bubble, tray menu (QR, approve/deny,
  disconnect, panic, diagnostics), QR overlay with expiry countdown.
- Real screen capture via **ScreenCaptureKit** at the display's native aspect
  ratio, with change-driven delivery, static-screen keepalive frames, and
  bounded automatic restart when the OS stops the stream.
- Hardware H.264 encoding via **VideoToolbox** (openh264 software fallback),
  low-latency configuration: no B-frames, ~1s GOP, shallow two-frame send
  queue, drop-oldest + forced-IDR overload recovery.
- Loss-based adaptive bitrate (AIMD + REMB cap) between 1–10 Mbps with a
  quality floor that survives conservative initial receiver estimates.
- RTP timestamps track real capture spacing, keeping the receiver's jitter
  buffer aligned with wall time on change-driven capture.
- Input injection via CGEvent: pointer, wheel, keys, shortcuts, text (IME
  paste-through), double/triple-click via `clickState`, all gated per-session
  scope at the injection boundary with full drop accounting.
- Two capture modes switchable mid-session: **Motion** (30 fps, 1920-long-edge
  cap) and **Text** (15 fps, 2560 cap) for reading-heavy work.
- Clipboard sync desktop → phone with change detection.
- First-run permission wizard (Screen Recording + Accessibility) with live
  status, deep links into System Settings, and one-click relaunch.
- Display-sleep prevention (IOPM assertion) held for the lifetime of a session.
- Session state machine with reconnect grace, ICE-restart budget, and panic
  disconnect.

### Mobile (iOS · bare React Native)

- QR scanner → pairing → live viewer with connection-quality HUD
  (RTT/bitrate/fps) and state-specific placeholders (waiting, denied,
  recovering, failed).
- Full touch model: tap/double-tap/triple-tap clicks, settle-window drags,
  long-press right-click, two-finger scroll, pinch-zoom viewport (up to 6×)
  with pan, zoom-lock mode, and two-finger double-tap reset — transforms
  applied atomically for gesture smoothness.
- Landscape full-bleed mode with collapsible control tray.
- Hidden-TextInput keyboard bridge preserving iOS autocorrect/IME, with a
  native accessory "Done" bar (the keyboard covers the on-screen toggle).
- Sticky modifier chips (⌘⇧⌥⌃), shortcut toolbar with press-and-hold repeat,
  Motion/Text/Zoom toggles, two-tap disconnect confirm.
- Keep-awake during sessions; app-lifecycle-aware signaling pause/resume and
  automatic reconnect with ICE restart on network change.

### Backend (Node · Fastify)

- Single-use QR pairing tokens (60s TTL, Redis) with per-IP rate limiting.
- Room-scoped WebSocket signaling with heartbeat reaping, per-IP connection
  caps, per-socket token-bucket rate limiting, same-host origin enforcement,
  and mid-session seat-holding with a reconnect grace window.
- Per-session, per-role time-limited TURN credentials (coturn shared-secret
  HMAC) — the master secret never leaves the server.
- Boot-time LAN-IP auto-detection for QR URLs in development; strict
  https/wss/pinned-URL enforcement for production boots.
- Postgres (Drizzle) schema for users/devices/sessions/audit logs; security
  events (pairing, approval, denial, panic) audit-logged.
- `/health` (Postgres + Redis liveness) and bearer-gated `/metrics`.

### Protocol

- Shared zod schemas (`@lilypad/protocol`) for the QR payload, every
  signaling message, and the full input-event vocabulary — mirrored by serde
  types in Rust with a drift test pinning the two.
- All string fields length-bounded; input batches size-bounded; monotonic
  sequence ordering with stale-event rejection.

[1.0.0]: https://github.com/lilypad/lilypad/releases/tag/v1.0.0
