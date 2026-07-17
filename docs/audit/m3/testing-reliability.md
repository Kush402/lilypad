# Lilypad M3 Engineering Audit — Testing & Reliability

**Auditor:** Staff Engineer, Quality/Reliability
**Scope:** Test coverage inventory and reliability-engineering gap analysis across `apps/backend`, `apps/desktop/src-tauri`, `apps/mobile`, and the CI/test-infrastructure story for the whole monorepo.
**Mandate:** M2 prototype → M5 production quality. No feature work — this document only proposes tests, harnesses, and process to _prove_ the existing behavior is correct and stays correct.

---

## Executive summary

Lilypad's backend signaling core (`SignalingHub`, `SessionStateMachine`, `SessionManager`, TURN credentials, transport guards) is genuinely well tested at the unit level — `apps/backend/src/signaling/hub.test.ts` in particular is a model of behavior-driven testing (happy path, spoofing, reconnect grace, capacity limits, metrics). The desktop Rust media pipeline is similarly strong at the component level: `media_pipeline.rs`, `pipeline_fault.rs`, and the gold-standard `rtc_media_e2e.rs` prove real H.264 → RTP flow in-process, and `abr.rs`'s pure bitrate-control logic has six solid unit tests. This is real, valuable coverage and should not be thrown away or duplicated.

But the audit surfaced a sharp discontinuity: **coverage stops exactly at the seams where components are wired together into a running session**, which is precisely where a remote-desktop product lives or dies in production. `run_session` in `apps/desktop/src-tauri/src/session.rs` — by line count and cyclomatic complexity the single most complex function in the codebase (289 lines, a 7-armed `select!` loop driving ICE restarts, signaling reconnect, pairing timeouts, recovery deadlines, and pipeline lifecycle) — has exactly one unit test, and it tests a pure helper function (`backoff_delay`, session.rs:627-636), not the orchestration itself. The mobile app has zero test runner configured at all, and reading its signaling client during this audit surfaced a live-looking bug that testing infrastructure would have caught on day one: `MobileSignaling` (`apps/mobile/src/lib/signaling.ts`) never registers a `ws.onclose` handler and has no reconnect logic whatsoever, while the desktop side (`session.rs:105-123`) has a full exponential-backoff reconnect path — the two ends of the same handshake are asymmetric, untested, and never proven to interoperate. There is no CI configuration in the repository at all (`.github/` does not exist); nothing currently stops any of this from regressing silently on every merge.

The report below inventories what's tested, names the concrete untested surfaces, and proposes 13 prioritized findings: a fake-based test harness for `run_session`, an ICE-restart/recovery-deadline test suite, a fix-and-test plan for mobile reconnect, a GitHub Actions CI matrix, a backend-restart/mid-session reliability model, a network-simulation and chaos-testing harness (built from the existing but currently manual `headless_offer`/`headless_mobile_peer` fixtures), a 24-hour soak-test design, and CI-wired performance-regression gates for the existing `bench_*` benchmarks. None of these require new product features — they require investing in the test harnesses the codebase's own architecture (dependency injection, trait boundaries, fake `Peer`/`KvStore`/capture backends) already makes possible but nobody has yet finished plumbing to the orchestration layer.

---

## Cross-cutting: proposed test pyramid (reference for all findings below)

| Layer                                              | Today                                                                                                                                                        | Proposed additions (see findings for detail)                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **L0 — pure logic (unit)**                         | Strong: `stateMachine.test.ts`, `guards.test.ts`, `credentials.test.ts`, `protocol.test.ts`, `abr.rs` tests, `convert.rs`/`software.rs`/`synthetic.rs` tests | Add: `session.rs` pure helpers beyond `backoff_delay` (recovery-deadline arithmetic, ICE-restart-budget arithmetic) |
| **L1 — component/service (fakes for I/O)**         | Strong on backend (`hub.test.ts`, `manager.test.ts`, `pairing.test.ts`); **absent** for `run_session`                                                        | Add: `session.rs` test harness with fake `SignalingHandle`/`WebRtcPeer`/`MediaPipeline` traits (Finding 1)          |
| **L2 — integration (real subsystems, in-process)** | Strong for media (`media_pipeline.rs`, `pipeline_fault.rs`), **absent** for signaling↔session, HTTP routes                                                   | Add: route-level Fastify `.inject()` tests (Finding 10); Rust↔Rust reconnect-vs-hub interop test (Finding 12)       |
| **L3 — E2E (real network, real processes)**        | One gold-standard manual fixture (`rtc_media_e2e.rs`); `headless_offer`/`headless_mobile_peer` are manual-only, unasserted                                   | Add: automated CI job driving the headless fixtures with assertions + injected network faults (Finding 6)           |
| **L4 — chaos / soak**                              | None                                                                                                                                                         | Add: kill-9 matrix, network-impairment matrix, 24h soak harness (Findings 6, 7)                                     |
| **L5 — performance regression**                    | `bench_encode`/`bench_input`/`bench_pipeline` exist, print-only, manual, not in CI                                                                           | Add: JSON output + threshold gate in CI (Finding 9)                                                                 |
| **Process — CI**                                   | None (`.github/` absent)                                                                                                                                     | Add: GitHub Actions matrix (Finding 4)                                                                              |

---

## Finding 1 — `run_session` (the core orchestration function) has zero behavioral test coverage

**Severity:** critical

### Current implementation

`run_session` is defined at `apps/desktop/src-tauri/src/session.rs:126-415`. It is a single `tokio::select!` loop (session.rs:180-395) with seven concurrent arms: pairing-timeout, inbound signaling, media-pipeline-failure, signaling-reconnect-completion, UI control commands, peer events (including ICE-restart and ABR wiring), and a heartbeat/recovery-deadline tick. It owns and mutates eight pieces of state across the loop body: `sig`, `inbound: Option<...>`, `reconnecting: bool`, `peer: Option<Arc<WebRtcPeer>>`, `pipeline: Option<MediaPipeline>`, `abr: Option<BitrateController>`, `peer_connected: bool`, `input_channel_open: bool`, `ice_restarts: u32`, `recovery_deadline: Option<Instant>`, and `paired: bool`.

The only test in the file is the `#[cfg(test)] mod tests` block at session.rs:622-637, which tests exactly one pure function, `backoff_delay` — it asserts the exponential-backoff schedule (500ms → 1s → 2s → 4s → 8s, capped) and nothing else. No test constructs a `run_session` future, drives it with synthetic `Control`/`Envelope`/`PeerEvent` inputs, and asserts on the `SessionEvent`s it emits or the state transitions it makes.

The four Rust integration test files that exist (`input_worker.rs`, `media_pipeline.rs`, `pipeline_fault.rs`, `rtc_media_e2e.rs`) all test components `run_session` composes (`InputWorker`, `MediaPipeline`, `WebRtcPeer`) in isolation — none of them drive `run_session` itself. The two `examples/headless_*.rs` binaries (`headless_offer.rs`, `headless_mobile_peer.rs`) do exercise `run_session` end-to-end against a live backend, but they are manual `cargo run` scripts with no `#[test]` attribute, no CI wiring, and no assertions beyond `eprintln!` (headless_offer.rs:41, headless_mobile_peer.rs:196) — a human has to read stderr to know if they passed.

### Problems

1. Every one of the following behaviors — which together define whether a live remote-desktop session survives real-world network conditions — has never been exercised by an automated test: a repeat `session-start` correctly closing the stale `peer` (session.rs:541-544); a signaling drop while `peer_connected` correctly entering background reconnect instead of ending the session (session.rs:204-227); a signaling drop while _not_ `peer_connected` correctly ending the session immediately (session.rs:221-225); `Control::Disconnect` arriving _while_ a reconnect is in flight (the `select!` must still service the `ctrl` arm — this is the exact race the code comment at session.rs:140-142 calls out as "H5" but no regression test pins it); the ICE-restart budget exhausting and ending the session (session.rs:329-332); the recovery deadline firing on the heartbeat tick when a restart never completes (session.rs:386-393); the pairing-abandonment timeout firing when no device ever pairs (session.rs:182-186); and RTCP-driven ABR retargeting actually reaching `pipeline.control().set_target_bitrate()` (session.rs:352-365).
2. Because the function is untested, refactors are dangerous by construction — any change to the `select!` arm ordering, the `Option` state machine, or the boolean gating (`peer_connected && input_channel_open`, session.rs:307) can silently reintroduce a zombie session or a double-inject-after-disconnect bug with no automated signal.
3. The function currently cannot be unit-tested even by a motivated engineer without a redesign: `signaling::connect`, `WebRtcPeer::new`, and `MediaPipeline::start` are called as free functions/inherent methods (session.rs:133, 545, 485), not through an injectable trait, so a test cannot substitute a fake transport or a fake peer the way `hub.test.ts` substitutes `FakePeer` for the backend.

### Root cause

The backend's `SignalingHub` was explicitly designed for testability: `Peer` is a trait (hub.ts:16-19), dependencies are injected via `SignalingHubDeps` (hub.ts:22-44), and time is injected via `now()`. `run_session` was not given the same treatment — `signaling::connect`, `WebRtcPeer`, and `MediaPipeline` are concrete types called directly, so there is no seam at which a test can substitute a controllable fake. This is an architectural asymmetry between the two halves of the same product (backend vs. desktop), not a lack of testing skill — the backend team's pattern is right there to copy.

### Redesign

Introduce three narrow traits at the exact points `run_session` currently calls concrete constructors, and thread them through as generic parameters (or `Box<dyn Trait>`, given this is not a hot path):

```rust
#[async_trait::async_trait]
pub trait SignalingTransport: Send + Sync {
    fn send(&self, env: Envelope) -> Result<()>;
}
pub trait PeerHandle: Send + Sync {
    async fn create_offer(&self) -> Result<String>;
    async fn set_answer(&self, sdp: String) -> Result<()>;
    async fn add_ice_candidate(&self, c: String, mid: Option<String>, idx: Option<u16>) -> Result<()>;
    async fn restart_ice(&self) -> Result<String>;
    async fn close(&self) -> Result<()>;
}
pub trait PipelineHandle: Send + Sync {
    fn control(&self) -> Arc<PipelineControl>;
    fn metrics(&self) -> Arc<PipelineMetrics>;
    fn stop(&mut self);
}
```

Extract `run_session`'s body into `run_session_inner<T: SignalingTransport, P: PeerHandle, ...>` (or use `Box<dyn Trait>` for simplicity given this is not a hot path) so the existing thin `run_session` entry point still constructs the real types, but tests call `run_session_inner` with fakes: a `FakeSignaling` that lets the test script inbound `Envelope`s and inspect outbound sends (mirroring `FakePeer` in hub.test.ts:5-20 exactly), a `FakePeerHandle` whose `restart_ice()` can be told to hang or fail, and a `FakePipelineHandle` that never touches real capture/encode. This is the same shape of investment the backend already made for `SignalingHub` — it is not new architecture, it is parity.

