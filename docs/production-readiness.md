# Lilypad — Production Readiness Audit

_Audit date: 2026-07-12. Scope: full monorepo (desktop, backend, mobile, infra, docs, CI)._

This audit treated the product as feature-complete-for-MVP and looked only for
reliability, security, and operational gaps. Findings were produced by three
parallel subsystem reviews plus direct verification of every Critical claim.
Issues fixable immediately without changing product scope were fixed, verified,
and are marked ✅ **FIXED** below.

---

## Production readiness: ~75% (macOS-only, trusted-network beta)

_Updated after the hardening phase: C1-critical desktop bugs, C2 DoS limits, and desktop H5 (blocking reconnect) are fixed and verified. The remaining Critical (backend signaling auth) is the M5 milestone._

- **macOS desktop + backend, on a trusted network, after the fixes below: ready for a supervised beta.**
- **Public-internet exposure: NOT ready** — the signaling WebSocket has no authentication (backend C1); this is the M5 auth milestone and is the single largest blocker.
- **Windows: not shippable** — capture/encode/input are compile-complete stubs pending a Windows machine.
- **Mobile: happy-path only** — no reconnect, no lifecycle handling, a touch-mapping bug; gates real-world use.

---

## Fixes applied in this audit (verified)

All verified by `cargo test` (58 desktop tests), backend `vitest` (37 tests),
full `turbo typecheck build lint`, a 3-minute pipeline soak, and a live
end-to-end WebRTC run (desktop ↔ real webrtc-rs mobile peer, 4,883 RTP packets,
PLI round-trip).

