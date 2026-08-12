---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: M3 production audit — streaming and media findings.
---

# Streaming Media Engineering Audit — M2 → M5

**Scope:** desktop capture/encode pipeline (`apps/desktop/src-tauri/src/media/*`), the WebRTC peer (`apps/desktop/src-tauri/src/rtc/mod.rs`), the session runner's wiring of adaptive bitrate (`apps/desktop/src-tauri/src/session.rs`), and the mobile viewer's receive path (`apps/mobile/src/lib/webrtc.ts`, `apps/mobile/src/screens/ViewerScreen.tsx`).

**Method:** every file in the mandate was read in full, plus `apps/desktop/src-tauri/src/session.rs` (wires the pipeline, ABR controller, and peer together — not in the original file list but required to understand how `abr.rs`'s output actually reaches the encoder) and `apps/desktop/src-tauri/src/media/mod.rs` (module exports). Two claims about `webrtc-rs` 0.11.0's default codec/interceptor registration (pinned in `Cargo.lock:5603-5605`) were verified against the crate's upstream source rather than assumed, since the local code (`rtc/mod.rs:108-115`) doesn't declare RTCP feedback or SDP `fmtp` itself. Every other claim is grounded in a specific file:line in this repository.

## Executive Summary

The M2 prototype proves the architecture works — real ScreenCaptureKit capture, hardware H.264, real RTP over a real ICE/DTLS/SRTP peer, all covered by genuine (non-mocked) integration tests. That is a solid foundation. But nothing in the pipeline yet behaves like a product tuned for "feels like local rendering": capture resolution and frame rate are hardcoded to 1280×720@30 regardless of the actual display (`capture/mod.rs:55-63`, never overridden in `session.rs:465-480`), every frame is captured/converted/encoded even when the screen hasn't changed at all (no dirty-region or idle detection anywhere in the desktop crate), and — most seriously — the adaptive-bitrate loop's only mechanism for changing the encoder's bitrate is to **tear down and rebuild the entire compression session**, which forces an IDR keyframe on every single retarget (`videotoolbox.rs:213-219`, `software.rs:80-88`). Given the AIMD controller's default 2-second upward-probe cadence (`abr.rs:43`), a healthy, improving network connection causes a full keyframe roughly every 2 seconds — on top of, and defeating, the encoder's own 1-second GOP tuning — burning bandwidth on redundant I-frames at precisely the moments adaptation should be saving it. Separately, the capture path pays for two full-frame CPU memcpys (once in `screencapturekit.rs:71-102` to pull pixels out of the `CVPixelBuffer`, again in `videotoolbox.rs:138-155` to push them into an `IOSurface`) when ScreenCaptureKit's `CVPixelBuffer` is very likely already `IOSurface`-backed and could be handed to VideoToolbox directly. None of these are exotic bugs; they're the ordinary gap between "it works" and "it's tuned," and every one below is scoped with a concrete redesign, a migration path, and a test plan so it's implementable without re-deriving the analysis.

Findings are ordered by user-facing severity for a production remote-desktop competing with Parsec/AnyDesk/Jump Desktop.

---

## Finding 1: Capture resolution and frame rate are hardcoded, never matched to the real display

### Current implementation (cite file:line)

`CaptureConfig::default()` fixes `width: 1280, height: 720, fps: 30` (`apps/desktop/src-tauri/src/media/capture/mod.rs:55-63`). `EncoderSettings::default()` independently fixes the same numbers plus `bitrate_kbps: 2500, keyframe_interval: 30` (`apps/desktop/src-tauri/src/media/encoder/mod.rs:33-43`). The only place a live session builds its pipeline config is `start_media_pipeline` in `apps/desktop/src-tauri/src/session.rs:465-480`, which takes `PipelineConfig::default()` and overrides **only** `capture_kind` and `encoder_kind` (lines 470-471) — `capture.width/height/fps` and `encoder.width/height/fps` are never touched. `ScreenCaptureKitSource::start()` then configures the `SCStream` with exactly those fixed numbers (`apps/desktop/src-tauri/src/media/capture/screencapturekit.rs:185-190`, `with_width`/`with_height`/`with_fps`), and ScreenCaptureKit will scale the actual display content into that fixed buffer size — it does not report or adapt to the display's native resolution or refresh rate anywhere in this code.

### Problems

- A user with a 4K/5K Retina display or an ultrawide monitor gets their entire desktop downscaled/cropped into a 1280×720 16:9 buffer — small text and UI chrome in the controlled app becomes illegible, which is disqualifying for a remote-desktop product whose whole pitch is "feels local."
- A 120Hz/ProMotion display is capped at 30fps with no attempt to use the display's actual refresh rate, leaving perceptible motion smoothness on the table on hardware that supports better.
- Aspect-ratio mismatch has a second-order effect on input precision: `apps/mobile/src/screens/ViewerScreen.tsx:103` renders the track with `objectFit="contain"`, and the touch handlers at lines 76, 82, 87 normalize touch position against the _container's_ layout size (`layout.current.w/h`, set at line 61-63), not the actual letterboxed video rect. Whenever the capture's fixed 16:9 buffer doesn't match the source display's real aspect ratio, `contain` introduces letterbox bars, and touches landing in or near those bars map to the wrong on-screen position on the host. This turns a resolution bug into a control-precision bug.

### Root cause

The pipeline was built and tested against a single hardcoded 720p profile (matching the crate's own test fixtures, e.g. `media_pipeline.rs:14-18` uses 320×240) and that same default silently became the production path — nothing in `session.rs` was ever added to query the real display characteristics before building `PipelineConfig`.

### Redesign

1. Add a `fn primary_display_mode() -> Result<(u32, u32, u32)>` (width, height, refresh-rate-hz) to `screencapturekit.rs`, implemented via `SCShareableContent::get()` → `displays()[0]` (already used at `start()`, line 177-182) plus `CGDisplayModeGetRefreshRate`/`CGDisplayPixelsWide/High` (or the equivalent exposed by the `screencapturekit` crate's `SCDisplay`, if it wraps this — verify against the crate's `SCDisplay` API before implementing).
2. Call this before building `PipelineConfig` in `start_media_pipeline` (`session.rs:465`), and set `config.capture.width/height/fps` and `config.encoder.width/height/fps` from the real values, capping fps at a sane ceiling (e.g. 60) and width/height at an encode-cost ceiling (e.g. 1920×1200) with a downscale-to-fit rather than a fixed 720p target — encode cost and bitrate should scale with the real display, not silently truncate it.
3. Preserve even-dimension enforcement (`& !1`, already done at `screencapturekit.rs:132-134` and `synthetic.rs:34-36`) after the real-resolution computation.
4. On the mobile side, once resolution matches the source exactly (or at least preserves its aspect ratio), also switch `ViewerScreen.tsx`'s touch-normalization to divide by the _actual rendered video rect_ inside the container (computable from track dimensions + `objectFit=contain` math) rather than the raw container layout, closing the input-precision gap even for any residual aspect mismatch.

### Tradeoffs

Higher-resolution capture raises CPU/GPU/encode cost and bandwidth need proportionally (a 4K capture is ~9x the pixels of 720p) — this must be paired with Finding 6's dynamic-resolution-under-pressure work, or a strong network will get 4K and a weak one will stall badly. A capped downscale ceiling (not literal native-resolution passthrough) is the safer initial target.

### Implementation plan

1. Land the display-mode query behind a small trait method so it's unit-testable with a fake (mirrors the existing `CaptureBackend` abstraction).
2. Thread the queried values into `PipelineConfig` in `session.rs` only (no change to `PipelineConfig::default()`, which existing tests rely on for a stable 1280×720/30fps fixture).
3. Add a downscale-ceiling constant (e.g. `MAX_CAPTURE_LONG_EDGE = 1920`) applied after querying the real resolution.
4. Update the mobile touch-mapping math in a follow-up PR once resolution matching lands, since it depends on knowing the true video aspect ratio.

### Migration strategy

No wire-protocol change — this only affects what the desktop offers as capture/encode parameters, negotiated entirely locally before the offer is created. Ships as a single desktop-only release; no coordinated mobile rollout required for the capture-side fix. The touch-mapping fix should ship in the same mobile release as ViewerScreen's other tuning to avoid churn.

### Testing strategy

- Unit test the display-mode query against a fake `SCDisplay`-like value.
- Integration test: assert `PipelineConfig` built by `start_media_pipeline`'s (soon-to-be-refactored) config builder reflects a mocked non-16:9, non-720p display size end to end (extend `media_pipeline.rs`'s existing pattern of overriding `cfg.capture.width/height` per test).
- Manual test matrix: 13" MacBook (2560×1600 native/2x), external 4K, ultrawide 21:9 — confirm legible text and correct touch mapping in each.

### Risk assessment

Low-medium. The main risk is picking a downscale ceiling that's too aggressive (regression for 720p users) or too generous (regression for weak networks) — mitigate by gating the ceiling behind the ABR/dynamic-resolution work in Finding 6 landing first or concurrently.

### Performance impact

Neutral-to-negative for encode/CPU cost in isolation (more pixels) but strictly positive for the product's core value proposition (legibility, motion smoothness). Must ship alongside Finding 6 to avoid regressing weak-network users.

### Future extensibility

Once real display metadata flows into `PipelineConfig`, the same path supports multi-monitor selection (`SCShareableContent::displays()` already returns all displays, only `.next()` — the first — is used at `screencapturekit.rs:180`) as a natural next step, and per-display refresh-rate-aware fps selection for users who plug in a lower-refresh external display.

---

## Finding 2: Adaptive bitrate retargets by rebuilding the entire encoder session — forces an IDR on every change

### Current implementation (cite file:line)

`VideoToolboxEncoder::set_bitrate` (`apps/desktop/src-tauri/src/media/encoder/videotoolbox.rs:213-219`): if the requested kbps differs from the current setting, it unconditionally calls `self.reset()`, which calls `build_session(&self.settings)` (line 222) — a brand-new `CompressionSession` — and resets `frame_index = 0` (line 223). The encoder's own comment at lines 160-164 confirms: _"A freshly built session's first frame is always an IDR... rebuilding is the honest way to satisfy a forced keyframe today."_ `Openh264Encoder::set_bitrate` (`apps/desktop/src-tauri/src/media/encoder/software.rs:80-88`) does the identical thing — full `reset()` on any bitrate delta, with its own comment admitting _"Coarse but effective."_ The pipeline applies a changed `want_bitrate` on _every loop iteration_ where it differs from `current_bitrate` (`apps/desktop/src-tauri/src/media/pipeline.rs:110-120`), calling `encoder.set_bitrate(want_bitrate)` directly — there is no debounce or coalescing at this layer either.

Meanwhile `BitrateController::on_loss_report` (`apps/desktop/src-tauri/src/media/abr.rs:88-108`) probes upward every `increase_interval` (default `Duration::from_secs(2)`, line 43) whenever loss is clean, and each successful probe returns `Some(kbps)` (line 107), which `session.rs:352-357` forwards straight to `pl.control().set_target_bitrate(kbps)` — read by the pipeline loop next iteration and applied via `set_bitrate`.

### Problems

- **On a healthy, improving network, the encoder issues a fresh IDR roughly every 2 seconds** — on top of, and independent from, the encoder's own configured `keyframe_interval` (30 frames ≈ 1s at 30fps, `encoder/mod.rs:40`). A keyframe is typically 5-10x the size of a delta frame; this defeats the whole point of tuning a short GOP for low latency, because the "short GOP" is now irrelevant — IDRs are arriving faster than the GOP interval anyway, driven by an unrelated control loop.
- The `VideoToolboxEncoder` reset path is also taken for the drop-recovery keyframe (`pipeline.rs:146,165`, via `encode()`'s `force_keyframe && self.frame_index != 0` check at `videotoolbox.rs:165-168`) and for viewer PLI/FIR — meaning a single dropped frame under transient network backpressure, or a single viewer decoder hiccup, triggers a _full VideoToolbox session teardown/rebuild_ on the hot path, not merely a request for the next frame to be an IDR. `openh264`'s equivalent (`force_intra_frame()`, `software.rs:47`) is comparatively cheap — an in-session request, no rebuild — so the two backends behave very differently under the same recovery event, and the production backend (VideoToolbox, selected by default in `session.rs:450-453`) is the expensive one.
- Rebuilding a `VTCompressionSession` is a documented-expensive OS-level operation — the very problem the pipeline already partially fixed for _periodic_ keyframes (`pipeline.rs:139-145`'s comment explicitly describes this prior bug: _"force only the cases the encoder can't know about... forcing them here too was redundant for openh264 and made VideoToolbox rebuild its whole session every interval"_) — yet the identical expensive rebuild remains wired into the bitrate-retarget path, unaddressed.
- No debounce: if RTCP reports arrive in a burst (e.g., a receiver report and a REMB in close succession both compute a new target), each distinct kbps value triggers its own `set_bitrate` call and therefore its own rebuild.

### Root cause

Neither the `videotoolbox` nor `openh264` Rust crate wrapper used here exposes a live, in-session bitrate property mutation — `videotoolbox.rs` never calls anything like `VTSessionSetProperty(kVTCompressionPropertyKey_AverageBitRate, …)` on the _existing_ session (unlike, e.g., the existing FFI shim in this same file at lines 32-42 for parameter-set extraction, which shows the codebase is already willing to drop to raw Core Media/VideoToolbox C APIs when the crate is insufficient). Session rebuild was the fastest way to get _a_ working `set_bitrate`, and it was never revisited once ABR started actually driving it continuously.

### Redesign

1. **VideoToolbox:** add a small `extern "C"` FFI shim (same pattern already used at `videotoolbox.rs:32-42`) calling `VTSessionSetProperty` with `kVTCompressionPropertyKey_AverageBitRate` on the live `CompressionSession`, avoiding any rebuild. VideoToolbox explicitly supports changing this property on a running session without an IDR being required.
2. **VideoToolbox force-keyframe:** likewise add a per-frame `kVTEncodeFrameOptionKey_ForceKeyFrame` option passed into `VTCompressionSessionEncodeFrame` (the `videotoolbox` crate's `encode()` call at line 179 would need either a new parameter or a raw FFI encode path) instead of `reset()`. This removes the session-rebuild cost from _both_ the ABR-retarget and the PLI/drop-recovery paths in one change, since both currently funnel through the same `reset()`.
3. **openh264:** check whether the wrapped `openh264` crate/`Encoder` exposes a runtime bitrate-adjustment call (many libavcodec-style wrappers do, distinct from `force_intra_frame()` which already works in-session per line 47); if the crate genuinely doesn't expose one, keep the reset-based fallback there but debounce it (see #4) since it's the non-default backend.
4. **Debounce at the pipeline layer:** in `pipeline.rs`'s loop (around lines 110-120), only call `encoder.set_bitrate` if the requested value differs from `current_bitrate` by more than a threshold (e.g. 5%) AND at least N ms have elapsed since the last change — this bounds the retarget rate independent of the encoder-level fix and protects the non-fixed openh264 path too.

### Tradeoffs

The raw `VTSessionSetProperty` FFI shim adds a small amount of unsafe surface (mirroring what's already accepted for parameter-set extraction), but it's a narrow, well-understood VideoToolbox API. Debounce adds a small amount of latency to bitrate convergence (bounded by the debounce window, e.g. 200-500ms) — acceptable given AIMD's own 2-second probe cadence.

### Implementation plan

1. Ship the pipeline-layer debounce first (Item 4) — it's backend-agnostic, low-risk, and immediately caps the worst-case rebuild rate on both encoders with no crate-level FFI work.
2. Follow with the VideoToolbox live-property FFI shim (Item 1) — eliminates rebuilds for the common (non-drop, non-PLI) ABR path entirely.
3. Follow with the VideoToolbox per-frame force-keyframe FFI (Item 2) — eliminates rebuilds for the PLI/drop-recovery path too.
4. Investigate the openh264 crate's API surface for a non-reset bitrate path as a lower-priority cleanup.

### Migration strategy

Entirely desktop-internal; no wire or protocol change, no mobile-side coordination needed. Ship as a normal desktop release. Because `EncoderSettings`/`VideoEncoder` trait signatures don't need to change (only internal implementations), this is safe to land incrementally per item without a flag.

### Testing strategy

- Extend `videotoolbox.rs`'s existing `set_bitrate_reconfigures_without_error` test (line 374-378) to additionally assert the session/`frame_index` was _not_ reset (i.e., `frame_index` continues incrementing across the call) once the live-property path lands.
- Add a test mirroring `media_pipeline.rs`'s `keyframe_request_forces_idr_on_next_frame` (lines 11-49) but for _bitrate changes_: assert repeated `set_target_bitrate` calls over a long GOP (`keyframe_interval: 3000`, same pattern as line 18) do **not** produce extra keyframes beyond the intentional first one.
- Add a debounce unit test: rapid-fire `set_target_bitrate` calls within the debounce window should coalesce to a single `encoder.set_bitrate` call (requires exposing a call-count testable seam, e.g. a spy `VideoEncoder` impl in `pipeline.rs`'s test module).

### Risk assessment

Medium. The FFI shim touches real VideoToolbox session state on the production path — needs on-device testing (already the pattern for this file, which has real hardware tests at lines 289-348 and 350-371) before shipping. The debounce is low-risk and should ship independently first to de-risk the release.

### Performance impact

This is the single highest-leverage fix in this audit for the M5 "feels like local rendering" mandate on real (non-LAN) networks: eliminating spurious IDRs during ABR convergence directly reduces bandwidth spent on redundant I-frames, which is bandwidth that should instead either lower latency (smaller queue backlog) or raise visual quality on P-frames. Expect a measurable reduction in `avg_frame_bytes` (`metrics.rs:84`) variance and in `frames_dropped`/forced-recovery-IDR frequency (since IDR storms are the events most likely to overflow the 4-frame queue in `session.rs:475-480`, per Finding 13).

### Future extensibility

Once VideoToolbox supports fine-grained live property control, the same mechanism generalizes to live keyframe-interval and (per Finding 6) live encoder resolution changes without a rebuild — worth designing the FFI shim as a small general "live property setter" rather than one bitrate-specific function.

---

## Finding 3: Two full-frame CPU copies before the frame ever reaches the hardware encoder

### Current implementation (cite file:line)

`FrameHandler::did_output_sample_buffer` in `apps/desktop/src-tauri/src/media/capture/screencapturekit.rs:66-117` locks the `CVPixelBuffer` read-only (line 72) and copies every row into a freshly-reused `Vec<u8>` (lines 82-101) — a full-frame CPU memcpy (with per-row bounds handling for stride mismatches). This becomes the `RawFrame.bgra: Vec<u8>` (`apps/desktop/src-tauri/src/media/frame.rs:11`). Downstream, `VideoToolboxEncoder::encode` (`apps/desktop/src-tauri/src/media/encoder/videotoolbox.rs:159-211`) calls `write_bgra_into_surface` (lines 138-155), which locks a _separate_ `IOSurface` and copies that same pixel data row-by-row _again_ (lines 147-153) before handing the surface to the hardware compressor.

### Problems

- Two full-frame memcpys per frame is pure overhead with no algorithmic benefit: at 1280×720 BGRA (≈3.7MB/frame) and 30fps, that's roughly 221MB/s of memory bandwidth spent copying pixels the OS almost certainly already has in a hardware-accessible surface. At a corrected native 4K capture (per Finding 1), this scales to ~2GB/s — a meaningful CPU/battery cost with zero visual benefit.
- This directly adds to capture-to-glass latency: both copies happen synchronously on the pipeline's dedicated capture/encode thread (`pipeline.rs:126-136` timing window includes the ScreenCaptureKit copy via `capture.next_frame()`; the IOSurface copy happens inside `encoder.encode()` at `pipeline.rs:147`, measured in `encode_us_total`), so this is time subtracted directly from the `PipelineMetrics::record_latency` budget documented at `metrics.rs:17-19` as the "desktop-side latency budget."
- The file's own module doc (`videotoolbox.rs:3-6`) states the intent explicitly: _"VideoToolbox's hardware does the BGRA→YUV conversion internally, so this backend skips the software `bgra_to_i420` conversion entirely"_ — the design already recognizes zero-copy-to-hardware as the goal for the YUV conversion step, but doesn't carry that same zero-copy intent back one stage further to the capture→IOSurface handoff.

### Root cause

`CVPixelBuffer`s vended by `SCStream` for screen content are, in practice, backed by an `IOSurface` already (accessible via `CVPixelBufferGetIOSurface`). The current code path never checks for or extracts that existing `IOSurface`; instead it always materializes a plain `Vec<u8>` (an OS-agnostic intermediate `RawFrame` representation used identically by the cross-platform `CaptureBackend` trait and the software `openh264` path), then — on the VideoToolbox path only — re-wraps those same bytes into a _new_, unrelated `IOSurface`. The `RawFrame`/`CaptureBackend` abstraction (`capture/mod.rs:13-37`) was designed to be encoder-agnostic (the same `RawFrame` feeds both `Openh264Encoder`, which needs a `Vec<u8>` to convert to I420, and `VideoToolboxEncoder`, which wants a native surface) — but that generality is exactly what forces the wasteful path when VideoToolbox is in use.

### Redesign

1. Introduce a capture-side variant that preserves the _native_ `IOSurface` handle when available, e.g. extend `RawFrame` with an optional `iosurface: Option<IOSurface>` field (or a small enum `PixelSource { Bytes(Vec<u8>), Surface(IOSurface) }`) populated by `FrameHandler::did_output_sample_buffer` via `CVPixelBufferGetIOSurface` when running on the ScreenCaptureKit backend.
2. `VideoToolboxEncoder::encode` checks for the native surface first and feeds it directly to `self.session.encode(...)`, skipping `next_surface`/`write_bgra_into_surface` entirely when present; falls back to the existing copy-based path only when a native surface isn't available (synthetic source, or a future non-macOS capture backend).
3. `Openh264Encoder` is unaffected — it still needs the `Vec<u8>` path for `bgra_to_i420`, so the byte-copy in `screencapturekit.rs` should only be skipped when the encoder in use is VideoToolbox (a config-time decision already known in `session.rs:471`).

### Tradeoffs

Adds a conditional path and couples `RawFrame`'s shape more tightly to macOS surface types (behind `#[cfg(target_os = "macos")]`, consistent with the existing `screencapturekit`/`videotoolbox` modules' own gating). Increases the surface area of what `CaptureBackend` implementations must produce, though the `Option`/enum approach keeps the trait itself unchanged and cross-platform-safe.

### Implementation plan

1. Verify (spike, on-device) that `SCStream`'s delivered `CVPixelBuffer`s do in fact carry a valid `IOSurface` via `CVPixelBufferGetIOSurface` for the configured `BGRA` pixel format (`screencapturekit.rs:188`) — this is the load-bearing assumption and must be confirmed empirically before the redesign is finalized, since ScreenCaptureKit's IOSurface-backing behavior can depend on pixel format and `SCStreamConfiguration` options not covered by this audit.
2. If confirmed, add the `IOSurface` passthrough field to `RawFrame` and wire it in `FrameHandler`.
3. Update `VideoToolboxEncoder::encode` to prefer the native surface.
4. Retain the existing copy path unconditionally for `Openh264Encoder` and the synthetic source.

### Migration strategy

Fully internal to the desktop capture/encode pipeline; no protocol or mobile changes. Land behind the existing `EncoderKind`/`CaptureKind` selection already in `session.rs` — ship once validated on-device, no flag needed beyond normal release gating.

### Testing strategy

- Existing hardware tests in `videotoolbox.rs` (`encodes_a_real_hardware_keyframe_then_delta`, line 327-348; `reused_iosurface_sustains_a_multi_frame_stream`, line 350-371) should continue to pass unmodified against the fallback (byte-copy) path, proving no regression there.
- Add a new on-device-only test asserting that when a native `IOSurface` is supplied, no byte-copy occurs (e.g. instrument `write_bgra_into_surface` call count via a test-only counter, or assert wall-clock encode time drops materially for a fixed frame size — the latter is noisier but requires no new test seams).
- Re-run `rtc_media_e2e.rs`'s real end-to-end RTP test after the change to confirm the video track still produces valid decodable H.264 (it currently uses the synthetic source, so this test alone won't exercise the new path — flag as a gap needing an on-device manual verification pass).

### Risk assessment

Medium — the core risk is the unverified assumption that ScreenCaptureKit's delivered buffers are reliably `IOSurface`-backed for this configuration; if not, the redesign degrades gracefully to today's behavior (fallback path), so the risk is "we don't get the win," not "we regress."

### Performance impact

Removes ~3.7MB × 2 of memcpy per frame at 720p (scaling with resolution — more, proportionally, once Finding 1 lifts the resolution ceiling); directly shrinks the desktop-side portion of the latency budget documented in `metrics.rs:17-19`, and reduces CPU/battery draw, which matters for a laptop-hosted product running for hours.

### Future extensibility

The same native-surface-passthrough pattern is the prerequisite for any future GPU-side scaling/cropping (e.g. multi-monitor region selection, cursor compositing) done via Metal/Core Image directly on the surface instead of CPU pixel manipulation.

---

## Finding 4: No dirty-region / static-content detection anywhere in the pipeline

### Current implementation (cite file:line)

`FrameHandler::did_output_sample_buffer` (`screencapturekit.rs:66-117`) processes and publishes **every** `CMSampleBuffer` the `SCStream` delivers, unconditionally — there is no check of any per-sample "frame status" or damage-region attachment before doing the full copy/publish work. The pipeline's main loop (`pipeline.rs:108-202`) then captures, converts, and encodes every published frame at the configured cadence with no similarity check against the previous frame. `Openh264Encoder`'s config explicitly disables the encoder's own skip-frame heuristic: `.enable_skip_frame(false)` (`software.rs:39`), with the comment "we manage drops upstream" — but "upstream" (the pipeline) only drops frames under queue backpressure (`pipeline.rs:162-168`), never due to content similarity.

### Problems

- A static desktop (no mouse movement, no animation, user reading a document) still drives full-rate capture, a full CPU/IOSurface copy (Finding 3), and a full H.264 encode 30 times a second, indefinitely. This is the dominant real-world usage pattern for remote-desktop sessions (most of a session is not full-motion video), and it's being treated identically to a fast-moving scene.
- Battery and thermal cost on a laptop host scale directly with this — a session left open while the user reads something on the controlled screen burns the same CPU/GPU/network budget as one with constant motion.
- ScreenCaptureKit is specifically capable of reporting per-frame change status (frame "idle"/"complete"/"blank" attachments on the sample buffer) precisely so callers can skip redundant work — the product's own module doc for this file (`screencapturekit.rs:1-17`) doesn't mention this capability at all, suggesting it wasn't evaluated.

### Root cause

The capture path was built to satisfy "deliver a frame at the configured fps" (matching the synthetic source's contract, which always produces new content, `synthetic.rs:120-129`) and never differentiated ScreenCaptureKit's actual delivery semantics, which can include repeated/idle notifications for unchanged content.

### Redesign

1. Inspect the sample buffer's per-frame status attachment (the `screencapturekit` crate's `SCStreamOutputTrait`/`CMSampleBuffer` wrapper should expose this — needs verification against the crate's API surface, since this file's imports (`screencapturekit::prelude::*`, line 25) weren't traced further than what's used today) inside `did_output_sample_buffer`, and skip publishing to the `FrameSlot` (or publish a lightweight "no-change" marker) when the frame is reported idle/unchanged.
2. On the pipeline side, when no new frame has arrived within one frame interval but the previous frame was unchanged, hold the encoder idle rather than re-encoding identical content — this pairs naturally with Finding 7 (idle/background throttling): a run of unchanged frames is the same signal that should trigger throttling.
3. Keep periodic keyframes (`keyframe_interval`, `encoder/mod.rs:40`) firing on a wall-clock cadence even during a static period, so a viewer that joins mid-static-period still gets a timely IDR — this must not be skipped just because content is unchanged.

### Tradeoffs

Adds complexity to the capture output handler and requires careful interaction with the encoder's own frame-pacing expectations (encoders generally expect a steady input cadence for rate control; simply _not calling_ `encode()` for unchanged frames, rather than encoding-and-discarding, needs verification that both `openh264` and VideoToolbox's rate controllers tolerate a variable input cadence gracefully). Risk of visible artifacts if "idle" detection has false positives (e.g. a slowly-fading animation misclassified as static).

### Implementation plan

1. Spike: confirm what change/idle metadata the `screencapturekit` crate actually surfaces from `CMSampleBuffer`/`SCStreamFrameInfo` before committing to an approach.
2. Add idle detection at the `FrameHandler` level, publishing a distinguishable "unchanged" signal into the `FrameSlot`.
3. Extend `next_frame()` (`screencapturekit.rs:206-222`) or the pipeline loop to skip the encode call for unchanged frames while still respecting the keyframe cadence.
4. Add metrics counters for "frames skipped as unchanged" to `PipelineMetrics` (`metrics.rs:9-24`) to measure the win in the field.

### Migration strategy

Desktop-only, no protocol change (skipping an encode simply means fewer RTP packets are sent — the receiver already tolerates variable frame delivery, as this is normal WebRTC behavior). Ship as an opt-outable feature flag initially given the risk of interaction with rate control, then default-on once validated.

### Testing strategy

- The `synthetic.rs` source always produces changing content (by design, per its doc comment lines 1-6) — it cannot exercise this path. Add a new synthetic-source mode (or a wrapper) that holds output static for N frames to exercise idle-skip logic in the crate's existing test harness pattern (`media_pipeline.rs`).
- Assert via `PipelineMetrics` that a static-content run produces measurably fewer `frames_encoded` than `frames_captured` once the feature is enabled, while `keyframes` still fires on schedule.
- On-device manual test: leave a session open on a static desktop, confirm via Activity Monitor / `powermetrics` that CPU draw drops relative to a moving-content baseline.

### Risk assessment

Medium-high (highest-effort item in this list): touches core pipeline cadence assumptions and needs on-device validation with real ScreenCaptureKit metadata whose exact shape wasn't verified in this audit. Recommend it as a fast-follow after Findings 1-3, not a blocker for the same release.

### Performance impact

Potentially the single largest battery/CPU win in this document for typical usage patterns (most of a session is static or near-static), and it directly reduces sustained bandwidth consumption, which improves headroom for Finding 2's ABR to actually spend on quality when content _is_ changing.

### Future extensibility

The same idle signal is the natural trigger for Finding 7's background throttling (drop fps/bitrate further when idle _and_ the app is backgrounded) and for a future true region-based (dirty-rect) partial encode, if the encoder/protocol ever supports tiled or region-based updates.

---

## Finding 5: Adaptive bitrate reacts only to loss and REMB — no TWCC, no RTT

### Current implementation (cite file:line)

The video track's codec capability is declared with only a MIME type, nothing else: `RTCRtpCodecCapability { mime_type: MIME_TYPE_H264.to_owned(), ..Default::default() }` (`apps/desktop/src-tauri/src/rtc/mod.rs:108-114`) — no `sdp_fmtp_line`, no explicit `rtcp_feedback`. Verified against `webrtc-rs` 0.11.0 (pinned at `Cargo.lock:5603-5605`) upstream source: `MediaEngine::register_default_codecs()` registers H.264 with RTCP feedback types `goog-remb`, `ccm fir`, `nack`, and `nack pli` — **`transport-cc` is not among them for H.264**, so the negotiated SDP never advertises TWCC support for the video m-line regardless of what the mobile viewer's underlying `libwebrtc` (via `react-native-webrtc`) could otherwise provide. The RTCP receive loop in `rtc/mod.rs:122-149` only branches on `PictureLossIndication`/`FullIntraRequest` (→ `VideoKeyframeRequest`, line 129-131), `ReceiverEstimatedMaximumBitrate` (→ `VideoRemb`, lines 132-137), and `ReceiverReport` (→ `VideoLossReport`, taking the _worst_ `fraction_lost` across all report blocks in the packet, lines 138-146) — there is no `TransportLayerCc` branch at all. `BitrateController` (`abr.rs:49-121`) only ever sees `on_loss_report(fraction_lost, now)` and `on_remb(bitrate_bps)` — it has no notion of RTT and no bandwidth-estimate signal finer-grained than REMB's single aggregate number.

### Problems

- REMB is the older, coarser bandwidth-estimation mechanism in the WebRTC ecosystem; modern stacks primarily use TWCC-derived estimates (e.g. Google Congestion Control) because per-packet transport-wide feedback reacts faster and more precisely to changing conditions than periodic loss-fraction/REMB reports. This codebase is structurally locked out of that path by its own codec-capability declaration, not merely "not yet implemented."
- Pure loss-fraction AIMD is inherently reactive, not predictive: by the time `fraction_lost` crosses the 10% decrease threshold (`abr.rs:39`), packets have already been lost — the viewer has already seen glitches. A TWCC-style estimator can react to queueing delay _before_ packets are dropped.
- No RTT signal is captured or used anywhere (`ReceiverReport`'s `last_sr`/`delay_since_last_sr` fields, which would let the sender compute RTT, aren't read at `rtc/mod.rs:138-146` — only `fraction_lost` is extracted). RTT is directly useful both as an ABR input (e.g. don't probe upward if RTT is climbing, a sign of queue buildup) and as a diagnostic (distinguishing "bad last-mile network" from "server-side backend/relay issue").

### Root cause

The ABR implementation was built against the two feedback signals `webrtc-rs`'s default interceptor stack hands back with zero extra configuration (REMB and receiver-report loss), and the codec capability was never extended to request `transport-cc` feedback, so the richer signal was never in reach without additional negotiation work.

### Redesign

1. Add `transport-cc` to the video track's advertised RTCP feedback. Since `webrtc-rs`'s `register_default_codecs()` doesn't offer it for H.264, this likely requires registering a custom H.264 codec via `MediaEngine::register_codec` with an explicit `RTCRtpCodecParameters` including a `transport-cc` `RTCPFeedback` entry, rather than relying on `register_default_codecs()` — verify against the crate's registration API before implementing, since this changes `build_api()` in `rtc/mod.rs:285-294`.
2. Register the TWCC _sender_-side interceptor (adds the transport-wide sequence number RTP header extension to outgoing packets) — `register_default_interceptors` in this version registers a TWCC **receiver**-only interceptor (confirmed upstream), which processes incoming TWCC feedback structurally but the registry construction (`rtc/mod.rs:289`) would need an additional interceptor for full sender-side bandwidth estimation (e.g. wiring in `webrtc-rs`'s GCC-equivalent, if the crate ships one, or implementing a minimal transport-wide feedback → bandwidth-estimate translation directly in this codebase as a new pure-logic module analogous to `abr.rs`).
3. Extract RTT from `ReceiverReport.reports[].last_sender_report`/`delay_since_last_sr` (available today with no protocol change) and feed it into `BitrateController` as a new input — e.g. suppress upward probing when RTT is trending upward even if loss is nominally clean, catching bufferbloat before it becomes loss.

### Tradeoffs

Registering a custom H.264 codec instead of the default increases the surface area of SDP negotiation code and needs careful testing against `react-native-webrtc`'s actual offer/answer behavior (risk of an interop regression if the custom registration diverges from what `register_default_codecs()` produces in other respects, like the `sdp_fmtp_line` profile variants). Implementing a from-scratch TWCC-to-bandwidth-estimate translator is a meaningful chunk of new logic (this is, in essence, reimplementing a slice of Google Congestion Control) — should be scoped as its own project, not bundled casually.

### Implementation plan

1. Ship the RTT extraction from existing `ReceiverReport` data first (Item 3) — zero protocol change, immediate diagnostic and modest ABR-quality value, lowest risk.
2. Spike custom H.264 codec registration with `transport-cc` feedback (Item 1) against a real `react-native-webrtc` client to confirm it still negotiates a working H.264 session.
3. Scope the sender-side TWCC bandwidth estimator (Item 2) as a separate, larger initiative once 1-2 are validated — likely M6+ rather than M5, given its scope.

### Migration strategy

Items 1-2 change SDP offer contents — must be validated against the _current production_ mobile client (`apps/mobile`) before rollout, since a malformed or unexpected codec negotiation could break connectivity entirely. Roll out behind a feature flag on the desktop side with the ability to fall back to today's default-codec registration.

### Testing strategy

- Extend `abr.rs`'s existing table of pure-logic unit tests (lines 123-198) with new cases once RTT is added as an input — e.g. "clean loss but rising RTT suppresses the upward probe."
- Extend `rtc_media_e2e.rs`'s real-peer test (which already validates the full ICE/DTLS/SRTP/RTP path, lines 1-160) to assert the negotiated SDP contains `transport-cc` in the video m-line's `rtcp-fb` once the codec registration changes, and that RTP still flows (regression guard against a broken custom registration).
- Manual interop test against the actual `react-native-webrtc` mobile client is mandatory before shipping Item 1 — SDP negotiation bugs are exactly the class of bug unit/integration tests in this repo (which use a second `webrtc-rs` peer as the answerer, not the real mobile stack) cannot catch.

### Risk assessment

High for Items 1-2 (SDP negotiation changes are a classic source of "works with our test peer, breaks with the real one" regressions); low for Item 3 (purely additive, no wire change).

### Performance impact

Faster, smoother convergence to available bandwidth and fewer loss-triggered quality drops — the core promise of "adaptive bitrate" done properly. RTT-awareness alone should reduce the frequency of the loss-triggered multiplicative decrease (`abr.rs:89-93`) by catching congestion before it manifests as loss.

### Future extensibility

Full TWCC-based estimation is also the prerequisite for any future simulcast/SVC work (multi-quality-layer streaming), since those designs assume a modern bandwidth estimator as their control input.

---

## Finding 6: No dynamic resolution/FPS scaling — quality degrades only via bitrate, never resolution

### Current implementation (cite file:line)

`PipelineControl` (`apps/desktop/src-tauri/src/media/pipeline.rs:43-60`) exposes exactly two live-tunable knobs: `set_target_bitrate` and `request_keyframe`. There is no `set_resolution` or `set_fps`. `BitrateController` (`abr.rs:49-121`) has a hard floor of `min_kbps: 300` (`abr.rs:37`) — under sustained loss, the AIMD decrease (`×0.7`, line 91) converges toward that floor and simply stays there, per the `never_leaves_configured_bounds` test (`abr.rs:158-171`), with no other lever available.

### Problems

- At 300kbps and 1280×720@30fps (today's fixed resolution — see Finding 1), H.264 quality is going to be visibly poor (heavy blocking/blurring) — there is no fallback to trade resolution or frame rate for legibility, which is exactly the tradeoff Parsec/AnyDesk make on constrained links (drop to a lower resolution or fps to keep the _same_ bitrate budget looking sharp, rather than keeping full resolution and starving it).
- This compounds with Finding 1: once real display resolution flows through (e.g. a 4K source), a bandwidth floor that's currently barely tolerable at 720p becomes unusable at higher resolutions with no scaling escape valve.

### Root cause

The pipeline and ABR were built bitrate-first because bitrate is the one parameter every encoder here already exposes a live-ish (if expensive, per Finding 2) mutation path for; resolution/fps changes require rebuilding capture (`ScreenCaptureKitSource::start`, `screencapturekit.rs:176-204`) and the encoder's dimensions together, which is more invasive and was reasonably deferred.

### Redesign

1. Extend `PipelineControl` with a `target_resolution_scale: AtomicU32` (e.g. a percentage: 100/75/50) alongside `target_bitrate_kbps`.
2. Add a "resolution ladder" policy in `BitrateController` (or a new sibling controller consuming its output): when the bitrate target has been pinned at `min_kbps` for longer than some sustained window (e.g. 5s) and loss is still elevated, step down one resolution rung instead of continuing to starve the current resolution; step back up analogously once bandwidth recovers and holds for a cooldown window (mirroring the existing `increase_interval` rate-limiting pattern at `abr.rs:98-104`).
3. Wire a resolution-rung change to _re-run_ the capture/encoder resize path — for VideoToolbox this is already a supported "recreate on dimension change" flow (`next_surface`'s staleness check, `videotoolbox.rs:124-136`); for ScreenCaptureKit, `SCStreamConfiguration` updates typically require reconfiguring the stream (verify against the crate's update-config API vs. a full stop/restart).

### Tradeoffs

A resolution change is visually more disruptive than a bitrate change (the viewer sees a discrete jump, not a gradual quality shift) and — depending on how ScreenCaptureKit's stream reconfiguration is implemented — may itself require a brief capture interruption, so the hysteresis (sustained-window-before-stepping) must be generous enough to avoid flapping.

### Implementation plan

1. Design the resolution ladder as pure decision logic first, in the same testable style as `abr.rs` (no I/O, `Instant` passed in) — e.g. a `ResolutionLadder` type consuming the same loss/REMB signals plus "time spent pinned at floor."
2. Wire ladder decisions into a new `PipelineControl` field.
3. Implement the actual resize path per backend (VideoToolbox first, since it's the production default).
4. Add telemetry (a new `MetricsSnapshot` field, e.g. `resolution_scale_pct`) to observe ladder behavior in the field before fully trusting it.

### Migration strategy

Purely desktop-internal (resolution changes are invisible to the wire protocol — the video track simply starts producing differently-sized frames, which any WebRTC H.264 receiver handles via normal SPS/PPS renegotiation on the next keyframe). No mobile changes required, though the mobile `RTCView`'s `objectFit="contain"` (`ViewerScreen.tsx:103`) should already handle a resolution change gracefully since it re-fits per frame.

### Testing strategy

- Unit-test the resolution ladder's decision logic exhaustively (pinned-at-floor timing, step-up cooldown, hysteresis) in the same style as `abr.rs`'s existing test module (lines 123-198).
- Integration test: drive `MediaPipeline` through a sustained-high-loss scenario (via a test double replacing real RTCP with synthetic loss reports, following the `keyframe_request_forces_idr_on_next_frame` pattern) and assert a resolution step-down occurs after the hysteresis window, then step-up after recovery.

### Risk assessment

Medium — the core logic is low-risk (pure decision code, easily unit-tested), but the resize execution path (especially ScreenCaptureKit reconfiguration) is the part most likely to have on-device surprises and needs hands-on validation.

### Performance impact

Should materially improve perceived quality on constrained/degrading networks compared to today's bitrate-only degradation, at the cost of occasional visible resolution transitions — a favorable tradeoff for legibility-focused remote control.

### Future extensibility

The same ladder concept extends naturally to fps scaling (drop to 15fps under severe constraint before dropping resolution further, or vice versa depending on content type — a future per-content-type policy, e.g. text-heavy vs. video-heavy source, could pick which axis to sacrifice first).

---

## Finding 7: No idle/away detection or background throttling

### Current implementation (cite file:line)

A repo-wide search of `apps/desktop/src-tauri/src` for idle/throttle/background-power concepts turns up nothing related to _capture_ idle detection — only unrelated uses of "idle" for pairing/session UI state (`apps/desktop/src-tauri/src/state.rs:16,43`, `commands.rs:181-188,277-283`). The media pipeline (`pipeline.rs:108-202`) runs its capture→encode loop at the same configured cadence for the entire lifetime of the session, with no notion of "the user hasn't touched anything," "the viewer app is backgrounded," or "the screen content hasn't changed in N seconds."

### Problems

- A session left connected but unattended (viewer app backgrounded on the phone, or the desktop user stepped away) continues consuming full capture/encode/network resources indefinitely — no cost reduction kicks in.
- This is a well-established pattern in competing products (Parsec, AnyDesk) specifically because remote-desktop sessions are frequently left open longer than they're actively watched.

### Root cause

No idle/attention signal exists anywhere in the pipeline to throttle against — this is a straightforward gap rather than a design decision, and it depends on Finding 4's static-content detection existing as a foundation (an "idle" policy needs to know when nothing has changed before it can safely throttle).

### Redesign

1. Add an idle-timer alongside Finding 4's static-content detection: once N consecutive seconds of unchanged content are observed, step down fps (e.g. to 5-10fps) and/or bitrate independent of the ABR loop, resuming full cadence immediately on the next detected change.
2. Add a viewer-attention signal from the mobile side: the DataChannel or a lightweight signaling message indicating the app is backgrounded (React Native's `AppState`) — on receipt, the desktop can throttle far more aggressively (e.g. 1-2fps "keep-alive" cadence) since no one is actually watching, restoring full cadence on foreground.
3. Both signals should compose: static content alone throttles moderately; backgrounded _and_ static throttles maximally.

### Tradeoffs

Backgrounded-throttle in particular needs a fast, reliable resume path — any perceptible delay when the user re-opens the app to "wake" the stream back to full quality would feel broken. This requires the resume path to be at least as fast as, e.g., a fresh keyframe request (already fast via Finding 2's improvements) rather than a full pipeline restart.

### Implementation plan

1. Land after Finding 4 (shares the static-content signal).
2. Add the mobile `AppState`-driven signaling message as a new lightweight message type on the existing signaling channel (`apps/mobile/src/lib/webrtc.ts`'s `MobileSignaling`) or the DataChannel already open for input (`INPUT_CHANNEL_LABEL`, `webrtc.ts:9,122`) — reuse the existing channel rather than adding new signaling-server surface.
3. Wire both signals into a single throttle-policy module on the desktop, feeding `PipelineControl`.

### Migration strategy

Requires a coordinated mobile + desktop release (the backgrounded-signal half needs both sides), but is purely additive/optional — an old desktop talking to a new mobile client that sends the signal, or vice versa, should simply ignore the unfamiliar message rather than fail (verify the signaling message-handling default-case behavior, e.g. `session.rs`'s `handle_inbound` already has a no-op `_ => {}` catch-all at line 581, suggesting this is safely additive today).

### Testing strategy

- Unit test the throttle-policy decision logic in isolation (static+foreground vs static+background vs changing+background, etc.).
- Integration test simulating a backgrounded signal arriving mid-session, asserting the pipeline's fps/bitrate step down and recover correctly on a simulated foreground signal.
- Manual battery/thermal test: leave a session open and backgrounded for 10+ minutes, confirm CPU/battery draw drops substantially versus an actively-viewed session.

### Risk assessment

Low-medium — mostly new, additive logic with a clear fallback (no signal received → behaves exactly as today).

### Performance impact

Directly reduces the average power/CPU/network cost of a typical session, since most sessions include idle stretches; the win compounds with Finding 4.

### Future extensibility

The same attention signal is a natural hook for a future "away mode" UI affordance (e.g. auto-lock the host screen, or notify the desktop user their session is unattended).

---

## Finding 8: Capture stall detection is slow (2s) and purely terminal — no in-place recovery attempt

### Current implementation (cite file:line)

`FRAME_WAIT_TIMEOUT: Duration = Duration::from_secs(2)` (`apps/desktop/src-tauri/src/media/capture/screencapturekit.rs:41`). `next_frame()` (lines 206-222) blocks on a condvar up to this timeout and, if no frame arrived, returns `Err` (line 219). The pipeline's main loop treats any `capture.next_frame()` error as fatal: it logs and `break`s out of the loop entirely (`pipeline.rs:127-133`), closing the sample channel. `session.rs`'s consumer task (lines 490-505) detects the channel closed _without_ the stop flag being set and immediately ends the whole session (`media_fail_tx.send(...)`, lines 500-503; consumed at `session.rs:230-239`, disabling input and sending `SessionEvent::Ended`).

### Problems

- Two full seconds of a frozen viewer image before the system even recognizes a stall, then the _entire session_ is torn down — there is no attempt to restart just the `SCStream` (e.g. a transient hiccup from display sleep/wake, a macOS secure-input-mode toggle, or a momentary GPU driver issue) before giving up on the whole remote-control session.
- For a product targeting "feels like local," a full session teardown for what might be a sub-second recoverable glitch is a disproportionate response — the user has to re-pair/re-approve from scratch (per `session.rs`'s overall pairing flow) rather than seeing a brief freeze-and-recover.

### Root cause

The 2-second timeout and hard-fail behavior were designed as a safety net against a genuinely dead capture stream (matching the comment at `screencapturekit.rs:38-41`: "Generous... so it only fires on a genuine stream stall, not ordinary jitter") — reasonable as a _last-resort_ signal, but no intermediate recovery tier (stream restart) was built before escalating to full session death.

### Redesign

1. On a `next_frame()` timeout, before propagating a fatal error, attempt an in-place `SCStream` restart: call `stop()` (`screencapturekit.rs:246-252`) then `start()` (`screencapturekit.rs:176-204`) again, bounded to a small retry budget (e.g. 2 attempts) with a short backoff — mirroring the existing bounded-retry pattern already used for ICE restarts in `session.rs` (`MAX_ICE_RESTARTS`, line 72, and its usage at lines 313-333).
2. Only escalate to the pipeline-fatal path (today's behavior) once the retry budget is exhausted.
3. Surface a transient `SessionEvent` (e.g. a new `CaptureRecovering` variant, following the existing `SignalingReconnecting`/`SignalingReconnected` pattern at `session.rs:48-51`) so the UI can show "reconnecting video…" instead of nothing, and so this is observable/testable.

### Tradeoffs

A retry-before-fail adds a small amount of additional latency to the _genuine_ dead-stream case (today's fast-fail becomes fail-after-one-retry), and adds state-machine complexity to `ScreenCaptureKitSource`. Must ensure the retry logic can't itself hang (bounded attempts + timeout per attempt, not unbounded).

### Implementation plan

1. Add the bounded restart-retry loop inside `ScreenCaptureKitSource` (or as a wrapper the pipeline calls), reusing `stop()`/`start()`.
2. Add the new transient `SessionEvent` variant and wire it through `session.rs`'s existing event-emission pattern.
3. Keep the ultimate fatal path (channel closes, `stop_flag` unset) exactly as today once retries are exhausted, preserving the crash-detection contract `pipeline_fault.rs` tests today.

### Migration strategy

Fully desktop-internal; the new `SessionEvent` variant is additive to the existing `#[serde(tag = "kind", ...)]` enum (`session.rs:33-58`) and the UI (Tauri frontend, not read in this audit) would need a small update to render it, but its absence is not breaking — an older UI simply wouldn't display the new transient state.

### Testing strategy

- Extend `pipeline_fault.rs`'s fault-injection pattern (`LILYPAD_SYNTHETIC_FAIL_AFTER`, lines 11-40) with a new "transient stall then recovers" injection mode for the synthetic source, to unit-test that a bounded number of transient failures does _not_ end the session, while exceeding the budget still does (preserving today's `unexpected_capture_death_closes_channel_with_stop_flag_unset` guarantee, lines 12-40, for the genuinely-exhausted case).
- On-device manual test: put the Mac to sleep/wake mid-session, confirm the video recovers without a full session teardown.

### Risk assessment

Low-medium — additive behavior with a clear, bounded fallback to today's existing (already-tested) fatal path.

### Performance impact

Reduces unnecessary full session teardowns (and the re-pairing friction that follows) for transient, recoverable capture hiccups — a direct reliability/UX win with negligible cost in the common (non-stalled) case.

### Future extensibility

The same bounded-retry-then-escalate pattern could be generalized (a shared `RecoveryBudget` helper) and reused for the encoder-reset error path (`pipeline.rs:174-183`, which already resets on any encode error with no attempt budget/backoff at all — today it will reset-and-retry forever on a persistently failing encoder, which is its own smaller version of this same problem).

---

## Finding 9: Color space — BT.601 on the software path, no explicit tagging on the hardware path

### Current implementation (cite file:line)

`bgra_to_i420` (`apps/desktop/src-tauri/src/media/convert.rs:1,13-67`) uses BT.601 coefficients throughout: the luma computation (`66*r + 129*g + 25*b`, line 28) and the chroma computations (lines 58-60) are the standard BT.601 (SD, limited-range) matrix. This function is used exclusively by the `Openh264Encoder` (`software.rs:53`, module doc at `encoder/mod.rs:1-2` and `videotoolbox.rs:3-6` both confirm VideoToolbox bypasses it entirely, consuming BGRA directly). `VideoToolboxEncoder`'s `build_session` (`videotoolbox.rs:103-114`) configures real-time mode, frame reordering, keyframe interval, bitrate, and frame rate — but calls no color-primaries/transfer-function/matrix-coefficients property at all, leaving VideoToolbox's internal BGRA→YUV conversion and its output SPS VUI color tagging to library/hardware defaults.

### Problems

- BT.601 is the older standard-definition color matrix; BT.709 is the modern standard for HD content, and a desktop screen (essentially always rendered in an sRGB/BT.709-ish color space by the OS) encoded with BT.601 coefficients will show a visible, systematic color/saturation shift versus the true on-screen colors when decoded correctly by a BT.709-aware receiver — or, if the receiver decodes assuming BT.601 uniformly (unlikely for a modern mobile client for HD content), skips the visible mismatch but is inconsistent with the encoder's stated intent.
- On the VideoToolbox path, since no explicit color-space tagging is configured, the SPS VUI parameters describing color primaries/transfer/matrix are whatever VideoToolbox defaults to for the given resolution — there is no code-level guarantee this matches what the mobile decoder assumes, and no test in this repo verifies color fidelity end-to-end (the existing VideoToolbox tests, e.g. `videotoolbox.rs:326-348`, check keyframe/SPS-PPS presence, not color-space correctness).
- Since VideoToolbox (the production default per `session.rs:450-453`) is unaffected by the BT.601 bug specifically, the _severity_ of the BT.601 issue itself is scoped to the software fallback path (used only when `LILYPAD_ENCODER_KIND=software` or on non-macOS) — but the _lack of explicit tagging_ issue affects the production path.

### Root cause

`convert.rs`'s doc comment (line 1) states the BT.601 choice plainly but doesn't explain why BT.601 was chosen over BT.709 — most likely it was simply the first correct, working matrix implemented (BT.601 coefficients are the more commonly-referenced "textbook" RGB→YUV formula) without a deliberate evaluation of which standard matches actual desktop-capture content. The VideoToolbox path's lack of explicit tagging is simply an omission — no code was added to set it, defaulting to whatever VideoToolbox's internal heuristic picks.

### Redesign

1. Replace the BT.601 coefficients in `convert.rs` with BT.709 coefficients (`Y = 0.2126R + 0.7152G + 0.0722B` etc., in the same fixed-point style already used, e.g. matching the `(66*r + 129*g + 25*b + 128) >> 8` pattern's structure but with BT.709-derived integer constants) for the software path, matching the color standard modern screen content and modern decoders (including `react-native-webrtc`'s underlying platform decoders) actually expect.
2. On the VideoToolbox path, explicitly set color primaries/transfer function/matrix coefficients via `VTSessionSetProperty` (`kVTCompressionPropertyKey_ColorPrimaries`, `kVTCompressionPropertyKey_TransferFunction`, `kVTCompressionPropertyKey_YCbCrMatrix`, all set to their BT.709/`ITU_R_709_2` variants) — using the same FFI-shim pattern already established in this file for parameter-set extraction (lines 32-42) and proposed in Finding 2 for live bitrate control, so this can ship as part of the same FFI-shim work.
3. Add an explicit SDP/negotiation-level color hint if `webrtc-rs`/the H.264 payload format supports one — otherwise, correctness here relies on both ends assuming BT.709 by convention for HD content, which is the de facto standard and the safer default to explicitly encode into the bitstream (VUI) rather than leave to defaults.

### Tradeoffs

Changing the color matrix changes the exact pixel values produced by the software encoder — this is a visible, if subtle and directionally-correct, change; should be validated with a side-by-side visual comparison before shipping to confirm the fix actually looks more accurate rather than introducing a different mismatch.

### Implementation plan

1. Update `convert.rs`'s coefficients to BT.709, update the existing unit tests' comments/assertions if any encode specific-standard assumptions (check `convert.rs:85-113`'s black/white/red tests — these check luma/chroma direction, not exact BT.601-specific values, so they should remain valid under BT.709 with at most minor tolerance adjustments).
2. Add the VideoToolbox color-property FFI calls alongside the Finding 2 FFI shim work (same file, same pattern, worth bundling into one PR for review efficiency).

### Migration strategy

No protocol change — this is purely an encoder-internal correctness fix. Safe to ship as a normal desktop release; a receiver expecting the old (wrong) color space would, if anything, look _more_ correct after the fix, not less compatible.

### Testing strategy

- Update/extend `convert.rs`'s existing tests (lines 85-113) with BT.709-specific expected value ranges.
- Add a manual/visual verification step (encode a known color-bar test pattern — conveniently, `synthetic.rs`'s existing color-bar strip, lines 68-88 — decode it, and compare against the known input colors) to confirm the fix.
- For the VideoToolbox tagging, add an on-device test asserting the encoded SPS's VUI parameters (extractable via the same `CMVideoFormatDescriptionGetH264ParameterSetAtIndex`-adjacent APIs already used in this file) report BT.709 explicitly.

### Risk assessment

Low — a well-understood, narrowly-scoped correctness fix with no protocol implications.

### Performance impact

No performance cost; pure visual-fidelity improvement, directly relevant to "feels like local rendering" since color accuracy is part of what makes remote content look native.

### Future extensibility

Once explicit color tagging exists on the VideoToolbox path, the same mechanism is the natural place to add HDR/wide-gamut support if the product ever needs to mirror a P3/HDR-capable display faithfully.

---

## Finding 10: No explicit H.264 profile/level control — encoder output isn't guaranteed to match what's actually negotiated

### Current implementation (cite file:line)

The video track's codec capability (`rtc/mod.rs:108-114`) declares no `sdp_fmtp_line`. Per the upstream `webrtc-rs` 0.11.0 source verified for this audit, `register_default_codecs()` registers **five** distinct H.264 `fmtp` variants as separate payload types (baseline/main-ish profile-level-id `42001f` and `42e01f` in both packetization-mode 0 and 1, plus a High-profile `640032` variant) — all offered simultaneously in the SDP. Neither `VideoToolboxEncoder::build_session` (`videotoolbox.rs:103-114`) nor `Openh264Encoder::build` (`software.rs:31-42`) constrains its own output to a specific profile/level; each simply configures rate/GOP/real-time parameters and lets the underlying encoder (VideoToolbox or openh264) pick its own default profile.

### Problems

- The SDP offer advertises multiple profile/level payload-type options, but nothing in this codebase controls _which one the encoder will actually produce_, nor verifies the negotiated answer's chosen payload type matches the encoder's actual output profile. If `react-native-webrtc`'s answer negotiates, say, the High-profile (`640032`) payload type as its preferred match, while the actual `VideoToolboxEncoder`/`Openh264Encoder` output defaults to Baseline, there is a latent mismatch between negotiated capability and actual bitstream content that could produce decode failures or silent fallback behavior on some receivers, depending on how strictly the receiving decoder validates the payload type against the bitstream's actual SPS profile_idc.
- No test in this repo validates that the negotiated payload type's declared profile matches the SPS profile_idc actually present in the encoded bitstream (the existing tests check for SPS/PPS/IDR _presence_, e.g. `videotoolbox.rs:340-344`, not profile _value_ agreement with negotiation).

### Root cause

Profile/level was simply never explicitly configured on either the negotiation side (`rtc/mod.rs`) or the encoder side (`videotoolbox.rs`, `software.rs`) — the defaults have evidently worked in whatever ad-hoc testing has been done so far (the codebase's own E2E test, `rtc_media_e2e.rs`, uses a generic `webrtc-rs` peer as the answerer, which will simply accept whatever the offer's default codec negotiation produces, rather than exercising the specific negotiation behavior of the real `react-native-webrtc`/mobile decoder stack).

### Redesign

1. Explicitly register a single, deliberately-chosen H.264 profile (e.g. Constrained Baseline, `profile-level-id=42e01f`, the most broadly hardware-decodable profile across iOS/Android) as the _only_ offered variant, rather than relying on `register_default_codecs()`'s five-way default — this both simplifies negotiation and guarantees a single, known target profile.
2. Explicitly configure both `VideoToolboxEncoder` and `Openh264Encoder` to emit that exact profile/level (`kVTCompressionPropertyKey_ProfileLevel` for VideoToolbox; `openh264`'s equivalent config option, if exposed, for the software path) so encoder output and negotiated capability are provably in agreement.
3. Add a runtime assertion/log (debug builds only) that decodes the SPS's `profile_idc`/`level_idc` from produced keyframes and confirms it matches the configured target — cheap self-check against silent drift if the underlying crate's defaults ever change.

### Tradeoffs

Constrained Baseline is the safest interop choice but forgoes the compression efficiency of Main/High profile (worse quality-per-bit) — this is a legitimate tradeoff to make deliberately rather than accidentally; if broad hardware-decoder compatibility across all target Android devices is confirmed to support Main/High, that would be a better choice for bitrate efficiency and could be revisited with real device-matrix data.

### Implementation plan

1. Decide the target profile/level based on the actual supported-device matrix for the mobile client (requires product input beyond this audit's scope — flagging as a decision point, not making the call here).
2. Implement the single-profile codec registration in `rtc/mod.rs`.
3. Implement matching explicit profile/level configuration in both encoder backends.
4. Add the debug-mode SPS self-check.

### Migration strategy

This is an SDP-negotiation change and needs the same interop caution as Finding 5's Items 1-2 — validate against the real mobile client before shipping, ideally in the same coordinated testing pass as Finding 5 since both touch `rtc/mod.rs`'s codec registration.

### Testing strategy

- Add a unit test parsing the SPS NAL from a real encoded keyframe (both backends already have real-hardware/real-software encode tests, e.g. `videotoolbox.rs:326-348`, `software.rs:114-136`) and asserting `profile_idc`/`level_idc` match the configured target exactly.
- Manual interop test against real mobile devices (both a lower-end Android and a recent iOS device, since hardware decoder profile support varies most at the low end) to confirm the chosen profile decodes cleanly on all target hardware.

### Risk assessment

Medium — same class of SDP-negotiation risk as Finding 5, but narrower in scope (a single profile choice rather than new interceptor wiring).

### Performance impact

Neutral-to-positive: removes ambiguity that could cause silent decode issues on some devices; the profile choice itself trades a small amount of compression efficiency for interop certainty, which is the right default posture for a product's first production hardening pass.

### Future extensibility

Once a single, explicit, verified profile is locked in, per-device or per-negotiation profile _selection_ (e.g. offering High profile only to devices confirmed to support it) becomes a safe, additive enhancement rather than an implicit gamble.

---

## Finding 11: No sender-side packet pacing — bursty transmission, worst at exactly the moments the link is stressed

### Current implementation (cite file:line)

`WebRtcPeer::send_video_sample` (`apps/desktop/src-tauri/src/rtc/mod.rs:268-277`) calls `self.video_track.write_sample(&Sample { data, duration, .. })` synchronously, once per encoded access unit, as fast as the pipeline produces them. Verified against upstream `webrtc-rs` 0.11.0: `register_default_interceptors` (called at `rtc/mod.rs:289`) registers NACK generator/responder, RTCP sender/receiver reports, and a TWCC-receiver interceptor — **no pacer and no bandwidth-estimation interceptor** is included by default. There is no other pacing mechanism anywhere in this codebase's `rtc` or `media` modules.

### Problems

- A keyframe — especially the artificially-frequent ones from Finding 2's session-rebuild bug, or any legitimate periodic/PLI-triggered IDR — is typically 5-10x the size of a delta frame's payload, and `write_sample` packetizes and hands the _entire_ frame's RTP packets to the transport in one synchronous call with no inter-packet spacing. On a bandwidth-constrained or bufferbloat-prone link, this creates a self-inflicted burst of packets right at the moment the encoder has produced its largest payload — exactly when the link has the least margin to absorb a burst without inducing queueing delay or loss.
- This interacts badly with Finding 2 (IDR storms) and Finding 5 (loss-based ABR): a paced sender would smooth exactly the traffic pattern that today's unpaced sender turns into self-inflicted congestion signals, which then feed back into the ABR loop as apparent network loss, potentially triggering an unnecessary bitrate decrease caused by the sender's own burstiness rather than genuine path capacity.

### Root cause

`webrtc-rs`'s default interceptor registry doesn't include a pacer (confirmed upstream) — pacing is something applications using this crate are expected to add themselves if needed, and this codebase never added one, likely because the initial LAN-only prototype (per the mandate's framing: "first real end-to-end session... over LAN") never exposed the problem.

### Redesign

1. Add a simple send-side pacer between the encoder's output queue and `send_video_sample`: instead of sending an entire encoded access unit's RTP packets back-to-back, spread them evenly across the frame interval (e.g. for a 33ms frame interval and an N-packet frame, space packets ~33ms/N apart, with a minimum floor to avoid over-spacing tiny frames).
2. This can be implemented as a small wrapper around `video_track.write_sample` — or, more precisely, since `TrackLocalStaticSample::write_sample` handles RTP packetization internally, true packet-level pacing would require either a custom `TrackLocal` implementation (larger change) or splitting a large sample into deliberately-timed sub-calls (workaround, less precise) — needs a design decision on how deep to go; a `webrtc-rs`-idiomatic pacer would ideally sit as an outbound interceptor rather than in application code, which may require contributing to or wrapping the crate rather than a pure call-site fix.
3. At minimum, apply this pacing specifically to keyframes (the highest-leverage case) if full per-packet pacing for every frame is judged too large a change for the current milestone.

### Tradeoffs

Pacing adds a small amount of latency to keyframe delivery (spreading a keyframe across the frame interval means the last packet arrives later than an unpaced burst would deliver it) — this is a deliberate, favorable tradeoff (smoother delivery vs. marginally later worst-packet arrival) but should be validated it doesn't push keyframe delivery past a single frame interval, which would itself cause visible smearing.

### Implementation plan

1. Prototype frame-interval-based keyframe-only pacing first (narrowest, highest-value scope) as a wrapper in `session.rs`'s existing sample-forwarding task (lines 490-496).
2. Measure impact on real network captures (packet burst size, inter-packet gaps) before and after.
3. Evaluate whether full per-frame pacing is warranted based on measured results, scoping any deeper `TrackLocal`/interceptor-level work as a separate, larger initiative if so.

### Migration strategy

Fully desktop-internal, no protocol change (pacing only affects _when_ packets already destined for the wire are sent, not their content). Safe to ship as an internal implementation change.

### Testing strategy

- Packet-capture-based test (e.g. a loopback test measuring inter-packet-arrival intervals for a forced keyframe) confirming pacing actually spreads transmission rather than bursting.
- Regression-test that `rtc_media_e2e.rs`'s existing real-RTP-flow assertion (lines 155-159) still passes with pacing enabled (no packets lost/delayed to the point the test's 15-second window, lines 143-149, fails).

### Risk assessment

Low-medium for the keyframe-only scope; higher if a full per-packet/interceptor-level pacer is attempted, since that likely requires deeper changes to how the track writes packets.

### Performance impact

Should reduce self-inflicted burst-induced jitter/loss specifically at keyframe boundaries — the moments that matter most for perceived quality (a lost keyframe packet, per Finding 2, can only be recovered by another full keyframe request/PLI round-trip).

### Future extensibility

A proper pacer is also the natural foundation for implementing Finding 5's full TWCC/GCC bandwidth estimator, since GCC-style algorithms assume a paced sender as part of their control loop.

---

## Finding 12: Fixed 4-frame queue depth, not adapted to measured network conditions

### Current implementation (cite file:line)

`start_media_pipeline` builds the sample channel with a hardcoded bound: `mpsc::channel::<EncodedSample>(4)` (`apps/desktop/src-tauri/src/session.rs:480`), with the comment explaining the reasoning: "≈133ms worst-case at 30fps — enough to absorb send jitter without building a stale backlog." On overflow, `pipeline.rs:162-168` drops the newest sample and sets `recover_with_keyframe = true`, forcing an IDR on the next successfully-queued frame (per Finding 2, an expensive VideoToolbox session rebuild).

### Problems

- A fixed 133ms buffer is a reasonable LAN default but the mandate explicitly frames this as an "internet-first" product — on a higher-RTT path (e.g. cross-region, cellular), send-side jitter can regularly exceed 133ms even on an otherwise healthy connection, causing routine, avoidable frame drops (and therefore routine, avoidable forced-IDR recovery events, each expensive per Finding 2) that a slightly deeper buffer would have absorbed without meaningfully hurting latency.
- Conversely, on an excellent LAN connection, even 133ms may be more buffering than necessary, adding latency margin that isn't earning its keep.
- There is no signal anywhere (RTT from Finding 5's proposed extraction, or observed drop rate) feeding back into this constant.

### Root cause

The queue depth was chosen as a single reasonable-sounding constant during initial LAN prototyping and never revisited once RTCP feedback (which could inform a better choice) became available.

### Redesign

1. Make the queue depth a function of measured RTT (once Finding 5's Item 3 RTT extraction lands) — e.g. `queue_depth = clamp(2 * rtt_estimate / frame_interval, min=2, max=8)`, so a low-RTT LAN path gets a shallow, low-latency buffer and a high-RTT path gets enough headroom to avoid routine drops.
2. Since `mpsc::channel`'s capacity is fixed at creation and can't be resized live, this either requires periodically recreating the channel (disruptive) or switching to a buffer primitive that supports live resizing/a soft threshold check even if the underlying channel capacity is fixed larger than the "effective" threshold — e.g. allocate the channel at the max depth (8) but track a separate `effective_depth` the pipeline checks against for its own drop decision, adjustable without recreating the channel.

### Tradeoffs

More buffering under high RTT trades added tail latency for fewer drops/forced-IDRs — this is very likely still a net win (see Finding 2's cost analysis of forced IDRs) but should be validated with real network measurements, not assumed.

### Implementation plan

1. Depends on Finding 5's RTT extraction landing first.
2. Implement the "allocate at max, enforce a smaller effective threshold" pattern described above as the lowest-risk path to a dynamic effective depth without channel-recreation churn.
3. Feed the RTT estimate into the effective-depth calculation, updated on each new RTCP report.

### Migration strategy

Fully desktop-internal; no protocol change.

### Testing strategy

- Unit test the depth-calculation function directly (clamping, RTT→depth mapping) in isolation.
- Extend `media_pipeline.rs`'s existing drop/recovery test (`dropped_frame_recovers_with_immediate_keyframe`, lines 104-146) with variants at different simulated RTTs, confirming fewer drops occur at a higher configured effective depth for the same injected backpressure.

### Risk assessment

Low — additive tuning on top of existing, already-tested drop/recovery mechanics.

### Performance impact

Should reduce the frequency of forced-IDR recovery events on higher-RTT paths (compounding with Finding 2's fix to make each such event cheaper too), directly improving perceived stability on non-LAN networks — the product's stated target environment.

### Future extensibility

The same RTT-adaptive-buffering principle could extend to the mobile receive side's jitter buffer if `react-native-webrtc` exposes any tunable playout-delay hint (not verified in this audit — flagged as an open question for Finding 14).

---

## Finding 13: No end-to-end (glass-to-glass) latency visibility — only desktop-side capture→queued is measured

### Current implementation (cite file:line)

`PipelineMetrics::record_latency` (`apps/desktop/src-tauri/src/media/metrics.rs:28-31`) records `raw.captured_at.elapsed()` at the moment a sample is successfully queued (`pipeline.rs:160`) — the doc comment for this field is explicit about its scope: _"End-to-end frame age (capture instant → sample queued): staleness in the latest-frame slot + encode time. **The desktop-side latency budget.**"_ (`metrics.rs:17-19`, emphasis reflecting the comment's own framing). Nothing in this codebase measures time from sample-queued → RTP-sent → network transit → jitter-buffer → decode → render-on-screen on the mobile side.

### Problems

- The mandate's core target — "feels like local rendering" — is fundamentally a _glass-to-glass_ latency claim (input event → pixel change visible to the user), and this codebase currently cannot measure that number at all. Every optimization in this document (Findings 1-3, 11-12) affects a _different segment_ of that total latency budget, and without end-to-end measurement there's no way to validate which optimizations actually move the number that matters, prioritize future work by measured impact, or detect a regression before it ships.
- `avg_latency_ms`/`max_latency_ms` in `MetricsSnapshot` (`metrics.rs:43-45`) will look "healthy" even if network transit or mobile-side decode/render adds hundreds of milliseconds on top — the metric gives a false sense of visibility into the thing that actually matters to the user.

### Root cause

Latency instrumentation was built alongside the desktop-only pipeline (matching the milestone's scope — capture through the WebRTC track) and never extended across the network boundary, likely because that requires clock synchronization or round-trip timestamp echoing between two separate processes (desktop + mobile), which is meaningfully more engineering than an in-process counter.

### Redesign

1. Embed a capture timestamp (already available as `RawFrame.captured_at`/`timestamp`, `frame.rs:13-17`) into the RTP stream in a way the receiver can read back — e.g. via an RTP header extension carrying the capture timestamp, or by having the mobile client echo a periodic sample-identifying value back over the existing input DataChannel once rendered, and having the desktop correlate the echo against its own send-time record.
2. Simpler first step: instrument the _mobile_ side independently — timestamp when a frame is delivered to `RTCView` (via a `track` state-change or a periodic `getStats()` poll, since `react-native-webrtc`/the underlying WebRTC stack exposes standard `RTCStatsReport` metrics including jitter-buffer delay and frames-decoded — worth checking what `getStats()` surfaces here specifically) and report it back to the desktop (or to application logs) as a coarse proxy for render latency, without needing tight clock sync with the desktop.
3. Combine desktop-side `avg_latency_ms` (capture→queued) with a network-transit estimate (derivable from RTT/2, once Finding 5's Item 3 lands) and a mobile-side decode/render estimate (Item 2) into a single reported end-to-end estimate, even if approximate, surfaced in logs/telemetry.

### Tradeoffs

True glass-to-glass measurement (Item 1, with real timestamp correlation) is meaningfully more engineering effort than the approximate composition in Item 3; the approximate approach is a pragmatic first step but should be labeled as an estimate, not a precise measurement, to avoid false confidence.

### Implementation plan

1. Investigate `react-native-webrtc`'s `getStats()` surface for jitter-buffer-delay and decode-time stats as the lowest-effort mobile-side signal (Item 2) — start here.
2. Add RTT extraction (shared with Finding 5) and desktop-side capture→queued (already exists) as the other two legs of the approximate composition (Item 3).
3. Scope true end-to-end timestamp correlation (Item 1) as a larger follow-up once the approximate number demonstrates where the biggest remaining latency actually lives.

### Migration strategy

Requires a small mobile-side addition (stats polling + reporting back over the existing input DataChannel or signaling channel) — additive, doesn't require protocol version negotiation if implemented as an optional periodic message the desktop simply logs/ignores if the mobile client is old enough not to send it.

### Testing strategy

- Manual, instrumented, on-device testing is unavoidable here (this measures a real physical property — actual glass-to-glass delay — that in-process/loopback integration tests like `rtc_media_e2e.rs` cannot capture, since that test's "answerer" is a bare `webrtc-rs` peer with no rendering, per `rtc_media_e2e.rs:31-44`).
- A simple, low-tech validation: point a high-frame-rate camera at both the source screen and the phone displaying the mirrored session simultaneously, showing a visible timer/counter on the source screen, and measure the frame-count delta between the two in the recorded video — a classic, reliable glass-to-glass measurement technique independent of any in-app instrumentation, valuable as a ground-truth check against whatever the software-based estimate reports.

### Risk assessment

Low for the instrumentation-only work; the value is entirely in what it enables (validating every other finding in this document), not in any behavior change of its own.

### Performance impact

No direct performance impact — this is observability work — but it is the prerequisite for confidently prioritizing and validating every latency-affecting fix in this document (Findings 1-3, 6, 11-12) against the actual metric the M5 mandate cares about.

### Future extensibility

Once end-to-end latency is measured and logged, it becomes the natural input for an automated regression-detection process (e.g. a CI or nightly on-device benchmark gate) protecting the "feels like local" claim over time as the codebase evolves.

---

## Finding 14: Encoder error-recovery loop has no attempt budget or backoff

### Current implementation (cite file:line)

`pipeline.rs:174-183`: on any `encoder.encode()` error, the loop logs and calls `encoder.reset()`, then simply continues the loop (`Ok(())` falls through to `frame_no += 1` and the next iteration) — there is no counter tracking how many consecutive encode errors have occurred, and no backoff between reset attempts. Only if `reset()` itself errors does the loop `break` (line 178-181).

### Problems

- If the encoder enters a state where every `encode()` call fails but `reset()` itself always succeeds (a plausible failure mode — e.g. a persistent hardware/driver issue that a session rebuild doesn't fix), the pipeline will spin resetting the encoder on every single frame indefinitely, burning CPU and (for VideoToolbox) repeatedly paying the expensive session-rebuild cost from Finding 2, without ever surfacing this as a session-ending condition the way a capture failure does (Finding 8's fatal path).
- No frames are ever successfully produced in this scenario, so the viewer sees a frozen/black stream indefinitely with the session nominally still "connected" and no error surfaced to the user, since `Ok(None)` and the reset-then-continue path never emits a `SessionEvent::Error`.

### Root cause

The reset-and-continue design (comment context at lines 176-177 doesn't articulate a retry budget) assumed transient, self-healing encode errors (matching the pattern that motivated the _capture_-side design of a bounded, generous timeout before failing) but never added the equivalent bound for the encoder side.

### Redesign

Add a consecutive-error counter (reset to 0 on any successful `encode()`) and, once it exceeds a small threshold (e.g. 5 consecutive failures), escalate to the same fatal path capture failures already use (`break`, closing the channel with the stop flag unset, letting `session.rs`'s existing crash-detection end the session cleanly per Finding 8's existing — and correctly tested — contract).

### Tradeoffs

None significant — this only adds a safety bound to an already-present recovery loop; it doesn't change behavior for the (presumably common) case where resets actually fix things within a few attempts.

### Implementation plan

1. Add a `consecutive_encode_errors: u32` local to the pipeline loop, incremented on the error branch, reset to 0 on success.
2. Escalate to `break` once the threshold is exceeded, matching the existing capture-failure `break` path exactly so `session.rs`'s consumer logic (lines 497-504) needs no changes.

### Migration strategy

Fully desktop-internal, no protocol change.

### Testing strategy

Add a fault-injection test mirroring `pipeline_fault.rs`'s pattern but for the encoder rather than capture — inject a persistent encode failure (would require a small test-only encoder double or an env-var-gated fault injection analogous to `LILYPAD_SYNTHETIC_FAIL_AFTER`) and assert the pipeline terminates (stop flag unset) after the threshold rather than spinning forever; assert a _transient_ (self-healing after N attempts) failure does _not_ terminate the session.

### Risk assessment

Low — small, well-contained addition to existing, already-tested error-handling code.

### Performance impact

Prevents an unbounded CPU-burning spin in a rare but real failure mode, and ensures the user actually sees an error/session-end rather than an indefinitely frozen "connected" session.

### Future extensibility

The same consecutive-failure-counter pattern, once established, should also be applied to the drop-recovery path (Finding 2's discussion) to bound repeated forced-IDR attempts if a persistently bad link keeps triggering them back-to-back.

---

## Finding 15: `RawFrame::new` always zero-fills a full-size buffer, even when every byte will be immediately overwritten

### Current implementation (cite file:line)

`RawFrame::new` (`apps/desktop/src-tauri/src/media/frame.rs:20-31`) allocates via `vec![0; (width as usize) * (height as usize) * 4]` (line 25) — Rust's `vec![0; n]` is a zeroing allocation. `SyntheticSource::render` calls `RawFrame::new(...)` (`synthetic.rs:54`) and then immediately overwrites every pixel across three nested-loop passes (lines 57-103) — the zero-fill is fully redundant on this hot path, since it runs once per frame for the entire lifetime of any synthetic-source session (used both in production as the `LILYPAD_CAPTURE_KIND=synthetic` dev/test override and in every automated test in this audit's scope).

### Problems

Minor but real, compounding cost: a redundant full-buffer zero-fill on every single synthetic-source frame (irrelevant to the real ScreenCaptureKit path, which builds `RawFrame` manually field-by-field with an already-populated `bgra`, `screencapturekit.rs:104-112`, not via `RawFrame::new`).

### Root cause

`RawFrame::new` was written as a general-purpose constructor convenient for both production zero-initialization needs (if any exist) and test/synthetic use, without noting that the synthetic source's own subsequent full-frame writes make the zero-fill dead work specifically in that call site.

### Redesign

Add a `RawFrame::new_uninitialized`-style constructor using `Vec::with_capacity` + `set_len` (requires `unsafe`, since the bytes are genuinely uninitialized until the caller writes them) — or, simpler and fully safe, use `Vec::with_capacity(n)` followed by `resize(n, 0)` only where zero-initialization is actually needed, and have `SyntheticSource::render` allocate via a helper that skips the zero-fill (e.g. reuse a persistent scratch buffer across frames the same way `screencapturekit.rs:82-89` already does for the _capture_ side's frame-slot reuse, applying that same reuse pattern to the synthetic source).

### Tradeoffs

An `unsafe` uninitialized-buffer path needs careful auditing to guarantee every byte is genuinely written before being read (a partially-uninitialized buffer read is undefined behavior in Rust) — the safer "reuse a scratch buffer across calls" approach avoids `unsafe` entirely and is the recommended path.

### Implementation plan

Give `SyntheticSource` a persistent `Vec<u8>` scratch buffer (owned by the struct, sized once) reused across `render()` calls instead of allocating a fresh `RawFrame` via `RawFrame::new` each time — mirroring the reuse pattern already proven correct in this codebase at `screencapturekit.rs:82-89`.

### Migration strategy

Fully internal to the synthetic source (test/dev-only path); zero risk to production ScreenCaptureKit/VideoToolbox behavior.

### Testing strategy

Existing `synthetic.rs` tests (`frames_differ_and_advance`, lines 181-192, etc.) should pass unchanged, since output content is unaffected — only allocation behavior changes. Add a benchmark or allocation-count assertion if the codebase has a benchmarking harness (not observed in this audit's scope) to quantify the win.

### Risk assessment

Very low — cosmetic/efficiency-only change to a test/dev-only code path.

### Performance impact

Negligible in absolute terms (this path doesn't run in production with a real capture backend) but improves synthetic-source throughput for local dev iteration and CI test speed.

### Future extensibility

None significant — this is a self-contained polish item.

---

## Finding 16: Metrics conflate keyframe and delta-frame sizes, obscuring the cost of IDR storms

### Current implementation (cite file:line)

`MetricsSnapshot::avg_frame_bytes` (`apps/desktop/src-tauri/src/media/metrics.rs:49,84`) is computed as `bytes / encoded` — a single average across _all_ encoded frames, keyframes and deltas alike. `keyframes` (line 39, incremented at `pipeline.rs:154-155`) is tracked as a separate count, but there is no corresponding "bytes spent on keyframes" or "average keyframe size vs. average delta size" breakdown anywhere in `PipelineMetrics`.

### Problems

Given Finding 2's IDR-storm bug (or even just legitimate, correctly-functioning periodic/PLI keyframes), keyframes are disproportionately large — a single blended average makes it impossible to tell, from metrics alone, whether a bandwidth spike or a high `avg_frame_bytes` reading is caused by frequent large keyframes (fixable via Finding 2) versus genuinely high-detail P-frame content (an unavoidable content characteristic) — exactly the diagnostic distinction an engineer would need to validate that Finding 2's fix actually worked.

### Root cause

Metrics were built to answer "is the pipeline producing output and roughly how much" (a basic health check) rather than "where is the bitrate actually going" — a reasonable M2-stage scope that needs to grow alongside the ABR-tuning work in Findings 2 and 6.

### Redesign

Split `bytes_encoded` into `keyframe_bytes_total` and `delta_bytes_total` (two new `AtomicU64` fields), incremented conditionally at the same call site that already checks `sample.is_keyframe` (`pipeline.rs:154-155`), and surface both an `avg_keyframe_bytes` and `avg_delta_bytes` in `MetricsSnapshot`.

### Tradeoffs

None significant — purely additive metrics.

### Implementation plan

1. Add the two new atomic counters to `PipelineMetrics` (`metrics.rs:9-24`).
2. Update the increment site in `pipeline.rs:152-156` to route bytes to the correct counter based on `sample.is_keyframe`.
3. Add the derived averages to `MetricsSnapshot::snapshot()` (`metrics.rs:52-86`).

### Migration strategy

Fully internal; additive fields on a `Serialize`-derived struct (`metrics.rs:34`) are backward-compatible for any consumer that doesn't hard-fail on unknown-but-now-present fields (standard `serde` `Serialize` behavior — consumers deserializing this JSON elsewhere, if any exist outside this audit's scope, should be checked for strict-schema deserialization that might reject extra fields, though the more common risk direction — adding fields to a _serialized_ struct — is normally safe for JSON consumers).

### Testing strategy

Extend `media_pipeline.rs`'s existing metrics assertions (e.g. `pipeline_streams_real_h264_with_metrics`, lines 51-99, which already asserts `metrics.keyframes >= 1` at line 95) with a new assertion that `avg_keyframe_bytes > avg_delta_bytes` for a real encoded stream (keyframes should always be larger, a basic sanity check on the new metric itself).

### Risk assessment

Very low — additive observability only.

### Performance impact

None on the pipeline itself; directly enables validating the performance impact of Finding 2's fix.

### Future extensibility

This breakdown is also the natural metric to expose in any future in-app debug overlay (mentioned as an existing consumer of `PipelineMetrics` per this module's own doc comment, `metrics.rs:1-2`: "for logging and the debug overlay") for a developer/support-diagnostics view of exactly where bandwidth is going.

---

## Finding 17: VideoToolbox force-keyframe is explicitly documented as a known stopgap tied to a missing crate capability

### Current implementation (cite file:line)

`VideoToolboxEncoder::encode` (`videotoolbox.rs:159-168`) contains an explicit acknowledgment in its own comment: _"The crate doesn't expose a per-frame force-keyframe hook (VideoToolbox's C API takes it via per-frame properties, which `encode()` doesn't surface yet). A freshly built session's first frame is always an IDR, so rebuilding is the honest way to satisfy a forced keyframe today."_

### Problems

This is the same root cause underlying the most severe finding in this document (Finding 2) — surfacing it here as its own item because it's a _documented, self-acknowledged_ shortcut rather than an undiscovered bug, meaning the team already knows the direction of the fix (a per-frame force-keyframe hook) and it should be prioritized accordingly rather than rediscovered.

### Root cause

The `videotoolbox` Rust crate wrapper in use doesn't expose VideoToolbox's native `kVTEncodeFrameOptionKey_ForceKeyFrame` per-frame encode option.

### Redesign

Identical to Finding 2's Item 2 redesign — implement a small FFI shim (matching the pattern already used in this same file for parameter-set extraction, `videotoolbox.rs:32-42`) to pass `kVTEncodeFrameOptionKey_ForceKeyFrame` directly into `VTCompressionSessionEncodeFrame`, bypassing both the crate's higher-level `encode()` wrapper and the session-rebuild workaround entirely.

### Tradeoffs

Same as Finding 2 — small increase in unsafe FFI surface, consistent with an already-accepted pattern in this exact file.

### Implementation plan

Bundle directly with Finding 2's implementation plan (Item 2) — this is not a separate piece of work, it's the same fix, called out separately here only because the codebase's own comment flags it as a known, trackable gap independent of this audit's own discovery of the ABR-driven severity (Finding 2).

### Migration strategy

See Finding 2.

### Testing strategy

See Finding 2.

### Risk assessment

See Finding 2.

### Performance impact

See Finding 2.

### Future extensibility

See Finding 2.

---

## Summary Table

| #   | Finding                                                            | Severity               | Primary file(s)                                |
| --- | ------------------------------------------------------------------ | ---------------------- | ---------------------------------------------- |
| 1   | Hardcoded capture resolution/fps, never matched to real display    | Critical               | `capture/mod.rs`, `session.rs`                 |
| 2   | ABR bitrate change rebuilds the whole encoder session → IDR storms | Critical               | `videotoolbox.rs`, `software.rs`, `abr.rs`     |
| 3   | Two full-frame CPU copies before hardware encode                   | Critical               | `screencapturekit.rs`, `videotoolbox.rs`       |
| 4   | No dirty-region/static-content detection                           | High                   | `screencapturekit.rs`, `pipeline.rs`           |
| 5   | ABR is loss/REMB-only; no TWCC, no RTT                             | High                   | `rtc/mod.rs`, `abr.rs`                         |
| 6   | No dynamic resolution/FPS scaling under pressure                   | High                   | `pipeline.rs`, `abr.rs`                        |
| 7   | No idle/away detection or background throttling                    | Medium-High            | (absent)                                       |
| 8   | Capture stall detection slow and terminal, no in-place recovery    | Medium                 | `screencapturekit.rs`, `session.rs`            |
| 9   | BT.601 color matrix; no explicit color tagging on hardware path    | Medium                 | `convert.rs`, `videotoolbox.rs`                |
| 10  | No explicit H.264 profile/level control                            | Medium                 | `rtc/mod.rs`, `videotoolbox.rs`, `software.rs` |
| 11  | No sender-side packet pacing                                       | Medium                 | `rtc/mod.rs`                                   |
| 12  | Fixed queue depth, not adapted to network conditions               | Medium                 | `session.rs`, `pipeline.rs`                    |
| 13  | No end-to-end (glass-to-glass) latency visibility                  | Medium                 | `metrics.rs`                                   |
| 14  | Encoder error-recovery loop has no attempt budget                  | Low-Medium             | `pipeline.rs`                                  |
| 15  | Redundant zero-fill allocation on synthetic hot path               | Polish                 | `frame.rs`, `synthetic.rs`                     |
| 16  | Metrics conflate keyframe/delta frame sizes                        | Polish                 | `metrics.rs`, `pipeline.rs`                    |
| 17  | VideoToolbox force-keyframe stopgap (see Finding 2)                | Critical (= Finding 2) | `videotoolbox.rs`                              |
