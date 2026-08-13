---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-12
summary: Milestone status, past and current.
---

# Lilypad — Milestone Plan

Internet-first is proven early: signaling + WebRTC over STUN/TURN lands in M2,
before real capture. Each milestone is independently demoable.

## M0 — Design docs ✅

Architecture + technical design + DB schema + API + protocols + plugin interface

- threat model + this plan. (This `docs/` folder.)

## M1 — Scaffold + pairing skeleton ✅

- Monorepo (pnpm + Turborepo), shared `protocol`/`shared` packages.
- Docker Compose: Postgres, Redis, coturn.
- Backend `GET /health` + Redis **QR session service** (`/pairing/create` +
  `/pairing/redeem`, single-use 60s tokens) + Drizzle schema/migrations.
- Desktop shell: floating **bubble** + **tray** + **QR overlay** + approve/deny
  control window + **plugin host** (8 plugins, per-OS backends stubbed).
- Mobile: bare RN app with a working **QR scanner** that parses the payload via
  the shared schema and redeems the token.

**Demo:** click bubble → QR appears from a real backend token → scan on phone →
token redeems (single-use, 60s expiry) → approve/deny UI is drivable.

## M2 — Signaling + WebRTC ✅ (headless-verified)

- ✅ **Backend:** real room-routed signaling, session state machine, time-limited
  TURN credentials. Zod-validated, unit-tested, smoke-tested over live WebSockets.
- ✅ **Desktop peer (webrtc-rs):** signaling client + PeerConnection + input
  DataChannel + H.264 track; drives register→approve→offer→answer→ICE. Verified
  end-to-end (real SDP offer + trickled ICE over the live server).
- ✅ **Mobile viewer (react-native-webrtc):** answer-side connection, RTCView
  render, input DataChannel bridge — written + typechecked. Running it needs a
  device + native build tooling (see blocker below).

## M3 — Real capture + encode ✅ ScreenCaptureKit + VideoToolbox real

- ✅ **Media pipeline** (`src/media/`): CaptureBackend → BGRA→I420 convert →
  H.264 encoder → bounded queue (drop/backpressure) → WebRTC track, with metrics
  - structured logging. **Verified end-to-end: 13 real H.264 RTP packets received
    over an actual WebRTC connection** by a second peer (all-Rust, headless).
- ✅ **Software encoder (openh264):** real low-latency H.264 (no B-frames, short
  GOP, adaptive bitrate, auto re-init on resolution change) — the default.
- ✅ **ScreenCaptureKit capture (real)**: `SCStream` over the main display →
  `CVPixelBuffer` (BGRA, stride-correct) → shared latest-frame slot → pipeline.
  Gated on Screen Recording via `CGPreflightScreenCaptureAccess` (cached, same
  fix as Accessibility). **Live sessions default to this** (`session.rs`); a
  missing grant surfaces a clear `SessionEvent::Error` — never a silent fake
  screen. `LILYPAD_CAPTURE_KIND=synthetic` stays available as a dev override.
  **Verified two ways:** unit/integration tests, and a full live session
  through real signaling + real WebRTC negotiation to `Connected`, observing
  the exact permission error on this machine, then re-run with the synthetic
  override to confirm zero regression.
- ✅ **VideoToolbox hardware encoder (real)**: `CompressionSession` configured
  low-latency (`real_time`, `allow_frame_reordering=false` → no B-frames,
  `max_keyframe_interval` → short GOP, `average_bit_rate`). Feeds captured BGRA
  directly via `IOSurface` (matches the crate's own pattern — skips the
  BGRA→I420 conversion the software path needs; `VideoEncoder::encode()` now
  takes the raw `RawFrame` so each backend picks its own native input).
  VideoToolbox's native AVCC output is converted to Annex-B (keyframe detected
  from the NAL type) for the WebRTC H.264 packetizer. Needs **no OS
  permission**, so it's the live-session default on macOS
  (`session_encoder_kind()`) with `LILYPAD_ENCODER_KIND=software` as an
  explicit override; `PipelineConfig::default()` stays Software for the
  crate's own tests. **Verified**: a real-hardware unit test (keyframe + delta
  frame), and a live end-to-end run through real signaling + real WebRTC
  negotiation — **2,650 real RTP video packets received continuously over
  ~13s**, proving the hardware encode → AVCC→Annex-B conversion → RTP
  packetization chain is correct (a conversion bug would break the packetizer
  immediately, not sustain thousands of clean packets).
