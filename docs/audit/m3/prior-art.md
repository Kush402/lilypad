---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: M3 production audit — prior-art survey.
---

# Lilypad Prior-Art / Competitive Technical Audit (M3 → M5)

**Scope:** every technique that makes Parsec, Jump Desktop, AnyDesk, Chrome
Remote Desktop, RustDesk, Apple Sidecar/Universal Control, and Moonlight/
Sunshine _feel_ native, mapped one-by-one against the actual code in this
repository — desktop capture/encode/input (Rust/Tauri/webrtc-rs), mobile
viewer (React Native/react-native-webrtc), and backend signaling/pairing
(Fastify/Redis) — to produce concrete, implementable recommendations for the
M3→M5 hardening pass. This is a competitive-technique mapping, not a general
code review; where a finding overlaps ground already covered by
`docs/audit/m3/input-touch.md` or `docs/audit/m3/reconnect-lifecycle.md`, this
report cites the same lines but frames the problem and the fix around the
specific competitor technique that solves it, and cross-references rather
than re-deriving the existing analysis.

**Files read in full for this audit:** `docs/architecture.md`,
`docs/technical-design.md`, `docs/milestones.md`,
`apps/desktop/src-tauri/src/media/abr.rs`,
`apps/desktop/src-tauri/src/media/pipeline.rs`,
`apps/desktop/src-tauri/src/media/encoder/mod.rs`,
`apps/desktop/src-tauri/src/media/encoder/software.rs`,
`apps/desktop/src-tauri/src/media/encoder/videotoolbox.rs`,
`apps/desktop/src-tauri/src/media/capture/screencapturekit.rs`,
`apps/desktop/src-tauri/src/rtc/mod.rs`,
`apps/desktop/src-tauri/src/plugins/clipboard.rs`,
`apps/desktop/src-tauri/src/plugins/qr_pairing.rs`,
`apps/mobile/src/lib/webrtc.ts`, `apps/mobile/src/lib/input.ts`,
`apps/mobile/src/screens/ViewerScreen.tsx`,
`apps/backend/src/services/pairing.ts`, `apps/backend/src/db/schema.ts`,
`packages/protocol/src/constants.ts`. Sections of `apps/desktop/src-tauri/src/session.rs`
and `apps/desktop/src-tauri/src/media/capture/mod.rs` relevant to bitrate
control wiring and default capture resolution were also read. Prior audits
`docs/audit/m3/input-touch.md` and `docs/audit/m3/reconnect-lifecycle.md`
were read in full to avoid duplicating their file:line evidence gathering.

---

## Executive Summary

Lilypad's M2/M3 prototype made exactly the right foundational bets — real
WebRTC (not a custom protocol), real hardware H.264 (VideoToolbox), real RTCP
feedback (loss + REMB driving a genuine AIMD bitrate controller), and a real
shallow-queue latency budget (30→4 frames, documented in
`docs/milestones.md:73-75`). Those are not table stakes to add; they are
already-shipped, already-tested infrastructure that most hobbyist remote-
desktop projects never get right. The gap to Parsec/AnyDesk/RustDesk-caliber
production quality is not architectural — it is a long list of specific,
well-known techniques those products use that Lilypad's current code simply
doesn't apply yet, even though in most cases the surrounding plumbing to
apply them already exists.

Three patterns recur across every finding in this report:

1. **The video pipeline treats every frame and every network condition
   identically.** There is no client-side cursor rendering (Parsec, Moonlight,
   Apple Sidecar/Universal Control all decouple the pointer from the video
   path), no resolution/fps step-down under sustained congestion (Moonlight/
   Sunshine, Parsec, AnyDesk all cascade quality knobs beyond bitrate alone),
   no idle-frame short-circuit (AnyDesk's DeskRT philosophy), and the
   congestion controller only reacts to _already-lost_ packets or the
   receiver's own REMB estimate — never to delay/jitter trends the way
   full-stack WebRTC (Chrome Remote Desktop) or Parsec's proprietary
   controller do. `docs/technical-design.md:29-30` even promises a "1080p
   text mode" that has zero lines of implementation anywhere in the repo.
2. **Half-built plumbing is left half-built, in exactly the shape that would
   make finishing it cheap.** A `trusted_devices` table exists in the schema
   (`apps/backend/src/db/schema.ts:51-61`) but the pairing service never reads
   or writes it — every session, even a same-phone reconnect five minutes
   later, requires a fresh QR scan and a fresh manual Approve, where Apple's
   Universal Control treats a previously-known device pair as effectively
   zero-config. The clipboard plugin's own doc comment claims it "bridges
   clipboard text between phone and desktop" (`apps/desktop/src-tauri/src/plugins/clipboard.rs:1-2`)
   but the wire protocol and injection code only ever move text phone→desktop —
   RustDesk, Parsec, AnyDesk, and Chrome Remote Desktop all sync both
   directions.
3. **Telemetry the desktop already computes never reaches the user.** The
   media pipeline logs a full metrics snapshot (bitrate, capture/encode time,
   drops, latency) every second (`apps/desktop/src-tauri/src/media/pipeline.rs:186-188`),
   but none of it crosses the wire to the phone — the mobile UI's entire
   connection-quality feedback is a five-word text badge
   (`apps/mobile/src/screens/ViewerScreen.tsx:34-40`). Every competitor named
   in this brief shows the user _some_ live signal (a bar, a number, a graph)
   of how good the connection currently is.

None of the redesigns below require abandoning any of Lilypad's stated
non-negotiables (`docs/architecture.md:9-18`, `docs/milestones.md:175-179`) —
no custom video protocol, no LAN-only design, no gaming-first shortcuts. Every
recommendation is a refinement of code that already exists, which is exactly
the audit's mandate.

### Classification at a glance

**Table stakes we lack** (every named competitor has these; ship before
calling this production-ready):

- Client-decoupled cursor rendering (Finding 1)
- A real "readable text" mode — the promised 1080p/high-fidelity path
  (Finding 2)
- Congestion control that reacts before loss, not just after (Finding 3)
- Resolution/fps step-down under sustained bandwidth pressure (Finding 4)
- Bidirectional clipboard (Finding 6)
- Some visible connection-quality indicator (Finding 9)

**Differentiators worth building** (would meaningfully close the gap to
Jump-Desktop/Parsec-grade feel, but are not universal table stakes):

- A relative/trackpad input mode alongside direct-touch (Finding 5) — Jump
  Desktop's signature feature; genuinely optional for a "touch a Mac like
  glass" product, but worth an explicit product decision rather than silent
  omission
- Trusted-device fast reconnect without a fresh QR/Approve (Finding 8) —
  Apple Sidecar/Universal Control's zero-config feel; the schema already has
  a place for it
- Idle-frame encode short-circuit for CPU/battery (Finding 7) — a lightweight
  echo of AnyDesk's DeskRT philosophy without building a custom codec
- Client-side decode-latency tuning (Finding 10) — Moonlight/Sunshine's
  shallow-decoder-queue discipline, currently only applied on the send side

**Explicitly do not build:**

- AnyDesk's DeskRT codec itself (a full proprietary hybrid vector/H.264
  codec) — `docs/architecture.md:14` ("No custom video protocol") correctly
  rules this out; only the _idle-skip_ spirit of it is worth adopting
  (Finding 7), not a custom codec
- Parsec's/RustDesk's option to run a custom transport over raw UDP bypassing
  WebRTC entirely — contradicts the internet-first ICE+TURN mandate
  (`docs/architecture.md:11-14`) that this product correctly commits to
- Moonlight/Sunshine's LAN-first assumptions (mDNS discovery, wired-network
  jitter budgets) — explicitly the opposite of this product's target user
  (`docs/technical-design.md:18-22`)
- Game-controller/haptics input support — explicitly out per
  `docs/milestones.md:177` ("no gaming-first shortcuts")
- RustDesk's direct-IP/self-hosted "one client acts as the server" mode —
  incompatible with the phone-behind-cellular/laptop-behind-NAT target user

Findings below are ordered roughly by user-visible severity for a product
competing head-to-head with Parsec/AnyDesk/Jump Desktop.

---

## Finding 1 — The cursor is baked into the encoded video frame; every competitor named in this brief decouples pointer feedback from the video path

**Prior art:** Parsec renders the remote cursor as a client-side overlay
driven by the same input events the user just sent, reconciled against the
server's reported position — the user's own pointer movement is visually
instantaneous regardless of glass-to-glass latency. Moonlight/Sunshine
(game-streaming) apply the same idea for the mouse cursor in relative-mouse
modes. Apple Sidecar and Universal Control go further: the "remote" cursor
_is_ the local OS pointer — there is no round trip for cursor feedback at
all, by construction, since the pointer is drawn by the client's own window
server.

### Current implementation (cite file:line)

`apps/desktop/src-tauri/src/media/capture/screencapturekit.rs:184-190` builds
the `SCStreamConfiguration` with `.with_shows_cursor(true)` — the OS compositor
draws the real cursor into the captured frame _before_ it ever reaches the
encoder. There is no field anywhere in `packages/protocol/src/signaling.ts`
or `packages/protocol/src/input.ts` carrying cursor position, shape, or
visibility as its own piece of telemetry (only the _inbound_ `pointer_move`
`InputEvent`, which is control input phone→desktop, not host-cursor state
desktop→phone). `apps/mobile/src/screens/ViewerScreen.tsx:99-115` renders
nothing but the raw `RTCView` — there is no overlay layer of any kind.

### Problems