| #            | Severity         | Issue                                                                                                                                                                                 | Fix                                                                                                                                                                          | Verified by                                                                                                                                |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| C1           | **Critical**     | Input worker never called `backend.initialize()` → **all** macOS input injection failed silently (every event dropped as "not initialized")                                           | `initialize()` now called in the worker thread with error logging                                                                                                            | Confirmed by reading `source()` bail path; compiles + input tests pass                                                                     |
| C2           | **Critical**     | VideoToolbox keyframes carried only SEI+IDR, **no SPS/PPS** → phone shows a black screen (VideoToolbox is the default macOS encoder)                                                  | Extract H.264 parameter sets from the sample buffer's `CMFormatDescription` (CoreMedia FFI) and prepend them Annex-B to every keyframe                                       | Proven: dumped NAL types before (`[6,5]`) and after (`[7,8,6,5]`); new regression test asserts SPS+PPS+IDR present                         |
| C3 (partial) | High             | VideoToolbox rebuilt its whole compression session ~1×/sec (periodic keyframe forced from the pipeline)                                                                               | Removed pipeline-side periodic force — the encoder's own `max_keyframe_interval` produces periodic IDRs; pipeline forces only first-frame / drop-recovery / viewer-PLI       | Soak shows 180 keyframes / 180s (1/s) with 0 session rebuilds; remaining rebuild-on-explicit-bitrate-change documented as v1.0 work        |
| H1           | High             | `handle_peer_event(...)?` could early-return past the teardown block, leaking the PeerConnection + capture/encode pipeline                                                            | Relay failures now log-and-continue; only a real terminal condition breaks the loop (→ teardown)                                                                             | Compiles; reconnect path already covers dead-signaling                                                                                     |
| H2           | High             | UI cleared `control_tx` on `failed`/`disconnected`, but the runner treats those as recoverable — **the Disconnect/Panic buttons silently stopped working** while capture kept running | Only the runner's definitive `Ended` event tears down UI state + control channel                                                                                             | Confirmed against `apply_session_event`; compiles                                                                                          |
| H4           | High             | `wss://` signaling could never connect (no TLS feature on tokio-tungstenite)                                                                                                          | Enabled `rustls-tls-webpki-roots` (matches reqwest's rustls)                                                                                                                 | Compiles                                                                                                                                   |
| M3           | Medium           | A repeat `session-start` overwrote the peer without closing the old one (leaked ICE/DTLS/RTCP tasks)                                                                                  | Close the previous peer before replacing                                                                                                                                     | Compiles                                                                                                                                   |
| M5           | Medium           | Input DataChannel had no `on_close` — the injection gate could stay open after the channel closed                                                                                     | Added `on_close` → `InputChannelClosed` event → `set_enabled(false)`                                                                                                         | Compiles                                                                                                                                   |
| B-H2         | High (backend)   | Static TURN secret advertised to clients via dead `config.iceServers` (leaked the coturn master secret)                                                                               | Removed the static-credential export; only per-session HMAC creds are ever handed out                                                                                        | `grep` confirmed zero consumers; compiles                                                                                                  |
| B-H1         | High (backend)   | No WebSocket payload cap + unbounded SDP/candidate strings → parse-bomb DoS                                                                                                           | `maxPayload: 64KB` on the WS; `.max()` bounds on all signaling string fields                                                                                                 | Backend tests pass                                                                                                                         |
| B-H3         | High (backend)   | Prod could boot with publicly-known dev secrets (schema defaults)                                                                                                                     | `loadEnv` refuses to start in production with any default `TURN_SECRET`/`DATABASE_URL`                                                                                       | Backend tests pass                                                                                                                         |
| B-M2         | Medium (backend) | ioredis `error` event had no listener → a Redis flap could crash the process                                                                                                          | Added `redis.on('error')` handler (log + let ioredis retry)                                                                                                                  | Compiles; tests pass                                                                                                                       |
| B-M4         | Medium (backend) | Reaper iterated `this.rooms` while `endRoom` deleted from it (could skip entries)                                                                                                     | Snapshot `[...this.rooms.values()]` in the heartbeat loop                                                                                                                    | Backend tests pass                                                                                                                         |
| C2           | High (backend)   | Unbounded rooms/sockets, no per-IP or message-rate limits → trivial memory/event-loop DoS                                                                                             | Per-IP connection cap (20), per-socket token-bucket rate limit (60 burst / 20 sustained), 10s idle-close of unregistered sockets, 10k room cap (`signaling/guards.ts` + hub) | 7 unit tests; **live: 300-frame flood → socket closed 4429**, legit session (4,455 pkts) unaffected                                        |
| H5           | High (desktop)   | Signaling reconnect ran inline in the session `select!`, blocking Disconnect/Panic + peer/input events ~16s, then replaying stale input                                               | Reconnect now runs as a background task; the loop keeps servicing all events (which also prevents stale-input pileup)                                                        | 61 tests; **live: Disconnect fired mid-reconnect ended session immediately (not after ~16s)**; reconnect chaos test still passes           |
| M1           | Medium (desktop) | Media-pipeline death (capture stall / encoder failure) was invisible: session stayed Active, **input stayed live while the viewer saw a frozen frame**                                | Drain task signals unexpected death (channel closed + stop flag unset) → session disables input, emits Error + Ended                                                         | 2 tests (unit + own-binary fault-injection); **live: injected capture fault at frame 150 ended the session within ~1s and disabled input** |
| M2           | Medium (desktop) | Blocking capture bring-up (`SCShareableContent::get`, stream start, VT session build) and pipeline `stop()` join ran on a tokio worker, starving other tasks                          | Moved both onto `spawn_blocking` (start async; teardown stop off-worker)                                                                                                     | 61 tests; **live: session started/streamed (2,617 pkts)/stopped cleanly**                                                                  |
| M4           | Medium (desktop) | An abandoned QR leaked the signaling socket + heartbeat task forever (no pairing deadline)                                                                                            | 120s pairing deadline (env-overridable), disarmed on pair-request                                                                                                            | **live: no-device session ended "pairing expired" at the deadline, not at RUN_SECS**                                                       |
| B-M3         | Medium (backend) | Abrupt TCP close on shutdown (peers couldn't tell shutdown from a fault); no shutdown watchdog                                                                                        | `hub.shutdownAll` sends `session-end` + closes on Fastify `onClose`; 10s force-exit watchdog                                                                                 | 45 tests (+1); **live: SIGTERM → "room closed: server shutting down" logged, process exited cleanly under watchdog**                       |
| Obs          | Medium (backend) | Operators couldn't tell how many sessions were live without grepping logs                                                                                                             | `GET /metrics` (hub-owned) exposing `activeRooms` gauge + `sessionsStarted/Ended`, `roomsRejectedAtCapacity`, `peersReaped` counters                                         | 46 tests (+1); **live: idle `{activeRooms:0}` → mid-session `{activeRooms:1,sessionsStarted:1}`**                                          |
| L1           | Low (desktop)    | A panic holding the state mutex poisoned it → every later Tauri command (incl. tray Panic/Disconnect) panicked, bricking the app                                                      | All 9 app-state locks recover from poison (`into_inner`) via a `lock_state` helper                                                                                           | 61 tests pass                                                                                                                              |

---

## Remaining blockers (not fixed — require product decisions, hardware, or larger scope)

### Critical

- **Backend C1 — no signaling authentication.** Rooms are auto-created from client-supplied `roomId`; seats are claimed first-come; the WS never checks the pairing token. Anyone who learns a `roomId` can register as the desktop/mobile and drive the handshake. This is the M5 auth milestone. **Do not expose to the internet until fixed.** Fix: gate the WS on the redeemed pairing token bound server-side to roomId/role/deviceId.
- ~~No version control~~ **Resolved 2026-07-17**: the repo is under git with an initial baseline commit. Remaining: add a remote for off-machine backup.

### High

- **`ws://` in dev, no TLS termination story for prod** (desktop can now do `wss://`; the backend needs a TLS-terminating proxy + WSS-only enforcement).
- **No CI/CD** — nothing runs lint/typecheck/tests automatically. A GitHub Actions matrix (pnpm turbo + cargo test on macOS) is ~1–2 days.
- **No code signing / notarization / auto-updater** — an unsigned app requesting Screen Recording + Accessibility is effectively undistributable; no way to ship a security patch.
- **Mobile: no signaling reconnect, no AppState lifecycle handling, touch-coordinate letterbox bug, random per-launch deviceId** (defeats the backend's seat-reservation). Gates real-world mobile use. Requires a device to verify.

_C2 (DoS limits) and desktop H5 (blocking reconnect + stale input) fixed — see table above._

### Medium

- **C3 remainder — live bitrate change still rebuilds the VideoToolbox session.** The crate exposes `set_properties`; setting `kVTCompressionPropertyKey_AverageBitRate` live (no rebuild) is the correct fix (feature-flag + CFDictionary FFI), deferred for careful verification.
- **No backend `/metrics` endpoint, no crash reporting** anywhere (Sentry/Crashlytics). Pipeline metrics exist but die in logs.
- **Observability reach, versioning drift** (`VERSION` hardcoded in `health.ts` will lie on the first bump), stale `docs/api.md`.

_Desktop M2 (blocking runtime calls), M4 (pairing timeout), and backend M3 (graceful shutdown) fixed — see table above._

### Low

- Desktop mutex `.expect("state poisoned")` in every Tauri command (one panic bricks the app); prefer `parking_lot` or poison recovery.
- `Click` posts down+up with no delay and bypasses `held_buttons`; double-click count field unset.
- On a graceful **server** shutdown the desktop treats the socket close as a reconnect trigger (media P2P, so harmless — it then gives up) rather than reading the `session-end` first; distinguishing WS close code 1000 from abnormal closes would let it end cleanly.
- Mobile: no tests at all; ICE-candidate errors swallowed; input limited to tap/drag + shortcuts (no keyboard/scroll).

---

## Verified-sound (no action needed)

- Pairing token lifecycle: 192-bit entropy, 60s TTL, **atomic single-use via Redis `GETDEL`** (no concurrent-redeem race).
- TURN time-limited HMAC credentials correctly implemented and used by the hub.
- Input dispatcher gating/dedup/release-on-disable is correct and unit-tested; held keys/buttons released on disconnect.
- Media queue bounded with drop-oldest + recovery IDR; pipeline stop/Drop ordering correct.
- ICE restarts and signaling reconnects are bounded with capped exponential backoff (no retry storms).
- ABR controller clamped + rate-limited; no lock-across-await anywhere; state mutex never held across `.await`.
- IOSurface ping-pong reuse correctly avoids the encoder-holds-surface race.
- Backend env validation fails loudly at boot; FSM rejects illegal transitions; health endpoint honestly returns 503 on dependency loss.
- Memory: 3-minute 30fps soak showed no runaway growth (~24–37 MB RSS, stable).

---

## Launch checklist (v1.0, macOS beta)

1. **`git init` + remote + branch protection.**
2. **Backend auth (M5):** bind the signaling WS to the redeemed pairing token; reject unauthorized `roomId`/role/device.
3. **WSS everywhere:** TLS-terminating proxy in front of the backend; enforce `wss://`/`https://` in prod; reject plaintext in the QR payload.
4. **DoS limits:** per-IP WS connection cap, per-socket message-rate cap, room cap, fast idle-close of un-registered sockets.
5. **CI:** lint + typecheck + backend vitest (with PG/Redis services) + `cargo test` on a macOS runner, on every push.
6. **Code signing + notarization** (macOS Developer ID) and a **Tauri auto-updater** endpoint; set a real CSP.
7. **Mobile:** reconnect (`onclose` → backoff → re-register with a **persisted** deviceId), AppState background/foreground handling, fix the touch letterbox mapping, distinct failure UX.
8. **On-device video verification:** confirm the SPS/PPS fix decodes on a real phone at 720p (headless proof done; device proof pending).
9. **Observability:** backend `/metrics` (rooms, sessions, redeem failures, reap events) + Sentry/Crashlytics on all three clients.
10. **Secrets:** generate strong per-deploy `TURN_SECRET`/DB creds; confirm prod boot fails on any dev default (now enforced).

## Day-0 operational checklist

- Health probe (`GET /health`) wired to the load balancer; alert on 503.
- coturn reachable; run a forced TURN-relay connectivity test from a cellular device.
- Backend behind TLS; certificate valid and auto-renewing.
- Structured JSON logs shipping to aggregation; log level at `info`.
- Redis/Postgres backups + connection limits set; verify the server degrades (not crashes) when either is bounced.
- Rollback plan: previous signed desktop build retained; backend deploy is one revision back-revertible.

## Day-7 monitoring checklist

- Session success rate (pair → connected), median time-to-first-frame, TURN-relay %.
- Reconnect frequency and success; ICE-restart counts; zombie-session ends ("did not recover in time").
- p50/p95 capture→queued latency and encode time; keyframe rate; frames_dropped.
- Backend: concurrent rooms/sockets, reap events, redeem failures, WS payload rejections, Redis error rate.
- Crash-free session rate per client; memory RSS trend over multi-hour sessions (soak in the field).

## v1.0 release criteria

- Signaling authenticated; WSS-only; DoS limits in place; CI green on every push.
- Signed + notarized desktop build with a working auto-updater.
- Mobile reconnect + lifecycle + coordinate fix shipped and device-tested.
- On-device 720p session verified decodable and stable for ≥1 hour.
- `/metrics` + crash reporting live; no dev-default secrets in any environment.

## v1.1 roadmap

- Live VideoToolbox bitrate via `set_properties` (drop the rebuild-on-bitrate-change entirely).
- Windows backends (Media Foundation encode, Graphics Capture, SendInput verification).
- Resolution adaptation under sustained low bitrate; frame-drop policy tuning.
- Multi-monitor / display-change / sleep-wake handling in capture.
- Network-chaos + soak test harness in CI (latency/loss/NAT matrices, 24h runs).
- Mobile keyboard/scroll/gesture input; device-rotation coordinate remap.
- Observability overlay in the desktop debug panel (metrics already collected).
</content>