### Tradeoffs

Introducing trait objects on `WebRtcPeer`/`MediaPipeline` costs a small amount of dynamic-dispatch overhead (negligible next to the encode/network cost already in the loop) and a refactor risk window while `run_session` is restructured — mitigate by doing the extraction as a pure signature change with no logic edits, verified by running the existing `headless_offer`/`headless_mobile_peer` manual fixtures before and after to confirm identical behavior.

### Implementation plan

1. Define the three traits above in a new `session::fakes` (test-only, `#[cfg(test)]`) module plus production impls (thin wrappers around the existing concrete types) — 0.5 day.
2. Extract `run_session_inner` taking the traits as parameters; `run_session` becomes a 5-line adapter — 1 day, no behavior change.
3. Write the fake implementations (`FakeSignaling`, `FakePeerHandle`, `FakePipelineHandle`) — 1 day.
4. Write the test cases enumerated below — 2-3 days.

### Migration strategy

No production migration — this is additive test infrastructure. Land the trait extraction and fakes in one PR with no behavior change (verified by the manual headless fixtures still passing), then land test cases incrementally in follow-up PRs so review stays small.

### Testing strategy

Concrete named test cases for `run_session_inner` (L1, using the fakes above):

- `repeat_session_start_closes_stale_peer` — send two `session-start` envelopes; assert the fake peer's `close()` was called once before the second `create_offer()`.
- `signaling_drop_before_connect_ends_session` — drop the inbound channel with `peer_connected == false`; assert a single `SessionEvent::Ended{reason: "signaling closed"}` and no reconnect spawned.
- `signaling_drop_after_connect_reconnects_in_background` — drop inbound with `peer_connected == true`; assert `SignalingReconnecting` fires and the loop keeps servicing a `Control::Disconnect` sent immediately after (regression pin for "H5").
- `disconnect_during_reconnect_is_serviced_immediately` — same setup, assert `Control::Disconnect` is processed within one poll, not blocked behind the reconnect future.
- `ice_restart_budget_exhausts_and_ends_session` — feed `PeerEvent::ConnectionState("failed")` `MAX_ICE_RESTARTS + 1` times without ever reporting "connected"; assert the session ends with "ICE restarts exhausted" after exactly `MAX_ICE_RESTARTS` restart attempts.
- `recovery_deadline_fires_on_heartbeat_tick` — trigger a "failed" state, advance a fake clock past `RECOVERY_TIMEOUT` without the peer reporting "connected", tick the heartbeat; assert `Ended{reason: "connection did not recover in time"}`.
- `successful_ice_restart_resets_budget` — fail once, restart, report "connected"; assert `ice_restarts` and `recovery_deadline` are reset (session.rs:304-306), then fail again and confirm the full budget is available again.
- `pairing_timeout_fires_when_nobody_scans` — never send `pair-request`; advance past `pairing_timeout()`; assert `Ended{reason: "pairing expired…"}`.
- `pair_request_disarms_pairing_timeout` — send `pair-request`, advance past the pairing timeout; assert the session is still alive.
- `abr_loss_report_retargets_pipeline_bitrate` — with a pipeline+abr present, send `PeerEvent::VideoLossReport{fraction_lost: 0.5}`; assert the fake pipeline's `set_target_bitrate` was called with the value `BitrateController::on_loss_report` would produce.
- `input_disabled_immediately_on_media_failure` — send on `media_fail_tx`; assert `input.set_enabled(false)` happens before `Ended` is emitted (ordering matters: never let input act on a frozen frame).
- `keyframe_request_reaches_pipeline_control` — send `PeerEvent::VideoKeyframeRequest`; assert `request_keyframe()` was called on the fake pipeline.

### Risk assessment

Without this, the riskiest class of bug — a regression in the reconnect/ICE-restart/recovery-deadline state machine — ships silently, because it is invisible to every other test in the suite (they test the components this function _composes_, not the composition). Given this code sits directly on the "does the session survive a network blip" promise the product is sold on, this is the single highest-leverage test investment in the codebase.

### Performance impact

None on the runtime hot path (encode/RTP send bypass this loop's per-message overhead entirely); trait dispatch adds nanoseconds against millisecond-scale I/O. Test suite runtime: each fake-driven test completes in milliseconds (no real sockets/media), so this is cheap to run on every commit.

### Future extensibility

Once the trait seams exist, the same fakes support testing future features (e.g., a second video track, audio) without re-deriving the harness, and they compose with the network-simulation harness proposed in Finding 6 by letting `FakePeerHandle`/`FakeSignaling` inject configurable latency/loss/hangs.

---

## Finding 2 — Mobile signaling client has no reconnect logic, and no test harness exists that would have caught it

**Severity:** critical

### Current implementation

`apps/mobile/src/lib/signaling.ts`'s `MobileSignaling.connect()` (signaling.ts:22-34) wires exactly three WebSocket handlers: `ws.onopen` (resolves the connect promise), `ws.onerror` (rejects the promise — but only during the initial connect, since the promise is already settled after that), and `ws.onmessage`. **There is no `ws.onclose` handler at all**, anywhere in the class. `ViewerConnection` (`apps/mobile/src/lib/webrtc.ts:31-53`) calls `this.sig.connect()` once in `start()` and never re-invokes it. The desktop side, by contrast, has a fully worked-out exponential-backoff reconnect path: `reconnect_signaling` (session.rs:105-123) retries up to `MAX_SIGNALING_RECONNECTS` (5) times with `backoff_delay` spacing, and `run_session` re-registers on success (session.rs:214-220, 242-256).

`ViewerConnection`'s heartbeat (webrtc.ts:51: `setInterval(() => this.sig.heartbeat(), 10_000)`) keeps calling `MobileSignaling.emit()` (signaling.ts:37-39, `this.ws?.send(...)`) every 10 seconds regardless of socket state, with no try/catch around the `send` call.

### Problems

1. Any transient network interruption on the mobile side (going into an elevator, switching Wi-Fi↔cellular, backend restart/redeploy) — the exact scenarios this product exists to handle gracefully — permanently and silently kills the mobile's signaling channel. The desktop may successfully reconnect and hold its seat open per the grace window (`hub.ts:163-192`, `reregisterGraceMs`), but the mobile side never attempts to reconnect, so any subsequent signaling-dependent action (ICE restart's new offer/answer exchange, a fresh `pair-request` after a backend restart) can never complete on that device again — the user has to manually kill and restart the app.
2. `WebSocket.send()` on a socket in `CLOSING`/`CLOSED` state can throw in some RN WebSocket polyfills; `emit()` has no try/catch (signaling.ts:37-39), so the 10-second heartbeat interval (webrtc.ts:51) risks an unhandled exception on a background timer after any drop.
3. This is not a hypothetical — it is the direct, provable consequence of reading the two halves of the same handshake side by side. It went unnoticed because **no test exists that exercises `MobileSignaling`'s or `ViewerConnection`'s behavior under a simulated socket close**, and no such test _can_ exist yet because there is no test runner configured for `apps/mobile` at all (see Finding 3) — this finding is the concrete, motivating example for why that gap matters, not an abstract "coverage percentage" complaint.

### Root cause

The desktop's `session.rs` reconnect logic was built later (it is explicitly gated behind comments referencing "H5" — an issue/hypothesis ID — session.rs:141) as a deliberate reliability fix. The equivalent fix on the mobile side was never made, and because mobile has no test infrastructure, there was no automated signal that the two ends had drifted out of parity.

### Redesign

