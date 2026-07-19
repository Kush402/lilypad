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

## M6 — Harden + productize

TURN hardening (rotating creds) + deploy, Stripe billing (free/pro/team), admin
dashboard, observability overlay (capture/encode time, RTT, input round-trip,
ICE candidate type), desktop auto-update.

## Non-negotiables (all milestones)

No custom video protocol · no LAN-only design · no silent remote access · no
gaming-first shortcuts · prioritize internet connectivity, smooth pairing,
readable text, input responsiveness, security.
