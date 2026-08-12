---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: M3 production audit — input and touch findings.
---

# Lilypad M3 Engineering Audit: End-to-End Touch Input Pipeline

**Scope:** phone touch surface → `InputSender` batching → protocol wire format → WebRTC DataChannel → `InputWorker` → `InputDispatcher` → `InputBackend` (macOS `CGEvent` injection).

**Files read in full:**

- `apps/mobile/src/lib/input.ts`
- `apps/mobile/src/screens/ViewerScreen.tsx`
- `apps/mobile/src/lib/webrtc.ts`
- `packages/protocol/src/input.ts`
- `packages/protocol/src/constants.ts`
- `apps/desktop/src-tauri/src/input/mod.rs`
- `apps/desktop/src-tauri/src/input/worker.rs`
- `apps/desktop/src-tauri/src/input/dispatcher.rs`
- `apps/desktop/src-tauri/src/input/protocol.rs`
- `apps/desktop/src-tauri/src/input/macos.rs`
- `apps/desktop/src-tauri/src/input/metrics.rs`
- `apps/desktop/src-tauri/tests/input_worker.rs`
- `apps/desktop/src-tauri/examples/bench_input.rs`
- `apps/desktop/src-tauri/src/rtc/mod.rs`
- Relevant excerpts of `apps/desktop/src-tauri/src/session.rs`, `apps/desktop/src-tauri/src/media/capture/screencapturekit.rs`, `apps/mobile/package.json`

---

## Executive Summary

The desktop-side injection stack (`InputDispatcher` → `MacInputBackend`) is the strongest part of this pipeline: it is well-tested, correctly gates injection on connection state, releases stuck keys/buttons on disconnect, and cleanly separates OS-specific `CGEvent` mechanics from OS-agnostic gating logic. That quality does not carry through the rest of the chain. Three systemic problems dominate this audit:

1. **The protocol's own capabilities are mostly unreachable from the touch UI.** `InputSender` and the Rust dispatcher fully support scrolling, explicit clicks with multi-click counts, right/middle buttons, and free-text/keystroke typing — but `ViewerScreen.tsx` never calls `scroll()`, `click()`, `keyDown()`, `keyUp()`, or `text()`. The only things a user can actually do are: drag-emulated-as-left-click-and-move, and tap nine fixed shortcut buttons. This is not a "missing feature" so much as **already-built functionality left unwired**, which is squarely in scope for "perfect what exists."
2. **Coordinate mapping is architecturally incapable of being correct.** The video is rendered with `objectFit="contain"` (letterboxed), but touch coordinates are normalized against the _full view bounds_, not the letterboxed content rect — and the protocol has no field anywhere that tells the phone the source display's aspect ratio, so even a rewrite of `ViewerScreen.tsx` alone cannot fix this without a protocol change.
3. **The transport and gesture-recognition choices actively fight the latency budget.** The DataChannel uses default reliable+ordered SCTP for a stream that is mostly disposable (pointer moves), and gesture recognition runs on the JS thread via the legacy `PanResponder` API even though `react-native-gesture-handler` — a native-thread, multi-touch recognizer — is already a declared dependency and simply unused.

None of this is visible in a LAN demo with a lucky aspect-ratio match and a calm network; all of it will be visible the first time this ships to a Parsec/AnyDesk-caliber user on a real network with a real MacBook display next to a real phone screen.

---

## Finding 1 — Touch coordinates are normalized against the view, not the letterboxed video content

### Current implementation (cite file:line)

`apps/mobile/src/screens/ViewerScreen.tsx:61-63` records the _container_ layout size:

```ts
const onLayout = (e: LayoutChangeEvent) => {
  layout.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
};
```

`apps/mobile/src/screens/ViewerScreen.tsx:72-89` normalizes every touch directly against that container size:

```ts
inp.pointerDown(clamp01(locationX / layout.current.w), clamp01(locationY / layout.current.h));
```

The video itself is rendered at `apps/mobile/src/screens/ViewerScreen.tsx:103` with `objectFit="contain"`, i.e. letterboxed/pillarboxed whenever the source aspect ratio differs from the container's. Nowhere in `packages/protocol/src/signaling.ts` (checked for any `width`/`height`/`resolution`/`aspect` field) or elsewhere in the protocol package is the desktop's capture resolution or aspect ratio ever communicated to the phone. On the desktop side, `apps/desktop/src-tauri/src/input/macos.rs:76-80` maps the normalized coordinate straight onto `CGDisplay::main().bounds()`:

```rust
fn screen_point(&self, x: f64, y: f64) -> CGPoint {
    let bounds = CGDisplay::main().bounds();
    CGPoint::new(bounds.size.width * x, bounds.size.height * y)
}
```

### Problems

Whenever the Mac's display aspect ratio differs from the phone viewport's aspect ratio (the common case — a 16:10 MacBook display vs. a 19.5:9 phone in portrait, or even landscape), `objectFit="contain"` letterboxes the picture: the actual video occupies a _sub-rectangle_ of the container, centered, with black bars on two sides. `locationX/layout.current.w` divides by the full container width, so:

- Touches inside the letterbox bars are normalized to values that land _inside_ the visible screen on the Mac, i.e. taps on black space produce real clicks somewhere on the desktop.
- Touches on real video content are normalized incorrectly proportional to the wrong denominator, i.e. the mapped point is offset and scaled wrong — a tap on an on-screen button will land near it only by coincidence.
  This is the single most visible defect a real user will hit in the first ten seconds of any session where the two devices' aspect ratios don't match, which in practice is nearly always. It undermines "indistinguishable from touching the Mac directly" more than any other finding in this report.

### Root cause

Two independent gaps compound: (a) the mobile view-layer never computes the letterboxed content rect that `objectFit="contain"` actually renders into, and (b) the wire protocol never carries the information (source aspect ratio / resolution) needed to compute it even if the mobile code tried.

### Redesign

1. Add a `frame-size` (or extend `session-start`/renegotiation) signaling message carrying the desktop's current capture resolution (width/height in pixels) whenever the encoder pipeline starts or the display/resolution changes. `apps/desktop/src-tauri/src/media/capture/screencapturekit.rs:178-184` already resolves a concrete `display` and knows its dimensions at stream-start time — thread that value out through the existing signaling channel (mirroring how `session.rs` already surfaces peer/session events).
2. In `ViewerScreen.tsx`, replace the raw `layout.current` normalization with a small pure function `computeContentRect(containerW, containerH, videoW, videoH) -> {x, y, w, h}` implementing the standard "contain" fit math (`scale = min(containerW/videoW, containerH/videoH)`, then center). Recompute it whenever either the layout or the source resolution changes.
3. In the `PanResponder` handlers, clamp touches outside the content rect to a no-op (do not forward pointer events for touches that land in the letterbox bars at all), and remap in-bounds touches as `(locationX - contentRect.x) / contentRect.w`, `(locationY - contentRect.y) / contentRect.h`, still clamped 0..1.
4. Keep `screen_point` in `macos.rs:76-80` unchanged — it is correct _given_ correctly-normalized input; the bug is entirely upstream.

### Tradeoffs

Requires a (small, backward-compatible) protocol addition — the audit brief says "no new features," but this is a bug-fix payload addition to an existing signaling message, not a new user-facing capability, and there is no way to make coordinate mapping correct without it. Alternative: derive the video's intrinsic size from the `MediaStreamTrack`/`RTCView` at runtime instead of signaling it explicitly (some WebRTC bindings expose `track.getSettings().width/height` or a native `onLoadedMetadata`-equivalent) — cheaper to ship if `react-native-webrtc`'s `RTCView`/track surface supports it, but this repo does not currently invoke any such API, so it would need verification against the exact `react-native-webrtc@^124` API before committing to that path over explicit signaling.

### Implementation plan

1. Add `frameWidth`/`frameHeight` fields to the relevant signaling payload in `packages/protocol/src/signaling.ts` and bump handling on both mobile and desktop signaling clients.
2. Desktop: emit the value once at pipeline start and on any resolution change event already tracked by the ABR/encoder pipeline (`media/encoder`, `media/capture` — not read in full for this audit but referenced by `session.rs`).
3. Mobile: store `{videoW, videoH}` in `ViewerScreen` state, derive `contentRect` via `useMemo` keyed on `[layout, videoW, videoH]`, and rewrite the three `PanResponder` handlers to use it.
4. Add a `clamp01OrNull` helper that returns `null` for touches outside the content rect, and short-circuit those in all three handlers (grant/move/release) without sending any input event.

### Migration strategy

