---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-12
summary: Milestone status, past and current.
---

# Lilypad — Milestone Plan

Internet-first is proven early: signaling + WebRTC over STUN/TURN lands in M2,
before real capture. Each milestone is independently demoable.

**Two tracks, deliberately distinct numbering.** **M0–M18** build the platform:
capture, input, signaling, accounts, authorization, scaling, infrastructure.
**[P1–P6](#product-completion-track-p1p6)** turn that platform into a product
someone can buy and use. They run on the same codebase along different axes, so
they do not share a number line — an entry is never both. Where a P-milestone
refines an M-milestone, the M-entry stays exactly as written and says so.

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
became **M9** below, which also closed SEC-5.

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
- ✅ Purge legacy `connect_secret_hash = NULL` pairs (SEC-5, migration `0005`)

**The unowned lane was a migration ramp, and it is now closed (2026-08-22).** A
device row with no `user_id` used to keep its pre-accounts behaviour, on the
plan that P1 would make enrolment mandatory. P1 chose the opposite — linking is
offered, not demanded — so the ramp had become permanent. With the product
model settled as **account → devices**, a device on no account may do nothing:
`lane: 'unowned'` is deleted and `lane: 'owner'` is the only `allow`. The
linking ceremony itself is ungated, so a new computer can still mint the code a
phone approves. See [ADR-0010](adr/0010-explicit-device-linking.md).

## M9.5 — LAN-direct connectivity (no internet required) 🚧

**Deliberately before the cloud deployment milestone**, so the cloud is added
_beside_ a working local path rather than in front of it. See
[ADR-0006](adr/0006-lan-first-connectivity.md),
[ADR-0007](adr/0007-cloud-is-control-plane-only.md),
[NETWORKING.md](NETWORKING.md).

**Why now:** M13 as originally written would have moved signaling to
`signal.takedia.com` and thereby made every same-room session depend on the
public internet — a regression against a hard product requirement. Building the
local path first prevents that.

- ✅ **Embedded signaling server on the desktop** serving the existing
  `@lilypad/protocol` contract at `https://<laptop>:8787/ws/signal` (macOS default;
  `LILYPAD_LAN_CONTROL=0` disables). LAN hub reuses pairing/session-start/ICE
  relay semantics for two peers.
- ✅ **Local channel security:** TLS with a self-signed certificate (device-id DNS
  SAN + LAN IP SAN), SHA-256 pinned by the phone via native modules.
- ✅ **Discovery:** cached last-known address first, then mDNS `_lilypad._tcp`
  (desktop `mdns-sd`, iOS `NetServiceBrowser`, Android `NsdManager`).
- ✅ **Connection race** in the mobile client: LAN paths within `LAN_PROBE_BUDGET_MS`
  before any cloud call.
- ✅ **Local reconnect auth:** trust cache + `trust-record` / `connect_secret_hash`.
- 🔜 Drop the hardcoded Google STUN; serve STUN from our own coturn.
- **DoD (release-blocking):** automated `lan_control_e2e` proves control-plane
  connect without cloud. **Remaining:** real-device scenario with cloud unreachable
  proving video, input, and clipboard with zero cloud requests; then
  `ENFORCE_REMOTE_ENTITLEMENT=true` in production.

## M10 — Desktop security hardening 🔜

Real CSP, drop `withGlobalTauri`, per-window command authorization, scoped
`shell:allow-open`, persisted rotating logs, panic hook, crash reporting.
Closes SEC-6, part of OBS-1.

## M11 — Horizontal scaling 🔜

In-memory rooms + Redis pub/sub relay
([ADR-0004](adr/0004-signaling-horizontal-scaling.md)), Redis-backed rate
limiting, backend Dockerfile, readiness probes, graceful drain. Closes OPS-1.

## M12 — Security hardening + isolation suite 🔜

> **Partly closed early.** M9 shipped SEC-7's isolation suite
> (`auth/authorize.test.ts`, `routes/authorization.test.ts`). What remains here
> is the threat-model refresh, the agent prompt-injection and sandbox-escape
> tests, and making a missing isolation case fail CI.

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

> **M14 is superseded by the product completion track**, which splits it into
> [P1](#p1--account-connected-clients-) (onboarding and account-connected
> clients), [P2](#p2--device-management-) (device management) and
> [P4](#p4--lilypadtakediacom-) (the site). Kept here unchanged for history.
> M15 is untouched.

## M16 — Android GA · M17 — Windows GA · M18 — Ask productisation

Android needs a real signing keystore (it currently ships with the committed
debug keystore) and hardware validation. Windows needs its input path actually
executed, a real encoder, and a Windows-compatible single-instance guard.

> **M18's Ask half is superseded by [P5](#p5--ask-productisation-).** M16 and
> M17 are untouched, and they are the reason P4 advertises macOS + iOS only.

---

# Product completion track (P1–P6)

**Added 2026-08-13.** The milestones above take Lilypad from prototype to a
secure, scalable **platform**. This track is the separate question of turning
that platform into a **product a stranger can buy and use**: an account you can
sign into, a computer you can link and manage, a coherent visual language, a
site that explains it, and an Ask feature that does not leak internal tier
names.

It is numbered **P1–P6 rather than M19+** deliberately. These are not "the next
milestones after M18" — they run against the same codebase on a different axis,
and several of them refine work the M-track already sketched. Reusing M-numbers
would have made two different plans claim the same labels.

**What it supersedes.** Nothing is deleted; the entries above stay as written.

| Old milestone            | Status under this track                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| M12 — isolation suite    | **Already closed by M9.** SEC-7 is covered; the release-blocking CI rule remains M12's part. |
| M14 — Consumer UX        | **Split.** Onboarding + device management + site become P1, P2, P4.                          |
| M18 — Ask productisation | **Becomes P5.**                                                                              |
| M13 — production infra   | **Unchanged.** P4 is the site's content and build; M13 still owns DNS, TLS and hosting.      |

**What it does not change.** LAN-first ([ADR-0006](adr/0006-lan-first-connectivity.md))
and cloud as control plane only ([ADR-0007](adr/0007-cloud-is-control-plane-only.md))
hold.

> **Amended 2026-08-25 by [ADR-0015](adr/0015-ownership-follows-sign-in.md).**
> This paragraph used to add explicit device linking and the rule that "an
> account never discovers devices". Signing in on a device is now what puts it
> on the account, on every platform. What survives, and is what that rule was
> actually protecting: **ownership buys no reach** — a phone sees a screen only
> through a `trusted_devices` pair created by the QR ceremony. No milestone here
> may introduce a flow where signing in makes a computer _reachable_.

## P1 — Account-connected clients 🚧

> **Read the ✅ items below as a record of what P1 delivered, not as current
> behaviour.** [ADR-0015](adr/0015-ownership-follows-sign-in.md) (2026-08-25)
> replaced the linking ceremony with ownership at sign-in and collapsed the
> wizard's four steps to three — **1 your account → 2 permissions → 3 pair your
> phone**. The enrollment QR described here still exists, as the recovery path
> for a Mac whose sign-in enrollment failed.

The account layer was built on both ends and connected on neither: the desktop's
`auth.rs` was dead code until M9 wired its token path, `SignInScreen.tsx` had no
route, `approveDesktopEnrollment()`'s only caller was a test, and there was no
desktop enrollment UI at all. A user could install Lilypad, grant permissions
and pair a phone without ever having an account (gap PROD-1).

- ✅ Desktop **This computer** panel: renders `Not linked` / `Linked` honestly,
  mints an enrollment QR, and polls for the phone's approval
  ([ADR-0008](adr/0008-desktop-enrollment-via-phone.md)).
- ✅ Phone: the scanner classifies **pair** and **link** codes and confirms them
  in different words, because one starts a session and the other hands over a
  computer permanently.
- ✅ Sign-in is routed, reached from the act that needs it, and its copy no
  longer promises the same-account discovery ADR-0010 reversed.
- ✅ Onboarding: the **Setup** window now carries the whole first run in order —
  **1 permissions → 2 link this computer → 3 pair a phone** — instead of stopping
  after the permissions. Steps 2 and 3 stay hidden until the permissions are
  granted, because offering to put a computer on an account, or to pair a phone
  with it, before it can capture or type is a step that cannot work.
- ✅ **The wizard no longer claims to be finished when it isn't.** It used to end
  with _"All set — you can start pairing now"_ the moment the two permissions
  landed, which is precisely what the DoD's second clause forbids: permissions
  say what the machine can do, never whose it is. The final card now states
  whichever of two things is actually true — set up **and on your account**, or
  set up and **not on an account yet**. Regression-tested, and the test was
  mutation-checked against the exact old behaviour.
- ✅ Linking is **offered, not demanded**. Pairing genuinely works on an unlinked
  computer, so blocking on step 2 would be a lie in the other direction.
  Sign-in has no step of its own by design: the desktop has no OAuth client
  ([ADR-0008](adr/0008-desktop-enrollment-via-phone.md)), so it happens on the
  phone inside step 2, where the QR is what tells the phone which backend to
  sign in to.
- 🔜 Human tap-through of the whole flow on the phone.
- **DoD:** a fresh install completes sign-in → link → pair with no manual steps,
  and the desktop never implies it is available before a phone has approved it.
  **The second clause is now enforced by a test.** The first is built and
  covered by unit tests end to end, but a person still has to walk it once on
  real hardware — driving a touchscreen is not something that can be automated
  here.

**A constraint that shaped this, verified in the repo rather than assumed:** the
phone has **no configured backend address**. Every `apiBaseUrl` it uses comes
from a scanned code or a stored pair. So "sign in, then find your computer" is
not a flow that can exist — the computer's code is what tells the phone where
Lilypad lives, and sign-in is reached from the moment it is actually needed.

Closes gap PROD-1. Makes enrolment universal, which is what lets `authorize.ts`'s
unowned lane be deleted.

## P2 — Device management 🚧

An authenticated "my devices" surface. Built on M9's ownership rule — this is
the milestone `manageDevice`'s "any of the owner's devices qualifies" rule
exists for.

- ✅ `GET /devices`, `PATCH /devices/:id` (rename), `DELETE /devices/:id`
  (revoke), all `requireDevice` and ownership-gated.
- ✅ Revocation is **immediate**: the backend ends the device's live rooms and
  its presence room, then its next `/devices/token` fails. Without that, a
  ten-minute access token would leave a stolen laptop controllable for ten more.
- ✅ Active-session state comes from the signaling hub, because the `sessions`
  table is still never written and an empty table rendered as "no active
  sessions" would state something false rather than omit something missing.
- ✅ Phone **Your devices** screen: list, rename, remove, with copy that keeps
  it apart from "Your laptops" — forgetting a laptop ends one pairing, removing
  a device withdraws ownership.
- 🔜 Desktop-side view of the same list. The phone is where the account lives
  ([ADR-0008](adr/0008-desktop-enrollment-via-phone.md): the desktop has no
  OAuth client), so the phone gets it first; the desktop already manages its own
  pairs and its own link state.
- 🔜 Session history. Needs the `sessions` table to actually be written.

**Verified against a live backend** (Postgres + Redis): two accounts, real
Ed25519 enrolment, and 20 assertions including that one account cannot rename or
revoke another's device (404 both), that a revoked device genuinely stops
authenticating, and that fingerprints are masked in listings.

**Verified on a real iPhone 13** (Xcode 26.6, `devicectl`): the app builds for
arm64, installs, launches and stays running, and every P1/P2 screen and its copy
is present in the shipped Hermes bundle. **Not verified: the tap-through flow**
— driving the touchscreen needs a person, so sign-in → link → rename → revoke
has been exercised against the live backend by script, not by hand on the phone.

**Tooling blocker, unchanged since M8.** The repo's real bundle id
(`com.takedia.lilypad`) carries the Sign in with Apple entitlement, and Xcode
refuses to provision it: _"Personal development teams … do not support the Sign
In with Apple capability."_ The device build above used a throwaway bundle id and
empty entitlements **on the command line only** — the repository is untouched. So
Apple and Google sign-in cannot be exercised on this hardware; magic-link
sign-in is the path that works. Clearing this needs a paid Apple Developer
Program membership, not a code change.

## P3 — Design system ✅

One source of truth for colour. The palette was triplicated across the desktop,
mobile and admin surfaces, and it had already drifted in four places
([ADR-0011](adr/0011-design-tokens.md)).

- ✅ `@lilypad/design` holds colour (both schemes), corner radii and the font
  stack. The web surfaces `@import '@lilypad/design/tokens.css'`; mobile imports
  the TypeScript module. Three documented exemptions remain, each a colour that
  must not follow the theme: the vendor sign-in buttons, the floating bubble,
  and the QR code's white frame.
- ✅ The four drifts closed: `#04140d` → `onAccent`, `#e0a83e` → `pending`, the
  desktop's Apple-system status dots → `accent`/`pending`, and `SignInScreen` —
  which had no background colour at all and rendered white in a dark-green
  product — put on the palette.
- ✅ A drift test parses the shipped `tokens.css` and fails if it disagrees with
  `tokens.ts` in either direction. Mutation-checked: changing one hex in the CSS
  does fail it.
- **Deliberately out of scope: font sizes and spacing.** They are not
  duplicated, they are genuinely different — the web surfaces are tuned around
  11–18px and mobile around 13–26pt, because a phone is held at arm's length and
  a laptop is not. One shared numeric scale would have to move one of them,
  which is a redesign rather than a de-duplication. Recorded as a decision in
  ADR-0011, not as unfinished work.
- **One visible behaviour change:** the admin dashboard hardcoded the dark
  palette and now follows the OS scheme like the desktop does. Its rendered
  values are unchanged; which set applies is not.

**Verified:** the design package's 5 drift tests, both Vite builds with the
tokens correctly inlined into the emitted CSS (both schemes intact), and the
full mobile, desktop and backend suites.

## P4 — `lilypadhome.takedia.com` ✅ (content and build)

The marketing site: what Lilypad is, which platforms are **actually** supported,
and the plans. Static, no framework — `apps/site` is one HTML file plus one
stylesheet, and ships no JavaScript at all.

- ✅ Advertises **macOS + iOS only**. Windows and Android appear in the platform
  table marked **Not yet**, with the reason stated: code exists for both, but
  neither has been proven on real hardware — see gap AND-1's history for why
  claiming otherwise is not acceptable.
- ✅ Tiers are `free`, `pro`, `team` (`users.tier`), rendered as Free / Pro /
  Team with **`$XXXX`** prices. The page says outright that prices are not set
  and the allowances are not quantified, because no price point, quota or
  allowance exists anywhere in the repository.
- ✅ Colour comes from `@lilypad/design`, so the site cannot drift from the
  product it describes, and it follows the visitor's light/dark preference for
  free ([ADR-0011](adr/0011-design-tokens.md)).
- ✅ **A claims test** (`apps/site/src/claims.test.ts`) asserts the page against
  the rules the repo actually sets: macOS/iOS supported, Windows/Android not,
  `$XXXX` the only price on the page, no legal pages linked, and Ask's internal
  tier names absent. A marketing page does not crash when it goes wrong — it
  keeps rendering a claim that stopped being true, so the claim is the thing
  worth testing. Mutation-checked: marking Windows supported, or writing a real
  price, both fail it.
- ✅ No download button. There is **no tag and no published release**, so the
  page says so and links to the Releases page rather than promising a binary
  that does not exist.
- 🔜 DNS, TLS and hosting remain M13's — and see the hostname conflict below.

### The hostname, and why it is not the tunnel's

The site answers on **`lilypadhome.takedia.com`** (decided 2026-08-13).

`lilypad.takedia.com` is a different thing and keeps its job: it is the named
cloudflared tunnel serving the development backend for off-LAN and cellular
testing ([RUNBOOK](RUNBOOK.md)), with `.env` pinning
`PUBLIC_BASE_URL`/`SIGNALING_URL` to it. Pointing that name at a static site
would break cellular testing, so the two are deliberately separate hostnames and
**nothing has to move for the site to ship**. Relocating the tunnel, if it ever
happens, belongs to M13 with the rest of the production DNS.

P4 still touches no DNS: the site is built, and hosting is M13's.

### Not verified

How the page looks **on the iPhone**. It was rendered and measured in Chrome at
a 390×844 viewport, and the real iPhone did fetch and load it over the LAN — but
Blink is not WebKit, and confirming it looks right on the phone needs a person
looking at the phone.

## P5 — Ask productisation ⏹️ closed, no change

**Closed 2026-08-13 by product decision, without code changes.** Ask's current
model is the intended one: it is an **in-app-only input**, and the existing
transcripts are what the product wants to show. The two changes P5 proposed —
relabelling the transcript surface and adding a desktop Ask input — were a plan's
assumption, not a reported defect, and building them would have changed a design
that is already correct.

The M18 Ask half it superseded stays superseded; there is simply nothing to do
for either. Ask remains open to bug fixes like any other subsystem — this closes
the redesign, not the code.

## P7 — Consumer onboarding ✅

**The order the product is used in, made the order it is presented in**, plus
the sign-in method that makes that order possible on both clients
([ADR-0012](adr/0012-password-authentication.md)).

Three things were wrong, all of them ordering rather than capability:

1. **The desktop's front door was a pairing QR.** Clicking the bubble minted a
   pairing code and put a QR on screen as the app's first act — before any
   account existed and before the user had seen a screen explaining what Lilypad
   is. It now opens the dashboard, which leads with the account and carries its
   own "Pair a new device" button.
2. **The phone had no auth gate.** It opened on the paired-laptop list, pairing
   worked entirely signed out, and sign-in appeared only when the scanner hit a
   `DeviceAuthError`. Sign-in is now the only route in the stack while signed
   out — expressed as which screens exist, so there is no protected route to
   reach by mistake.
3. **The desktop could not sign in at all.** ADR-0008 gives it no OAuth client
   and production has no mail sender, so every method in ADR-0001 was
   unreachable there. Email + password needs neither.

**What did not change, and is now enforced rather than assumed:** an account
never discovers devices. Signing in on a Mac does not link it — a phone
approving its enrollment code does — and `/devices/enroll` refuses
`kind: "desktop"` outright so that rule survives a client that forgets it. That
guard is what made desktop sign-in safe to add.

**Shipped:** `users.name` + scrypt hashing (`auth/password.ts`), four routes
(`/auth/signup`, `/auth/password`, `/auth/password/reset/{request,confirm}`),
password-reset tokens in their own Redis namespace, a mobile session record and
auth gate, a mobile sign-out, `apps/mobile/src/config/backend.ts` (the app ships
a backend address for the first time), desktop `account.rs` + six Tauri commands,
and an account panel on both the dashboard and the first-run wizard.

**Verified:** 19/19 live assertions against the running backend (signup,
duplicate-address, weak password, sign-in, wrong password, unknown address at
matched timing, an OAuth account refusing password sign-in, reset request/confirm,
reset-token single-use, a reset token refused at `/auth/magic-link/verify`, and a
signed-in desktop refused at `/devices/enroll`).

**Ordering, after real use.** Three follow-up fixes came out of driving the
built app rather than the tests:

1. The mobile gate and the signed-in stack both had a screen named `SignIn`.
   React Navigation keeps a focused route across a conditional-screen swap when
   the name survives, so signing in succeeded end to end — `/auth/password` 200,
   `/devices/enroll` 200, six times — and the screen never changed. The gate is
   `SignInGate` now, a name the signed-in stack does not use.
2. The desktop dashboard offered a live enrollment QR to a signed-out user,
   directly beneath the sign-in form, with nothing relating the two. Linking now
   waits for sign-in.
3. **Pairing now waits for linking**, on every surface — the tray item, the
   dashboard's "+", the wizard's step 4, and `create_pairing` itself. A pair
   made on an unowned computer belongs to no account: it appears in no "Your
   devices" list and can be revoked from nowhere, which
   [ADR-0010](adr/0010-explicit-device-linking.md) rejected and which
   `docs/api.md` said would end "when P1 makes enrolment mandatory". This is the
   client half of that; the backend half followed on 2026-08-22, when the
   unowned lane was closed.

**Open:** password reset is implemented and tested but not deliverable until M13
provides a mail sender — it answers 503 in production, exactly as magic link
does. `DEFAULT_API_BASE_URL` points at the existing tunnel and moves with M13.
Setting a password on an account created by OAuth is not offered anywhere; it is
account management rather than sign-in, and no screen has a place for it yet.

## P6 — Entitlements 🔜

Backend-enforced plan limits. `users.tier` is still read nowhere, but **what** is
gated is now decided: [ADR-0013](adr/0013-connectivity-is-the-paid-boundary.md)
makes **connectivity** the boundary — LAN free forever, remote paid after a
one-month trial. One gate on remote session establishment
(`/connect/request`, presence, the signaling room), not a meter on traffic; LAN
needs no gate because its media never reaches us.

Still blocked on **prices** (`$XXXX`), and it now has a prerequisite that is not
a pricing question: **a LAN session still depends on the control plane to
establish**, so "free = LAN" is not yet a shippable product. See
[NETWORKING.md §2](NETWORKING.md) — the laptop acting as its own control plane
is the existing target design, and it is now on the launch critical path.

## Open decisions blocking this track

Recorded rather than guessed. Each blocks only its own dependent.

1. **Pricing numbers** — `pro`/`team` prices. Blocks P4's real prices and all of
   P6. Everything else proceeds on `$XXXX`. _(Partly answered 2026-08-15: the
   free/paid **boundary** is decided — see
   [ADR-0013](adr/0013-connectivity-is-the-paid-boundary.md) — so only the two
   numbers remain. The free-tier relay allowance is no longer a question: free
   has no relay, because free has no remote.)_
2. **Platform advertising** — macOS is real; Windows input has never executed and
   Android has no field validation. Until that changes, P4 says macOS + iOS.
3. **Legal pages** — privacy policy and terms need real answers on data
   retention and jurisdiction. Compliance claims will not be drafted from
   inference.

---

## Non-negotiables (all milestones)

No custom video protocol · no LAN-only design · no silent remote access · no
gaming-first shortcuts · prioritize internet connectivity, smooth pairing,
readable text, input responsiveness, security.