- ✅ **End-to-end latency pass** (post-VideoToolbox): the pipeline now measures
  true frame age (capture instant → sample queued) as `avg/max_latency_ms` in
  the metrics. Fixes applied, each verified by test + benchmark:
  - **Capture-driven pacing**: push sources (ScreenCaptureKit) report
    `provides_pacing()` and the pipeline skips its own sleep — previously a
    fresh frame could age up to a full frame interval (~33ms at 30fps) in the
    latest-frame slot while the loop slept.
  - **Shallow sample queue**: 30 frames (~1s of viewer latency when the network
    lags) → 4 frames (~133ms cap). On overflow the pipeline drops the frame
    **and forces an immediate recovery IDR** so the stream un-smears on the
    next frame instead of waiting ~1s for the periodic keyframe
    (integration-tested).
  - **VideoToolbox double-buffered IOSurfaces**: was one kernel allocation per
    frame; a single reused surface stalls (the encoder can still hold frame
    N's surface while frame N+1 is written), so two surfaces alternate.
    Measured: p95 encode 12.6ms → ~10.4ms, max 28ms → ~19–25ms; avg unchanged
    (hardware-bound ~6.4ms).
  - **SCK frame copy**: no per-frame zero-fill; reuses the allocation of a
    frame the consumer never picked up (drop-oldest path) instead of
    allocating ~4MB/frame.
  - **Measured** (`examples/bench_pipeline.rs`, release, 720p30 synthetic +
    VideoToolbox, 10s): **avg 8.4ms capture→queued**, 0 drops, 296/296 samples
    delivered. `examples/bench_encode.rs` benchmarks the encoders in isolation
    (software avg ~14–16ms/frame, VideoToolbox avg ~6.4ms/frame at 720p30).
    Live re-verified over real signaling + WebRTC: 448 RTP packets over ~15s.
- ✅ **Adaptive bitrate + viewer-driven keyframes (RTCP feedback loop)**: the
  video sender's RTCP — previously read and discarded — is now parsed
  (`crate::rtc`): receiver-report loss and REMB feed a pure, unit-tested AIMD
  controller (`media/abr.rs`: loss >10% → ×0.7 back-off; ≤2% → ×1.05 probe
  every 2s; REMB caps at 95%), and PLI/FIR force an immediate IDR. The session
  applies decisions through `MediaPipeline::control()`
  (`set_target_bitrate` / `request_keyframe`), applied between frames.
  **Live-verified**: on a clean link the bitrate probed 2500→3347 kbps in
  exact 2s steps (6 retargets logged); a real PLI sent mid-stream by the
  mobile peer produced "viewer requested keyframe — forcing IDR" on the
  desktop within the same second; 4,240 RTP packets, 0 drops. 6 controller
  unit tests cover back-off, hold, rate-limited probing, floor/ceiling, REMB
  capping, and probe-timer reset.
- ✅ **Reconnection + failure recovery** (session runner):
  - **Signaling reconnect**: a dropped signaling WebSocket mid-session no
    longer kills a healthy stream — media flows peer-to-peer regardless, and
    the runner reconnects with exponential backoff (500ms→8s, 5 attempts,
    unit-tested) and re-registers. **Chaos-tested live**: backend killed
    mid-stream → 4 failed reconnect attempts at exact backoff spacing →
    backend restarted → `SignalingReconnected` — with the mobile peer
    receiving RTP continuously through the entire outage (2,711 packets,
    1,734 frames, 0 drops).
  - **ICE restart**: a `failed` peer connection triggers a bounded (2×)
    ICE-restart re-offer (`WebRtcPeer::restart_ice`, `ice_restart: true`)
    for network-path changes; exercised live (restart fired and re-offered
    when the peer vanished).
  - **No zombie sessions**: previously a dead peer left the session running
    forever. Now `failed`+restarts-exhausted, `closed`, and a 20s
    recovery-deadline (checked on the heartbeat tick) all end the session
    with a clear reason. **Live-verified**: mobile vanished → ICE restart
    fired → stuck in `new` → session ended "connection did not recover in
    time" at the deadline.
  - **Backend re-register grace** (`signaling/hub.ts`): a mid-session
    transport drop no longer tears the room down instantly — the seat is
    held 15s (configurable) for the _same deviceId_ to re-register (a
    different device is rejected with `seat_reserved`, so the grace window
    is not a seat-hijack window). Deliberate `disconnect` messages still end
    immediately; expiry is checked by the existing reaper. `endRoom` now
    sends `session-end { reason }` to surviving peers _before_ closing their
    socket, so clients can distinguish "session over" from a network fault.
    4 new hub unit tests (hold+reclaim, hijack-reject, grace expiry with
    session-end, pre-session immediate close); grace path also observed live.
- 🔜 Windows Media Foundation hardware encoder — stub, pending a Windows machine.

### Build environment notes (real blockers hit + fixed, macOS)

- Command Line Tools shipped an SDK too old for a transitive Swift dependency
  (`apple-metal`, macOS 26 Metal APIs) — fixed via `softwareupdate --install
"Command Line Tools for Xcode 26.6-26.6"` (no Xcode.app / Apple ID needed,
  unlike the iOS SDK gap noted for mobile).
- Deployment-target / linker-search-path mismatches between Rust's default and
  the Swift bridge's actual minimum — fixed via
  [`apps/desktop/src-tauri/.cargo/config.toml`](../apps/desktop/src-tauri/.cargo/config.toml).
- Known benign linker warning: `screencapturekit` and `apple-cf` (same author)
  both bundle an identical `CoreMediaBridge` Swift module, producing duplicate-
  symbol warnings the linker resolves without affecting behavior (all 42 tests
  pass). Upstream packaging quirk, not fixable from this repo.

## M4 — Input injection ✅ macOS real, Windows compile-complete

- ✅ **Desktop pipeline**: DataChannel bytes → decode → `InputDispatcher`
  (OS-agnostic gating/dedup/held-state, unit-tested behind a mock) →
  `InputBackend` → OS. Real **CGEvent** injection on macOS (mouse incl. drag,
  scroll, keyboard + modifiers, Unicode text, dev shortcuts, clipboard via
  `arboard`), gated on Accessibility permission with actionable errors on a
  missing grant. SendInput path is compile-complete, isolated behind the same
  trait, pending a Windows machine to verify.
- ✅ **Mobile trackpad/direct-touch modes** shipped in the M2 mobile-viewer pass.
- ✅ Verified: 39 Rust tests total (incl. an integration suite hitting the real
  worker thread + channel with the exact mobile wire format), a live
  `AXIsProcessTrusted()` check on this machine (correctly reports NotGranted
  and rejects injection with an actionable message — proves graceful handling,
  not a bug), and a measured **~15.8 µs/event** dispatch latency after fixing
  a real perf issue found by benchmarking (the permission check is an XPC
  round-trip to `tccd`; now cached with a 500ms TTL).

## M5 — Auth + trusted devices (in progress)

### M5.3 — Ask AI operator ✅

On-device tiered agent (P1 skills → P2 sandboxed codegen → P3 accessibility →
P4 vision), security gate with phone-side approvals, instant human takeover,
model-agnostic provider layer (Anthropic + any OpenAI-compatible endpoint),
keychain key storage. See `ask-architecture-audit.md` / `m5.3-ai-executor-plan.md`.

### M5.4 — Persistent trusted devices ✅

Pair once (QR + approve + "Trust this device"), reconnect forever: keychain
device identity + saved pairs on the phone (My Devices → Connect), desktop
presence channel + ring/auto-approve, `trusted_devices` rows with per-pair
auto-connect + revocation, desktop Trusted Devices dashboard. See
`m5.4-trusted-devices-audit.md`.

### M5 remainder — accounts + cryptographic device identity

Email/password (then Google/Apple), Ed25519 device keys + challenge-response
(the `m5-auth-design.md` spec — upgrades the self-asserted deviceId strings in
place), session expiry, per-device scope policies.

## M6 — Harden + productize (in progress)

### Shipped

- ✅ **Desktop auto-update** — Tauri v2 updater plugin against a
  `latest.json` published to GitHub Releases; signed with a minisign key
  (`tauri.conf.json#plugins.updater`), driven by an explicit state machine
  (`useUpdater.ts`: idle → checking → available → downloading → ready →
  relaunch) with a manual "check now" panel in Diagnostics.
- ✅ **Signed + notarized macOS CD** — [`release.yml`](../.github/workflows/release.yml):
  a `v*` tag builds a universal (aarch64 + x86_64) `.app`/`.dmg`, Developer-ID
  signs, notarizes, staples, and publishes the Release plus updater artifacts.
  Cut with `pnpm release`.
- ✅ **Mobile CI/CD** — [`mobile-ios.yml`](../.github/workflows/mobile-ios.yml)
  (fastlane → TestFlight) and
  [`mobile-android.yml`](../.github/workflows/mobile-android.yml)
  (fastlane → Play internal track + APK artifact).
- ✅ **CI** — [`ci.yml`](../.github/workflows/ci.yml): TypeScript (lint +
  typecheck + test) and Rust (fmt + clippy + test) jobs, plus nightly and
  weekly soak runs.
- ✅ **TURN hardening (self-hosted)** — `infra/coturn-prod/` runs coturn with
  `use-auth-secret`, sharing `TURN_SECRET` with the backend so credentials are
  short-lived HMAC-derived per session/role. `FORCE_RELAY` pins
  `iceTransportPolicy: relay`.
- ✅ **Operational runbook** — [`RUNBOOK.md`](./RUNBOOK.md): fresh clone → running,
  cutting releases, how updates reach installed apps, reclaiming disk.

### Remaining

- 🔜 Stripe billing (free/pro/team).
- 🔜 Admin dashboard — `apps/admin` is scaffolded (Vite + React) and probes
  `/health`; the users/devices/sessions cards are still placeholders, and the
  `/admin/*` API is unbuilt.
- 🔜 Observability overlay (capture/encode time, RTT, input round-trip, ICE
  candidate type).
- 🔜 Rotating TURN credentials in a managed deploy (the self-hosted relay above
  is the prerequisite, not the whole item).

---

# Consumer product track (M7+)

From here the goal changes: take a working **single-user engineering product**
and make it a **secure, scalable, polished consumer product** where many
independent users control their own laptops. The decisions driving this live in
[`adr/`](adr/); the verified gap list lives in
[`PROJECT-INDEX.md`](PROJECT-INDEX.md).

## M7 — Documentation system + CI guardrails 🚧

Deliberately first: this repo has already shipped docs claiming features were
unbuilt when they had shipped, and API docs missing five live routes. Every later
milestone makes that worse unless the guardrails exist first.

- ✅ `pnpm docs:check` — frontmatter (`status`/`owner`/`last-verified`), relative
  link resolution, and **API route drift** (routes in code vs `api.md`, both
  directions). Wired into CI.
- ✅ Status vocabulary on every doc under `docs/`; rules in
  [`CONTRIBUTING.md`](../CONTRIBUTING.md#documentation).
- ✅ [`adr/`](adr/) — ADR-0001..0005 record authentication, device identity, the
  QR→same-account change, signaling scale-out, and TURN topology.
- ✅ CodeQL + dependency audit job in CI.
- 🔜 Make the dependency audit blocking (gap DEP-1 — 19 high/critical advisories
  must be cleared first; this should land before M8).

## M8 — Accounts + device identity ✅

Apple/Google OAuth + email magic link ([ADR-0001](adr/0001-account-authentication.md));
Ed25519 device enrollment with challenge-response
([ADR-0002](adr/0002-device-identity.md)); desktop enrolled by an authenticated
phone ([ADR-0008](adr/0008-desktop-enrollment-via-phone.md)). Backend and both
client libraries are implemented and verified end to end against a live
backend. Closes SEC-1 and SEC-2.

Applying that identity to every route turned out to be its own body of work and
became **M9** below; SEC-5 (legacy null-secret pairs) is still open.

## M9 — Ownership + authorization ✅

**Rewritten 2026-08-13.** The previous scope (same-account visibility, no
pairing ceremony) is superseded by
[ADR-0010](adr/0010-explicit-device-linking.md): an account never discovers
devices, and the explicit linking ceremony establishes ownership.

A computer belongs to exactly one account, and only its owner may see, reach or
revoke it. Knowing an identifier is never sufficient. Closes SEC-3, SEC-4 and
SEC-7.

- ✅ Linking makes a laptop reachable, not merely owned (ADR-0008 amendment)
- ✅ Device states `unlinked → linked → revoked` (`auth/deviceState.ts`)
- ✅ Ownership rule + isolation unit tests (`auth/ownership.ts`)
- ✅ Authorization applied to every HTTP route (`auth/authorize.ts`, `optionalAuth`)
- ✅ WebSocket presence `register` gate keyed on the authenticated device (SEC-4)
- ✅ Client token wiring — both clients send a device token whenever they can
  mint one, so pairing and reconnect are unchanged for a device no account owns
- ✅ Table-driven cross-user isolation suite + route-wiring suite (SEC-7)
- 🔜 Purge legacy `connect_secret_hash = NULL` pairs (SEC-5)

**The unowned lane is deliberate, and it is what M10 closes.** A device row with
no `user_id` has no owner to protect, so it keeps its pre-accounts behaviour;
every route demands a matching token the moment a device is linked. Both halves
meet without a flag day — clients send a token whenever they can mint one, the
backend requires one whenever the resource is owned. When M10 makes enrolment
mandatory in both clients, the unowned branch becomes unreachable and is deleted.

## M9.5 — LAN-direct connectivity (no internet required) 🔜

**Deliberately before the cloud deployment milestone**, so the cloud is added
_beside_ a working local path rather than in front of it. See
[ADR-0006](adr/0006-lan-first-connectivity.md),
[ADR-0007](adr/0007-cloud-is-control-plane-only.md),
[NETWORKING.md](NETWORKING.md).

**Why now:** M13 as originally written would have moved signaling to
`signal.takedia.com` and thereby made every same-room session depend on the
public internet — a regression against a hard product requirement. Building the
local path first prevents that.

- **Embedded signaling server on the desktop** serving the existing
  `@lilypad/protocol` contract at `https://<laptop>:PORT/ws/signal`. A LAN room
  is exactly two known peers, so no room registry, capacity policy, or Redis —
  it reuses `MessageRouter`'s decision semantics.
- **Local channel security:** TLS with a self-signed certificate bound to the
  device's Ed25519 identity ([ADR-0002](adr/0002-device-identity.md)), pinned by
  the phone at pairing. No CA, no name resolution, no internet.
- **Discovery:** cached last-known address first (one TCP connect, works where
  multicast is blocked), then mDNS `_lilypad._tcp.local` via each platform's
  native API — `NWBrowser`/`NetService`, `NsdManager`, `dns-sd`. Needs only the
  iOS Local Network permission, **not** the multicast entitlement.
- **Connection race** in the client: LAN paths are attempted before any cloud
  call, with a ~1.5s budget before falling through.
- **Local presence** — "is my laptop here?" answered by discovery, not the cloud.
- Drop the hardcoded Google STUN; serve STUN from our own coturn.
- **DoD (release-blocking):** an automated scenario with **the cloud entirely
  unreachable** and both devices on one LAN proves discovery, connection, video,
  input, and clipboard all work, and asserts **zero cloud requests** occur.

## M10 — Desktop security hardening 🔜

Real CSP, drop `withGlobalTauri`, per-window command authorization, scoped
`shell:allow-open`, persisted rotating logs, panic hook, crash reporting.
Closes SEC-6, part of OBS-1.

## M11 — Horizontal scaling 🔜

In-memory rooms + Redis pub/sub relay
([ADR-0004](adr/0004-signaling-horizontal-scaling.md)), Redis-backed rate
limiting, backend Dockerfile, readiness probes, graceful drain. Closes OPS-1.

## M12 — Security hardening + isolation suite 🔜

Refreshed threat model, agent prompt-injection and sandbox-escape tests, and a
**release-blocking table-driven multi-user isolation suite** — a new route
without an isolation case fails CI. Closes SEC-7.

## M13 — Production infrastructure + takedia.com 🔜

**Revised for cost.** The earlier version assumed managed PaaS and managed
everything. The cost model shows self-hosted coturn on bandwidth-inclusive VPS is
~1000× cheaper than managed TURN at scale — the difference between a sustainable
free tier and none. See
[INFRASTRUCTURE-COST-MODEL.md](INFRASTRUCTURE-COST-MODEL.md).

- **Phase 1 footprint only:** one VPS running API + signaling + Postgres, one
  coturn VPS. **No Redis** (not needed until multi-instance), no Kubernetes, no
  managed observability. Target: **under €30/month**.
- coturn self-hosted with a properly sized relay port range (the current config
  allows only ~50 concurrent relays), the auth secret off the command line,
  `turns:` on 443, and our own STUN replacing Google's.
- Full DNS/TLS for `takedia.com`, staging mirroring production, migrations run on
  deploy, updater manifests moved off GitHub.
- **The cloud never becomes required for a LAN session** — M9.5's local path
  keeps working unchanged.
- **DoD:** staging and production reachable, health-checked, monitored; deploy
  and **rollback** runbook exercised once; measured cost matches the model's
  Phase 1 estimate.

Closes OPS-2, OPS-3, OPS-4, NET-1, NET-2.

## M14 — Consumer UX · M15 — Observability

Onboarding, plain-language errors, device management, marketing site and web
dashboard; then privacy-preserving metrics and crash reporting across all tiers.

## M16 — Android GA · M17 — Windows GA · M18 — Ask productisation

Android needs a real signing keystore (it currently ships with the committed
debug keystore) and hardware validation. Windows needs its input path actually
executed, a real encoder, and a Windows-compatible single-instance guard.

---

## Non-negotiables (all milestones)

No custom video protocol · no LAN-only design · no silent remote access · no
gaming-first shortcuts · prioritize internet connectivity, smooth pairing,
readable text, input responsiveness, security.