Add an `onclose` handler to `MobileSignaling` that, when the socket closes unexpectedly (not via the explicit `close()` teardown method, signaling.ts:113-116), invokes a caller-supplied reconnect callback with the same exponential-backoff shape as `backoff_delay` (mirror session.rs:96-100 in TypeScript for parity, e.g. move it into `@lilypad/protocol` or a shared mobile util so both ends literally share the constant). On reconnect, `ViewerConnection` must re-register and, if no `session-start` has been seen yet, re-send `pair-request`; if a session was already established, it should NOT re-request pairing (mirroring the backend's `reregisterGraceMs` seat-hold semantics at hub.ts:281-292) — just re-register into the held seat so any pending signaling (ICE-restart offer/answer) can flow again. Guard `emit()` with try/catch so a mid-teardown send never throws into a bare timer callback.

```ts
// signaling.ts
private explicitClose = false;
connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('signaling connection failed'));
    ws.onclose = () => {
      this.ws = null;
      if (!this.explicitClose) this.onDisconnect?.();
    };
    ws.onmessage = (e) => { /* unchanged */ };
  });
}
```

`ViewerConnection` supplies `onDisconnect` = a bounded-retry reconnect (same backoff table as `backoff_delay`) that calls `connect()` + `register()`, and re-sends `pairRequest()` only if `session-start` was never received.

### Tradeoffs

A naive reconnect-and-re-pair-request risks a double `pair-request` landing on an already-approved session if the timing races the desktop's own grace window; the redesign above avoids this by tracking whether `session-start` was ever received, but this state must be threaded carefully and is exactly the kind of logic that needs the test harness from Finding 3 to pin down before shipping.

### Implementation plan

1. Add the shared backoff constant/helper (TS port of session.rs:96-100) to `@lilypad/protocol` or a new `@lilypad/mobile/lib/backoff.ts` — 0.5 day.
2. Add `onclose`/reconnect wiring to `MobileSignaling` + `ViewerConnection` per the redesign — 1 day.
3. Write the mobile test suite (Finding 3) in parallel so this change ships with regression tests, not after.

### Migration strategy

No data migration. Ship behind no flag — this is a pure bug fix restoring intended behavior (the backend already assumes reconnect is possible via its grace window; the mobile fix makes that assumption true). Validate manually first with the existing `headless_offer`/`headless_mobile_peer` fixtures plus a real device before merging, since this is exactly the kind of change that needs to be proven against the real hub semantics (see Finding 12).

### Testing strategy

Once Finding 3's Jest harness exists, named test cases:

- `reconnects_on_unexpected_close_with_backoff` — mock `WebSocket`, trigger `onclose`, assert a new `WebSocket` is constructed after the expected backoff delay (fake timers).
- `does_not_reconnect_on_explicit_close` — call `close()`, assert no reconnect attempt.
- `re_registers_but_does_not_repair_after_session_established` — simulate receiving `session-start` before the drop; assert reconnect sends `register` but not a second `pair-request`.
- `repairs_if_dropped_before_session_start` — simulate a drop before `session-start`; assert reconnect resends both `register` and `pair-request`.
- `heartbeat_does_not_throw_on_closed_socket` — close the socket, advance the heartbeat timer, assert no unhandled exception.
- Integration (L2, against a real in-process `SignalingHub` instance from the backend test suite, or a lightweight fake server): drop the mobile's WS mid-session, advance past `reregisterGraceMs`, reconnect, assert the room in `SignalingHub` is still alive and routes an ICE-restart offer through correctly (this closes the interoperability gap named in Finding 12).

### Risk assessment

This is the highest-severity _product-correctness_ bug this audit surfaced (as opposed to a coverage gap): it means the mobile app cannot survive the exact network conditions ("internet-first" mobile use — cellular handoffs, brief drops) the product's positioning is built on, and it currently fails silently with no user-facing signal beyond "control just stops working."

### Performance impact

Negligible — a bounded reconnect attempt count with backoff, identical cost shape to the already-shipped desktop side.

### Future extensibility

Sharing the backoff constant between desktop and mobile (rather than each hand-rolling it) means future tuning (e.g., adjusting `MAX_SIGNALING_RECONNECTS`) only has one place to change, and the re-pair-vs-re-register distinction generalizes cleanly to any future multi-viewer or session-handoff feature.

---

## Finding 3 — Mobile app has no test runner configured; zero test files exist

**Severity:** high

### Current implementation

`apps/mobile/package.json` (read in full) defines scripts for `start`, `ios`, `android`, `pods`, `typecheck`, `lint`, `clean` — no `test` script exists. No Jest config file, `jest.config.js`, or `jest` key exists anywhere under `apps/mobile`. `find apps/mobile -iname "*.test.*"` returns zero files. `apps/mobile/src/lib/webrtc.ts` (164 lines) and `apps/mobile/src/lib/signaling.ts` (117 lines) — the entire viewer-side session/signaling logic — have never been executed by an automated test.

### Problems

1. Finding 2's bug is the direct, demonstrated cost of this gap — it is not a theoretical "we should have more tests" concern.
2. `ViewerConnection.onSignal` (webrtc.ts:59-90) is a state-machine dispatcher structurally identical in spirit to `SignalingHub.dispatch` (hub.ts:303-380), which is exhaustively tested on the backend — the mobile equivalent has never been exercised for a single one of its six message-type branches.
3. `InputSender` (referenced at webrtc.ts:124, `apps/mobile/src/lib/input.ts`) and the QR-scan → `redeemPairing` flow (`apps/mobile/src/lib/api.ts`) are similarly untested; a coalescing/encoding bug in `InputSender` would only surface as "touch doesn't work" in manual QA.

### Root cause

React Native test infrastructure (Jest + `react-native-webrtc`/`react-native` mocks) was never bootstrapped for this package, likely because M2's priority was getting a live demo working, not test scaffolding — reasonable for a prototype, not for M5.

### Redesign

Add `jest` + `jest-expo`-style RN preset (or `react-native`'s own default Jest preset, since this is bare RN not Expo) as a devDependency, with a `jest.config.js` using `preset: 'react-native'` and manual mocks for `react-native-webrtc` (`RTCPeerConnection`, `RTCSessionDescription`, `RTCIceCandidate`, `MediaStream`) and the global `WebSocket`, since neither has a usable implementation under Node/Jest. Structure: `__mocks__/react-native-webrtc.ts` exporting jest-mock classes whose event-listener registration (`addEventListener`) is capturable so tests can fire `track`/`icecandidate`/`connectionstatechange`/`datachannel` events synchronously, matching the pattern `webrtc.ts:95-133` already uses (a thin structural cast over the real RN API), which makes it comparatively easy to mock precisely.

### Tradeoffs

RN component/screen tests (anything touching `react-native-vision-camera` for QR scanning) are harder to mock well and lower value per hour than the pure logic in `lib/`; scope this finding to `lib/webrtc.ts`, `lib/signaling.ts`, and `lib/input.ts` first — these are the reliability-critical surfaces — and treat screen/component tests as a separate, lower-priority follow-up.

### Implementation plan

1. Add `jest`, `@types/jest`, `ts-jest` or `babel-jest`, `react-test-renderer` (matching the RN version already pinned, 0.76.5) — 0.5 day.
2. Write `__mocks__/react-native-webrtc.ts` — 1 day.
3. Add `"test": "jest"` to `apps/mobile/package.json` scripts and wire it into `turbo.json`'s task graph (see Finding 4/13) — 0.5 day.
4. Write the test suites named in Finding 2's testing strategy plus baseline coverage for `onSignal`'s other five branches (`offer`, `ice-candidate`, `pair-denied`/`disconnect`/`session-end`, `error`) and `InputSender` coalescing — 2 days.

### Migration strategy

Purely additive; no production code path changes required to add the harness (only the Finding 2 fix touches production code, and it should land together with its tests).

### Testing strategy

Named test cases beyond Finding 2's list:

- `onSignal_offer_sets_remote_description_and_answers` — feed an `offer` message, assert `pc.setRemoteDescription`/`createAnswer`/`setLocalDescription` were called and `sig.answer()` was sent with the resulting SDP.
- `onSignal_ice_candidate_is_added_and_swallows_errors` — feed a candidate before `setupPeer` has run (`pc` is null); assert no throw (webrtc.ts:68-69's `?.` should protect this — pin it).
- `onSignal_terminal_types_close_and_report_ended` — for each of `pair-denied`/`disconnect`/`session-end`, assert `cb.onState('ended')` and that `close()` tore down the heartbeat, data channel, and peer connection.
- `datachannel_event_only_wires_the_input_channel_by_label` — fire a `datachannel` event with a non-matching label; assert `input`/`dataChannel` stay null (webrtc.ts:121-122's label check).

### Risk assessment

Low risk to add (pure test infra); high risk of continued silent regressions on the mobile viewer if deferred, especially as the desktop side continues to evolve its reconnect sophistication without a corresponding mobile-side check.

### Performance impact

None on the shipped app; CI job runtime is milliseconds-to-seconds for this suite.

### Future extensibility

Once the Jest harness and WebRTC mocks exist, they're reusable for any future mobile feature (audio, clipboard sync, multi-monitor selection) that touches the same `pc`/data-channel surface.

---

## Finding 4 — No CI pipeline exists anywhere in the repository

**Severity:** critical

### Current implementation

`.github/` does not exist in the repository (confirmed via `find .github -type f` returning nothing). `turbo.json` (read in full) defines exactly four tasks: `build`, `dev`, `lint`, `typecheck` (turbo.json:12-31) — **there is no `test` task**, so even `turbo run test` from the root would no-op across every workspace rather than fail loudly, because Turborepo silently skips packages that don't define the requested script. The root `package.json`'s `scripts` block likewise has no `test` entry. `apps/backend/package.json` does define `"test": "vitest run"`, but nothing outside a developer's local terminal ever invokes it. Rust tests (`cargo test`), clippy, and `cargo fmt --check` have no invocation path anywhere in the repo's tooling.

### Problems

1. Every unit/integration test described elsewhere in this report — including the strong existing backend suite — currently runs only when a developer remembers to run it locally. A PR with a broken `hub.test.ts` or a `cargo test` failure in `pipeline_fault.rs` can merge to `main` with no automated signal.
2. There is no automated `clippy`/`eslint`/`tsc --noEmit` gate either, despite `lint`/`typecheck` already being defined turbo tasks (turbo.json:21-27) — they simply aren't invoked by anything but a human.
3. `apps/desktop/src-tauri`'s Rust tests require the `openh264`/`webrtc`/(on macOS) `screencapturekit`/`videotoolbox` toolchains to even compile; without CI, there is no continuously-verified guarantee the crate compiles and its test suite passes on a clean machine, only "it worked on the last engineer's laptop."

### Root cause

CI setup is pure process debt from an M2 prototype phase where the team was a small group iterating on a local machine — reasonable for that phase, a blocking gap for M5.

### Redesign

Add `.github/workflows/ci.yml` with the following job matrix (macOS runner required for the Rust jobs, since `screencapturekit`/`videotoolbox` are macOS-only cfg-gated dependencies — Cargo.toml's `[target.'cfg(target_os = "macos")'.dependencies]` block confirms this; Linux CI would need `LILYPAD_CAPTURE_KIND=synthetic`/`LILYPAD_ENCODER_KIND=software` env overrides per session.rs:425-437/446-457 to build a Linux-only subset):

```yaml
name: CI
on: [pull_request, push: { branches: [main] }]
jobs:
  ts-unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @lilypad/backend test
      - run: pnpm --filter @lilypad/mobile test # once Finding 3 lands

  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run lint typecheck

  rust-unit-integration:
    runs-on: macos-14
    env: { LILYPAD_CAPTURE_KIND: synthetic, LILYPAD_ENCODER_KIND: software }
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets

  rust-lint:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { components: clippy, rustfmt }
      - run: cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
      - run: cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check

  network-sim-e2e: # Finding 6 — nightly/on-label only, not every PR (slow)
    if: github.event_name == 'push' || contains(github.event.pull_request.labels.*.name, 'run-e2e')
    runs-on: macos-14
    services: { redis: { image: redis:7 }, postgres: { image: postgres:16 } }
    steps:
      [
        '…brings up backend + runs headless_offer/headless_mobile_peer under tc/network-link-conditioner faults, see Finding 6',
      ]

  bench-regression: # Finding 9 — informational on PRs, gate on main
    runs-on: macos-14
    steps: ['…runs bench_encode/bench_input/bench_pipeline, compares to baseline, see Finding 9']
```

Require `ts-unit`, `lint-and-typecheck`, `rust-unit-integration`, and `rust-lint` as required status checks on `main`; treat `network-sim-e2e` and `bench-regression` as advisory-then-required once stabilized (they're new and slower, so gate incrementally to avoid blocking shipping on day one of adding them).

### Tradeoffs

macOS GitHub-hosted runners are more expensive per-minute than Linux; mitigate by keeping the Linux-only TS jobs (which are the majority of PRs' changes) fast and cheap, and reserving macOS runners for the Rust jobs. Full `cargo test --all-targets` on `rtc_media_e2e.rs` involves real (loopback) WebRTC/ICE/DTLS negotiation and is not instant (~5-10s per the test's own polling loop, rtc_media_e2e.rs:143-150) — acceptable for a required check, but should be watched for flakiness under CI resource contention (loopback ICE timing can be sensitive to a noisy-neighbor runner).

### Implementation plan

1. Add `turbo.json`'s missing `test` task (Finding 13) so `turbo run test` fans out correctly — 0.5 day.
2. Author `.github/workflows/ci.yml` per above, starting with `ts-unit`/`lint-and-typecheck`/`rust-unit-integration`/`rust-lint` as required checks — 1 day.
3. Add `network-sim-e2e` and `bench-regression` as advisory jobs once Findings 6/9 exist — separate PRs.
4. Turn on branch protection requiring the four core jobs before enabling the advisory ones as required.

### Migration strategy

No code migration. Land CI first with jobs in "advisory" (non-blocking) mode for one week to catch flaky-test noise, then flip to required.

### Testing strategy

CI's own correctness is verified by deliberately breaking each job once in a scratch branch (a failing test, a clippy warning, a `cargo fmt` diff) and confirming the workflow reports red — standard CI-of-CI verification, not a persistent test.

### Risk assessment

This is the connective tissue for every other finding in this report: without it, none of the new tests proposed elsewhere are enforced, only suggested. It is also the highest "impact per hour of engineering time" item in the whole audit — a day of YAML unlocks continuous enforcement of everything else.

### Performance impact

Adds a few minutes of CI wall-clock per PR; no runtime product impact.

### Future extensibility

The job matrix generalizes cleanly to admin app tests, additional platform targets (Windows Graphics Capture per session.rs:428's noted M3-tracked gap), and future soak/chaos jobs (Findings 6/7) as scheduled/nightly workflows.

---

## Finding 5 — Backend restart or crash mid-session has no test coverage, and the current architecture cannot recover an established session across it

**Severity:** high

### Current implementation

`SignalingHub`'s entire room/seat state lives in two in-process `Map`s (`hub.ts:85-86`: `rooms: Map<string, Room>` and `ctx: Map<Peer, PeerCtx>`), with no persistence or replication. Session _records_ are separately persisted to Redis via `SessionManager` (`manager.ts:38-93`, keyed `lilypad:session:{id}`, TTL default 3600s at manager.ts:41, 91), but the routing state that lets a WebSocket message reach the other seat — `Room.desktop`/`Room.mobile`/`Room.established`/`Room.vacatedAt` — exists only in that one process's memory (`hub.ts:52-68`).

On graceful shutdown, `index.ts:10-25`'s `SIGTERM`/`SIGINT` handler calls `app.close()`, which fires the `onClose` hook registered at `signaling.ts:51-55`, which calls `hub.shutdownAll('server shutting down')` (`hub.ts:236-240`) — this correctly notifies every live peer with `session-end` before closing (hub.ts:443-446). On an *un*graceful death (`kill -9`, OOM-kill, crash), none of that runs; both peers simply see their raw sockets drop with no application-level notice.

The desktop's `reconnect_signaling` (session.rs:105-123) will retry against the new process, and its `register` message will succeed against the fresh (empty) hub — `SignalingHub.register` (hub.ts:248-301) creates a brand-new `Room` in `idle` state whenever `this.rooms.get(msg.roomId)` misses (hub.ts:262-274), with no concept of "this room used to be `connected`." The mobile side, per Finding 2, currently has no reconnect logic at all, so in the un-graceful-crash case neither peer will complete a fresh `pair-request → approve → offer → answer` cycle automatically — even after Finding 2 is fixed, `ViewerConnection`'s reconnect only re-registers/re-pairs, and a _new_ pairing needs a fresh QR-derived `roomId`/token in general, since the original pairing token was already single-use-consumed (`pairing.ts:35-51`'s `redeemPairing` burns the token on first use) — meaning a from-scratch re-pair after this kind of crash is not even possible via the existing reconnect path without a new pairing token.

### Problems

1. No test exists anywhere in the suite that simulates "the `SignalingHub` process restarts mid-session" and asserts on the resulting behavior — this is a completely blind spot, and per the above analysis, the _actual_ current behavior is "the session cannot recover automatically," which is worth confirming deliberately with a test rather than leaving as an emergent property nobody decided on.
2. This directly undermines the value of the sophisticated mid-session reconnect-grace logic tested so well in `hub.test.ts:176-274` — that logic protects against _transport_ drops (a socket blip), but a _process_ restart (routine redeploys, autoscaling, crash-and-restart) is functionally indistinguishable to the surviving peer from "the whole session died," even though the underlying P2P media/input path (which doesn't route through the backend at all once connected) might still be perfectly healthy.
3. Because `SessionManager` records have a 1-hour TTL and are never explicitly ended on an un-graceful crash, a session that was `connecting`/`connected` at crash time will show as "still active" in any admin/observability surface reading Redis for up to an hour after the backend that owned it is gone (manager.ts:41 default TTL, manager.ts:78-88's `end()` — which nothing calls on a crash — is the only path that marks `disconnected`).

### Root cause

The backend was built as a single stateful process for signaling routing, which is a reasonable M2/M3 choice (rooms are cheap, and it avoids the complexity of a distributed room registry), but the reliability implications of that choice — every process restart is a hard session boundary — were never made explicit as a tested, intentional contract, so nobody has evaluated whether it's an acceptable production tradeoff or needs Redis-backed room state (e.g., storing `Room` seat assignments and `established`/`vacatedAt` in Redis, keyed by `roomId`, so any backend replica can pick up routing for a room even after the original process dies) before M5 ships against real infrastructure that does rolling deploys and autoscaling.

### Redesign

Two complementary changes:

1. **Make the current behavior explicit and correct, not accidental.** On an un-graceful crash there is nothing the crashed process can do post-mortem, but the _next_ process's `register()` should distinguish "a genuinely new room" from "a room that used to exist" — this requires minimal persisted room metadata in Redis (roomId → {sessionId, scopes, established, deviceIds}, short TTL e.g. 60s, refreshed on heartbeat) so a freshly-started backend replica can detect "this roomId had an established session" and, on the first peer's re-register, hold that seat open (mirroring the in-memory `vacatedAt` grace logic at hub.ts:281-292) for the _other_ seat to also reconnect, rather than silently starting a fresh `idle` room. This closes the gap for the common case (rolling deploy / crash-restart with both peers attempting reconnect within seconds) without requiring full room-state replication.
2. **Explicitly end orphaned session records fast.** Add a startup task that, on boot, scans for `SessionRecord`s in a live (non-terminal) state whose `updatedAt` is older than some short "no heartbeat could have been missed for this long" threshold (e.g. 2x the heartbeat interval, `signaling.ts:50`'s `10_000`ms reaper tick, so ~20-30s) and marks them `disconnected` — bounding the "shows as active but isn't" window from up to an hour down to roughly one health-check cycle after the new process boots.

### Tradeoffs

Persisting room routing metadata to Redis adds a small latency/complexity cost to `register()`/`approve()` (an extra round-trip) and a new failure mode (Redis unavailable during the exact window a backend is restarting) — mitigate by making the Redis room-metadata write best-effort/fire-and-forget (matching the existing `onSessionStart`/`onSessionEnd` pattern at hub.ts:26-34, which are explicitly documented as "the hub never awaits them") so a Redis hiccup degrades to today's behavior rather than blocking signaling.

### Implementation plan

1. Add a `RoomRegistry` Redis-backed companion to `SignalingHub` (roomId → JSON blob, ~60s TTL, refreshed each `reapStale()`/heartbeat tick) — 2 days.
2. Wire `register()` to consult it on a local miss before creating a fresh `idle` room, holding the seat per the existing grace pattern — 1 day.
3. Add the boot-time orphaned-session sweep to `index.ts`'s startup path — 0.5 day.
4. Write the tests below — 1-2 days.

### Migration strategy

Ship the Redis room-metadata write first (additive, unused), then the read-and-hold-seat behavior behind a check that degrades safely if the Redis key is absent (treats it identically to today — a fresh room). No backward-incompatible wire format changes.

### Testing strategy

Since this spans two processes, model it as an L2 integration test using two independently-constructed `SignalingHub` instances sharing a fake Redis-backed `RoomRegistry` (mirroring `FakeKv`/`FakePairingRedis` already used in `manager.test.ts:5-17`/`pairing.test.ts:10-23`):

- `second_hub_instance_holds_seat_for_a_room_the_first_instance_established` — establish a room to `connected` on hub A, simulate A's death (drop it without calling any teardown), register the same desktop device on hub B, assert the seat is held/reserved for the mobile device exactly as the in-process grace test does (mirroring hub.test.ts:202-217).
- `boot_sweep_marks_stale_connecting_sessions_disconnected` — seed a `SessionRecord` in `connected` state with an old `updatedAt` via `FakeKv`, run the sweep, assert `end()` was called.
- `redis_unavailable_during_register_falls_back_to_fresh_room` — make the fake `RoomRegistry` throw, assert `register()` still succeeds (degrades to current behavior) rather than propagating the error to the peer.

### Risk assessment

Medium-high: this is a real gap in a distributed-systems sense, but it is bounded by the fact that established sessions' media/input already flow peer-to-peer and don't strictly need signaling to survive short-term (per the design intent already documented at hub.ts:63-67) — the risk is specifically around _any_ future signaling need mid-session (an ICE restart, a renegotiate) landing during exactly the restart window, which is a real but not catastrophic-probability event. It should be fixed before scaling past a single long-lived backend process (e.g., before adopting rolling deploys or autoscaling in production).

### Performance impact

One additional Redis round-trip on register/approve (fire-and-forget, non-blocking per the tradeoff above); negligible.

### Future extensibility

This is also the prerequisite for horizontally scaling the signaling tier at all — today, a WebSocket's room routing is pinned to whichever single process holds the in-memory `Map`, so this redesign is the first step toward multi-instance signaling (e.g., behind a sticky-session load balancer today, a pub/sub-routed mesh later).

---

## Finding 6 — No network-simulation or chaos-testing harness; existing headless fixtures are manual, unasserted, and not wired into anything automated

**Severity:** high

### Current implementation

`apps/desktop/src-tauri/examples/headless_offer.rs` (55 lines) and `headless_mobile_peer.rs` (198 lines) together drive a real `run_session` against a live backend room, with the mobile side performing genuine WebRTC negotiation (answer, ICE trickle, and even sending a real `PictureLossIndication` RTCP packet at the 4-second mark, headless_mobile_peer.rs:100-114, to exercise the desktop's PLI→keyframe path). This is excellent fixture design — it is described in its own doc comment as "used to drive the real desktop `run_session`… proving the live session's capture-kind selection and permission-error surfacing end-to-end — not just in a unit test" (headless_mobile_peer.rs:1-6). But both are `cargo run --example` binaries with a `#[tokio::main] async fn main()`, not `#[test]` functions; their only output is `eprintln!` (e.g. headless_offer.rs:41, headless_mobile_peer.rs:196) — there is no `assert!` anywhere in either file, so "passing" currently means a human reads the terminal and judges the RTP packet count printed at headless_mobile_peer.rs:196 by eye. Neither is invoked by any script, Makefile target, or (per Finding 4) CI job.

There is no tool anywhere in the repo for injecting network conditions (packet loss, latency, jitter, bandwidth caps) between the simulated peers, and no test kills any process tier (`kill -9` on the backend, the desktop, or the mobile-fixture process) to observe recovery.

### Problems

1. The single most valuable E2E proof point in the codebase — "does a real session survive real conditions" — is entirely manual, meaning it is exercised only when an engineer remembers to run it, and its pass/fail is a subjective eyeball check, not a build gate.
2. The mandate explicitly calls for "ABR behavior under simulated loss/RTT" and "chaos scenarios (kill -9 each tier, packet loss via network link conditioner)" — neither exists today in any form, automated or manual. The `abr.rs` unit tests (abr.rs:123-199) prove the _decision function_ is correct in isolation, but nothing proves that a real induced-loss RTCP receiver report from a real WebRTC stack actually reaches `BitrateController::on_loss_report` and actually changes the real encoder's output bitrate (session.rs:352-357's wiring is never exercised by any test that induces real loss).
3. Reconnect-under-adverse-conditions (the product's core promise) is untested against anything resembling real network behavior — only the backend's in-process, zero-latency `hub.test.ts` reconnect-grace tests exist (hub.test.ts:176-274), which are valuable but assume perfect, instant message delivery once a reconnect attempt is made.

### Root cause

The headless fixtures were built as debugging tools during M2/M3 development (their doc comments talk about proving things to the engineer running them, e.g. headless_offer.rs:3-5's "so a JS 'mobile' stub can verify") rather than as a permanent, assert-driven test artifact — a reasonable order of operations for a prototype, but they were never "graduated" into the test suite.

### Redesign

1. **Add assertions, keep the binaries.** Convert the eyeball checks into real `assert!`s that fail the process with a non-zero exit code: `headless_mobile_peer.rs` should assert `total > threshold` (using the count already computed at line 195) before exiting, and `headless_offer.rs` should be driven by a companion script that checks both processes' exit codes.
2. **Wrap both in a `#[test]`-driven harness**, not raw `cargo run`, so they're `cargo test`-invokable: a new integration test file (e.g. `tests/network_e2e.rs`) that spawns the backend (`docker compose -f infra/docker-compose.yml up`, matching the existing `pnpm infra:up` root script) as a `std::process::Command` child, then spawns `headless_offer`/`headless_mobile_peer` as child processes (or, cleaner, imports `run_session` directly per Finding 1's trait work and spawns the "mobile" logic as an in-process task using the same webrtc-rs APIs `rtc_media_e2e.rs` already demonstrates work in-process), and asserts on real RTP/state-change counts.
3. **Add network-condition injection.** On macOS CI runners, use the built-in Network Link Conditioner (`scutil` / `dnctl`/`pfctl` pipes) or, more portably, insert a userspace UDP relay between the two ICE endpoints that can be told to drop/delay/reorder packets (simplest: bind both peers' ICE candidates to `127.0.0.1` through a relay process that reads/writes UDP and applies a configurable loss percentage and delay — this also works identically on Linux CI, unlike `dnctl`, so prefer it for portability). Parameterize a `NetworkProfile { loss_pct, latency_ms, jitter_ms, bandwidth_kbps }` and run the E2E fixture across `{ perfect, lte_typical (2% loss, 60ms), lte_poor (8% loss, 150ms), wifi_congested (15% loss, 20ms) }` profiles.
4. **Add a chaos matrix** using the same process-spawning harness: kill the backend process (`kill -9`) mid-session and assert the desktop emits `SignalingReconnecting`/attempts recovery (bounded by Finding 5's redesign for whether it _can_ fully recover); kill the "mobile" fixture process and assert the desktop's `peer.connectionState` eventually reports a terminal state rather than hanging forever; kill and restart the "mobile" fixture and assert (post-Finding-2-fix) it resumes.

### Tradeoffs

This class of test is inherently slower and flakier than unit tests (real sockets, real timing, real process spawning) — run it as a separate, non-blocking-by-default CI job (the `network-sim-e2e` job sketched in Finding 4, gated to `main` pushes and an opt-in PR label) rather than a required check on every PR, to avoid flaky-test fatigue poisoning the "required checks" trust model.

### Implementation plan

1. Add `assert!`s to the existing headless fixtures — 0.5 day.
2. Build the UDP-relay network-condition injector as a small standalone binary/test utility — 2 days.
3. Wrap the fixtures + relay into a `tests/network_e2e.rs` (or a `xtask`-style separate test binary given the process-spawning nature) with the profile matrix — 2-3 days.
4. Add the chaos-matrix cases (kill -9 per tier) — 2 days.
5. Wire into CI per Finding 4's `network-sim-e2e` job — 0.5 day.

### Migration strategy

Purely additive test infrastructure; no production code changes required (aside from whatever Finding 1/2/5 fixes are validated by it).

### Testing strategy

Named test cases for the new harness (L3/L4):

- `session_establishes_under_lte_typical_profile` — full pair→connected under 2% loss/60ms; assert connects within a bounded time and video RTP flow resumes.
- `abr_backs_off_under_lte_poor_profile` — run under 8%+ loss for 30s; assert the pipeline's `metrics().snapshot().bitrate_kbps` drops from its initial value (closes the real gap named in Problems #2).
- `pli_recovery_under_jitter` — combine the existing PLI-send behavior (headless_mobile_peer.rs:100-114) with a jitter profile; assert an IDR is produced promptly (extends the existing `keyframe_request_forces_idr_on_next_frame` unit test, media_pipeline.rs:11-49, to real network conditions).
- `chaos_kill_backend_mid_session_desktop_attempts_reconnect` — kill -9 the backend child process after `connected`; assert `SessionEvent::SignalingReconnecting` fires and, per Finding 5's scope, document/assert the currently-expected outcome (recovers if within the room-registry TTL once Finding 5 ships, else ends cleanly rather than hanging).
- `chaos_kill_mobile_peer_desktop_detects_and_ends` — kill -9 the mobile fixture; assert the desktop's peer connection eventually reports `failed`/`closed` and the session ends (not a hang).

### Risk assessment

Without this, ABR and reconnect-under-real-conditions — the two features most directly responsible for competing with Parsec/AnyDesk's "just works on bad Wi-Fi" reputation — are validated only by pure-function unit tests and one manual, subjective smoke test.

### Performance impact

CI-only cost (minutes per run in a nightly/on-demand job); zero production impact.

### Future extensibility

The `NetworkProfile` injector and process-chaos harness are reusable for any future transport work (audio channel, multi-track, TURN-relay-forced scenarios) and for pre-release manual QA sign-off, not just CI.

---

## Finding 7 — No long-session soak test; several unbounded-growth and lifetime-averaged metrics are unverified over multi-hour runs

**Severity:** high

### Current implementation

No test in the repository runs any component for longer than the handful of seconds needed to collect a few encoded frames (the longest-running existing test, `pipeline_streams_real_h264_with_metrics`, media_pipeline.rs:51-99, collects 6 frames and stops). Nothing exercises `MediaPipeline`, `SignalingHub`, `InputWorker`, or `run_session` for anything resembling a real multi-hour remote-desktop session.

Specific structures with growth or staleness characteristics that a soak test would need to bound:

- `PipelineMetrics`'s `latency_us_total`/`encode_us_total`/`capture_us_total` (metrics.rs:15-19) are monotonically-accumulating `AtomicU64`s averaged over the _entire session's_ frame count in `snapshot()` (metrics.rs:66-81: `cap_us / captured`, etc.) — over a 24-hour session at 30fps (~2.6M frames), a late-session latency regression (e.g. thermal throttling degrading encode time in hour 20) would be almost invisible in the lifetime average, since it's diluted by 20 hours of healthy history. This is an observability gap that a soak test would surface immediately by comparing hour-1 vs. hour-20 _windowed_ behavior, which the current cumulative-average design cannot express at all.
- `SignalingHub.rooms`/`ctx` Maps (hub.ts:85-86) are correctly cleaned up on `endRoom` (hub.ts:432-450 deletes from `this.rooms` and, per-peer, from `this.ctx`) for every tested teardown path — but no test runs thousands of room lifecycles in sequence to confirm there's no slow leak from a missed code path (e.g., a room that errors out of `register()` before being fully torn down, or the `vacatedAt`/`lastSeen` partial records on a `Room` object that's never actually deleted).
- `InputWorker`'s metrics counters (`events_received`/`events_injected`/etc., exercised in `input_worker.rs:27-58`) are `u64` counters with no reset — fine numerically for any realistic session length, but never verified for thread-liveness over a long duration (the existing `malformed_frame_is_rejected_without_crashing_the_worker` test, input_worker.rs:61-72, proves liveness across _one_ bad frame, not thousands over hours).
- The sample queue's drop-and-recover-with-keyframe behavior (pipeline.rs:157-172) is tested for a single drop event (`dropped_frame_recovers_with_immediate_keyframe`, media_pipeline.rs:104-146) but never for sustained, repeated backpressure over a long run, where the interaction between `recover_with_keyframe` and a persistently-slow consumer could in principle produce a keyframe-storm (every recovered frame is large, refilling the queue faster, dropping again) — this specific interaction is unverified at any timescale beyond a few hundred milliseconds.

### Problems

1. Memory (RSS) and CPU growth over realistic session durations (hours, not seconds) is completely unmeasured — a slow leak in any of the above structures, or in `webrtc-rs`'s own internal state (RTP sequence-number/jitter-buffer bookkeeping, DTLS/SRTP key state) would currently ship undetected until a real user's multi-hour session degrades or crashes.
2. The lifetime-cumulative-average metrics design actively hides the exact class of regression a soak test exists to find (see the `latency_us_total` point above) — this is a design issue independent of whether a soak test exists, and should be fixed alongside adding one.
3. There is no answer today to "what does Lilypad do after 24 hours of continuous use" — competitors' remote-desktop products are routinely left connected for entire workdays.

### Root cause

Soak testing has an inherently different cost profile (hours of wall-clock time) than the rest of the suite, and building the harness plus the CI scheduling infrastructure for it was reasonably deferred past M2/M3's live-demo priorities — but it needs to exist before an M5 "production quality" claim is credible.

### Redesign

Build a synthetic soak harness that runs `run_session` (post-Finding-1's trait extraction, so it can run against fakes for the signaling/peer edges while still exercising the _real_ `MediaPipeline` and `InputWorker`, which are the components with genuine long-run resource concerns) continuously for a configurable duration, sampling process RSS (via `/proc/self/status` on Linux CI or `getrusage`/`task_info` on macOS — a small helper crate like `sysinfo` is a reasonable dependency to add here since it's test-only) and CPU time every minute, alongside the pipeline's own metrics snapshot. Also fix the metrics design to expose a _windowed_ (e.g. trailing-60-second) average in addition to (or instead of) the lifetime cumulative one, by keeping a small ring buffer or periodically-reset accumulator pair (a "current window" `AtomicU64` pair swapped every N seconds, with the previous window's values read into the snapshot) rather than the single ever-growing total.

Run three duration tiers: a 10-minute smoke-soak on every `main`-branch push (fast enough to be frequent), a 4-hour soak nightly, and a 24-hour soak weekly — each asserting RSS growth stays within a fixed budget (e.g., <5% growth after the first 5-minute warmup period, to allow for legitimate buffer/cache warmup) and that no thread panics or pipeline restarts occurred.

### Tradeoffs

A 24-hour CI job is expensive in both compute cost and in "time to red" (a regression introduced Monday might not be caught until the weekly run completes) — mitigate with the tiered approach above so the 10-minute smoke-soak catches gross leaks fast, while the longer tiers exist specifically to catch slow leaks that need real time to manifest and accept the longer feedback loop as the necessary cost of that class of bug.

### Implementation plan

1. Fix `PipelineMetrics` to track a windowed average alongside the lifetime cumulative one — 1 day.
2. Add an RSS/CPU sampling helper (thin wrapper around `sysinfo` or platform syscalls) — 1 day.
3. Build the soak-runner binary (a new `examples/soak.rs` or dedicated `xtask`, parameterized by duration and by which fakes vs. real components to use) reusing Finding 1's trait seams to run `run_session` against a fake signaling/peer edge but a real `MediaPipeline`+`InputWorker` — 2 days.
4. Add the three-tier CI schedule (smoke on push, 4h nightly, 24h weekly via `schedule:` cron triggers) — 1 day.
5. Define and tune the RSS/CPU growth budget empirically against a first baseline run — 1 day (plus the run time itself).

### Migration strategy

Purely additive; the metrics-windowing change is the only production-code touch and is backward compatible (add fields to `MetricsSnapshot`, don't remove the existing cumulative ones, since the desktop debug overlay/`Control.tsx` may already read them).

### Testing strategy

Named test/verification cases:

- `smoke_soak_10min_rss_stays_within_budget` — run the harness for 10 minutes with real pipeline+input worker; assert RSS after minute 9 is within X% of RSS after minute 1 (post-warmup baseline).
- `nightly_soak_4h_no_thread_panics` — assert the pipeline's `stop_flag`/worker thread liveness holds throughout (extends the existing liveness assertion pattern from `malformed_frame_is_rejected_without_crashing_the_worker`, input_worker.rs:61-72, to a multi-hour timescale).
- `nightly_soak_4h_windowed_latency_does_not_regress` — sample the new windowed-average metric every 5 minutes; assert no window exceeds e.g. 2x the first window's value (catches the "thermal throttling in hour 3" class of regression the current cumulative average would hide).
- `weekly_soak_24h_queue_never_enters_sustained_drop_storm` — assert `frames_dropped` growth rate in any 60-second window stays below a threshold (guards against the keyframe-storm interaction named in Problems #4).
- `weekly_soak_24h_hub_room_count_returns_to_zero_after_n_cycles` — a companion backend-side soak driving `SignalingHub` through thousands of full room lifecycles (in-process, using the existing `FakePeer` pattern from hub.test.ts, no real sockets needed since this targets the JS heap not the network) and asserting `hub.roomCount()` returns to 0 and process RSS is stable.

### Risk assessment

High: this is the exact gap that turns "worked in the demo" into "degraded/crashed during the user's actual workday," and it is currently completely unverified in either direction (we don't know if there's a leak, and we have no way to find out other than this report's proposal).

### Performance impact

CI-only cost; the metrics-windowing change adds one additional atomic swap per snapshot interval, negligible against per-frame encode cost.

### Future extensibility

The soak harness, once built on Finding 1's trait seams, is reusable for any future long-running-session feature (recording, session handoff, multi-monitor) without re-deriving the RSS/CPU sampling infrastructure.

---

## Finding 8 — Desktop React UI has zero tests; poll-based session-state can race with user actions

**Severity:** medium

### Current implementation

`apps/desktop/src` contains `App.tsx` (29 lines), `components/Bubble.tsx` (61 lines), `components/Control.tsx` (89 lines), `components/QrOverlay.tsx` (95 lines), and `lib/tauri.ts` (33 lines) — no `.test.tsx`/`.test.ts` file exists anywhere in the directory, and `apps/desktop/package.json`'s scripts have no `test` entry (only `dev:vite`, `build:vite`, `typecheck`, `lint`).

`Control.tsx:18-34` polls `api.getState()` every 800ms via `setInterval` rather than subscribing to a push event, and renders Approve/Deny buttons only while `state?.session === 'awaiting_approval'` (Control.tsx:36, 45-57). The buttons call `api.approve()`/`api.deny()` (Control.tsx:49, 52) which `invoke` Tauri commands (`tauri.ts:29-30`) with no client-side disabling/debouncing while the call is in flight.

### Problems

1. Because state is polled rather than pushed, there is up to an 800ms window where the UI shows stale `session` status — e.g., if the backend/Rust side moves out of `awaiting_approval` (say, the mobile disconnected before the user clicked) the Approve button can still be visible and clickable for up to 800ms, and nothing in `Control.tsx` guards against `api.approve()` being invoked against a session that's no longer `awaiting_approval`. This is exactly the kind of double-click/stale-state race a test would catch by mocking `api.getState()`'s timing against a click event.
2. None of the four components have ever been rendered in a test environment, so a bundling/JSX regression, a broken conditional render (e.g., the `session === 'active'` block at Control.tsx:59-71 never showing), or a broken `useEffect` cleanup (Control.tsx:30-33) would only surface in manual QA.

### Root cause

Same root cause as Finding 3 (mobile): UI test infrastructure was never bootstrapped, likely deprioritized relative to getting the Tauri/webview bridge itself working during M1/M2.

### Redesign

Add Vitest + `@testing-library/react` (Vitest is already a devDependency pattern used on the backend, so this keeps tooling consistent within the repo) to `apps/desktop`, with `lib/tauri.ts`'s `api` object mocked via `vi.mock('../lib/tauri')`. Fix the race by having `Control.tsx` guard the button handlers: capture the `session` value the button was rendered for and no-op (or re-check via a fresh `getState()`) if it's changed by the time the click resolves, and/or disable the buttons for the duration of the in-flight `invoke` call (a simple `useState<boolean> loading` gate around `approve`/`deny`/`disconnect`/`panic`).

### Tradeoffs

Testing Tauri-`invoke`-backed components requires mocking the Tauri bridge rather than exercising it for real, so these tests validate the React logic layer but not the actual IPC round-trip to Rust — that gap is intentionally left to the `network-sim-e2e`/manual-QA layer (Finding 6), not duplicated here.

### Implementation plan

1. Add `vitest`, `@testing-library/react`, `jsdom` to `apps/desktop`'s devDependencies and a `vitest.config.ts` (mirroring the backend's, `apps/backend/vitest.config.ts:1-10`, adapted with `environment: 'jsdom'`) — 0.5 day.
2. Add the loading-state/stale-click guard to `Control.tsx` — 0.5 day.
3. Write the tests below — 1.5 days.

### Migration strategy

Additive; the `Control.tsx` guard is a small, low-risk behavioral tightening (buttons already only appear conditionally — this just prevents a narrow race window).

### Testing strategy

Named test cases:

- `control_shows_approve_deny_only_when_awaiting_approval` — mock `getState` to return each `SessionStatus`; assert button visibility per state.
- `approve_click_disables_buttons_until_the_invoke_resolves` — mock a slow `api.approve()`; assert the button is disabled/no double-invoke on a second rapid click.
- `stale_approve_click_is_a_no_op_after_state_moved_on` — mock `getState` changing to `idle` between render and click resolution; assert `api.approve()` is not called (or its result is discarded).
- `plugin_health_list_renders_ok_and_down_states_distinctly` — assert the `ok`/`down` className branch (Control.tsx:80) renders correctly for both.
- `qr_overlay` / `bubble` smoke tests — basic render-without-throwing plus key prop-driven branches for the other two components.

### Risk assessment

Medium — this is the operator-facing "who's allowed to control my machine" gate; a UI bug here is a security-adjacent trust issue (approving the wrong session, or a stuck Deny button) even though the underlying authorization logic lives correctly in Rust/backend.

### Performance impact

None on the shipped app; negligible CI cost (jsdom-based component tests run in milliseconds).

### Future extensibility

Establishes the pattern for testing any future desktop UI surface (session history, settings, multi-device management) without re-deriving the Tauri-mocking approach.

---

## Finding 9 — Performance benchmarks exist but are print-only with no regression gate, and aren't run in CI

**Severity:** medium

### Current implementation

Three benchmark binaries exist under `apps/desktop/src-tauri/examples/`: `bench_encode.rs` (80 lines, measures per-frame encode latency for software/VideoToolbox encoders, printing avg/p50/p95/max), `bench_pipeline.rs` (50 lines, runs the full pipeline for a configurable duration and prints the `MetricsSnapshot`), and `bench_input.rs` (38 lines, measures per-event `InputDispatcher` processing latency). All three are `fn main()` (or `#[tokio::main]`) binaries whose only output is `println!`; none writes structured (JSON) output, none compares against a stored baseline, and none is invoked by any script or CI job (confirmed absent from `.github/`, per Finding 4, and not referenced in any `package.json`/`Cargo.toml` script alias).

### Problems

1. There is no regression detection at all for encode latency, pipeline throughput, or input-dispatch latency — a change that doubles `bench_encode`'s p95 (e.g., an accidental synchronous I/O call added to the hot encode path) would only be noticed if an engineer happens to run the benchmark manually and happens to remember what the number used to be.
2. `bench_encode.rs`'s own doc comment (bench_encode.rs:1-5) explicitly frames it as measuring "session-default settings" (1280x720@30) — i.e., it's designed to represent production load, which makes the lack of a regression gate on it specifically costly; this is precisely the kind of metric that should block a merge if it regresses by, say, 25%.

### Root cause

Benchmarks were built as ad-hoc developer tools for manual profiling during encoder/pipeline work, and (same pattern as Findings 4/6) never graduated into an enforced part of the build.

### Redesign

1. Add a `--json` output mode to each bench binary (behind an env var or CLI flag, e.g. `LILYPAD_BENCH_FORMAT=json`) emitting `{ metric: string, value: f64, unit: string }[]` so results are machine-comparable.
2. Store a baseline (`bench-baseline.json`, committed to the repo, one per bench per platform since VideoToolbox numbers only exist on macOS) and add a small comparison script (`scripts/check-bench-regression.mjs`, consistent with the existing `scripts/*.mjs` pattern used for `bootstrap.mjs`/`clean.mjs`/`doctor.mjs`) that fails (non-zero exit) if any metric regresses beyond a configured tolerance (e.g., ±15% for latency percentiles, since single-run noise on a CI runner is real).
3. Wire this as the `bench-regression` CI job sketched in Finding 4, run on `main` pushes (not every PR, to avoid noisy-runner false failures blocking unrelated PRs) with results posted as a PR comment/summary for visibility even when non-blocking.

### Tradeoffs

CI runners are noisier than a developer's dedicated machine, so percentile-based thresholds need real slack (15-25%) to avoid false positives — this means the gate catches gross regressions (2x, not 5%), which is an acceptable and honest scope for a CI-based perf gate; finer-grained regression hunting still benefits from a human running the bench locally with more runs.

### Implementation plan

1. Add JSON output to all three bench binaries — 1 day.
2. Write `scripts/check-bench-regression.mjs` + establish the initial baseline file — 1 day.
3. Wire into the `bench-regression` CI job — 0.5 day.

### Migration strategy

Additive; baseline starts as "whatever today's numbers are" (captured once, committed), so day one has no false regressions by construction.

### Testing strategy

- `check_bench_regression_fails_on_a_synthetic_regression` — feed the comparison script a fabricated "current" JSON with a metric 2x the baseline; assert non-zero exit.
- `check_bench_regression_passes_within_tolerance` — feed a current JSON within the tolerance band; assert zero exit.
- Manual verification: intentionally introduce a 2x encode-latency regression locally (e.g., add a `std::thread::sleep`), run the full bench+check pipeline, confirm it's caught, then revert.

### Risk assessment

Medium — performance regressions in the encode/input hot path directly degrade the user-visible "feels responsive" quality bar Parsec/AnyDesk compete on, but they're slower-burning than a correctness bug (they degrade UX rather than breaking sessions outright), hence medium rather than high/critical.

### Performance impact

CI-only cost (the benches themselves run for seconds); no production impact.

### Future extensibility

The JSON-output + baseline-comparison pattern generalizes to any future hot-path benchmark (e.g., a future audio pipeline, or a Windows-Graphics-Capture backend once it lands per session.rs:428's noted gap).

---

## Finding 10 — Backend HTTP/WebSocket route adapters have no integration tests; only the underlying pure services are unit-tested

**Severity:** medium

### Current implementation

`apps/backend/src/routes/pairing.ts` (32 lines, read in full) and `apps/backend/src/routes/signaling.ts` (138 lines, read in full) are the Fastify-layer adapters that wire HTTP/WebSocket transport to the well-tested pure services (`services/pairing.ts`, `signaling/hub.ts`). No test file exists for either route file — `find` across `apps/backend/src` for `*.test.ts` returns only `hub.test.ts`, `pairing.test.ts` (which tests `services/pairing.ts`, not `routes/pairing.ts`), `manager.test.ts`, `stateMachine.test.ts`, `guards.test.ts`, `credentials.test.ts`, and `protocol.test.ts` — none of them constructs a Fastify instance or exercises a route handler.

Specifically untested adapter-layer behavior: `routes/pairing.ts:9-11`/`:19-21`'s Zod `safeParse` → HTTP 400 mapping; `routes/pairing.ts:26-29`'s `PairingTokenError` → HTTP 410 mapping (vs. an unexpected error correctly re-thrown to Fastify's default handler at line 29's bare `throw err`); `routes/signaling.ts:64-137`'s entire WebSocket adapter, including the per-IP connection limiter integration (`routes/signaling.ts:65-74`), the register-timeout-close (`routes/signaling.ts:103-108`), the token-bucket rate-limit-close (`routes/signaling.ts:110-115`), and the malformed-JSON → `bad_json` error path (`routes/signaling.ts:116-128`, notably a _different_ error code, `bad_json`, than the hub's own `bad_message` for schema-invalid-but-valid-JSON, `hub.ts:127-129` — an inconsistency worth deliberately testing so it stays intentional rather than accidental).

### Problems

1. `IpConnectionLimiter` and `TokenBucket` are excellently unit-tested in isolation (`guards.test.ts`), but their _wiring_ into the real route — including the `release()` call on socket close (`routes/signaling.ts:77-82`, `132-136`) actually running for every close path, and not leaking a slot on an exceptional/early-return path — has never been exercised.
2. The `bad_json` vs `bad_message` error-code split (noted above) is exactly the kind of small inconsistency that's easy to either "fix" into a regression (someone unifies them, breaking a client that branches on the specific code) or leave permanently unintentional-looking, without a test pinning which behavior is deliberate.

### Root cause

The route files are deliberately thin ("a thin adapter," per routes/signaling.ts:18-19's own doc comment) specifically so the interesting logic lives in the well-tested `SignalingHub`/services — a reasonable design choice — but "thin" was taken to also mean "doesn't need its own test," which doesn't follow: adapter wiring bugs (a missed `release()`, a wrong status code) live exactly in the thin layer, not in the tested core.

### Redesign

Add `apps/backend/src/routes/pairing.test.ts` and `routes/signaling.test.ts` using Fastify's built-in `app.inject()` (no real network socket needed for HTTP; for the WebSocket route, use `@fastify/websocket`'s documented test pattern of injecting an upgrade request, or a lightweight real `ws` client against an ephemeral-port `app.listen()` instance — the latter is simpler to get right for WebSocket subprotocol/frame-level behavior and is a well-trodden Fastify testing pattern).

### Tradeoffs

WebSocket route testing is harder to do with pure `.inject()` and closer to an integration test than the HTTP routes' — accept a small amount of "spin up a real listener on an ephemeral port" overhead for the signaling route tests rather than fighting `.inject()`'s WS support, since correctness here matters more than test purity.

### Implementation plan

1. `routes/pairing.test.ts` — build a Fastify app with only `pairingRoutes` registered (against a fake Redis via the existing `FakePairingRedis`-style pattern, requiring `services/pairing.ts` to accept an injected redis client, which it already does per `pairing.test.ts:27`'s usage) — 1 day.
2. `routes/signaling.test.ts` — spin up a real ephemeral-port listener, connect with a real `ws` client (devDependency), exercise the guard-wiring paths — 1.5 days.

### Migration strategy

Purely additive.

### Testing strategy

Named test cases:

- `pairing_create_returns_400_on_invalid_body` / `pairing_redeem_returns_410_on_invalid_token` — pin the route-level status-code mapping.
- `pairing_redeem_rethrows_unexpected_errors_as_500` — confirm the bare `throw err` (pairing.ts:29) path isn't accidentally swallowed by a future refactor.
- `signaling_ws_closes_socket_at_per_ip_connection_cap` — open `MAX_CONNECTIONS_PER_IP + 1` connections from the same simulated IP (Fastify `req.ip` can be forced via `X-Forwarded-For` if `trustProxy` is configured, or by directly testing `ipLimiter` wiring at the injection layer); assert the extra socket is closed with code 4429.
- `signaling_ws_release_happens_on_every_close_path` — open then close a socket normally; assert a subsequent connection from the same IP succeeds (proves `release()` actually ran, closing the exact gap named in Problems #1).
- `signaling_ws_register_timeout_closes_a_silent_socket` — connect without ever sending `register`; wait past `REGISTER_TIMEOUT_MS` (inject a shorter timeout via a test-only constructor param, or accept the real 10s in a slow-but-correct test); assert close code 4408.
- `signaling_ws_malformed_json_gets_bad_json_not_bad_message` — send literal invalid JSON; assert the `bad_json` code specifically (pins the intentional-vs-accidental question above).

### Risk assessment

Medium — these are exactly the kind of "obviously correct, never verified" gaps that cause a production incident the day someone refactors the route file for an unrelated reason (e.g., adding a new guard) and breaks the `release()` call ordering.

### Performance impact

None; CI cost is small (a handful of real-but-local socket connections).

### Future extensibility

Establishes the pattern (fake-Redis-backed route tests, real-ephemeral-port WS tests) for any future route (e.g., an admin API, session-history endpoints).

---

## Finding 11 — ABR is well unit-tested as pure logic, but never validated end-to-end against real RTCP feedback and real encoder retargeting

**Severity:** medium (upgraded from low given ABR is core to the "works on bad networks" positioning; see also Finding 6's overlapping E2E proposal)

### Current implementation

`apps/desktop/src-tauri/src/media/abr.rs`'s `BitrateController` (abr.rs:49-121) is genuinely well tested at the algorithm level: six unit tests (abr.rs:123-199) cover heavy-loss backoff, moderate-loss holding, rate-limited upward probing, configured min/max bounds, REMB capping, and probe-timer reset-on-loss. This is solid, deterministic, `Instant`-injected testing exactly as the file's own doc comment intends ("Time is passed in… so every branch is deterministic under test," abr.rs:12-13).

The wiring from real RTCP feedback to this controller lives in `session.rs:350-365`: `PeerEvent::VideoLossReport`/`VideoRemb` call `ctl.on_loss_report`/`on_remb`, and a `Some(kbps)` result calls `pl.control().set_target_bitrate(kbps)` (pipeline.rs:51-53), which the encode-loop thread reads and applies via `encoder.set_bitrate()` (pipeline.rs:110-120). None of this wiring — real `PeerEvent`s reaching the controller, the controller's output reaching the live pipeline, or the pipeline's `set_bitrate` call actually changing the real encoder's output — is exercised by any existing test. `rtc_media_e2e.rs` (the closest existing E2E test) never sends an RTCP loss report or REMB from the receiving peer.

### Problems

1. There is a real, plausible bug class this leaves unguarded: a wiring mistake (wrong event field read, a stale `Arc` clone, a channel that's dropped before the pipeline is created if `PeerEvent::VideoLossReport` somehow arrives before `pipeline.is_some()` — session.rs:352-357's `if let (Some(pl), Some(ctl))` guard silently no-ops in that case, which is probably correct but is itself unverified) would silently mean ABR never actually engages in production despite every unit test passing.
2. `encoder.set_bitrate()`'s actual effect on encoded output size is untested at any layer — `bench_encode.rs` measures latency, not bitrate-target-adherence, and no test asserts that a lower `set_target_bitrate` call actually produces smaller encoded frames within a reasonable window.

### Root cause

The pure-logic/unit-test investment in `abr.rs` was well executed, but the integration seam (RTCP→controller→pipeline→encoder) was left to the "should be exercised manually via `headless_mobile_peer`'s PLI send" assumption (headless_mobile_peer.rs:100-114 sends a PLI, which exercises the _keyframe_ path, not the _loss-report/REMB_ path — these are different RTCP message types and the fixture doesn't send either of the two ABR-relevant ones).

### Redesign

Two additions, one small and immediate, one larger (overlapping Finding 6):

1. **Small, immediate:** extend `headless_mobile_peer.rs` to also periodically send a synthetic RTCP Receiver Report with a controlled `fraction_lost`, and add a `#[test]`-wrapped variant of `rtc_media_e2e.rs` that does the same in-process (it already has both peers' RTCP machinery available via `webrtc-rs`) — assert the offerer's `PeerEvent::VideoLossReport` fires and, if a `MediaPipeline`+`BitrateController` are wired in (extending the existing offerer setup in `rtc_media_e2e.rs` to include them, mirroring how `session.rs` wires them), that `metrics().snapshot().bitrate_kbps` changes accordingly.
2. **Larger:** fold this into Finding 6's network-simulation harness so ABR is validated not just against a synthetic RTCP message but against _real_ induced packet loss producing _organic_ RTCP receiver reports from the real `webrtc-rs` congestion/RR interceptor — this is the more convincing proof and the one the "ABR behavior under simulated loss/RTT" mandate item is really asking for.

### Tradeoffs

The synthetic-RTCP-injection test (option 1) is faster and more deterministic but proves less (it proves the wiring, not that real network loss produces the RTCP reports in the first place); the real-loss test (option 2, via Finding 6) is slower/flakier but is the only one that proves the full, real chain. Do both — they answer different questions.

### Implementation plan

1. Extend `rtc_media_e2e.rs` (or add a sibling test file) with the ABR-wiring assertion — 1.5 days.
2. Once Finding 6's harness exists, add the `abr_backs_off_under_lte_poor_profile` case already named there — tracked under Finding 6's plan, not duplicated here.

### Migration strategy

Additive test-only change.

### Testing strategy

- `synthetic_loss_report_retargets_real_pipeline_bitrate` — in-process, two real `webrtc-rs` peers (per `rtc_media_e2e.rs`'s existing pattern) plus a real `MediaPipeline`+`BitrateController` wired as `session.rs` does; inject a loss-indicating RTCP RR from the answerer; assert the offerer's pipeline bitrate metric changes within a bounded number of frames.
- `remb_report_caps_real_pipeline_bitrate` — same shape, using a REMB message instead.
- (via Finding 6) `abr_backs_off_under_lte_poor_profile` — real induced network loss, not synthetic RTCP injection.

### Risk assessment

Medium — a silent ABR-wiring failure degrades gracefully in the sense that video would just keep streaming at a bitrate the network can't sustain (worse quality/stutter under load, not a hard failure), so it's a UX-quality risk rather than a session-ending one, but it's directly the feature line PR/marketing would point to as a competitive differentiator.

### Performance impact

None in production; test-only cost (a few seconds per new test case).

### Future extensibility

Same harness extends to future congestion-control refinements (e.g., adding RTT-based rather than purely loss-based decisions, which the mandate explicitly names as a gap: "ABR behavior under simulated loss/**RTT**" — note `BitrateController` today has no RTT input at all, only loss and REMB; if RTT-aware behavior is added later, this is where its tests would live).

---

## Finding 12 — No test proves the Rust desktop's signaling client and the TypeScript `SignalingHub` actually interoperate; each side's tests assume the other's contract

**Severity:** medium

### Current implementation

The backend's reconnect-grace behavior is tested exhaustively but entirely in TypeScript, against a `FakePeer` (hub.test.ts:5-20) that is not the real WebSocket transport and certainly not the real Rust client. The Rust side's `reconnect_signaling` (session.rs:105-123) and its backoff schedule are tested only via the pure `backoff_delay` function (session.rs:627-636) — no test drives it against even a fake `SignalingHub`, let alone the real one. The only place these two halves have ever been run against each other is the manual `headless_offer`/`headless_mobile_peer` fixtures (Finding 6) against a real, live backend process — and even then, no test scenario in either fixture actually simulates the backend dropping and the Rust client needing to exercise its re-register-into-a-held-seat path (`hub.ts:281-292`'s `vacated`/`seat_reserved` logic) end-to-end; the fixtures assume a stable backend throughout their run.

### Problems

1. The wire-level contract each side assumes about the other — e.g., that re-registering with the same `deviceId` within `reregisterGraceMs` succeeds and routing resumes (hub.ts:281-292), or that a `seat_reserved` error (hub.ts:284-288) is something the Rust client should treat as fatal rather than retriable — has never been proven true by any test that runs both real implementations together under that specific scenario.
2. Future changes to either side's reconnect protocol (e.g., the backend adding a new error code, or the Rust client changing its retry count) have no automated signal if they silently break interoperability — each side's excellent unit tests would keep passing in complete isolation from the other.

### Root cause

The two halves are naturally developed and tested in their own language/toolchain silos (Vitest for TS, `cargo test` for Rust), and no cross-toolchain integration test was ever built to bridge them — this is a common and understandable gap in polyglot codebases, but it's exactly the seam this audit is asked to find.

### Redesign

Build the `chaos_kill_backend_mid_session_desktop_attempts_reconnect`-style scenario from Finding 6, but specifically target the reconnect-grace contract: spin up a real backend (via `docker compose`/the existing `infra:up` script) with a real `SignalingHub`, run `headless_offer` to `connected`, forcibly close _only_ the desktop's WebSocket (not kill the whole backend — simulate a pure transport blip, e.g. via a `TCPKill`-style intervention or by having a modified test-only `headless_offer` variant that closes and reopens its own socket on a signal), and assert the Rust client's `reconnect_signaling` succeeds, re-registers, and the room's `established` flag and routing survive — i.e., prove `hub.test.ts`'s `holds the seat on a mid-session drop` scenario (hub.test.ts:202-217) is also true when the "same device" re-registering is the _real_ Rust client, not `FakePeer`.

### Tradeoffs

This is inherently a slower, more infrastructure-heavy test than either side's unit suite (real backend process, real Redis, real Rust binary) — scope it as a small, targeted number of scenarios (the 2-3 most important contract assumptions) rather than trying to mirror all of `hub.test.ts`'s cases at this level; the unit-test layer remains the right place for exhaustive scenario coverage, this layer exists purely to prove the two implementations agree on the contract the unit tests assume.

### Implementation plan

1. Add a `LILYPAD_RECONNECT_TEST` signal/env-controlled path to a test-only variant of `headless_offer` (or extend it) that closes and reopens its own signaling socket on command — 1 day.
2. Build the scenario as a `tests/reconnect_interop.rs` driving `docker compose` + the modified fixture — 1.5 days.
3. Wire into the `network-sim-e2e` CI job from Finding 4/6 — no additional CI work if that job already exists.

### Migration strategy

Additive; no production code changes.

### Testing strategy

- `real_desktop_client_recovers_seat_after_transport_drop_within_grace` — the scenario above; assert `hub.metricsSnapshot().activeRooms` stays 1 throughout and video RTP resumes flowing after reconnect (reusing the RTP-counting pattern from `rtc_media_e2e.rs`/`headless_mobile_peer.rs`).
- `real_desktop_client_receives_seat_reserved_and_does_not_retry_forever` — simulate an intruder-style scenario (a different `deviceId` attempts the seat) and confirm the _legitimate_ client's own retry loop isn't confused/doesn't spin — mirrors hub.test.ts's `rejects a different device claiming the vacated seat` (hub.test.ts:219-231) from the real-client side.

### Risk assessment

Medium — the individual halves are well-tested, so this is a "belt and suspenders" contract-verification gap rather than a known-broken path, but polyglot protocol drift is a classic, easy-to-miss production incident category, and this is the one place in the whole audit where the two best-tested subsystems in the codebase have never actually talked to each other under test.

### Performance impact

CI-only cost; no production impact.

### Future extensibility

This is the natural home for any future signaling-protocol version negotiation testing (e.g., if the wire schema ever needs a versioned migration).

---

## Finding 13 — Small process/tooling polish gaps: missing `turbo.json` test task, cumulative-only metrics, and no coverage reporting

**Severity:** polish

### Current implementation

- `turbo.json:12-31` defines `build`/`dev`/`lint`/`typecheck`/`clean` tasks but no `test` task, and the root `package.json`'s `scripts` block has no `test` entry either — so there is no single command (`pnpm test`/`turbo run test`) that runs every workspace's test suite, even though `apps/backend/package.json` already defines `"test": "vitest run"`.
- No package in the repo currently reports code coverage (`vitest run --coverage` is not configured anywhere, no `c8`/`istanbul` config exists), so even the well-tested backend has no visibility into which branches of `hub.ts`'s `dispatch` switch (hub.ts:303-380) or `guards.ts` are actually exercised versus incidentally covered by the happy-path test.
- `apps/backend/vitest.config.ts:1-10` sets `LOG_LEVEL: 'silent'` for deterministic quiet test runs (a nice touch) but has no `coverage` block.

### Problems

Minor but compounding: without a root `test` task, adding new per-package test suites (mobile per Finding 3, desktop per Finding 8) doesn't automatically get picked up by "run everything" tooling until someone remembers to also update the root scripts — an easy thing to forget exactly when it matters most (right after adding a new test suite).

### Root cause

Straightforward tooling-configuration gaps rather than a design decision.

### Redesign

Add `"test": { "dependsOn": ["^build"], "outputs": [] }` to `turbo.json`'s `tasks` block (mirroring the existing `typecheck` task's shape at turbo.json:24-27) and `"test": "turbo run test"` to the root `package.json`'s `scripts`. Add `--coverage` to the backend's `vitest` invocation in CI (not necessarily locally, to keep local test runs fast) with a coverage threshold in `vitest.config.ts` (e.g., a starting floor around the current actual coverage, ratcheted upward over time rather than picked arbitrarily) once the CI job from Finding 4 exists.

### Tradeoffs

Coverage thresholds can create perverse incentives (padding tests to hit a number rather than testing behavior) — per this audit's own instruction to prioritize behavior coverage over line coverage, treat any coverage number as a floor/smoke-check ("did we forget an entire file") rather than a target to maximize.

### Implementation plan

1. Add the `turbo.json`/root `package.json` test task — 0.25 day.
2. Add `--coverage` + a starting threshold to the backend's CI test invocation — 0.5 day.

### Migration strategy

Trivial, additive tooling change.

### Testing strategy

Verify by running `pnpm test` from the repo root after Finding 3/8's mobile/desktop test suites land and confirming all three packages' suites execute.

### Risk assessment

Low — pure tooling ergonomics, but cheap enough to fix that there's no reason to defer it past the CI work in Finding 4.

### Performance impact

None.

### Future extensibility

Sets the convention every future package (admin app, any new service) should follow from day one.

---

## Summary table

| #   | Finding                                                                 | Severity | Effort |
| --- | ----------------------------------------------------------------------- | -------- | ------ |
| 1   | `run_session` has zero behavioral test coverage                         | critical | L      |
| 2   | Mobile signaling has no reconnect logic (found via this audit)          | critical | S–M    |
| 3   | Mobile app has no test runner configured                                | critical | M      |
| 4   | No CI pipeline exists                                                   | critical | M      |
| 5   | Backend restart mid-session is untested and largely unrecoverable today | high     | L      |
| 6   | No network-simulation/chaos harness; fixtures are manual/unasserted     | high     | L      |
| 7   | No long-session soak test; cumulative metrics hide late regressions     | high     | L      |
| 8   | Desktop UI has zero tests; poll-based state can race                    | medium   | S–M    |
| 9   | Benchmarks are print-only with no regression gate                       | medium   | S      |
| 10  | Backend route adapters have no integration tests                        | medium   | S–M    |
| 11  | ABR untested end-to-end against real RTCP/encoder                       | medium   | S–M    |
| 12  | Rust client and TS hub never proven to interoperate under test          | medium   | M      |
| 13  | Tooling polish: missing test task, no coverage reporting                | polish   | XS     |