No wire-format break for existing clients if the new signaling field is additive/optional with a documented fallback (assume full-bleed 1:1 mapping, today's behavior, when absent) — an old phone build talking to a new desktop, or vice versa, degrades to current (broken) behavior rather than crashing. Ship desktop-side signaling first (dark launch, ignored by old clients), then ship the mobile consumer.

### Testing strategy

- Unit test `computeContentRect` with a matrix of container/video aspect ratios (portrait phone vs. landscape 16:10, 16:9, 21:9, ultrawide, matching aspect ratio as a no-op case).
- Manual/integration test: pair a phone in portrait against a MacBook's native 16:10 display and verify a tap on each corner of the menu bar and each corner of the Dock lands within a few pixels on the real cursor position (screenshot-diff or a simple on-screen crosshair overlay test harness).
- Regression test for the "touch in letterbox bar is dropped" behavior (synthetic touch event outside `contentRect` produces zero calls to `InputSender`).

### Risk assessment

Low risk to ship — it is purely corrective and the fallback path preserves current (already broken) behavior for mismatched client/server versions. The main risk is under-scoping the "resolution changed mid-session" case (e.g., the user changes desktop resolution or unplugs an external monitor); the redesign must re-signal on every actual change, not just at session start, or Finding 1 will resurface any time the source resolution changes after the phone has already latched onto a stale content rect.

### Performance impact

Negligible — one additional small signaling message per resolution change (not per frame), and one extra `useMemo` recomputation on layout/resolution change on the mobile side. No impact on the per-touch latency path.

### Future extensibility

Once resolution is known client-side, the same content-rect math is the natural foundation for supporting rotation (landscape capture mirrored to a portrait-locked phone, or vice versa) and for a future "fit to width" vs. "fit to screen" viewing-mode toggle, without further protocol changes.

---

## Finding 2 — Input DataChannel uses default reliable + ordered delivery for all event kinds, including disposable pointer-move traffic

### Current implementation (cite file:line)

`apps/desktop/src-tauri/src/rtc/mod.rs:153` creates the one and only input channel with no custom configuration:

```rust
let input_channel = pc.create_data_channel("lilypad-input", None).await?;
```

Passing `None` for the `RTCDataChannelInit` means webrtc-rs (matching the WebRTC spec's `RTCDataChannelInit` defaults) opens the channel `ordered: true` with no `maxRetransmits`/`maxPacketLifeTime` set — i.e. fully reliable, in-order SCTP delivery, identical to how you'd configure a channel carrying, say, a file transfer. Every input event kind — `pointer_move`, `pointer_down/up`, `key_down/up`, `scroll`, `shortcut`, `clipboard` — shares this single channel and its single ordering/reliability domain (`apps/mobile/src/lib/input.ts:16-68` sends everything through one `send` callback wired to this one channel in `apps/mobile/src/lib/webrtc.ts:121-131`).

The desktop dispatcher already assumes and defends against loss/reorder at the application layer: `apps/desktop/src-tauri/src/input/dispatcher.rs:98-107` rejects any event whose `ts` is not strictly greater than the last accepted `ts` for its `EventKey`, which is exactly the kind of staleness guard you need when a transport can deliver out-of-date data — but SCTP `ordered:true` already guarantees order, so the guard's only remaining live purpose is deduping literal resends, while the _cost_ of reliable delivery (retransmission-induced head-of-line blocking under loss) is paid on every event regardless.

### Problems

Under real internet conditions (which is the explicit target of this M2→M5 transition — "internet-first," not LAN-only), any SCTP packet loss on this channel forces the reliable, ordered stream to stall _all_ subsequent messages — including brand-new pointer-down/click/key events — until the lost packet is retransmitted and redelivered in order. This is classic head-of-line blocking, and it hits precisely the traffic (pointer moves, i.e. cursor tracking) that would be _harmless_ to just drop, since the dispatcher already discards anything superseded by a newer position. Worse, retransmitting a stale mouse-move batch (which the receiver will only discard once decoded, per Finding above) burns available bandwidth and channel-buffer time that a real click sitting behind it in the SCTP send queue needs to arrive within budget. The result is intermittent, congestion-correlated latency spikes exactly when responsiveness matters most, and it will show up as "the cursor feels laggy/stuttery on real Wi-Fi/cellular" — a classic Parsec/AnyDesk pain point this product needs to beat, not inherit.

### Root cause

The channel was set up with `None` (framework default) rather than a deliberate choice, and the system was validated on LAN, where loss is rare enough that reliable-ordered semantics rarely show their cost. There is also no architectural separation between "this data is disposable, only the latest matters" (moves, scroll deltas) and "this data must arrive and must arrive in order" (down/up, key events, shortcuts, clipboard).

### Redesign

Split input onto two DataChannels with different reliability profiles, both still labeled distinctly and created up-front (WebRTC supports multiple channels per PeerConnection at negligible extra cost):

- `lilypad-input-critical` — keep default ordered+reliable. Carries `pointer_down`, `pointer_up`, `click`, `key_down`, `key_up`, `text_input`, `shortcut`, `clipboard`. These are discrete, must-not-lose, must-not-reorder events (a lost key-up is a stuck key on the desktop).
- `lilypad-input-move` — `ordered: true` (cheap to keep, avoids introducing new reorder logic) but `maxRetransmits: 0` (unreliable — a lost or superseded batch is simply gone, no retransmit, no HOL blocking of anything). Carries only `pointer_move` and (once wired, see Finding 4) `scroll`.
  `InputSender` (`apps/mobile/src/lib/input.ts`) picks the channel per event kind in `enqueue`/`flush`; the desktop `WebRtcPeer` (`apps/desktop/src-tauri/src/rtc/mod.rs`) creates both channels and forwards both to the same `InputWorker`/`InputDispatcher` (which is already transport-agnostic — it only sees decoded `InputEvent`s, so no dispatcher change is required).

### Tradeoffs

Two channels means two open/close lifecycles to gate correctly (`InputChannelOpen`/`InputChannelClosed` handling in `session.rs` currently assumes one channel — needs to require _both_ channels open before flipping the injection gate, or accept critical-only and treat move-channel loss as degraded-but-safe). Unreliable delivery for moves means a burst of pure moves can be lost outright under heavy congestion with no compensating retransmission — acceptable because the _next_ move corrects the cursor position within one round trip, but it should be explicitly decided (and documented) as the acceptable tradeoff, not discovered later.

### Implementation plan

1. `rtc/mod.rs`: create a second `RTCDataChannelInit { ordered: Some(true), max_retransmits: Some(0), ..Default::default() }` channel; wire its `on_open`/`on_close`/`on_message` to new `PeerEvent` variants (or reuse existing ones tagged with channel identity).
2. `session.rs`: extend the `input_channel_open` bool (currently single, lines ~163, 340-348 per the gating logic already in place) to track both channels; gate `input.set_enabled(...)` on the conjunction (or, if product accepts degraded mode, on critical-channel-open alone).
3. `apps/mobile/src/lib/webrtc.ts`: listen for both channel labels in the `datachannel` handler (currently only matches `INPUT_CHANNEL_LABEL` at line 122); construct `InputSender` with two send callbacks.
4. `apps/mobile/src/lib/input.ts`: route `pointer_move` (and, post-Finding-4, `scroll`) through the move-channel callback, everything else through the critical-channel callback.

### Migration strategy

This is a protocol/transport change that must be versioned: an old mobile build only knows the single `lilypad-input` label. Ship the desktop side to keep creating the legacy single channel as a fallback when it detects (via a capability flag in the pairing/session-start handshake) that the peer is on an old protocol version; new mobile builds negotiate the two-channel mode. Bump `PROTOCOL_VERSION` in `packages/protocol/src/constants.ts:5` and gate the behavior on it.

### Testing strategy

- Network-impairment integration test (e.g. `tc netem` / Network Link Conditioner) injecting 2-5% loss and 100-300ms of jitter: measure end-to-end pointer-move-to-CGEvent latency percentiles before/after the split; expect p99 latency on critical events to stop correlating with move-channel loss.
- Existing `apps/desktop/src-tauri/tests/input_worker.rs` integration tests should be extended with a second-channel variant to confirm gating still requires both (or the agreed degraded policy) before injecting.
- Bench: extend `apps/desktop/src-tauri/examples/bench_input.rs` with a simulated-loss harness on the move path to confirm no backlog buildup.

### Risk assessment

Medium — this touches the WebRTC negotiation surface and the gating state machine in `session.rs`, both security/safety-critical (a gating bug here risks injecting input before approval, which is explicitly guarded against today at `session.rs:157-165`). Requires careful test coverage of the "one channel opens, the other doesn't" edge cases before shipping.

### Performance impact

Should measurably reduce input latency tail (p95/p99) under any real-world packet loss or congestion, at the cost of occasional visibly "skipped" cursor positions under heavy loss — which is strictly better than a frozen/laggy cursor for a direct-manipulation product.

### Future extensibility

The same critical/disposable split generalizes cleanly if future work adds continuous data (e.g. clipboard-image preview streams, or high-frequency scroll deltas) — new disposable streams join the unreliable channel, new must-not-lose control messages join the critical one, without re-litigating this decision per feature.

---

## Finding 3 — No path exists to type text or send individual keystrokes from the touch UI

### Current implementation (cite file:line)

`InputSender.text()` (`apps/mobile/src/lib/input.ts:62-64`) and `InputSender.keyDown()`/`keyUp()` (`apps/mobile/src/lib/input.ts:56-61`) are fully implemented, and the wire schema (`textInput` at `packages/protocol/src/input.ts:78-82`, `keyDown`/`keyUp` at lines 64-76) and the desktop injection path (`inject_text` in `apps/desktop/src-tauri/src/input/macos.rs:233-246`, `inject_keyboard` at lines 205-214) are complete and covered by tests (`apps/desktop/src-tauri/src/input/protocol.rs:163-176`, `dispatcher.rs` key-repeat test at lines 359-368). A repo-wide search confirms `.keyDown(`, `.keyUp(`, and `.text(` are never called anywhere in `apps/mobile/src/` outside their own definitions. The only UI surface for keyboard interaction is the nine fixed buttons in `TOOLBAR` (`apps/mobile/src/screens/ViewerScreen.tsx:22-32`), each of which fires a single `shortcut()` call (`ViewerScreen.tsx:123`) drawn from a fixed 14-item enum (`packages/protocol/src/input.ts:87-102`).

### Problems

A user cannot type a URL into Safari, a filename into a Finder rename field, a search query, a chat message, or literally any free text on the remote Mac. This is not a rough edge — it is a missing core capability for a remote-desktop _control_ product; every competitor (Parsec, Jump Desktop, AnyDesk, Chrome Remote Desktop) surfaces the device's native keyboard for exactly this. Given the backend is already built and tested end-to-end, this is the highest-leverage, lowest-risk fix available in this whole audit: it requires zero protocol or Rust changes, only mobile UI wiring.

### Root cause

The mobile UI was built out only far enough to prove the fixed-shortcut and pointer path for the M2 milestone; the general keyboard entry point into `InputSender` was left unconnected to any UI affordance.

### Redesign

Add a "show keyboard" affordance (e.g. a keyboard-glyph button alongside the existing toolbar) that focuses a normally-invisible, zero-size, `autoCorrect`/`autoComplete`-appropriate native `TextInput` positioned off-screen or with `opacity: 0`. Drive it exactly the way remote-desktop apps standardly do:

- `onKeyPress` (where available) or `onChangeText` diffing to forward individual physical keys for control keys (Backspace, Enter, arrows, Tab) via `keyDown`/`keyUp`.
- Use `onChangeText`'s _committed_ text (which is IME/autocorrect-safe, per the existing doc comment at `packages/protocol/src/input.ts:81`, `/** Committed text (IME/autocorrect friendly), typed as a unit. */`) to forward typed runs via `InputSender.text()`, clearing the native field after each commit so it never accumulates state that could leak between fields.
- Toggle the field's focus on/off with the keyboard-glyph button so the on-screen video isn't permanently obstructed by the OS keyboard.

### Tradeoffs

A hidden `TextInput` approach is the standard, low-risk technique (used by essentially every mobile RDP client) but has known rough edges: autocorrect/autocapitalize suggestions bleeding into `onChangeText`, and needing to reset `value` after each commit to avoid an ever-growing buffer. These are solvable with standard `TextInput` props (`autoCorrect={false}`, `autoCapitalize="none"`, `spellCheck={false}`) and are a well-trodden path, not a research problem.

### Implementation plan

1. Add a controlled, invisible `TextInput` to `ViewerScreen.tsx`, refed for imperative `.focus()`.
2. Add a keyboard toggle button to the existing toolbar row (same `Pressable`/`styles.key` pattern already used at `ViewerScreen.tsx:120-126`).
3. Wire `onKeyPress`/`onChangeText` to `inp.text()` for committed runs and `inp.keyDown()`/`keyUp()` for control keys (Backspace/Enter/arrows) not otherwise reachable as printable text.
4. Confirm the existing `Enter`/`Tab`/arrow entries already in `TOOLBAR` (`ViewerScreen.tsx:26-31`) remain as quick-access buttons even once general typing works, since they're useful without opening the keyboard.

### Migration strategy

Purely additive UI; no protocol change, no version gate needed — the desktop side already accepts and correctly injects `text_input`/`key_down`/`key_up` today (proven by existing tests), so this can ship independently and immediately benefit any already-deployed desktop build.

### Testing strategy

- Manual test: type an emoji, an accented character (composed via iOS's press-and-hold accent picker), and a long paste-like fast burst of text into a real text field on the Mac (e.g. TextEdit) and confirm exact fidelity.
- Unit test the `onChangeText` diffing logic in isolation (given a sequence of intermediate autocorrect-mutated strings, verify only the final committed text is sent, not every intermediate keystroke-level mutation).
- Add an end-to-end test asserting `InputSender.text()` is invoked with the expected string when the hidden field commits.

### Risk assessment

Low — this is additive, uses a battle-tested RN pattern, and the receiving end is already tested. The only real risk is UX polish (keyboard toggle discoverability, avoiding the OS keyboard obscuring the video), not correctness or safety.

### Performance impact

Negligible — text commits are infrequent, human-paced events, already on the "immediate flush" (non-coalesced) path in `InputSender` (`input.ts:63`), which is correct for this data.

### Future extensibility

Once a real keyboard entry point exists, IME composition events (for CJK input) and clipboard-paste-as-text-input become natural incremental additions on the same hidden-`TextInput` foundation — worth flagging for the M4/M5 backlog even though out of scope here.

---

## Finding 4 — No scroll gesture exists in the touch UI

### Current implementation (cite file:line)

`InputSender.scroll()` (`apps/mobile/src/lib/input.ts:53-55`), the `scroll` wire schema (`packages/protocol/src/input.ts:55-62`), `ScrollAction`/`inject_scroll` on the desktop (`apps/desktop/src-tauri/src/input/mod.rs:52-58`, `apps/desktop/src-tauri/src/input/macos.rs:216-231`) are all implemented and tested (`dispatcher.rs` mock-backend `Call::Scroll` coverage). `ViewerScreen.tsx`'s `PanResponder` (lines 67-92) only ever recognizes a single-touch drag and calls `pointerDown`/`pointerMove`/`pointerUp`; `.scroll(` has zero call sites in `apps/mobile/src/`.

### Problems

There is no way to scroll a webpage, document, or list on the remote Mac other than repeatedly tapping the fixed arrow-key toolbar buttons (`ViewerScreen.tsx:26-31`), which move a text-caret/selection, not a scrollable view, in most apps — i.e. for practical purposes, **scrolling does not work at all**. This is a baseline expectation for any remote-desktop control surface.

### Root cause

Same as Finding 3: the receiving stack was built out fully, but no gesture recognizer was ever added to the touch surface to produce `scroll` events (specifically, no two-finger-touch handling exists at all — `PanResponder`'s single active-touch model as used here has no notion of a second simultaneous touch, see Finding 6).

### Redesign

Add a two-finger-touch scroll recognizer (see Finding 6 for the recommended `react-native-gesture-handler` `Pan`/native two-pointer detection) that, while exactly two touches are active and moving together, computes a per-frame `(dx, dy)` delta (in the same normalized/CSS-pixel convention already documented at `packages/protocol/src/input.ts:59`) and calls `inp.scroll(x, y, dx, dy)` with `x,y` at the two-finger centroid. Route the resulting event through the coalescing path described in Finding 11 rather than flushing immediately.

### Tradeoffs

Two-finger scroll and the existing single-finger drag-as-cursor-move must be mutually exclusive and cleanly disambiguated (starting with one finger, then adding a second, must not have already committed to a drag) — this requires the multi-touch-aware recognizer from Finding 6 rather than a small patch to `PanResponder`, so this finding's real implementation cost is coupled to that migration.

### Implementation plan

1. Land the `react-native-gesture-handler` migration (Finding 6) first — it is the multi-touch prerequisite.
2. Add a `Pan` (or two-pointer-specific) gesture configured for `minPointers: 2, maxPointers: 2`, mutually exclusive (`simultaneousWithExternalGesture`/`Exclusive` grouping) against the single-finger cursor-drag gesture.
3. Accumulate per-frame deltas and forward via `inp.scroll(...)`.
4. Consider an explicit "scroll" visual affordance (e.g. a two-finger-drag hint on first use) since it's not discoverable without prior remote-desktop-app experience.

### Migration strategy

No protocol change required (schema already supports it) — purely additive mobile UI work, safely shippable independent of any desktop change once Finding 6's gesture-handler foundation lands.

### Testing strategy

- Unit-test the delta-accumulation math against synthetic two-touch move sequences.
- Manual test: scroll a long Safari page and a Finder list; verify direction matches user expectation (see the sign-convention note under Finding 12) and there's no accidental single-finger-drag interference when lifting one of two fingers.

### Risk assessment

Low-medium — gated by the gesture-handler migration's own risk (Finding 6); the scroll math itself is straightforward once multi-touch events are available.

### Performance impact

Should be coalesced (Finding 11) to avoid channel flooding; with that in place, negligible.

### Future extensibility

The same two-finger primitive is the natural basis for a later pinch-to-zoom gesture (already flagged as explicitly out of the touch-interpretation matrix today — see Finding 7) if the product ever wants it.

---

## Finding 5 — No right-click, no middle-click, and no modifier-chorded clicks/drags are reachable — and the protocol has nowhere to put modifiers on pointer events even if a gesture existed

### Current implementation (cite file:line)

`PointerButton` supports `left | right | middle` end-to-end (`packages/protocol/src/input.ts:19-20`, `apps/desktop/src-tauri/src/input/protocol.rs:8-14`, full `CGEventType`/`CGMouseButton` mapping in `apps/desktop/src-tauri/src/input/macos.rs:93-108`). But every mobile call site defaults or hardcodes `'left'`: `pointerDown`/`pointerUp`/`click` in `input.ts:44-52` all take `button: PointerButton = 'left'` and `ViewerScreen.tsx:76,82,88` never pass anything else. Separately, the wire schema for `pointer_down`, `pointer_up`, `click`, and `scroll` (`packages/protocol/src/input.ts:32-62`) has **no `modifiers` field at all** — only `keyDown`/`keyUp` carry `modifiers` (lines 64-76). The same asymmetry exists in the Rust mirror: `MouseAction`/`ScrollAction` (`apps/desktop/src-tauri/src/input/mod.rs:30-58`) carry no modifier information, and `inject_mouse`/`inject_scroll` in `macos.rs` never call `.set_flags(...)` on the mouse/scroll `CGEvent` (contrast with `inject_keyboard` at `macos.rs:205-214`, which does call `event.set_flags(Self::modifier_flags(&action.modifiers))` at line 211).

### Problems

Two independent, compounding gaps: (1) there is no gesture in the UI that produces a right-click or middle-click at all (no long-press, no two-finger tap), and (2) even if one existed, and even if the user pre-holds a modifier via `keyDown`, the _click itself_ carries no modifier metadata in the protocol, so building "Cmd-click to open in new tab," "Shift-click to range-select," or "Option-drag to duplicate" cleanly is impossible without a schema change. (A workaround of sending a real `key_down` for the modifier immediately before a click may work by relying on macOS's live global modifier-flag state at the HID layer, but the current UI provides no affordance to hold a modifier during a gesture at all, so this is moot in practice.) Right-click in particular is a hard blocker for basic macOS workflows (context menus are everywhere), making this one of the more consequential gaps in this report.

### Root cause

The touch surface was built out only as far as "one-finger drag = left button," and the wire schema was designed with keyboard-modifiers as a keyboard-only concept, without anticipating that mouse gestures need the same metadata.

### Redesign

1. Add `modifiers: Modifier[] = []` to the `pointer_down`, `pointer_up`, and `click` schemas in `packages/protocol/src/input.ts` (mirrored in `protocol.rs`'s `PointerDown`/`PointerUp`/`Click` variants), and thread it through `MouseAction::Down/Up/Click/Drag` into a `.set_flags(Self::modifier_flags(&modifiers))` call added to `post_mouse`/the click loop in `macos.rs`.
2. Add a long-press recognizer (via the Finding-6 gesture-handler migration) that, on a sustained single-finger press past a ~400-500ms threshold with minimal movement, emits a right-click (`click(x, y, 'right', 1)`) instead of a drag-start — this is the standard mobile-RDP convention for context menus.
3. Expose a small set of "sticky modifier" toggle keys in the toolbar (Shift/Cmd/Option/Ctrl, alongside the existing Copy/Paste/Esc row) that, when active, get included in the `modifiers` array of the _next_ pointer gesture (down through up), then auto-clear — giving Shift-click and Cmd-click a discoverable UI affordance without needing a physical modifier key.

### Tradeoffs

This is the one finding in this report that most resembles "new feature" (a sticky-modifier toggle UI is new UI, not just wiring existing plumbing) — flagged accordingly for explicit product sign-off, since the brief calls for perfecting what exists rather than adding UI. If sign-off is withheld, the schema fix (item 1) should still land on its own, since it's cheap corrective work that other gestures reaching this code path (e.g. a future long-press) will immediately benefit from.

### Implementation plan

1. Schema + Rust plumbing changes (item 1) — bump `PROTOCOL_VERSION`.
2. Long-press-to-right-click recognizer, gated behind the gesture-handler migration.
3. (Pending product sign-off) sticky-modifier toolbar affordance.

### Migration strategy

Additive optional field with a default of `[]`/absent — old clients omitting `modifiers` continue to behave exactly as today (no regression), matching the existing pattern already used for `button`/`count` defaults in this same schema (`packages/protocol/src/input.ts:36,43,52` all use `.default(...)`).

### Testing strategy

- Rust unit test asserting a `Click` with `modifiers: [Meta]` produces a `CGEvent` with `CGEventFlagCommand` set (extend the existing `MockBackend` call-recording pattern in `dispatcher.rs`'s test module to capture flags, currently only capturing `{action:?}` debug strings which do include modifiers if threaded through — verify the `Debug` format actually surfaces them once added).
- Manual test: Cmd-click a link in Safari to confirm it opens in a new tab; long-press an icon in Finder to confirm the context menu appears.

### Risk assessment

Medium for the schema change (touches every mouse-event code path across three languages/layers); low for the long-press recognizer once gesture-handler is in place.

### Performance impact

Negligible — modifiers are a small, infrequently-populated array already proven cheap in the keyboard path.

### Future extensibility

Once mouse-event modifiers exist, they compose naturally with the two-finger-scroll (Finding 4) for a future "Shift-scroll = horizontal scroll" convention, matching native trackpad behavior, without further schema changes.

---

## Finding 6 — Touch recognition runs on the legacy `PanResponder` (JS thread), while `react-native-gesture-handler` is already a dependency and unused

### Current implementation (cite file:line)

`ViewerScreen.tsx:67-92` builds all touch handling via React Native's built-in `PanResponder.create(...)`. `apps/mobile/package.json:21` declares `"react-native-gesture-handler": "2.21.2"` as a dependency, but a repository-wide search finds zero imports of it and zero uses of `GestureHandlerRootView` anywhere under `apps/mobile/src/`.

### Problems

`PanResponder` gesture recognition executes on the JavaScript thread via the bridge, which means: (a) it is inherently single-active-touch in its `nativeEvent.locationX/Y` model as used here (no multi-touch primitive, blocking Findings 4 and part of 5/9), and (b) recognition latency is coupled to JS-thread health — any concurrent JS work (React re-renders, GC pauses, navigation transitions) can delay delivery of touch events to the point where the "touch to `CGEvent`" latency budget quietly balloons under load, which is exactly the kind of jank a trackpad-grade product cannot tolerate. `react-native-gesture-handler` exists specifically to solve both problems (native-thread gesture recognition, first-class multi-touch/simultaneous-gesture APIs) and is already paid for in bundle size as a dependency, yet delivers none of its value today.

### Root cause

Likely an artifact of an earlier, simpler M2 prototype (single-finger cursor emulation) that was never revisited once the dependency was added for planned but unimplemented gesture work.

### Redesign

Replace the `PanResponder` in `ViewerScreen.tsx` with `react-native-gesture-handler` primitives: a `Pan` gesture (`minPointers: 1, maxPointers: 1`) for cursor move/drag exactly mirroring today's `onPanResponderGrant/Move/Release` semantics, composed via `Gesture.Exclusive`/`Race` with the two-finger scroll `Pan` from Finding 4 and the long-press-to-right-click gesture from Finding 5, all defined declaratively with `Gesture.Simultaneous`/`Exclusive` composition instead of ad hoc boolean flags. Wrap the app root in `GestureHandlerRootView` (required setup, currently entirely absent) in `apps/mobile/src/main.tsx` (or wherever the RN root is registered — confirm actual root file at migration time).

### Tradeoffs

This is the largest single refactor in this report (touches the entire touch-input surface of `ViewerScreen.tsx`) and is a prerequisite for Findings 4, 5's long-press, and 9's touch-radius-based palm rejection (gesture-handler exposes richer per-touch metadata than `PanResponder`). It should be sequenced first among the mobile-UI findings, since 4/5/9 are most cleanly implemented on top of it rather than bolted onto the legacy API and then re-migrated.

### Implementation plan

1. Add `GestureHandlerRootView` at the app root (one-time setup step gesture-handler requires).
2. Reimplement the existing single-finger drag as a `Gesture.Pan()` with `.minPointers(1).maxPointers(1)`, preserving today's `onBegin`/`onUpdate`/`onEnd` → `pointerDown`/`pointerMove`/`pointerUp` mapping exactly, so this step alone is a behavior-preserving refactor validated against existing manual test flows before any new gesture is layered on.
3. Layer in two-finger scroll, long-press-right-click, and (if pursued) touch-radius palm rejection as additional composed gestures.

### Migration strategy

Purely a mobile-app-internal refactor; no protocol or desktop change, no version gate needed. Should be validated behind a quick manual smoke test of the existing LAN pair-connect-drag-click flow before layering any new gesture on top, to isolate "migration regressed something" from "new gesture has a bug."

### Testing strategy

- Behavior-preserving-refactor check: record the exact sequence of `InputSender` calls produced by a fixed scripted touch sequence before and after the migration (e.g. via a test double substituted for the `send` callback) and diff them — should be byte-identical for the single-finger-drag path.
- Add a lightweight latency probe (timestamp at native touch delivery vs. timestamp when `InputSender` enqueues) to quantify the JS-thread-jitter improvement empirically, rather than asserting it only qualitatively.

### Risk assessment

Medium — largest blast radius of any finding in this report (rewrites the entire touch handling surface), but bounded because the target library is already a project dependency (implying it was vetted for inclusion already) and the migration can be validated stepwise (preserve existing behavior first, then add new gestures).

### Performance impact

Expected to reduce touch-to-network-send latency variance under concurrent JS load; the single biggest latency-budget win available in this codebase, per the audit's own "input latency budget (touch to CGEvent)" mandate.

### Future extensibility

This migration is the load-bearing prerequisite for essentially every other gesture-related finding in this report (4, 5, 9) and for any future pinch/rotate gesture — it should be treated as the foundation, not one improvement among many.

---

## Finding 7 — Direct 1:1 absolute touch-to-screen mapping has no precision assistance (no accel curve, no settle/deadzone, no hover-preview)

### Current implementation (cite file:line)

`ViewerScreen.tsx:72-77` fires `pointerDown` on the very first touch-contact (`onPanResponderGrant`), immediately pressing the (left) mouse button at whatever raw coordinate the finger first lands on; `apps/desktop/src-tauri/src/input/macos.rs:76-80` maps normalized coordinates linearly (`bounds.size.width * x`) with no curve, offset, or smoothing of any kind. There is no code path anywhere in the audited files that inserts a deadzone, a non-linear gain curve, or a "hover without pressing" state — first contact is always, immediately, a button-down.

### Problems

A finger's contact patch is roughly 8-10mm across; on a modern MacBook display that patch can cover many dozens of logical pixels' worth of remote screen real-estate once mapped through a typical phone-screen-to-laptop-screen size ratio. Combined with Finding 1's coordinate error, this makes precisely clicking small UI targets (menu items, close buttons, scrollbar thumbs) and precisely dragging to select a specific word of text (explicitly called out in this audit's scope) unreliable by construction, independent of any bug — it is an inherent property of committing to a click at the exact raw first-touch coordinate with no correction. Real trackpads solve an analogous problem with pointer-acceleration curves (relative movement, non-linear gain); this product's _absolute_, direct-touch design (a deliberate, reasonable choice for "feels like touching the Mac directly") cannot use a relative-motion accel curve, but currently has literally none of the mitigations that touch-based remote-desktop products typically apply for absolute pointing (e.g. a brief high-precision "settle" window after touch-down before committing to a click, allowing a small correction drag before the button truly goes down).

### Root cause

The direct-touch interaction model was implemented in its simplest possible form (touch coordinate == click coordinate, unconditionally, on first contact) with no allowance for human finger imprecision.

### Redesign

Within the existing absolute-touch paradigm (explicitly not proposing a new relative/trackpad mode, which would cross into new-feature territory and needs explicit product sign-off — noted as a future option below, not a redesign recommendation here): introduce a short (~60-80ms) "settle" window on `onPanResponderGrant`/gesture `.onBegin` during which the touch is tracked but no `pointerDown` is sent yet; if the finger moves beyond a small threshold (a few points) within that window, treat it as the start of a drag/move rather than a click-in-place and send `pointerDown` at the settled (not first-contact) position; if it stays within threshold, send `pointerDown` at the average/settled position once the window elapses or the finger lifts, whichever is first. This reduces the "first-contact jitter" component of misclicks without changing the fundamental interaction model.

### Tradeoffs

Any settle delay trades a small, fixed amount of added latency (tens of ms) for improved click precision — for a product whose stated goal is indistinguishable-from-native feel, this tradeoff needs explicit UX validation (a 60-80ms hold-before-commit may itself feel laggy to power users) rather than being shipped on judgment alone. A full relative/trackpad mode toggle (industry standard in Parsec/Jump Desktop for exactly this precision problem) is flagged here as the more complete fix but is explicitly out of scope per "no new features" and should be raised with product as a follow-up decision, not silently implemented.

### Implementation plan

1. Land alongside the Finding-6 gesture-handler migration (natural place to add an `.onBegin`-relative settle timer without fighting `PanResponder`'s coarser API).
2. Add a small configurable constant (e.g. `TOUCH_SETTLE_MS`, `TOUCH_SETTLE_RADIUS_PX`) near the existing `POINTER_COALESCE_MS` constant for consistency (`packages/protocol/src/constants.ts:23`).
3. A/B or manually tune the two constants against real precision-clicking tasks (e.g. clicking a 16px window-close button) before finalizing defaults.

### Migration strategy

Purely mobile-UI-internal; no protocol or desktop change.

### Testing strategy

- Manual precision test: click a fixed-size small target (e.g. a 16x16px button rendered in a test HTML page on the Mac) N times with and without the settle window, measuring hit rate.
- Unit test the settle-vs-drag decision boundary given synthetic touch-move sequences crossing/not-crossing the threshold within the window.

### Risk assessment

Low — self-contained, tunable, and reversible via constant changes; the main risk is choosing settle parameters that feel laggy rather than precise, which is a tuning risk, not a correctness risk.

### Performance impact

Adds a fixed, small (tens-of-ms), configurable latency to the _first_ touch-down of each gesture only; move/up remain immediate.

### Future extensibility

This finding's "future option" (a relative/trackpad pointing mode) would also address hover-preview (moving a cursor without committing a click) and is a natural M4/M5 product discussion once this audit is delivered — noted here for completeness per the audit's explicit ask about "cursor acceleration curves" and "hover emulation," even though the direct redesign recommendation stays in-paradigm.

---

## Finding 8 — Event ordering/staleness uses the phone's wall-clock `Date.now()`, not a monotonic sequence

### Current implementation (cite file:line)

Every mobile-side event is timestamped via `Date.now()` (`apps/mobile/src/lib/input.ts:42,45,48,51,54,57,60,63,66`). The desktop dispatcher uses that same value as the sole ordering/staleness discriminant: `apps/desktop/src-tauri/src/input/dispatcher.rs:98-107` rejects any event whose `ts` is not strictly greater than the last accepted `ts` for its `EventKey` (`last_ts: HashMap<EventKey, u64>` at line 51), which is the mechanism validated by the `drops_stale_and_duplicate_events_by_timestamp` test (lines 343-356). There is no separate monotonic sequence number anywhere in the schema (`packages/protocol/src/input.ts`'s `WithTs` at lines 16-17 defines only `ts`).

### Problems

`Date.now()` is wall-clock time, not monotonic — it can and does step backward on real devices (NTP time-sync correction, manual clock changes, and in some OS/runtime combinations, resuming from background/sleep can coincide with a clock resync). If the phone's clock steps backward mid-session, every subsequent event of each affected `EventKey` (e.g. every future `pointer_move`, since `EventKey::Pointer` is a single shared key for all moves per `dispatcher.rs:21,28`) will have a `ts` less than or equal to the last accepted one and will be **permanently and silently dropped** as stale for the rest of that session (there is no self-healing — the guard only compares against the _last accepted_ value, which no longer advances once the stream is stuck below it, except for the fluke case where wall-clock time eventually climbs back past the pre-jump high-water mark). This is precisely the kind of long-tail production bug that never appears in a quick demo and then appears as "control just silently stopped working" in the field, with no obvious cause from the user's side.

### Root cause

Using a single 63-bit field to serve two different purposes — "when did this happen" (a latency/telemetry concern, naturally wall-clock) and "is this newer than the last one" (an ordering concern, which needs monotonicity) — and picking wall-clock for both.

### Redesign

Add a monotonically increasing per-session `seq: number` field (a simple incrementing counter starting at 0/1 per `InputSender` instance, i.e. per session) alongside the existing `ts`, and switch the dispatcher's staleness/ordering guard (`dispatcher.rs:98-107`) to compare `seq` instead of `ts`. Keep `ts` exactly as-is for its legitimate purpose (latency measurement, logging, any future telemetry), but stop using it for correctness-critical ordering decisions.

### Tradeoffs

A per-session counter must reset cleanly on reconnect (a new `InputSender`/dispatcher pairing per session already exists naturally, per `InputWorker::spawn()`'s lifecycle — verify at implementation time whether a reconnect reuses or recreates the dispatcher instance, since `last_ts`/a future `last_seq` map must be reset in lockstep with the counter restarting from 0, or the dispatcher will reject an entire new session's worth of events as "stale" relative to the old session's counter).

### Implementation plan

1. Add `seq: z.number().int().nonnegative()` to `WithTs` (or a sibling `WithSeq`) in `packages/protocol/src/input.ts`, and a matching field to every Rust `InputEvent` variant in `protocol.rs`.
2. `InputSender` maintains a private incrementing counter, stamping every enqueued event.
3. `dispatcher.rs`: replace the `ts`-keyed `last_ts` staleness check with a `seq`-keyed one; keep `ts` untouched everywhere else (metrics, logging).
4. Audit `InputWorker`/dispatcher construction (`worker.rs:37-48`, `session.rs:161`) to confirm the dispatcher (and therefore `last_ts`/`last_seq`) is recreated fresh per session/reconnect, not reused across reconnects with a stale high-water mark.

### Migration strategy

Additive field with a safe fallback: if `seq` is absent (old client), fall back to today's `ts`-based comparison (accept the pre-existing risk rather than breaking old clients) — gate the new codepath on `PROTOCOL_VERSION` or field presence.

### Testing strategy

- Unit test: simulate a clock step backward mid-stream (construct events with `ts` that decreases but `seq` that keeps increasing) and assert the dispatcher continues accepting/injecting via `seq`, where today's `ts`-only logic would (and should, as a regression test) show the drop.
- Extend the existing `drops_stale_and_duplicate_events_by_timestamp` test (`dispatcher.rs:343-356`) with a sibling test using the new field.

### Risk assessment

Low-medium — narrow, well-isolated change to a single comparison, but touches a security/correctness-relevant gate (the same mechanism also rejects literal replay attacks on the channel, so any change here must preserve that property — a monotonic per-session counter is at least as strong against replay as wall-clock, since replaying an old message reuses an old, already-seen `seq`).

### Performance impact

None — same O(1) hashmap comparison, just a different (more robust) source value.

### Future extensibility

A monotonic per-session sequence number is also the natural foundation for any future "resend on gap" reliability logic on the unreliable move channel proposed in Finding 2, since gaps become simply "seq jumped by more than 1," trivially detectable — whereas wall-clock gaps are not a reliable gap-detection signal at all.

---

## Finding 9 — No palm rejection / accidental-touch filtering

### Current implementation (cite file:line)

`ViewerScreen.tsx:70-71` sets `onStartShouldSetPanResponder: () => canControl` and `onMoveShouldSetPanResponder: () => canControl` — the _only_ gate on accepting a touch as a control gesture is whether the session has the `control` scope, with no consideration of touch size, touch count, or screen-edge origin.

### Problems

Any incidental contact while gripping the phone (a palm edge brushing the screen while holding the device in landscape for a wider mirrored view, a cheek during a call notification, etc.) is forwarded verbatim as a real `pointerDown`/drag on the remote desktop — potentially triggering unintended clicks, drags, or window moves on the controlled Mac. This is a well-known UX hazard for any touch-driven remote-control surface and is explicitly called out in this audit's scope.

### Root cause

No touch-quality signal (contact radius/force, where available; multi-touch arbitration; edge-exclusion zones) is consulted anywhere in the gesture-acceptance logic — it accepts every touch unconditionally.

### Redesign

Sequenced after the Finding-6 gesture-handler migration (which exposes richer per-touch data than `PanResponder`): (a) reject touches originating within a small margin (a few points) of the screen edges of the _phone's_ container view, a common heuristic since accidental grip contact overwhelmingly starts at the bezel/edge; (b) if the platform surfaces touch radius/force (iOS exposes `force` on touches; radius is less consistently available cross-platform), reject touches below a minimum registered contact size as likely non-intentional; (c) when a second touch arrives while a single-finger drag is already in progress and was not deliberately started as a two-finger gesture from the outset, treat the second touch as accidental and ignore it rather than reinterpreting the whole gesture.

### Tradeoffs

Any edge-exclusion margin risks rejecting legitimate intentional touches near the video's own edges (e.g., clicking something in the extreme corner of the remote screen) — the margin must be tuned small enough to only catch grip-contact, not user intent, and should probably be disabled or shrunk in portrait orientation where edge-hugging is less likely to be incidental grip contact.

### Implementation plan

1. Land after Finding 6's migration.
2. Add an edge-exclusion check in the gesture's `onBegin`/`shouldActivate` predicate.
3. If touch-force data is available and reliable enough on target devices (verify empirically — do not assume without testing on real hardware), add a minimum-force/radius threshold.
4. Add the "ignore late second touch during an in-progress single-finger drag" rule as part of the gesture composition (`Gesture.Exclusive`) from Finding 6.

### Migration strategy

Purely mobile-UI-internal, additive, and independently reversible via a feature flag/constant if the edge-margin heuristic proves too aggressive in the field.

### Testing strategy

- Manual test gripping the phone in landscape with a typical thumb/palm hold and confirming no accidental clicks register during a normal viewing session.
- Regression test that intentional taps/drags near (but not within) the exclusion margin still register correctly, to catch over-aggressive tuning.

### Risk assessment

Low — self-contained, tunable, and the "ignore late second touch" rule is a straightforward gesture-composition rule once Finding 6 lands.

### Performance impact

Negligible — a few extra cheap geometric checks per touch-start.

### Future extensibility

The same touch-quality-signal foundation would support a future "confirm before click" mode for accessibility/demo scenarios, if ever requested.

---

## Finding 10 — Double/triple-click has no explicit detection on the mobile side, and macOS injection never sets an explicit click-state on synthetic clicks

### Current implementation (cite file:line)

The `click` event schema explicitly models multi-click intent (`count: 1 | 2 | 3`, `packages/protocol/src/input.ts:46-53`, `apps/desktop/src-tauri/src/input/protocol.rs:75-83`), and `apps/desktop/src-tauri/src/input/macos.rs:188-201` implements it by looping `for _ in 0..count.max(1)` posting `count` independent down/up `CGEvent` pairs back-to-back with no explicit click-state field set on any of them (no call analogous to setting `kCGMouseEventClickState`, contrasted with the explicit `.set_flags(...)` calls used elsewhere in this same file for keyboard modifiers). Per Finding 3/5's broader "unreachable protocol surface" pattern, `InputSender.click()` (`apps/mobile/src/lib/input.ts:50-52`) is never called anywhere in `apps/mobile/src/` — a real double-tap on the phone today produces two independent `pointerDown`/`pointerUp` sequences (via `PanResponder`) with real elapsed wall-clock time between them, not a single `click(count: 2)` event.

### Problems

Two separable issues: (1) the `count`-based multi-click path is entirely dead code from the UI's perspective, so it has zero production validation despite having unit tests at the mock-backend level; and (2) whether double-tap-to-double-click _actually_ works today is left entirely to whatever heuristic macOS's WindowServer applies to two independently-timed, real down/up sequences with no explicit click-state signal from this app — a plausible-but-unverified assumption, and specifically the kind of behavior (does Finder register a double-click-to-open vs. two single clicks; does a rapid loop of `count:2`-style back-to-back clicks with near-zero inter-click spacing, if ever exercised via a future call site, get recognized as intentional by apps that check `NSEvent.clickCount`) that has literally zero test coverage today beyond "the mock backend recorded two Down/Up call pairs," which says nothing about real OS click-count semantics.

### Root cause

The `count` field and its desktop-side loop were built speculatively ahead of any UI path that would exercise it, and the desktop injection code never explicitly sets the OS-level click-state field that real applications actually query for double/triple-click behavior — it relies entirely on implicit, unverified WindowServer heuristics.

### Redesign

1. Since real double-tap is naturally expressed today as two independently-timed `pointerDown`/`pointerUp` pairs (which is _also_ how a real double-click physically happens on a real mouse), the pragmatic fix is to **verify and rely on** that natural path rather than build a separate `click(count:2)` sender — but this requires empirical validation (see Testing strategy) since it is currently unverified, not assumed-working.
2. Independently of (1), harden the existing `count`-based `Click` injection path (used by any future non-touch-tap caller, e.g. a hypothetical "force double-click" button) by explicitly setting the CGEvent's click-state integer field between each iteration of the loop in `macos.rs:192-199`, rather than relying purely on implicit OS timing heuristics, and insert a small explicit delay between synthesized click pairs matching typical human double-click cadence (tens of ms) rather than firing them at bare-loop speed.

### Tradeoffs

Explicitly setting click-state on synthetic events is more code and one more thing to get exactly right (the field's semantics are undocumented in Apple's public API beyond community reverse-engineering), but removes dependence on undocumented OS-heuristic behavior for a class of interaction (multi-click) that is otherwise completely unverified in this codebase.

### Implementation plan

1. Empirically test today's "two natural taps" path against Finder (rename vs. open) and note the actual observed behavior as a baseline (this alone may reveal it already works, in which case item 2 above becomes lower priority/backlog rather than urgent).
2. If gaps are found, add explicit click-state setting to the `Click` injection loop in `macos.rs` and a small inter-click delay.
3. Add a regression test harness that can only run on macOS with Accessibility granted (mirroring the existing `#[cfg(target_os = "macos")]` test patterns already in this codebase) asserting a real app's observed click count.

### Migration strategy

No protocol change required for item 1 (pure verification); item 2 is a desktop-internal implementation refinement with no wire-format impact.

### Testing strategy

- Manual, on real hardware: perform a real double-tap through the full phone→desktop pipeline against Finder and confirm rename-vs-open behaves as a real double-click would.
- If gaps found, add the explicit click-state fix and re-verify against the same manual scenario as an acceptance test (this class of OS-integration behavior is very difficult to meaningfully unit-test without a real WindowServer, so manual/QA verification is the appropriate primary testing strategy here, backed by whatever the mock-backend tests can assert about the call sequence).

### Risk assessment

Low — this finding is primarily about closing a verification gap; the redesign's code changes (if needed) are localized to one function in `macos.rs`.

### Performance impact

None to negligible (a possible small explicit inter-click delay in the rarely-used `count`-loop path only).

### Future extensibility

Verifying this path now avoids compounding uncertainty if/when a "force double-click" affordance or drag-and-drop-via-double-click-hold feature is ever added.

---

## Finding 11 — Scroll events bypass coalescing entirely, unlike pointer moves

### Current implementation (cite file:line)

`InputSender.scroll()` (`apps/mobile/src/lib/input.ts:53-55`) calls `this.enqueue({ kind: 'scroll', ... }, true)` — the `immediate: true` argument means every scroll event is flushed (sent over the DataChannel) individually, exactly like `pointerDown`/`click`/`keyDown` (all also `true`), in contrast to `pointerMove` (`input.ts:41-43`), which passes `false` and is batched behind the `POINTER_COALESCE_MS` (8ms, `packages/protocol/src/constants.ts:23`) timer in `enqueue`/`flush` (`input.ts:22-39`).

### Problems

Once a scroll gesture is wired up (Finding 4), a continuous two-finger-scroll drag would emit a `scroll` event on every touch-move callback — potentially matching or exceeding the phone's native touch-sampling rate (commonly 60-120Hz) — with each one becoming its own individual DataChannel `send()` call rather than being batched the way pointer moves already are. This directly contradicts the module's own stated design rule (`input.ts:12-14`, `packages/protocol/src/input.ts:7-11`: "pointer_move events are COALESCED... everything else flushes immediately") which implicitly assumes only _discrete_ events (down/up/key/shortcut) are in the "everything else" bucket — a _continuous_ stream like scroll was evidently not considered when that rule was written, and applying it unchanged produces exactly the kind of channel-flooding behavior the coalescing design was introduced to avoid for moves.

### Root cause

The coalescing decision (`immediate: true/false` per method) was made per-event-kind based on the mental model "moves are continuous, everything else is discrete," which was accurate for the protocol's implemented event kinds until `scroll` — a continuous-motion event kind — was added without revisiting that rule.

### Redesign

Change `InputSender.scroll()` to accumulate `dx`/`dy` deltas the same way `pointerMove` positions are batched, but with summation semantics rather than latest-wins: multiple `scroll` calls within one coalescing window should merge into a single `scroll` event carrying the _summed_ `dx`/`dy` (unlike pointer position, where only the latest matters, scroll deltas are cumulative and must not be dropped/overwritten, only combined), flushed on the same `POINTER_COALESCE_MS` cadence as moves.

### Tradeoffs

Summed-delta coalescing is a different merge strategy than the latest-wins semantics already used for moves, so it cannot reuse the exact same code path unchanged — it needs its own small accumulator, adding modest complexity to `InputSender` in exchange for avoiding channel flooding.

### Implementation plan

1. Add a `pendingScroll: { x, y, dx, dy } | null` accumulator field to `InputSender`.
2. Change `scroll()` to add incoming `dx/dy` into `pendingScroll` (using the latest `x,y` centroid) and arm the same coalescing timer used by moves if not already armed, rather than calling `enqueue(..., true)`.
3. On flush, emit the accumulated scroll event (if any) alongside any pending moves in the same batch.

### Migration strategy

Internal to `InputSender`; no wire-format change (the `scroll` event shape is unchanged, only its send cadence).

### Testing strategy

- Unit test: call `scroll()` multiple times within one coalescing window and assert exactly one `scroll` event is sent with the summed deltas, matching the existing move-coalescing tests' style (if any exist for `InputSender` — recommend adding, since none were observed in the audited files).
- Load test: simulate a sustained 120Hz scroll-delta stream and confirm DataChannel send count stays bounded near the coalescing rate rather than 1:1 with input samples.

### Risk assessment

Low — isolated to `InputSender`, no cross-language/protocol impact, straightforward to unit test.

### Performance impact

Directly reduces DataChannel message volume during scroll gestures from touch-sample-rate to the coalescing rate (~125Hz ceiling, same as moves), reducing overhead and (combined with Finding 2) avoiding unnecessary channel congestion.

### Future extensibility

The summed-delta accumulator pattern generalizes to any other future continuous-delta input kind without re-deriving the merge strategy.

---

## Finding 12 — macOS scroll injection uses discrete wheel events only; no scroll-phase/momentum signaling

### Current implementation (cite file:line)

`apps/desktop/src-tauri/src/input/macos.rs:216-231`:

```rust
fn inject_scroll(&mut self, action: ScrollAction) -> Result<()> {
    self.require_permission()?;
    let event = CGEvent::new_scroll_event(
        self.source()?,
        ScrollEventUnit::PIXEL,
        2,
        -(action.dy.round() as i32),
        -(action.dx.round() as i32),
        0,
    )
    .map_err(|_| anyhow::anyhow!("CGEventCreateScrollWheelEvent failed"))?;
    event.post(CGEventTapLocation::HID);
    Ok(())
}
```

This creates a single discrete pixel-unit scroll-wheel event per call, with no scroll-phase (`kCGScrollWheelEventScrollPhase`: Began/Changed/Ended) or momentum-phase (`kCGScrollWheelEventMomentumPhase`) fields set — those fields are not exposed at all in the `core-graphics` crate's `CGEvent::new_scroll_event` constructor used here, so setting them would require either a raw field-setter call (if the crate exposes `set_integer_value_field`/equivalent) or dropping to a lower-level FFI call.

### Problems

Real macOS trackpad scrolling is a continuous phased gesture (Began → repeated Changed → Ended, optionally followed by a synthetic Momentum phase as the OS decelerates the scroll after finger-lift) that many apps (Safari's rubber-band overscroll, Finder icon views, some Electron/Chromium-based apps) specifically listen for to drive their smooth/inertial scrolling and overscroll-bounce visuals. A stream of unphased discrete wheel events, even sent at high frequency, does not reliably trigger that inertial/rubber-band behavior in phase-aware apps — the practical symptom is scrolling that feels comparatively "steppy"/less fluid than a real trackpad, and no natural deceleration ("flick to scroll far") once the user lifts their finger, since momentum is normally synthesized by the OS/app in response to the momentum-phase signal that is never sent here. Additionally, the current implementation cannot itself produce any glide/deceleration after the input stream stops, since it only reacts to explicit incoming deltas — there is no kinetic/momentum simulation on either side of the pipe today.

### Root cause

The scroll injection was implemented using the simplest available `core-graphics` constructor (a discrete-event convenience API) without threading through phase state, likely because the mobile side (per Finding 4) doesn't produce a scroll gesture at all yet, so there has been no real gesture stream to validate feel against.

### Redesign

Two complementary pieces, best sequenced after Finding 4 lands (so there's a real gesture to validate against):

1. Thread explicit phase state through the pipeline: extend `ScrollAction` (`apps/desktop/src-tauri/src/input/mod.rs:52-58`) with a `phase: Began | Changed | Ended` (mirrored in the protocol schema, populated by the Finding-4 two-finger recognizer at gesture start/move/end), and set the corresponding CGEvent integer fields via whatever the `core-graphics` crate exposes for raw field access (verify exact API surface at implementation time — if unavailable, this may require a small `objc`/raw-FFI helper rather than the high-level constructor currently used).
2. On gesture end (`Ended` phase) with a nonzero recent velocity, synthesize a brief, decelerating sequence of `Momentum`-phase scroll events on the desktop side (a small local deceleration curve driven by the last observed velocity) so momentum scrolling works even though the _source_ touch stream stops the instant the finger lifts — this keeps the "kinetic feel" entirely server-side rather than requiring the phone to keep sending synthetic events after touch-up.

### Tradeoffs

Item 2 (synthesizing momentum) duplicates, on the desktop, a piece of physics (deceleration curve tuning) that the OS itself already does natively for real trackpad input — getting the curve to feel "native" will require iteration and is nontrivial polish work, not a mechanical wiring fix like most other findings in this report. If full parity proves too costly, phase-tagging alone (item 1, without item 2's synthesized momentum) is a smaller, still-valuable increment that at minimum lets phase-aware apps correctly start/stop their own overscroll-bounce animations.

### Implementation plan

1. Land after Finding 4 (real gesture stream to test against) and ideally after Finding 11 (coalescing) since phase transitions interact with batching (a `Began` must not get merged away if a `Changed` immediately follows within the same coalescing window).
2. Add phase to the schema/`ScrollAction`, populate `Began` on two-finger-touch-start, `Changed` on move, `Ended` on lift.
3. Investigate the exact `core-graphics` crate API for setting scroll-phase fields (or fall back to a small raw FFI shim) before committing to this design's feasibility.
4. Prototype momentum synthesis (item 2) as a separate, explicitly-flagged follow-up increment given its higher tuning cost.

### Migration strategy

Additive `ScrollAction`/schema field with a sensible default (treat absent phase as today's unphased discrete event, i.e. no regression for old clients).

### Testing strategy

- Manual A/B feel test in Safari (rubber-band overscroll at page top/bottom) and Finder icon view, comparing phased vs. unphased injection.
- Unit test that phase transitions are correctly derived from the two-finger gesture's begin/update/end callbacks (mobile side) once Finding 4 lands.

### Risk assessment

Medium — the momentum-synthesis half (item 2) is genuinely novel implementation work with real tuning risk (a bad deceleration curve reads as "broken," not just "unpolished"); the phase-tagging half (item 1) is comparatively low-risk plumbing once the crate's API surface is confirmed.

### Performance impact

Momentum synthesis (if pursued) requires a short-lived timer/animation loop on the desktop after gesture-end — bounded duration (typically well under a second), negligible resource cost.

### Future extensibility

Phase-aware scroll is also the correct foundation if the product ever wants true native trackpad forwarding (passing through a real trackpad's own phase/momentum data 1:1 from a future trackpad-equipped control surface) rather than synthesizing it from touch.

---

## Finding 13 — `held_buttons.iter().next()` picks an arbitrary button when synthesizing `Drag`

### Current implementation (cite file:line)

`apps/desktop/src-tauri/src/input/dispatcher.rs:137-144`:

```rust
InputEvent::PointerMove { x, y, .. } => {
    self.last_pointer_pos = (x, y);
    let action = match self.held_buttons.iter().next().copied() {
        Some(button) => MouseAction::Drag { x, y, button },
        None => MouseAction::Move { x, y },
    };
    self.backend.inject_mouse(action)
}
```

`held_buttons` is a `HashSet<PointerButton>` (field declared at line 48); `HashSet` iteration order in Rust is unspecified and not guaranteed stable across insertions/removals.

### Problems

If more than one button were ever concurrently held (not reachable today — the mobile UI's single-touch `PanResponder` never issues two concurrent `pointerDown`s for different buttons), the dispatcher would pick an unspecified one of them to represent the drag, which is a correctness landmine waiting for whichever future gesture (e.g. a deliberate two-button chord) first exercises this path.

### Root cause

`HashSet` was a convenient choice for "which buttons are currently held" but discards ordering information that matters the moment more than one button can be held (which button was pressed _first_, or _most recently_, are both more defensible semantics than "arbitrary").

### Redesign

Replace `held_buttons: HashSet<PointerButton>` with an insertion-ordered structure (e.g. a small `Vec<PointerButton>` with manual dedup-on-insert, or an `IndexSet` if a dependency for that is already present elsewhere in the workspace) and pick a documented, deterministic rule — most naturally "the most recently pressed still-held button drives the drag event type" (push to the back on down, remove on up, take `.last()`).

### Tradeoffs

Marginally more code than a `HashSet`, but the data structure here is tiny (at most 3 possible buttons) so there is no meaningful performance cost either way — this is purely a determinism/correctness fix, not a performance tradeoff.

### Implementation plan

1. Swap the field type and update the three call sites that mutate it (`dispatcher.rs:147,152,210`).
2. Document the chosen precedence rule directly in the field's doc comment.

### Migration strategy

Internal to the dispatcher; no protocol or cross-process impact.

### Testing strategy

Add a unit test alongside the existing `drag_emits_dragged_variant_while_button_held` test (`dispatcher.rs:370-383`) that holds two buttons down (in a known order) and asserts the `Drag` events consistently reflect the documented precedence rule, not just "some" button.

### Risk assessment

Low — small, isolated, currently-unreachable-in-practice code path; safe to fix opportunistically.

### Performance impact

None.

### Future extensibility

Removes a landmine that would otherwise resurface confusingly if multi-button chorded drag (e.g. a future "hold left+right for a special drag mode," seen in some 3D/CAD-oriented remote tools) is ever added.

---

## Finding 14 — Toolbar shortcut buttons have no press-and-hold repeat

### Current implementation (cite file:line)

`apps/mobile/src/screens/ViewerScreen.tsx:119-127` renders each `TOOLBAR` entry as a `Pressable` with a single `onPress` handler calling `connRef.current?.inputSender?.shortcut(k.action)` exactly once per tap; there is no `onLongPress`, no held-repeat timer, and the underlying `shortcut()` events (`ArrowUp/Down/Left/Right`, `Tab`, etc., `packages/protocol/src/input.ts:87-102`) are each single discrete down+up chords (`apply_shortcut`'s `chord` helper, `apps/desktop/src-tauri/src/input/dispatcher.rs:179-187`) with no `repeat` semantics wired from this call site at all (contrast with the `KeyDown`/`KeyUp` path's `repeat: bool` field, which exists in the schema but — per Finding 3 — is never populated as `true` by any current caller either).

### Problems

Holding down, say, the arrow-down toolbar button to move through a long list or scrub through a document does nothing beyond firing once — unlike a real held physical key, which the OS auto-repeats. This is a minor but noticeable polish gap for anyone using the toolbar for navigation-heavy tasks.

### Root cause

The toolbar was built as simple tap buttons without an auto-repeat affordance; this becomes largely moot once Finding 3's real keyboard entry point lands (arrow keys typed via a real hardware/software keyboard auto-repeat natively on the phone's OS keyboard, which would forward as repeated `key_down(repeat:true)` events if the hidden-`TextInput` approach's key handlers are wired to preserve native repeat), but the toolbar's fixed shortcut buttons are a separate, always-present affordance that won't inherit that fix for free.

### Redesign

Add a standard press-and-hold-repeat behavior to the toolbar `Pressable`s: on `onPressIn`, start a short initial delay (e.g. ~400ms) then a repeat interval (e.g. ~50-80ms) that re-fires `shortcut(k.action)` (or, better, the underlying `key_down(code, repeat:true)`/`key_up` pair for the arrow/Tab keys specifically, so the desktop sees proper repeat semantics rather than repeated discrete shortcut chords) until `onPressOut`.

### Tradeoffs

Only worth doing for keys where held-repeat is a meaningful, expected interaction (arrows, Tab, Backspace-equivalent) — applying it to `Copy`/`Paste`/`Save`/`Undo`/`Redo` would be actively harmful (repeated paste/undo on a long-press is a foot-gun), so the repeat behavior should be opt-in per toolbar entry, not blanket-applied to the whole `TOOLBAR` array.

### Implementation plan

1. Add an optional `repeatable: boolean` flag to the `TOOLBAR` entry type (`ViewerScreen.tsx:22`) and set it `true` only for the arrow keys/Tab.
2. Implement the press-in/hold-timer/press-out logic as a small reusable hook, applied conditionally per entry.

### Migration strategy

Purely mobile-UI-internal and additive; no protocol/desktop change needed if implemented via repeated `shortcut()` calls; a small desktop-side nicety if instead switched to real `key_down(repeat:true)` (already fully supported, per Finding 3's audit of the existing repeat-handling test at `dispatcher.rs:359-368`).

### Testing strategy

Manual test holding the arrow-down toolbar button in a long Finder list or document and confirming smooth continued navigation without needing repeated taps; unit test the hold-timer logic's start/repeat/stop transitions in isolation.

### Risk assessment

Low — small, isolated, opt-in per toolbar entry, easily reverted.

### Performance impact

Negligible — a bounded-rate timer only while a button is actively held.

### Future extensibility

None significant beyond what's already covered by Finding 3's general keyboard work, which is the more complete long-term answer for anything beyond these fixed toolbar shortcuts.

---

## Finding 15 — No DataChannel backpressure awareness on the mobile send path

### Current implementation (cite file:line)

`apps/mobile/src/lib/webrtc.ts:124-130`:

```ts
this.input = new InputSender((data) => {
  try {
    this.dataChannel?.send(data);
  } catch {
    /* channel not open */
  }
});
```

This is a synchronous, fire-and-forget `send()` with no check of `RTCDataChannel.bufferedAmount` (or a `bufferedamountlow` listener) before sending, and no application-level acknowledgment/backpressure signal from the desktop back to the phone. Separately, on the receiving end, `apps/desktop/src-tauri/src/input/worker.rs:88-98` only reports drops from its own local, post-SCTP, in-process channel (`QUEUE_CAPACITY: 256` at line 21) being full — it has no visibility into, and cannot reflect, congestion happening earlier in the SCTP send buffer on the phone side.

### Problems

Under sustained network congestion (especially relevant combined with Finding 2's reliable-ordered channel, where a stalled retransmission can back up the local SCTP send buffer), the mobile side has no way to know it is falling behind — it will keep calling `send()` at the same rate regardless of whether prior sends have actually left the buffer, and there is no signal anywhere in this codebase (mobile or desktop) that would let the app degrade gracefully (e.g., temporarily reduce pointer-move send rate, or surface a "control lagging" indicator to the user) under real congestion. The `InputWorker`'s own drop-counting (`events_dropped_invalid` on a full local channel, `worker.rs:93-96`) only reflects backpressure _after_ the network has already delivered the data and the OS-thread-side channel happens to be momentarily saturated — a different and much rarer condition than SCTP-level send-buffer congestion, so today's only "drop" metric materially under-reports the actual congestion scenario an internet-first product needs to detect and surface.

### Root cause

The send path was written for the LAN-first M2 prototype where SCTP buffer growth is not a realistic concern; no backpressure-aware send logic or telemetry was added when the product's scope moved to "internet-first."

### Redesign

1. Before each `send()`, check `dataChannel.bufferedAmount` against a small threshold (e.g. a few KB, tuned empirically); if over threshold, skip sending the current coalesced move/scroll batch outright (consistent with Findings 2/11's "moves are disposable" philosophy — the next batch will supersede it) rather than queuing indefinitely, and always still send discrete critical events (down/up/key/click) regardless of buffered amount, accepting the added latency as the lesser evil for must-not-lose events.
2. Register a `dataChannel.onbufferedamountlow` handler (with `bufferedAmountLowThreshold` set) to resume normal send behavior once the buffer drains, and consider surfacing a lightweight "control input lagging" UI indicator to the user if this state persists beyond a short window, so a real network problem is visible rather than silently degrading the feel of control.

### Tradeoffs

Deliberately dropping moves under backpressure (rather than queuing them) trades perfect fidelity for bounded latency — the correct tradeoff for a live-control product (a stale cursor position is worse than a slightly-behind but current one), consistent with the philosophy already established in Findings 2/11, but it is a product-visible behavior change (occasional visibly "chunky" cursor movement under bad networks) that should be communicated/tested as an explicit, intentional degradation mode rather than discovered as a surprise.

### Implementation plan

1. Add the `bufferedAmount` check and `onbufferedamountlow` handler to `ViewerConnection`'s data-channel setup in `webrtc.ts`.
2. Thread a "congested" boolean/callback out to `ViewerScreen` for an optional UI indicator (small, non-blocking — e.g. a badge similar to the existing connection-state badge at `ViewerScreen.tsx:112-114`).
3. Pair with Finding 2's channel split — the threshold policy differs meaningfully between the critical (never drop) and move (drop-when-congested) channels once they exist separately.

### Migration strategy

Mobile-internal, additive; no protocol change. Naturally sequenced after Finding 2 (channel split) since the drop-vs-never-drop policy is cleaner to express once critical and disposable traffic are on separate channels.

### Testing strategy

- Network-impairment test (same harness as Finding 2) confirming that under induced congestion, the mobile app measurably reduces its move-send rate (via `bufferedAmount` growth staying bounded) rather than growing an unbounded backlog.
- Manual test: verify discrete events (a click, a key press) still arrive and are injected promptly even while the move stream is being throttled by this logic.

### Risk assessment

Low-medium — read-only telemetry (`bufferedAmount`) plus a conditional skip is low risk in isolation, but should be validated together with Finding 2's channel split rather than independently, since the correct policy differs per channel.

### Performance impact

Prevents unbounded SCTP-buffer growth (a real risk of increasing rather than bounded latency over a session under sustained congestion) at the cost of visibly dropped intermediate cursor positions under those same conditions — a net latency-budget win for the product's stated goal.

### Future extensibility

The same `bufferedAmount`-aware pattern generalizes to any future high-frequency telemetry channel (e.g. a possible future audio/haptic-feedback channel) without re-deriving backpressure handling from scratch.

---

## Cross-Cutting Recommendations (Sequencing)

Given the dependencies surfaced across these findings, the most efficient implementation order is:

1. **Finding 6** (gesture-handler migration) — unlocks 4, 5's long-press, and 9.
2. **Finding 1** (coordinate mapping) and **Finding 3** (keyboard entry) — independent of everything else, highest user-visible impact, can proceed in parallel with (1).
3. **Finding 8** (monotonic sequence) — small, independent, unblocks safer reasoning about Finding 2's unreliable channel.
4. **Finding 2** (channel split) — sequence after 8 (cleaner gap-detection foundation) and before 4/12 (scroll benefits directly from a disposable channel).
5. **Findings 4, 5, 9, 11, 12** — layered on top of 6 and 2, roughly in that order.
6. **Findings 10, 13, 14, 15** — lower-risk, can be picked up opportunistically alongside any of the above.