Because the cursor is compositor-drawn into the source frame, the _only_ way
a user ever sees their own touch's effect on the pointer is the full
capture→encode→send→decode→paint round trip — the same round trip that
carries the entire desktop image. For a product whose own latency budget is
"< 60ms same-region, < 120ms TURN-relayed" (`docs/technical-design.md:80-82`),
every one of those milliseconds is directly perceptible in the one piece of
feedback a user is watching most closely while dragging or pointing: where
their own finger's effect landed. This is the single largest perceived-
latency lever available in the entire pipeline, and it is currently unused.
It also means a viewer-side PLI-triggered keyframe recovery, an ABR bitrate
drop, or an ICE hiccup all visibly stutter the cursor along with the rest of
the frame — there is no independent, robust channel for "at least show me
where my pointer is" the way Parsec's overlay guarantees.

### Root cause

The simplest possible implementation of "stream the screen" is to let the OS
draw the cursor into the frame like any other pixel — which is exactly what
`with_shows_cursor(true)` does. Decoupling the cursor requires a second,
independent signal path (host cursor position/shape → phone) that nothing in
this codebase's `packages/protocol` currently models, so the path of least
resistance was taken and never revisited.

### Redesign

1. Turn cursor capture **off** in the video path: `with_shows_cursor(false)`
   at `screencapturekit.rs:190` (and the equivalent Windows Graphics Capture
   flag once that backend lands) — the frame becomes exactly the desktop
   content with no baked-in pointer.
2. Add a lightweight, high-frequency, unreliable side-channel message —
   `cursor-state { x, y, visible, shape? }` — sent by the desktop whenever the
   real OS cursor position changes (macOS: poll `CGEvent(source: nil)`'s
   location or subscribe to a mouse-moved event tap; this is cheap and
   already adjacent to code the input-injection path touches in
   `apps/desktop/src-tauri/src/input/macos.rs`). Carry it over a new
   `unreliable, ordered:false, maxRetransmits:0` DataChannel (same rationale
   as the pointer-move-channel split recommended in
   `docs/audit/m3/input-touch.md` Finding 2) — a dropped cursor-position
   update is harmless; the next one supersedes it.
3. On the mobile side, add a small absolutely-positioned overlay `View`
   (a simple dot/arrow glyph, styled to resemble a system pointer) rendered
   on top of `RTCView` in `ViewerScreen.tsx`, positioned from the latest
   `cursor-state` message mapped through the same content-rect math
   recommended in `docs/audit/m3/input-touch.md` Finding 1 (so it lands in
   the correct spot once that letterboxing fix ships — these two fixes should
   be sequenced together, since an overlay cursor positioned via the _current_
   broken coordinate math would be actively worse than no overlay at all).
