# Changelog

All notable changes to Lilypad are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Cellular-stability hardening on top of 1.0.0 driven by live-hardware findings
(2026-07-19 → 2026-07-20), plus the release-engineering pass that makes the
apps shippable and self-updating.

### Engineering process

- **Documentation is now enforced by CI** (`pnpm docs:check`). It fails the build
  on three specific drifts, each of which had already happened in this repo:
  a doc under `docs/` without `status`/`owner`/`last-verified` frontmatter, a
  broken relative link, or an HTTP route that exists in the backend but not in
  `docs/api.md` (or the reverse). Rules and the what-to-update-when table are in
  `CONTRIBUTING.md`.
- **Architecture Decision Records** (`docs/adr/`). ADR-0001..0005 record the
  decisions behind the consumer-product track: OAuth-with-no-passwords account
  auth, Ed25519 device identity, replacing same-account QR pairing with account
  ownership, scaling signaling via Redis pub/sub while keeping rooms in memory,
  and running TURN on dedicated regional VMs rather than Kubernetes.
- **Security scanning in CI**: CodeQL plus a dependency audit. The audit is
  reporting-only for now — the tree carries 19 high/critical advisories including
  backend runtime dependencies, and clearing them is a separate reviewed pass
  rather than a silent side effect of another milestone.
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