4. For the direct-touch interaction model specifically (as opposed to a
   future relative/trackpad mode, Finding 5), the overlay's most valuable
   property isn't hiding round-trip latency on _movement_ — the touch point
   itself is already local and instantaneous — it's giving the user
   continuous confirmation of where the _host_ currently believes the
   pointer is (useful whenever host-side automation, another local input
   source, or a stale frame could disagree with the phone's touch position).

### Tradeoffs

This is the one finding in this report that most resembles new UI surface (an
overlay glyph) rather than a pure fix — flagged for explicit product
awareness, though it is additive/removable and does not add a new user-facing
_capability_, only a rendering aid for an existing one. Turning off
`shows_cursor` also means any _other_ local input source moving the mouse on
the host (e.g. the user's own hand on the trackpad during a session) is
invisible in the video unless the same `cursor-state` channel also tracks
host-originated moves, not just phone-originated ones — the polling/event-tap
approach in item 2 handles this automatically since it observes the real OS
cursor regardless of origin, but this must be verified, not assumed.

### Implementation plan

1. Flip `with_shows_cursor` to `false` (`screencapturekit.rs:190`).
2. Add `cursorState` message to `packages/protocol/src/signaling.ts` (or a
   new lightweight schema module) and a matching unreliable DataChannel
   creation in `apps/desktop/src-tauri/src/rtc/mod.rs` (mirrors the channel
   split already recommended for pointer moves).
3. Add a macOS cursor-position poller (short interval, e.g. 16ms/60Hz) or
   event-tap subscription feeding the new channel; stub/no-op on Windows
   until its input backend lands.
4. Add the overlay `View` + positioning logic to `ViewerScreen.tsx`, gated on
   the content-rect fix from `docs/audit/m3/input-touch.md` Finding 1.

### Migration strategy

Additive/optional on the wire: an old mobile client simply never receives
`cursor-state` and falls back to today's baked-in-cursor behavior if
`shows_cursor` is _not_ flipped for that client's negotiated protocol version
(gate the capture-side change behind the same capability negotiation
recommended in `docs/audit/m3/input-touch.md` Finding 2, so old and new
clients don't end up with an invisible cursor and no overlay).

### Testing strategy

- Manual: A/B the overlay vs. baked-in cursor while dragging a window across
  the full width of the display; the overlay should visibly move with zero
  perceptible delay while the underlying video content still trails by the
  normal glass-to-glass latency.
- Unit test the cursor-position→overlay-coordinate mapping function using the
  same fixture matrix as the content-rect tests recommended for
  Finding 1 of the touch-input audit.
- Regression: confirm host-originated (non-touch) mouse movement is still
  visible via the overlay when the video's baked-in cursor is disabled.

### Risk assessment

Medium — touches the WebRTC negotiation surface (a new DataChannel) and the
video pipeline's capture configuration; low risk of regressing anything else
since it's purely additive and the old behavior (baked-in cursor) is the
correct fallback for negotiation-mismatch cases.

### Performance impact

Small: a 60Hz position poll is cheap on macOS; the new channel's messages are
tiny (a few bytes) and unreliable (no retransmission cost under loss). Net
positive for perceived latency, which is the entire point.

### Future extensibility

Once a live cursor-state channel exists, it's the natural foundation for
showing the _host's own_ cursor shape changes (resize handles, text I-beam,
spinning wait cursor) to the phone user — useful context this product
currently discards entirely by baking a flat cursor glyph into lossy video.

---

## Finding 2 — No true high-fidelity ("readable text") encode path exists; the promised 1080p text mode has zero lines of implementation

**Prior art:** Parsec's 4:4:4 chroma mode exists specifically because
default 4:2:0 subsampling visibly smears fine, high-contrast detail — text,
thin UI lines, code editors — exactly the content a "developer controls" /
"readable text" product (`docs/architecture.md:18`) needs to render well.

### Current implementation (cite file:line)

`docs/technical-design.md:29-30` states: "Modes: `720p@30` default; `1080p`
"text mode" for readability." `apps/desktop/src-tauri/src/media/encoder/mod.rs:33-43`
defines exactly one `EncoderSettings::default()` — `width: 1280, height: 720,
fps: 30` — with no second preset, no mode enum, and no runtime toggle
anywhere. `apps/desktop/src-tauri/src/media/capture/mod.rs:50-59` mirrors the
same fixed 1280×720 default in `CaptureConfig`. A repository-wide search for
`text_mode`, `1080`, or any mode-switching construct in
`apps/desktop/src-tauri/src`, `apps/mobile/src`, or `packages/protocol/src`
returns **zero matches**. Separately, `apps/desktop/src-tauri/src/media/convert.rs:1,13`
and every encoder backend (`software.rs`, `videotoolbox.rs`) always produce
4:2:0-subsampled I420 — there is no 4:4:4 or 4:2:2 code path in either
backend, and openh264/VideoToolbox's default profile selection is left
entirely to the library defaults (no explicit `Profile::High444` or
equivalent request anywhere).

### Problems

The design doc makes a specific, testable product promise — "1080p text
mode for readability" — that does not exist in code at all. Any engineer or
stakeholder relying on `docs/technical-design.md` as ground truth will
believe this capability ships today; it does not. Functionally, this means
there is no way for a user to trade frame rate for resolution/sharpness when
reading dense text (a code editor, a spreadsheet, a terminal) — the one
explicit use case `docs/architecture.md:18` calls out ("developer controls
... readable text"). 4:2:0 chroma subsampling in particular blurs colored
text edges and thin syntax-highlighted underlines more than luma-only detail
would suggest, which is a well-documented weakness Parsec's 4:4:4 mode exists
specifically to solve.

### Root cause

The M3 milestone's actual scope (per `docs/milestones.md:33-134`) delivered
capture, hardware encode, ABR, and reconnection — a fixed single-resolution
pipeline was sufficient to prove those systems end-to-end, and the
resolution-mode toggle documented in M0's design pass was simply never
built. `EncoderSettings`/`CaptureConfig` were designed as a single flat struct
with no notion of "current mode" vs. "available modes."

### Redesign

1. Add an explicit `CaptureMode` enum (`Motion` = 720p30 today's default,
   `Text` = 1080p, lower fps e.g. 15-20 acceptable since static/reading
   content doesn't need 30fps motion smoothness) alongside
   `EncoderSettings`/`CaptureConfig`, and a `PipelineControl::set_mode(...)`
   analogous to the existing `set_target_bitrate`
   (`apps/desktop/src-tauri/src/media/pipeline.rs:48-59`) that triggers an
   `encoder.reset()`-equivalent resolution change (the encoders already
   support a `reset()` call used for bitrate/error recovery — extend it to
   accept new dimensions, or add a parallel `resize()` method).
2. For chroma fidelity: verify whether the `openh264` crate's
   `EncoderConfig` exposes a 4:4:4/4:2:2 profile option (not confirmed in
   this audit — `software.rs:31-42` only sets bitrate/framerate/rate-control
   today); if it does not, 4:4:4 is realistically VideoToolbox-only (Apple's
   `CompressionSessionBuilder` does support higher-fidelity profiles on
   supported hardware) — scope the software-encoder path to "1080p, still
   4:2:0, still a real readability win from resolution alone" rather than
   blocking the whole feature on software-path 4:4:4 support that may not
   exist.
3. Surface the mode choice as a mobile UI toggle (e.g. next to the existing
   toolbar, `ViewerScreen.tsx:117-129`) that sends a small signaling message
   requesting the mode; desktop applies it via `PipelineControl`.

### Tradeoffs

A resolution change (unlike a pure bitrate retarget) forces a full encoder
rebuild and a fresh capture configuration — expect a brief (sub-second)
visible glitch/black frame during the switch, which should be communicated
in the UI (a short "Switching to Text Mode…" toast) rather than left silent.
4:4:4 support is genuinely gated on library/hardware capability that this
audit could not fully verify without a build — ship 1080p-only first as a
safe, real improvement, and treat 4:4:4 chroma as a stretch goal pending a
spike to confirm `openh264`/`videotoolbox` crate support.

### Implementation plan

1. Add `CaptureMode`/mode-aware `EncoderSettings`/`CaptureConfig` construction
   in `apps/desktop/src-tauri/src/media/mod.rs` (or a new `mode.rs`).
2. Extend `VideoEncoder::reset()` (or add `resize()`) in
   `apps/desktop/src-tauri/src/media/encoder/mod.rs:52-61` and both backend
   implementations to rebuild at new dimensions.
3. Wire a `set_mode` signaling message end-to-end (protocol → hub relay →
   session.rs handler → `PipelineControl`).
4. Add the mobile toggle UI.
5. Spike: check `openh264` crate docs/source for a 4:4:4-capable
   `EncoderConfig` field; check `videotoolbox` crate / `CompressionSessionBuilder`
   for a chroma-format or profile-level option beyond today's defaults
   (`videotoolbox.rs:103-114` sets none explicitly).

### Migration strategy

Additive signaling message with a safe default (stay in `Motion`/720p mode
if the message is never sent or the peer doesn't understand it) — no breaking
change to existing sessions.

### Testing strategy

- Integration test: request `Text` mode mid-session, assert the encoder
  rebuilds at 1080p and a fresh IDR is produced (mirroring the existing
  `bench_pipeline.rs`/resolution-change tests referenced in
  `docs/milestones.md:73-75`).
- Manual: render a terminal window with 10pt monospace text on the host,
  compare legibility screenshots at 720p vs. 1080p text mode side-by-side.
- If 4:4:4 ships: a color-fringing regression test (render a red/cyan edge
  pattern, verify no chroma bleed at chroma block boundaries) comparing 4:2:0
  vs 4:4:4 output.

### Risk assessment

Medium — resolution changes touch the same reset/rebuild path already
exercised by bitrate changes (lower risk, proven pattern) but must be
tested against the capture backend's own resize behavior, which has not been
exercised by any existing test (`screencapturekit.rs`'s tests only cover a
fixed default resolution).

### Performance impact

1080p roughly doubles pixel count vs 720p — expect proportionally higher
CPU (software path) or GPU (VideoToolbox) encode cost and bitrate at a given
quality target; this is an intentional, user-opted-into tradeoff (readability
over smoothness), not a regression to the default path.

### Future extensibility

A real mode abstraction is the natural place to add further presets later
(e.g., a "battery saver" 480p mode) without further architectural change,
and closes the gap between what the design docs promise and what a new
contributor will actually find in the code — worth fixing even independent
of the competitive angle, since a docs/code mismatch this direct is a
credibility risk for the design-doc process itself.

---

## Finding 3 — Adaptive bitrate control reacts only to already-lost packets and the receiver's own REMB estimate, never to delay/jitter trends

**Prior art:** Chrome Remote Desktop rides on full libwebrtc, whose default
Google Congestion Control (GCC) estimator uses inter-arrival delay trends
(via transport-wide congestion control feedback, TWCC) to detect early
queueing/bufferbloat _before_ it turns into loss — this is the standard
technique that lets a well-behaved WebRTC sender back off proactively rather
than reactively. Parsec's own (proprietary, publicly described only in
broad strokes) low-latency congestion controller is understood to work
similarly: it treats rising one-way latency/frame-arrival jitter as the
primary signal, with loss as a secondary, already-too-late confirmation.

### Current implementation (cite file:line)

`apps/desktop/src-tauri/src/media/abr.rs:1-121` is the entirety of Lilypad's
congestion control: `BitrateController::on_loss_report(fraction_lost, now)`
(lines 88-108) backs off ×0.7 above 10% loss, holds between 2-10%, and probes
up ×1.05 every 2s below 2% loss; `on_remb(bitrate_bps)` (lines 112-120) caps
the target at 95% of the receiver's REMB estimate. `apps/desktop/src-tauri/src/rtc/mod.rs:119-150`
confirms these are the _only_ two RTCP signals ever parsed and forwarded —
`PictureLossIndication`/`FullIntraRequest` (→ keyframe request, not bitrate),
`ReceiverEstimatedMaximumBitrate` (→ REMB cap), and `ReceiverReport` (→ loss
fraction). No transport-wide congestion control feedback (TWCC) packet type
is parsed or requested anywhere in `rtc/mod.rs`, and `abr.rs` has no
input parameter or method that could accept a delay/jitter trend even if one
were supplied.

### Problems

Both of `abr.rs`'s live signals are lagging indicators. Packet loss on a
congested path typically only starts once a router or NAT's queue is already
full and dropping — by the time `fraction_lost > 0.10` fires, the user has
already experienced a burst of queueing delay (visible as a latency spike/
stutter) for however long it took to accumulate that loss. REMB is _the
receiver's own_ estimate, computed after-the-fact from what already arrived —
useful as a ceiling, but not a proactive signal either. A GCC-style delay-
based estimator would let the sender detect the queue _starting_ to build
(rising smoothed one-way delay / packet group inter-arrival time) and shed
bitrate within one or two RTT before it manifests as user-visible loss or
stutter at all. For a product whose entire value proposition rests on
feeling indistinguishable from local (`docs/architecture.md:6-7`), being
purely reactive rather than proactive to congestion is a meaningful and
measurable gap against any product built on a full congestion-control stack.

### Root cause

`webrtc-rs` (the crate powering `apps/desktop/src-tauri/src/rtc/mod.rs`) is a
comparatively thin implementation next to full libwebrtc — it does not ship
a productized sender-side GCC/TWCC bandwidth estimator the way Chrome's stack
does, so `abr.rs` was hand-rolled from the two RTCP signals that were readily
available (loss + REMB) rather than from a delay-based estimator, which would
require either implementing TWCC packet-feedback parsing from scratch or
adopting a maintained crate that provides it (unverified in this audit
whether one exists for `webrtc-rs`).

### Redesign

1. Investigate whether `webrtc-rs`'s interceptor registry
   (`register_default_interceptors`, `rtc/mod.rs:288-289`) already includes a
   TWCC sender/receiver interceptor pair that simply isn't being _read_ by
   this code (some WebRTC stacks register TWCC by default for RTX/NACK
   purposes even without a full GCC estimator consuming it) — if so, the
   fastest path to a delay-based signal is parsing the existing TWCC feedback
   packets `rtc/mod.rs`'s RTCP loop already has access to (extend the
   `packet.as_any().downcast_ref::<...>()` chain at lines 126-146 with a TWCC
   feedback type) rather than building a new transport mechanism.
2. If TWCC is unavailable, use frame-arrival-interval jitter as a cheaper
   proxy: track the _inter-arrival time_ of RTCP receiver reports themselves,
   or (more directly) have the mobile client compute simple one-way delay
   drift from its own frame-receive timestamps and periodically report it
   back over the existing input DataChannel or a small new "quality report"
   message — a lightweight, product-specific substitute for full TWCC that
   still gives `abr.rs` an early, delay-based signal instead of loss-only.
3. Add a new `BitrateController::on_delay_trend(trend: DelayTrend)` method
   (parallel to `on_loss_report`/`on_remb`) implementing a simple
   increasing/stable/decreasing classification (a minimal single-pole
   Kalman-style trend filter is the standard technique here, and is exactly
   the shape of algorithm real GCC implementations use) that triggers the
   same ×0.7 back-off _before_ loss reports would.

### Tradeoffs

A delay-based signal is more implementation work than the two RTCP fields
already wired up, and — done poorly — risks false-positive back-offs on
ordinary jitter (mitigated by using a proper trend filter with hysteresis,
not a raw threshold). This is the single most technically involved
recommendation in this report; it should be scoped as its own spike (verify
TWCC availability in `webrtc-rs` first) before committing to an
implementation plan, rather than assumed straightforward.

### Implementation plan

1. Spike: grep the `webrtc-rs` crate's interceptor/RTCP modules (vendored or
   via `cargo doc`) for TWCC support; if present, wire a new `PeerEvent`
   variant analogous to `VideoLossReport`/`VideoRemb` (`rtc/mod.rs:75-79`).
2. If absent: design the mobile→desktop quality-report message (protocol
   addition, versioned per the existing `PROTOCOL_VERSION` convention,
   `packages/protocol/src/constants.ts:5`).
3. Add `on_delay_trend`/`DelayTrend` to `abr.rs` with its own unit tests
   mirroring the existing test module's style (`abr.rs:123-199`).
4. Wire the new signal into `session.rs`'s existing RTCP-feedback match arm
   (`session.rs:349-368`) alongside the current loss/REMB/keyframe handling.

### Migration strategy

Purely additive — a peer that never sends delay/TWCC feedback simply never
triggers `on_delay_trend`, and the existing loss/REMB-based behavior is
unchanged as a fallback. No wire break for existing clients.

### Testing strategy

- Extend `abr.rs`'s existing unit-test module (already excellent coverage of
  loss/REMB edge cases, `abr.rs:123-199`) with delay-trend scenarios: rising
  delay with _no_ loss yet should still trigger a back-off; a stable delay
  trend should not.
- Network-impairment integration test (matching the technique recommended in
  `docs/audit/m3/input-touch.md` Finding 2): induce bufferbloat (a queueing
  `tc qdisc` rule, not pure loss) and confirm the new signal backs off
  materially earlier (lower peak queueing delay) than the loss-only baseline.

### Risk assessment

Medium-high — this is genuinely one of the harder problems in real-time
video (it's a large fraction of what a full WebRTC stack's engineering
investment goes toward), and a poorly-tuned delay estimator can oscillate or
under-react. Recommend landing behind a feature flag and A/B validating
against the existing loss/REMB-only controller before making it the default.

### Performance impact

None to the hot path if implemented as a periodic (not per-packet) signal;
correctly implemented, it should _reduce_ the frequency and depth of the
existing ×0.7 back-off transitions by acting earlier and smaller.

### Future extensibility

A working delay-trend signal is also the natural foundation for a future
"predictive" resolution/fps step-down (Finding 4) — the same trend classifier
can drive both bitrate and resolution/fps decisions from one shared
congestion signal instead of two independently-tuned mechanisms.

---

## Finding 4 — Only bitrate adapts to network conditions; resolution and frame rate are static, so a congested link is forced to render 720p30 at whatever bitrate floor is left, however blocky

**Prior art:** Moonlight/Sunshine, Parsec, and AnyDesk all cascade quality
knobs under sustained bandwidth pressure — dropping resolution and/or frame
rate to keep bits-per-pixel (and therefore visible block/mosquito-noise
artifacting) in a tolerable range, rather than holding resolution constant
and just starving the bitrate.

### Current implementation (cite file:line)

`apps/desktop/src-tauri/src/media/abr.rs:34-46`'s `AbrConfig::default()` sets
`min_kbps: 300` as the absolute floor — under sustained heavy loss,
`BitrateController` will drive the target down to 300 kbps
(`abr.rs:157-171`'s `never_leaves_configured_bounds` test proves this) and
hold there indefinitely. `apps/desktop/src-tauri/src/media/pipeline.rs:71-90`
and `apps/desktop/src-tauri/src/media/encoder/mod.rs:33-43` show `width`,
`height`, and `fps` are fixed at pipeline-construction time and never
adjusted by anything in the encode loop (`pipeline.rs:95-207`) other than the
`current_bitrate`/`want_bitrate` reconciliation at lines 110-120. A
repository-wide search for `simulcast`, `scaleResolution`, `downscale`, or
`resolution_scale` across `apps/desktop/src-tauri/src` and
`apps/mobile/src` returns **zero matches**.

### Problems

300 kbps at a fixed 1280×720/30fps is a genuinely poor bits-per-pixel budget
for H.264 — expect heavy macroblocking and motion smearing well before that
floor is even reached. Every competitor named in this brief instead reduces
_either_ resolution or frame rate (or both) as bitrate drops, preserving a
tolerable bits-per-pixel ratio and, for game-streaming products like
Moonlight/Sunshine, preserving motion smoothness at the cost of detail (or
vice versa, depending on content). Lilypad's single-resolution, fixed-fps
design means the _worst_ possible network condition the ABR floor is designed
to survive is also the condition where the picture looks the worst it
possibly can, with no mechanism to trade off resolution for quality instead.

### Root cause

The pipeline's `EncoderSettings`/`CaptureConfig` were designed for a single
fixed operating point (the M3 milestone's job was proving hardware encode +
RTCP feedback end-to-end, not a full multi-dimensional quality-adaptation
matrix), and `PipelineControl` (`pipeline.rs:43-60`) was built with exactly
one knob (`set_target_bitrate`) because that was the only dimension `abr.rs`
needed to drive at the time.

### Redesign

1. Extend `PipelineControl` (`pipeline.rs:43-60`) with a
   `request_resolution_step(direction: Up | Down)` method, and give
   `BitrateController` (or a new sibling `QualityLadderController`) a small
   ordered ladder of `(width, height, fps, min_kbps, max_kbps)` tuples (e.g.
   1280×720@30, 960×540@30, 640×360@24) — when the bitrate controller would
   otherwise hold at its _lowest_ rung for longer than some hysteresis window
   (e.g. 5s), step the resolution ladder down one notch instead of
   continuing to starve the current resolution; step back up analogously
   once bitrate has recovered and held comfortably above the next rung's
   floor for a similar window.
2. Resolution changes go through the same encoder `reset()`/rebuild path
   already used for bitrate changes and (per Finding 2) mode switches — this
   is a proven pattern in the existing code, not new machinery.
3. Keep the ladder conservative and product-owned (not automatically
   inferred) — three or four rungs, tuned empirically against real network
   conditions, rather than a continuous function.

### Tradeoffs

Resolution changes are visually more disruptive than a bitrate retarget (a
brief black-frame/re-init glitch each step, per Finding 2's tradeoffs
section) — the hysteresis windows must be tuned generously enough that a
brief loss spike doesn't trigger a resolution ping-pong, at the cost of being
slower to recover full quality than a pure-bitrate approach would be. This
finding should be sequenced after Finding 3 (delay-based signal) lands, since
a resolution ladder driven by a laggier, loss-only signal will react to
congestion later and more coarsely than one driven by an early delay trend.

### Implementation plan

1. Define the resolution ladder as a small ordered `Vec<QualityRung>` in
   `media/abr.rs` or a new sibling module.
2. Add ladder-stepping logic to `BitrateController` (or wrap it), gated by
   sustained-floor hysteresis timers, unit-tested with the same
   `Instant`-driven determinism style as the existing tests
   (`abr.rs:123-199`).
3. Wire `PipelineControl::request_resolution_step` through to the encoder/
   capture rebuild path (`pipeline.rs`).
4. Surface the _current_ rung as part of the metrics snapshot
   (`media/metrics.rs`) so Finding 9's connection-quality UI can show it.

### Migration strategy

Fully desktop-internal — no protocol change required (the resolution the
desktop chooses to send is invisible to the wire format, which already
tolerates any frame size). Safe to roll out independently.

### Testing strategy

- Unit test the ladder-stepping hysteresis logic against synthetic
  sustained-floor and recovery scenarios.
- Network-impairment integration test: throttle bandwidth below the 720p
  floor's viable range for the hysteresis window, confirm a resolution
  step-down fires and visual quality (measured via encoded bitrate-per-pixel,
  a cheap objective proxy) improves at the new rung vs. holding 720p at the
  same starved bitrate.

### Risk assessment

Medium — reuses the already-proven encoder-rebuild pattern, but the
hysteresis tuning is empirical and could misfire (resolution ping-pong) if
under-tested against real bursty loss patterns rather than only clean
synthetic throttling.

### Performance impact

Lower resolution reduces both encode cost and bandwidth at the low end —
strictly positive for the exact condition (a congested link) where CPU/
bandwidth headroom is scarcest.

### Future extensibility

The same ladder mechanism generalizes to a manual user-facing "performance
vs. quality" preference slider later, without further architectural work,
and composes directly with Finding 2's mode system (a "Text" mode rung and a
"Motion" mode rung can share the same stepping machinery).

---

## Finding 5 — Only absolute direct-touch input exists; there is no relative/trackpad mode, unlike Jump Desktop's signature dual-mode design

**Prior art:** Jump Desktop's most-cited differentiator is exactly this
choice: "Fluid" (direct absolute touch — tap where you want the cursor) vs.
a relative trackpad mode (move your finger to move the cursor proportionally,
tap-to-click, two-finger right-click, drag with a modifier) — letting users
pick the precision tool for the job (direct touch for casual pointing,
trackpad mode for fine text selection or precise icon-dragging). RustDesk's
mobile client ships an equivalent toggle.

### Current implementation (cite file:line)

`apps/mobile/src/screens/ViewerScreen.tsx:67-92`'s `PanResponder` is the
entirety of Lilypad's touch-input model: `onPanResponderGrant` fires
`pointerDown` at the raw first-touch coordinate (lines 72-77),
`onPanResponderMove` fires `pointerMove` at the raw current coordinate (lines
78-83), both normalized directly against the container's full bounds. There
is no state, prop, toggle, or code path anywhere in `apps/mobile/src`
implementing relative motion (a mode where finger _delta_ rather than finger
_absolute position_ drives the cursor) — confirmed via the same audit that
found this in `docs/audit/m3/input-touch.md` Finding 7, which frames it as an
in-paradigm precision aid rather than a full mode switch; this report treats
the _mode switch itself_ as the competitive-parity gap, since Jump Desktop
(the product this audit is explicitly asked to compare against) ships both
modes as first-class, user-selectable options, not one mode with precision
assists bolted on.

### Problems

Direct absolute touch is genuinely the right _default_ for a "touch a Mac
like glass" phone-first product (`docs/architecture.md:6-7`) — but it is
inherently worse than a mouse for fine work (selecting a specific word,
dragging a small window's corner to resize, hitting a 16px close button)
because a finger's contact patch and the phone/laptop screen size ratio make
sub-pixel-accurate absolute placement structurally hard, independent of any
bug (as already noted in the touch-input audit). Every competitor that takes
"precision work" seriously ships a second, relative mode specifically to
route around this limitation, rather than only tuning the absolute mode's
settle/deadzone behavior. Lilypad currently offers users no way to opt into
that precision, even as a fallback for the moments direct touch is provably
worse.

### Root cause

The M2/M3 prototype scope was "prove one interaction model end-to-end
(direct touch)" — a second, independent interaction mode is real net-new
surface (input recognizer, a mode-switch affordance, and a second coordinate-
mapping strategy: cursor-delta accumulation instead of absolute normalization)
that was never built because it wasn't required to prove the pipeline.

### Redesign

Add a mode toggle (e.g. a small persistent icon near the existing toolbar,
`ViewerScreen.tsx:117-129`) switching between:

- **Direct** (today's behavior, unchanged): first-touch = `pointerDown` at
  the touch coordinate.
- **Trackpad**: first-touch does _not_ send `pointerDown` — instead, tracks
  the finger's _delta_ since the last sample and calls a new
  `InputSender.pointerDelta(dx, dy)` (mirroring the existing
  `InputSender.scroll(x, y, dx, dy)` shape already in
  `apps/mobile/src/lib/input.ts:53-55`) which the desktop dispatcher applies
  as a relative move against the _current_ OS cursor position (not an
  absolute placement) — requires a new `MouseAction::MoveRelative { dx, dy }`
  variant alongside the existing absolute move in
  `apps/desktop/src-tauri/src/input/mod.rs`, and a `CGWarpMouseCursorPosition`-
  or `CGEventCreateMouseEvent`-relative-move equivalent in
  `apps/desktop/src-tauri/src/input/macos.rs` (today's `screen_point`,
  `macos.rs:76-80`, only supports absolute mapping). A short, stationary tap
  (below a small movement threshold, released quickly) becomes a click in
  this mode — the standard trackpad "tap-to-click" convention Jump Desktop
  and most laptop trackpads share.

### Tradeoffs

This is explicitly flagged (matching `docs/audit/m3/input-touch.md`'s own
framing of the adjacent finding) as the recommendation in this report that
most resembles genuinely new user-facing capability rather than a pure fix —
it requires product sign-off given the audit's "no new features" mandate.
Recommend framing it internally not as "add a feature" but as "ship the
second half of an interaction-model decision the product already implicitly
made when it modeled `scroll` as a delta-based event" — the wire-protocol
shape for relative motion already exists in spirit (`scroll`'s `dx`/`dy`),
this only extends the same idea to primary pointer movement.

### Implementation plan

1. Product decision gate (per Tradeoffs) before implementation.
2. Add `MouseAction::MoveRelative`/`pointerDelta` to
   `packages/protocol/src/input.ts`, `apps/desktop/src-tauri/src/input/mod.rs`
   and `protocol.rs`, `apps/desktop/src-tauri/src/input/macos.rs`.
3. Add the mode-toggle UI and a `Trackpad`-mode gesture recognizer in
   `ViewerScreen.tsx` (best built atop the `react-native-gesture-handler`
   migration already recommended in `docs/audit/m3/input-touch.md` Finding 6,
   since delta accumulation and tap-vs-drag disambiguation both benefit from
   that library's richer per-touch data).
4. Implement tap-to-click timing/threshold detection (reuse the settle-
   window concept from `docs/audit/m3/input-touch.md` Finding 7).

### Migration strategy

Additive protocol field + additive mobile UI; no breaking change to
`Direct` mode, which remains the default and today's exact behavior.

### Testing strategy

- Unit test the relative-delta accumulation and tap-vs-drag threshold logic
  with synthetic touch sequences.
- Rust unit test asserting `MoveRelative` produces the correct
  `CGEventCreateMouseEvent`-relative call sequence (mock backend, matching
  existing `dispatcher.rs` test patterns).
- Manual precision test: select a specific word in a text field and resize a
  small window corner in Trackpad mode vs. Direct mode, comparing success
  rate/attempts needed.

### Risk assessment

Medium — new protocol surface plus a second full interaction-recognition
path; risk is bounded by keeping `Direct` mode's code path entirely
unchanged and additive.

### Performance impact

Negligible — same event cadence/coalescing budget as existing pointer
moves; relative deltas are no more expensive to compute or transmit than
absolute coordinates.

### Future extensibility

A working relative-motion primitive is also the natural foundation for a
future physical-mouse-via-Bluetooth-to-phone passthrough mode, or a "cursor
acceleration curve" (real trackpads apply non-linear gain to relative
motion, which only makes sense once motion is relative rather than
absolute) — both natural asks once this exists, out of scope here.

---

## Finding 6 — Clipboard sync is one-directional (phone→desktop only); RustDesk, Parsec, AnyDesk, and Chrome Remote Desktop all sync both ways

**Prior art:** Every general-purpose remote-desktop product in this brief's
comparison set treats clipboard sync as bidirectional and automatic — copy
on either end, paste on the other, no explicit "send" action required.

### Current implementation (cite file:line)

`apps/desktop/src-tauri/src/plugins/clipboard.rs:1-2`'s own module doc
comment states: "ClipboardPlugin — bridges clipboard text between phone and
desktop (copy/paste over the input channel)." The implementation
(`clipboard.rs:6-38`) is a bare `Plugin` lifecycle stub with no clipboard-
reading logic of any kind — the actual clipboard _write_ happens entirely
inside the input dispatcher: `apps/desktop/src-tauri/src/input/dispatcher.rs:173`
calls `self.backend.set_clipboard(&text)` when an inbound `Clipboard` event
arrives, and `apps/desktop/src-tauri/src/input/macos.rs:248-253`
(mirrored in `windows.rs:47-53`) implements `set_clipboard` by writing to the
OS clipboard via `arboard` — a write-only operation. The wire schema
(`packages/protocol/src/input.ts:105-121`, the `clipboard` `InputEvent`
variant) carries only a `text` field to _set_ the desktop clipboard; there is
no corresponding message type anywhere in `packages/protocol/src/signaling.ts`
or `apps/mobile/src/lib/*.ts` for the desktop to push its own clipboard
contents to the phone, and a repository-wide search confirms no such
message exists.

### Problems

A user can paste something copied on their phone into the remote desktop
(one direction, and only that direction, works), but cannot copy text,
a URL, or a code snippet from the remote desktop back to their phone to use
elsewhere (a message app, a notes app, a different tool) — a routine,
constant-use-case workflow for anyone doing real work through this product,
and a capability every named competitor treats as basic. The module's own
doc comment overstates what the code actually does ("bridges... between
phone and desktop," implying both directions), which is also a documentation-
accuracy problem worth fixing on its own.

### Root cause

`ClipboardPlugin` was scaffolded with the right _intent_ (per its doc
comment) during the plugin-host build-out, but only the phone→desktop
direction was ever wired to a concrete data path (the existing input-event
dispatch pipeline, which is naturally phone→desktop by construction) — the
desktop→phone direction requires an entirely different mechanism (the
desktop must _observe_ its own clipboard changing and push a message out),
which was never built.

### Redesign

1. Add a macOS/Windows clipboard-change observer (macOS:
   `NSPasteboard.general.changeCount` polling at a modest interval, e.g.
   500ms-1s, is the standard low-overhead technique since there's no native
   clipboard-change notification API; Windows has `AddClipboardFormatListener`
   for a true push notification) inside `ClipboardPlugin`
   (`clipboard.rs`), which currently does nothing but track a `ready` bool.
2. On a detected change, push a new `clipboard-update { text }` signaling
   message (or a dedicated small reliable DataChannel message, consistent
   with the "critical" channel split recommended in
   `docs/audit/m3/input-touch.md` Finding 2, since a dropped clipboard update
   is a real correctness issue, not disposable telemetry) to the phone.
3. On the mobile side, use `@react-native-clipboard/clipboard` (a new
   dependency; RN's built-in `Clipboard` API was deprecated) to write the
   received text into the phone's OS clipboard on receipt, and surface a
   small transient toast ("Copied from Mac") so the user knows it happened
   without having to check.

### Tradeoffs

Polling `NSPasteboard.changeCount` (necessary on macOS; there is no native
push API) has a small, constant background cost and a small detection-latency
window (bounded by the poll interval) — acceptable given clipboard changes
are a low-frequency, human-paced event, not a latency-critical one. Pushing
every clipboard change automatically (rather than requiring an explicit
"send to phone" action) also has a minor privacy consideration — copying a
password or sensitive text on the host would, by default, silently propagate
to the phone's clipboard; every competitor in this comparison accepts this
tradeoff as standard, but it's worth a one-line mention in user-facing
documentation/settings (e.g. an eventual opt-out toggle), not a blocker to
shipping the core capability.

### Implementation plan

1. Add `NSPasteboard`/`AddClipboardFormatListener` observation to
   `ClipboardPlugin` (`clipboard.rs`), platform-gated like the rest of the
   `os/macos.rs` / `os/windows.rs` split.
2. Add `clipboard-update` to `packages/protocol/src/signaling.ts` (or as a
   new `InputEvent`-adjacent desktop→phone message type, since today's
   `clipboard` variant in `input.ts:105-121` is explicitly phone→desktop by
   direction of the DataChannel it travels on).
3. Wire the desktop-side push into `session.rs`'s existing event-dispatch
   loop.
4. Add the mobile receiver + OS-clipboard-write + toast in
   `apps/mobile/src/lib/webrtc.ts` / `ViewerScreen.tsx`.
5. Correct the misleading doc comment at `clipboard.rs:1-2` once both
   directions are real (or beforehand, to accurately describe current
   one-directional behavior — a one-line docs fix with zero risk,
   independently worth doing today regardless of the rest of this finding's
   timeline).

### Migration strategy

Additive message type; no existing behavior changes. Old mobile clients
simply never receive/act on `clipboard-update` until updated.

### Testing strategy

- Manual: copy a string on the Mac, confirm it lands in the phone's system
  clipboard within the poll interval, paste-test in a phone text field.
- Unit test the (mocked) `NSPasteboard` change-detection loop with a fake
  changing `changeCount` sequence.
- Regression: confirm the existing phone→desktop direction
  (`dispatcher.rs:173`) is unaffected.

### Risk assessment

Low — additive, and the existing one-directional path is untouched. Main
risk is the privacy consideration noted in Tradeoffs, which is a product/UX
decision, not a technical risk.

### Performance impact

Negligible — a sub-second poll interval on a lightweight OS API call, and
clipboard changes are inherently a low-frequency event.

### Future extensibility

Once bidirectional text clipboard sync exists, image/file clipboard sync
(also standard in AnyDesk/RustDesk) becomes a natural, scoped-separately
follow-on using the same change-detection + push mechanism, just with a
richer payload type — explicitly out of scope for this finding.

---

## Finding 7 — The encoder runs unconditionally on every capture tick, even when the screen content is completely static

**Prior art:** AnyDesk's DeskRT codec is built around detecting and
specially handling static/text regions rather than treating every frame as
uniform photographic content — the practical, portable takeaway (without
building a custom codec, which this report explicitly recommends against)
is: don't spend encode/transmit work on a frame that hasn't changed at all.

### Current implementation (cite file:line)

`apps/desktop/src-tauri/src/media/pipeline.rs:126-147`'s encode loop calls
`encoder.encode(&raw, force_kf)` (line 147) on every single iteration,
unconditionally, for every frame `capture.next_frame()` returns
(line 127) — there is no comparison of the incoming `RawFrame` against the
previous one anywhere in `pipeline.rs`, `apps/desktop/src-tauri/src/media/convert.rs`,
or `apps/desktop/src-tauri/src/media/frame.rs` (confirmed by reading all
three in full). For the software path, this also means every idle frame
still pays the full `bgra_to_i420` conversion cost
(`apps/desktop/src-tauri/src/media/encoder/software.rs:51-59`) before the
encoder even runs.

### Problems

A user reading a document, thinking between keystrokes, or simply leaving a
session open while looking at a static screen still drives the capture
thread at full configured fps (30Hz default,
`apps/desktop/src-tauri/src/media/encoder/mod.rs:38`), the full BGRA→I420
conversion pass, and a full encoder invocation every single frame — burning
host CPU/GPU cycles, battery, and a P-frame's worth of bandwidth for content
that is bit-for-bit identical to the previous frame. H.264's own P-frame
delta coding will produce a _small_ payload for an unchanged frame, but "small
but nonzero, computed 30 times a second" is strictly worse than "computed
zero times" for the actual common case of a user not actively interacting —
plausibly the majority of wall-clock time in any real session.

### Root cause

The simplest correct pipeline design encodes every captured frame
unconditionally; a frame-equality short-circuit is an optimization layered
on top that was never added, likely because M3's priority was proving the
capture→encode→network chain worked at all, not minimizing steady-state idle
cost.

### Redesign

Add a cheap frame-difference check between `capture.next_frame()` and the
previously captured `RawFrame` (a fast content hash — e.g. `xxhash` over the
BGRA buffer, or even a coarse sampled-pixel comparison for speed — computed
on the same capture thread right after `next_frame()` returns,
`pipeline.rs:127-133`) and, when the frames are identical _and_ no keyframe
is currently forced (`force_kf` at line 146 is false), skip the
`encoder.encode(...)` call and the `bgra_to_i420` conversion entirely for
that tick, incrementing a new `frames_skipped_idle` metric instead of
`frames_encoded`. The receiver already tolerates gaps in frame delivery (the
video track simply doesn't get a new sample that tick); nothing downstream
needs to know the difference between "no change" and "we chose not to
re-encode the same content."

### Tradeoffs

A full-frame hash comparison has a real (if small) CPU cost of its own —
must be measurably cheaper than the conversion + encode it's meant to avoid,
which is likely true for a fast non-cryptographic hash but should be
benchmarked, not assumed. This also interacts with the periodic-keyframe/GOP
logic (`pipeline.rs:139-146`) — a long run of skipped idle frames must not
accidentally suppress the periodic IDR the encoder or the pipeline expects;
the redesign must still force a keyframe on the normal cadence even during an
idle stretch (or, more precisely, on the _first_ frame after an idle stretch
ends, since there's no reason to IDR a stream that never stopped decoding
cleanly).

### Implementation plan

1. Add a lightweight hash (or a cheaper coarse-sample comparison, benchmark
   both) computed once per `RawFrame` right after `next_frame()` in
   `pipeline.rs`'s loop.
2. Track `last_frame_hash: Option<u64>`; skip `bgra_to_i420`/`encoder.encode`
   when it matches and `force_kf` is false; still update `frame_no` and
   pacing bookkeeping so cadence-based logic (keyframe interval, metrics
   logging) stays correct.
3. Add `frames_skipped_idle` to `apps/desktop/src-tauri/src/media/metrics.rs`'s
   `PipelineMetrics`.
4. Benchmark via a new `examples/bench_pipeline_idle.rs` (mirroring the
   existing `bench_pipeline.rs`/`bench_encode.rs` pattern referenced in
   `docs/milestones.md:87-90`) comparing CPU time for a static-content run
   with and without the skip.

### Migration strategy

Fully desktop-internal; no protocol or client change — a receiver that
simply gets fewer samples during an idle period behaves identically to one
receiving redundant near-zero-delta P-frames today, just with less host CPU
spent to produce that outcome.

### Testing strategy

- Unit test: feed the pipeline a sequence of bit-identical `RawFrame`s,
  assert `frames_encoded` stays at 1 (the initial keyframe) while
  `frames_skipped_idle` increments for the rest.
- Regression test: interleave identical and changed frames, assert changed
  frames still encode normally and the periodic-keyframe cadence is
  unaffected by the skipped frames in between.
- Benchmark comparison (CPU time, battery proxy) for a synthetic
  fully-static 30s run, before/after.

### Risk assessment

Low — self-contained to the capture/encode loop, with the main risk being a
subtle interaction with keyframe cadence bookkeeping (mitigated by explicit
tests above) rather than any correctness risk to the actual video content.

### Performance impact

Directly positive: reduces host CPU/GPU and battery use in what is likely
the most common real-world session state (a mostly-idle screen), and
reduces bandwidth consumption proportionally — the desired outcome, not a
tradeoff.

### Future extensibility

The frame-hash mechanism this introduces is also useful groundwork for a
much coarser, future region-based diff (only re-encode the sub-rectangle
that changed) if the product ever wants to move further toward AnyDesk's
DeskRT philosophy — explicitly not recommended as part of this finding's
scope, but a natural next step the hash-comparison infrastructure enables
without more plumbing.

---

## Finding 8 — Every session requires a fresh QR scan and manual Approve, even from a device that was approved five minutes ago; the schema already has a home for trusted devices that the pairing service never uses

**Prior art:** Apple Sidecar and Universal Control's defining UX property is
that once two devices are known to each other (same Apple ID, prior
pairing), reconnection is automatic and essentially invisible — no code, no
explicit re-approval, just proximity. This is the extreme end of "zero-config
reconnection"; this report is not recommending Lilypad remove its explicit-
approval security model (`docs/architecture.md:15-16` is a stated
non-negotiable, correctly so for a remote-control product), only that a
_previously-approved_ device pair should not have to repeat the full QR+
Approve ceremony identically to a first-ever connection.

### Current implementation (cite file:line)

`apps/backend/src/db/schema.ts:51-61` defines a `trustedDevices` table
(`userId`, `desktopDeviceId`, `mobileDeviceId`, `createdAt`), explicitly
commented `// ── trusted_devices (M5) ──`. `apps/backend/src/services/pairing.ts:35-65`
(`createPairing`) and lines 79-97 (`redeemPairing`) are the entire pairing
service — neither function references `trustedDevices`, `devices`, or any
lookup keyed on a returning device pair; `createPairing` unconditionally
mints a brand-new random token (`randomBytes(24)`, line 39) and room
(`randomUUID()`, line 40) on every single call, with a flat 60-second TTL
(`config.pairingTokenTtlSeconds`, `apps/backend/src/config.ts:16`, sourced
from `env.PAIRING_TOKEN_TTL_SECONDS`). `docs/architecture.md:15-16` documents
"Every session requires an explicit Approve on the desktop" as a permanent
design pillar — this finding does not dispute that pillar; it addresses the
_QR-rescan_ step, which is a separate mechanism from approval.

### Problems

A user who paired their phone to their laptop yesterday, and wants to
reconnect today, must physically pick up the laptop, click the bubble, wait
for a QR code, and scan it again with the phone — every single time, forever
— even though the backend's own schema was explicitly designed
(`schema.ts:50`'s own comment: "M5") to recognize this exact device pair as
already trusted. This is friction that directly undercuts the "phone-first"
design pillar (`docs/architecture.md:17`): the entire point of a phone-first
control surface is being able to reconnect quickly without returning to the
laptop for a fresh code each time.

### Root cause

`trustedDevices` was added to the schema during the M0/M1 design pass in
anticipation of M5's auth work (per its own comment and
`docs/milestones.md:166-168`'s "M5 — Auth + trusted devices" scope), but the
M2/M3 pairing service that actually exists today was built before M5 and
never wired to it — this is expected, forward-looking scaffolding, not a bug,
but it means the _current_ code has zero path to the reduced-friction
reconnect flow the schema was clearly designed to eventually enable.

### Redesign

Since M5 is the milestone explicitly scoped for auth/trusted-devices work
(`docs/milestones.md:166-168`), this finding is best read as a concrete
starting design for that milestone rather than a request to build ahead of
schedule:

1. On first successful pairing + Approve for a given (desktop, mobile)
   device-id pair under a given user, insert a row into `trustedDevices`
   (`schema.ts:51-61`) — this requires M5's auth/user model to exist first,
   since `trustedDevices.userId` is a required foreign key
   (`schema.ts:53-55`); note this dependency explicitly rather than treating
   it as independently shippable today.
2. Extend `createPairing`/`redeemPairing` (`pairing.ts:35-97`) with a
   fast-path: if the requesting mobile `deviceId` has a `trustedDevices` row
   for this `desktopDeviceId`, skip the full QR-scan requirement — e.g., the
   desktop app itself can silently attempt to re-establish a room for a
   previously-trusted phone the moment it's on the same network/reachable
   via the backend, or the phone can hold a long-lived (not 60-second)
   resumption credential scoped to that trust relationship, redeemed without
   a fresh QR display.
3. The desktop's explicit Approve/Deny step (`docs/architecture.md:15-16`)
   should remain for a **new, never-before-trusted** device pair, and should
   arguably remain available as a per-session option even for trusted pairs
   (a "always ask" setting) — but the _QR re-scan_ specifically is the
   friction this finding targets, not the approval concept itself.

### Tradeoffs

This is explicitly gated on M5 landing first (auth/user model), so this
finding is a design contribution to that milestone rather than an immediately
implementable M3 fix — flagged accordingly rather than sequenced alongside
the encode/input findings above. There is also a real security tradeoff to
navigate deliberately: reducing re-pairing friction for a trusted device
must not silently reduce the "no silent remote access" guarantee
(`docs/architecture.md:15`) — a trusted-device fast path should still surface
_some_ visible signal on the desktop (a toast, a tray notification) when a
known phone reconnects, even if it skips the interactive Approve click.

### Implementation plan

(Sequenced as part of M5, not this audit's immediate scope)

1. Land M5's user/auth model (prerequisite for `trustedDevices.userId`).
2. Populate `trustedDevices` on first successful Approve.
3. Add a trusted-device lookup branch to `createPairing`/`redeemPairing`.
4. Design and implement the reduced-friction reconnect flow (silent
   desktop-initiated re-offer, or long-lived phone-held resumption
   credential) with an explicit, visible "known device reconnected" signal
   on the desktop side.

### Migration strategy

No existing behavior changes for untrusted/first-time pairs (identical QR
flow). Trusted-pair fast-reconnect is purely additive once M5's prerequisites
land.

### Testing strategy

- Unit test: a `trustedDevices` row exists for a given pair → the fast
  reconnect path is taken and no fresh QR token is minted.
- Unit test: no matching row → falls back to today's full QR flow exactly
  unchanged.
- Manual/security test: confirm the desktop still visibly signals a
  trusted-device reconnect (no fully silent reconnection), and confirm a
  revoked/deleted `trustedDevices` row correctly forces the device back to
  the full QR+Approve flow.

### Risk assessment

Medium-high (deferred, not immediate) — this is a security-relevant surface
(who can reconnect to a previously-paired laptop without explicit interactive
approval) and must be designed carefully alongside M5's broader auth work,
not bolted on ad hoc. Flagged here primarily so M5's design starts from this
schema's clear original intent rather than rediscovering it.

### Performance impact

Positive for user-perceived friction (the actual goal); negligible backend
cost (one additional indexed lookup per pairing attempt).

### Future extensibility

This is the natural foundation for the "multi-device handoff" idea already
flagged as a future extensibility note in
`docs/audit/m3/reconnect-lifecycle.md` Finding 3 (approve on one phone,
resume from another trusted device) — both should be designed together once
M5 begins.

---

## Finding 9 — The desktop already computes rich connection telemetry every second; none of it reaches the phone, which shows only a five-word text badge

**Prior art:** Chrome Remote Desktop, RustDesk, and AnyDesk all expose a
live connection-quality indicator to the user (a bandwidth/latency number, a
signal-strength-style icon, or an expandable stats panel); Moonlight/Sunshine
similarly surface bitrate/fps/latency in an on-screen overlay. This is
treated as baseline product polish, not an advanced feature, across the
comparison set.

### Current implementation (cite file:line)

`apps/desktop/src-tauri/src/media/pipeline.rs:186-188` logs a full metrics
snapshot (via `PipelineMetrics::snapshot()`, `apps/desktop/src-tauri/src/media/metrics.rs`)
approximately once per second — this snapshot already includes bitrate,
capture/encode timing, drop counts, and latency (per the M3 latency-pass
description in `docs/milestones.md:67-91`, which explicitly measures
`avg/max_latency_ms`). None of this data is ever placed on the wire to the
phone — a repository-wide search of `packages/protocol/src/signaling.ts` and
`apps/mobile/src/lib/*.ts` for any metrics/stats/quality-carrying message
type returns no matches, and `docs/architecture.md:72-76` explicitly defers
"Debug overlay + metrics: capture time, encode time, RTT, input round-trip,
ICE candidate type" to **M6**. The entirety of the mobile UI's live
connection feedback is `apps/mobile/src/screens/ViewerScreen.tsx:34-40`'s
`STATE_LABEL` map (`'connecting'|'negotiating'|'connected'|'failed'|'ended'`
→ a short string) rendered in a small badge (lines 112-114, 157-166).

### Problems

A user watching "Connected" has no way to know whether their session is
currently silky-smooth or one packet away from a stutter — no bitrate
number, no latency estimate, no indication the ABR controller
(`docs/audit/m3` findings above) just backed off due to loss. This matters
disproportionately for a product marketed on low latency/responsiveness:
every competitor gives the user _some_ ambient signal that reinforces "this
is fast" when it is, and explains "this is a bit rough right now" when
network conditions degrade, rather than leaving the user to guess why the
cursor suddenly feels laggy. This is explicitly scoped to M6 today
(`docs/architecture.md:72-76`), which is a reasonable prioritization call —
but it's worth flagging in a competitive audit precisely because it's one of
the cheapest, highest-visible-polish gaps relative to how much of the
underlying telemetry already exists.

### Root cause

The M3 milestone correctly prioritized _producing_ accurate telemetry
(latency measurement was a real, tested M3 deliverable per
`docs/milestones.md:67-91`) before _transmitting/displaying_ it — a
reasonable build order, but it means the data exists entirely server-side
today with no transport path to the client, and M6 is where the product
docs currently plan to close that gap.

### Redesign

1. Add a small periodic `quality-report { bitrateKbps, rttMs, avgLatencyMs,
packetLossFraction, iceCandidateType }` signaling message (or a dedicated
   lightweight unreliable DataChannel entry, consistent with the channel-
   split pattern recommended elsewhere in this report and in
   `docs/audit/m3/input-touch.md`), sent by the desktop every ~1-2s directly
   from the existing `PipelineMetrics::snapshot()` plus the ABR controller's
   current state (`abr.rs`'s `current_kbps()`) and the peer connection's
   already-available ICE candidate-pair type.
2. On mobile, render a minimal indicator (a small colored dot or a one-line
   "◐ 2.6 Mbps · 42ms" caption near the existing state badge,
   `ViewerScreen.tsx:112-114`) — deliberately not a full debug overlay (that
   remains the right scope for M6's more complete observability work), just
   enough ambient signal to answer "is my connection currently good or bad."

### Tradeoffs

This slightly pulls forward a slice of M6's explicitly-planned observability
work ahead of schedule — reasonable given how little new code it requires
(the hard part, accurate telemetry, is already built and tested; this is
"expose it," not "build it"), but should be scoped narrowly (one summary
line, not a full stats panel) to avoid scope-creeping into M6's fuller
"debug overlay" deliverable.

### Implementation plan

1. Add `quality-report` (or similar) to `packages/protocol/src/signaling.ts`.
2. Wire a periodic sender in `apps/desktop/src-tauri/src/session.rs`'s
   existing heartbeat/tick loop, sourcing values from
   `MediaPipeline::metrics()` (`pipeline.rs:221-223`) and
   `BitrateController::current_kbps()` (`abr.rs:66-68`).
3. Add the mobile receiver + minimal UI indicator in `webrtc.ts`/
   `ViewerScreen.tsx`.

### Migration strategy

Additive message; old clients simply never receive/render it, no behavior
change. Safe, independent, low-risk to ship ahead of the rest of M6.

### Testing strategy

- Unit test the desktop-side periodic sender fires at the expected cadence
  and carries the current pipeline/ABR state accurately.
- Manual: throttle the network mid-session, confirm the displayed number(s)
  visibly reflect the resulting bitrate/latency change within one reporting
  interval.

### Risk assessment

Low — read-only telemetry exposure with no control-plane effect; cannot
regress session correctness, only adds a small periodic message.

### Performance impact

Negligible — one small message per 1-2s, using data already computed for
internal logging purposes.

### Future extensibility

This is the natural, minimal seed of M6's full "debug overlay" deliverable
(`docs/architecture.md:72-76`) — the wire message and desktop-side sourcing
built here should be designed so M6 can extend the payload (more fields) and
the mobile UI (a fuller expandable panel) without a second protocol
redesign.

---

## Finding 10 — The receive/decode path has zero latency tuning, unlike the send path, which was explicitly hardened; Moonlight/Sunshine's shallow-decoder-queue discipline is applied on only one side of the pipeline

**Prior art:** Moonlight/Sunshine's low-latency reputation rests heavily on
keeping the _decoder-side_ queue as shallow as the network allows — pacing
frame delivery and minimizing buffered-but-undisplayed frames, rather than
only tuning the sender.

### Current implementation (cite file:line)

`apps/desktop/src-tauri/src/media/pipeline.rs`'s sample queue was
deliberately shrunk from 30 frames to 4 (per `docs/milestones.md:73-75`,
"Shallow sample queue... 30 frames... → 4 frames"), and `pipeline.rs:157-172`
implements explicit drop-oldest-with-recovery-IDR backpressure handling on
that queue — this is real, tested, latency-conscious engineering on the
_send_ side. On the receive side, `apps/mobile/src/lib/webrtc.ts` (the
entire file, read in full) contains no configuration of `RTCView`,
`RTCPeerConnection`, or any decoder/jitter-buffer parameter whatsoever beyond
the bare `new RTCPeerConnection({ iceServers })` call at line 93 — a
repository-wide search of `apps/mobile/src` for `jitter`, `playout`, or
`delay` (beyond the unrelated `POINTER_COALESCE_MS`-based input coalescing)
returns no matches.

### Problems

The send-side latency work (shallow queue, immediate-recovery IDR on drop)
is only half of the glass-to-glass budget documented in
`docs/technical-design.md:78-82`. The _receive_ side runs entirely on
`react-native-webrtc`'s (i.e., the underlying libwebrtc's) default jitter-
buffer and decoder behavior — which is tuned by that library's own defaults
for general call-quality smoothness, not necessarily for the aggressive,
Moonlight-style "minimum viable buffering" this product's own stated latency
budget implies. There is no visibility into, or control over, how many
frames of latency the receive side itself is contributing, which means the
one side of the pipeline this audit could _not_ verify is tuned is exactly
the side downstream of every other fix in this report — a resolution
step-down (Finding 4) or a delay-based ABR reaction (Finding 3) both lose
some of their value if the receiver is independently buffering an extra
frame or two behind the scenes.

### Root cause

`react-native-webrtc` (and the underlying native WebRTC stack it wraps) is a
third-party dependency whose jitter-buffer/playout-delay internals are not
directly exposed through the JS API surface used in this codebase today —
the desktop side's latency work was custom-built and fully within this
repo's control, while the receive side inherits whatever the dependency does
by default, and no investigation into what's configurable was undertaken as
part of M3.

### Redesign

1. Investigate `react-native-webrtc`'s actual configuration surface for
   playout delay / jitter buffer control — modern WebRTC (the native
   libwebrtc `react-native-webrtc` wraps) exposes a `playoutDelayHint` /
   `RTCRtpReceiver.playoutDelay` style API in some bindings; confirm whether
   the version pinned in `apps/mobile/package.json` exposes anything
   equivalent before assuming it's controllable at all — this audit could
   not verify this without a device build, and the implementation plan below
   should not proceed past the spike step until confirmed.
2. If configurable: request the minimum viable playout delay (trading
   smoothness-under-jitter for latency, consistent with this product's
   stated priority order — `docs/technical-design.md:78-82` puts a hard
   number on glass-to-glass latency, implying this tradeoff is intentional
   and desired).
3. If not configurable through the current library version/API: this
   finding becomes a documented, explicit **known limitation** (call it out
   in `docs/technical-design.md`'s latency-budget section) rather than a
   silent gap — the honest engineering answer when a dependency doesn't
   expose a knob is to say so, not to pretend it's tuned.

### Tradeoffs

Aggressively minimizing playout delay increases sensitivity to jitter — a
receive-side buffer that's too shallow will visibly stutter/freeze on any
network hiccup that a slightly deeper buffer would have smoothed over
invisibly. This is the same fundamental latency-vs-smoothness tradeoff
Moonlight/Sunshine make deliberately for game streaming; this product's own
documented latency budget suggests it should make the same choice, but this
should be a measured, tunable decision (if the library allows tuning at
all), not a blind minimum.

### Implementation plan

1. Spike: read `react-native-webrtc`'s actual TypeScript API surface (the
   version pinned in `apps/mobile/package.json`) for any
   playout-delay/jitter-buffer control; check whether it forwards to a
   native WebRTC API that exposes `RTCRtpReceiver.playoutDelayHint` or
   equivalent.
2. If available: wire a low-playout-delay hint into `setupPeer`
   (`webrtc.ts:92-133`) once the peer/track is established.
3. If unavailable: add an explicit note to
   `docs/technical-design.md`'s latency-budget section (lines 78-82)
   documenting that receive-side buffering is currently un-tuned/library-
   default, so this doesn't silently read as "handled" to a future engineer.

### Migration strategy

Mobile-app-internal only if a knob exists; a documentation-only change if it
doesn't. No protocol impact either way.

### Testing strategy

- If tunable: measure actual glass-to-glass latency (a timestamp overlay
  technique, or the `bench_pipeline`-style approach already used server-side,
  adapted to include the receive side) before/after applying the low-delay
  hint, on both a clean and a jittery synthetic network.
- If not tunable: no test needed beyond confirming the documentation
  accurately reflects the limitation.

### Risk assessment

Low if a knob exists and is applied conservatively (with a fallback if it
visibly increases stutter); zero risk if this resolves to a documentation-
only outcome — the risk in this finding is entirely in _not knowing_ which
of those two outcomes applies without the spike.

### Performance impact

Potentially the single highest-leverage remaining latency win in this report
if a playout-delay hint is available and effective, since it would apply on
top of every other improvement rather than being redundant with any of them.

### Future extensibility

Once the spike resolves this either way, the finding either closes cleanly
(documented limitation) or opens a natural home for further receive-side
tuning (e.g., matching a future resolution-ladder rung's frame size to an
appropriately-sized receive buffer) — no further speculation warranted until
the spike's result is known.

---

## Top 10 techniques to adopt (ranked)

Ranked by (perceived-latency impact × implementation cost efficiency) for a
production remote-desktop product competing with the named set. Each entry
names its source product and the finding above where the concrete plan lives.

1. **Client-side cursor rendering, decoupled from the video path** — Parsec /
   Moonlight / Apple Sidecar-Universal Control. The single largest perceived-
   latency lever available; the user's own pointer feedback currently pays
   the full glass-to-glass round trip for no architectural reason. (Finding 1)
2. **A real high-fidelity/"text mode" encode path** — Parsec (4:4:4 chroma).
   Currently a _documented promise with zero implementation_ — the highest-
   priority documentation/reality gap in the codebase, and a direct hit
   against this product's own "readable text" pillar. (Finding 2)
3. **Delay/jitter-based proactive congestion control, not loss-only reactive
   control** — Chrome Remote Desktop (full WebRTC GCC) / Parsec. The
   existing `abr.rs` is a genuinely solid loss+REMB controller; this closes
   the gap to a stack that reacts _before_ the user feels it. (Finding 3)
4. **A visible, ambient connection-quality indicator** — RustDesk / Chrome
   Remote Desktop / AnyDesk / Moonlight-Sunshine. Nearly free: the telemetry
   already exists server-side and is already tested; it just never crosses
   the wire. Highest ratio of user-visible polish to implementation cost in
   this entire report. (Finding 9)
5. **Bidirectional clipboard sync** — RustDesk / Parsec / AnyDesk / Chrome
   Remote Desktop. A routine, constant-use-case workflow gap; the plumbing's
   own doc comment already claims this works. (Finding 6)
6. **Resolution/fps step-down under sustained bandwidth pressure, not
   bitrate-only** — Moonlight-Sunshine / Parsec / AnyDesk. Directly improves
   the worst-case visual outcome at the ABR floor, using the exact
   encoder-rebuild pattern already proven for bitrate changes. (Finding 4)
7. **A relative/trackpad input mode alongside direct touch** — Jump Desktop's
   signature feature. The largest genuinely-new-surface item in this list;
   flagged for explicit product sign-off, but the highest-leverage precision
   fix available for anyone doing real work (text selection, window
   resizing) through the product. (Finding 5)
8. **Trusted-device fast reconnect, skipping the QR rescan for known
   pairs** — Apple Sidecar / Universal Control's zero-config feel. The
   schema already has a `trustedDevices` table waiting for this; sequenced
   as part of M5's planned auth work. (Finding 8)
9. **Idle-frame encode short-circuit** — the practical, non-custom-codec
   takeaway from AnyDesk's DeskRT philosophy. A pure win (CPU, battery,
   bandwidth) for the most common real-world session state (a static
   screen), with no user-visible tradeoff once keyframe cadence is handled
   correctly. (Finding 7)
10. **Client-side decode/playout-delay tuning to match the send side's
    already-tuned shallow queue** — Moonlight/Sunshine's shallow-decoder-
    queue discipline. Ranked last only because it depends on a spike into
    `react-native-webrtc`'s actual configuration surface before a concrete
    plan can be committed to — potentially high-impact, currently unverified.
    (Finding 10)

**Explicitly not on this list, by design:** AnyDesk's DeskRT codec itself,
Parsec's/RustDesk's custom-transport-over-UDP option, Moonlight/Sunshine's
LAN-first assumptions, and any game-controller/haptics input support — each
contradicts a stated non-negotiable of this product
(`docs/architecture.md:9-18`, `docs/milestones.md:175-179`) and is
intentionally excluded rather than overlooked.
