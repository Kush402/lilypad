# Lilypad Mobile — M3 UX Production-Readiness Audit

**Scope:** `apps/mobile/src/screens/{LoginScreen,DeviceListScreen,ScannerScreen,ViewerScreen}.tsx`, `apps/mobile/src/lib/{api,device,webrtc,signaling,input}.ts`, `apps/mobile/src/theme.ts`, `apps/mobile/src/types.ts`, `apps/mobile/App.tsx`, plus the shared contracts they depend on in `packages/protocol/src/{qr,pairing,signaling,input,constants}.ts` and the backend pairing route/service (`apps/backend/src/routes/pairing.ts`, `apps/backend/src/services/pairing.ts`) that determine what data and error information the mobile app has available to render.

**Method:** every file above was read in full. All claims below cite `file:line`. Where I reference a platform behavior (e.g. iOS's permission re-prompt policy) rather than a line of this repo, I say so explicitly and do not conflate it with a code citation.

---

## Executive Summary

The mobile app is a working M2 prototype: it can scan a QR code, redeem a token, join a signaling room, negotiate WebRTC, render H.264 video, and forward touch/keyboard input. As a _demo_, it succeeds. As the front door of a product meant to compete with Parsec/Jump Desktop/AnyDesk, it currently fails the "30-second time-to-first-session for a novice" mandate in several concrete, fixable ways: the first screen a new user sees contains two text fields that do nothing (`LoginScreen.tsx:23-39`); the single most important waiting moment in the whole flow — "your laptop owner needs to click Approve" — has no dedicated UI state at all, so users stare at a generic "Connecting…" spinner with no idea what to do (`apps/mobile/src/lib/webrtc.ts:18,47-53,61-63`); and the exact bug that motivated this audit (an expired-QR redemption surfacing as raw `"Network request timed out"`) is not an isolated incident but the designed behavior of the error path — every failure mode from network-unreachable to token-already-used to malformed-JSON is funneled through one `Error.message` string rendered verbatim in red text (`apps/mobile/src/screens/ScannerScreen.tsx:75-78,123`, `apps/mobile/src/lib/api.ts:23-26`).

Beyond error handling, the viewer itself — the screen where a user will spend 99% of their session time — has no connection-quality HUD, no reconnect/retry logic despite the protocol already supporting ICE restart (`packages/protocol/src/signaling.ts:151-159`, unused by `apps/mobile/src/lib/signaling.ts:83-91`), no way to type text into the remote machine despite the input protocol already supporting it (`packages/protocol/src/input.ts:78-82`, unused by `apps/mobile/src/screens/ViewerScreen.tsx`), no pinch-zoom, no safe-area awareness despite `SafeAreaProvider` being installed and never consumed (`apps/mobile/App.tsx:31`, zero `useSafeAreaInsets` calls anywhere in `src/`), and zero accessibility semantics anywhere in the app (zero `accessibilityLabel`/`accessibilityRole` occurrences across all four screens). None of these are new features — the transport and protocol layers already do the work; the UI simply never turns the crank.

This report contains 20 findings, ranked by user-impact severity, each with a complete redesign specific enough to implement without re-deriving the analysis.

| #   | Finding                                                                        | Severity    |
| --- | ------------------------------------------------------------------------------ | ----------- |
| 1   | Missing "waiting for approval" state — no "look at your laptop" moment         | Critical    |
| 2   | No error taxonomy — raw exceptions/HTTP bodies shown as UI text                | Critical    |
| 3   | No way to type text into the remote session                                    | Critical    |
| 4   | Dead stub login screen with non-functional fields                              | High        |
| 5   | No reconnect/retry logic; ICE-restart and WS-reconnect plumbing unused         | High        |
| 6   | Camera permission flow doesn't distinguish soft vs. hard denial                | High        |
| 7   | Race condition: Rescan doesn't cancel in-flight redeem                         | High        |
| 8   | No connection-quality HUD (latency/bitrate/packet loss)                        | High        |
| 9   | No device identity shown at the pairing-confirmation moment                    | High        |
| 10  | No pinch-zoom; multi-touch gestures misrouted as single-pointer input          | Medium-High |
| 11  | Zero accessibility semantics app-wide; control surface unusable with VoiceOver | Medium-High |
| 12  | Native back-gesture/header conflicts with left-edge touch control              | Medium      |
| 13  | Disconnect has no confirmation, undo, or intent-guard                          | Medium      |
| 14  | Toolbar: no haptics, no scroll affordance, no visual hierarchy, no key-repeat  | Medium      |
| 15  | Safe-area insets installed but never consumed                                  | Medium      |
| 16  | Landscape layout not optimized; no immersive/auto-hide chrome                  | Medium      |
| 17  | Dark-only theme, not adaptive to system appearance                             | Low-Medium  |
| 18  | Device list is permanently empty; copy overpromises persistence                | Low         |
| 19  | Scan reticle gives no liveness/success feedback                                | Polish      |
| 20  | Toolbar touch targets borderline below 44pt minimum                            | Polish      |

---

## Finding 1: Missing "waiting for approval" state — no "look at your laptop" moment

### Current implementation

`ViewerState` is defined as exactly five values: `'connecting' | 'negotiating' | 'connected' | 'failed' | 'ended'` (`apps/mobile/src/lib/webrtc.ts:18`). `ViewerConnection.start()` connects to signaling, registers, sends `pair-request`, and immediately calls `this.cb.onState('connecting')` (`apps/mobile/src/lib/webrtc.ts:47-53`). The next place `onState` is called is inside `handleOffer`, which sets `'negotiating'` only once the desktop's SDP offer arrives (`apps/mobile/src/lib/webrtc.ts:135-142`). In between — i.e., for the entire duration the desktop user is looking at their approve/deny dialog, which could be seconds or, if they've stepped away, minutes — the state never changes. Notably, the `session-start` signal handler (`apps/mobile/src/lib/webrtc.ts:61-63`, `case 'session-start': this.setupPeer(m.payload.iceServers); break;`) does not call `onState` either, so even the transition from "waiting for a human" to "ICE/DTLS setting up" is invisible.

`ViewerScreen` renders this via a static lookup table, `STATE_LABEL` (`apps/mobile/src/screens/ViewerScreen.tsx:34-40`), which only has entries for the same five states. The placeholder view during this entire wait is a centered `ActivityIndicator` plus the text `"Connecting…"` (`STATE_LABEL.connecting`) and the desktop's device name, on a plain black background (`apps/mobile/src/screens/ViewerScreen.tsx:104-111,148`).

If the desktop user clicks **Deny**, the `pair-denied` signal is handled identically to a normal `disconnect`/`session-end`: all three collapse to `this.cb.onState('ended')` followed by `this.close()` (`apps/mobile/src/lib/webrtc.ts:78-83`), which renders as `STATE_LABEL.ended = 'Disconnected'` (`apps/mobile/src/screens/ViewerScreen.tsx:39`) — indistinguishable from a graceful hangup.

### Problems

- A brand-new user's very first live session begins with an indefinite, unexplained "Connecting…" spinner during exactly the moment they most need guidance: _"go pick up your laptop and click Approve."_ This is the single highest-leverage fix for the 30-second-time-to-first-session mandate, because for most novices this wait **is** the 30 seconds.
- There is no way to tell, from the phone, whether the app is (a) still reaching the signaling server, (b) waiting on a human on the other end, or (c) already past approval and doing ICE/DTLS negotiation. These have wildly different recommended user actions (wait patiently vs. go find your laptop vs. nothing to do).
- A denial is presented identically to any other disconnect ("Disconnected"), giving the user zero actionable information — they don't know if they were rejected, if the laptop crashed, or if their own network dropped.
- There is no timeout or escape hatch: if the desktop is asleep, minimized, or the owner never sees the notification, the phone waits forever with no cancel affordance beyond backgrounding the app.

### Root cause

`ViewerState` was modeled around wire-protocol states (`webrtc.ts`'s own responsibilities: connect, negotiate, connect, fail, end) rather than user-meaningful journey stages. The signaling protocol itself _does_ carry the information needed (`pair-request` sent → `session-start` received → `offer` received are three distinct, observable milestones per `packages/protocol/src/signaling.ts:57-65,104-112,84-88`), but `ViewerConnection` discards the middle milestone instead of surfacing it.

### Redesign

Expand `ViewerState` in `apps/mobile/src/lib/webrtc.ts:18` to:

```ts
export type ViewerState =
  | 'connecting' // WS connecting to signaling
  | 'awaiting-approval' // pair-request sent, session-start not yet received
  | 'negotiating' // session-start received, waiting on/handling offer
  | 'connected'
  | 'denied' // pair-denied received (was folded into 'ended')
  | 'failed'
  | 'ended';
```

Concretely:

- In `start()` (`webrtc.ts:47-53`), after `this.sig.connect()` resolves, keep `onState('connecting')` for the WS-connect leg, then call `onState('awaiting-approval')` once `pairRequest` is sent (same function, just split the single `onState('connecting')` call into two calls bracketing the `pairRequest` line).
- In the `session-start` case (`webrtc.ts:61-63`), add `this.cb.onState('negotiating')` before calling `setupPeer` — this is the true "ICE/DTLS setting up" stage, distinct from "waiting on the offer SDP" which today is the only thing that triggers `'negotiating'`. (If finer granularity is wanted later, `negotiating` can stay a single bucket for both; the important fix is that it no longer overlaps with the approval wait.)
- Split the `pair-denied` case out of the `disconnect`/`session-end` group (`webrtc.ts:78-83`) into its own `case 'pair-denied': this.cb.onState('denied'); this.close(); break;`.
- In `ViewerScreen.tsx`, extend `STATE_LABEL` (`ViewerScreen.tsx:34-40`) and replace the flat text placeholder (`ViewerScreen.tsx:104-111`) with a small step indicator, e.g. three dots/labels ("Connecting to server" → "Waiting for approval" → "Starting video") with the current step highlighted, and state-specific body copy:
  - `awaiting-approval`: primary message **"Look at your laptop — tap Approve to allow this device."** plus the desktop's device name if known (it currently isn't known at this point — see Finding 9) and a subtle "Still there? We'll keep waiting." after e.g. 20s, with a **Cancel** button that calls `disconnect()`/`navigation.replace('Devices')`.
  - `denied`: **"Your laptop declined this request."** with a **Try again** button that returns to the scanner, distinct from generic `ended`/`failed` copy.
  - `failed`: keep existing copy but add a **Retry** action (see Finding 5).

### Tradeoffs

Splitting `connecting` into two states is a small, additive change to a closed enum used only within this module and its one consumer (`ViewerScreen.tsx`) — low blast radius. The only design tension is whether to also expose a live "connecting → negotiating" sub-split; I recommend keeping that single-bucketed for now since the ICE/DTLS phase is normally sub-second and doesn't need its own copy, avoiding UI churn for a stage nobody will actually see.

### Implementation plan

1. Update `ViewerState` union and `STATE_LABEL` map.
2. Add the two new `onState` call sites in `ViewerConnection` (`awaiting-approval` after `pairRequest`, `negotiating` on `session-start`).
3. Split `pair-denied` into its own switch case.
4. Build a small `<ApprovalWaitCard>` component (step list + copy + Cancel) reused by the `awaiting-approval` branch of `ViewerScreen`'s placeholder render.
5. Add `Try again` / `Retry` buttons wired to existing navigation (`navigation.replace('Scanner')` or a new `reconnect()` — see Finding 5).

### Migration strategy

No wire-protocol change, no backend change — this is purely additive to the mobile-local state enum and its renderer. Ship behind no flag; it strictly improves an under-specified state. Because `ViewerState` is not persisted or sent anywhere, there's no versioning concern.

### Testing strategy

- Unit test `ViewerConnection`'s state transitions by feeding it a scripted sequence of `SignalingMessage`s (register → pair-request → session-start → offer → ...) and asserting the `onState` callback fires with the new intermediate values in order (extend `apps/mobile/src/session-adjacent` equivalent test patterns already used in `apps/backend/src/session/stateMachine.test.ts` as a model for state-machine unit tests).
- Manual test: pair, then deliberately wait 15s before approving on desktop — confirm the phone shows the new "waiting for approval" copy the whole time, not "Connecting…".
- Manual test: deny on desktop — confirm the phone shows denial-specific copy, not "Disconnected".

### Risk assessment

Low risk: additive enum values, no removal of existing behavior, no protocol/schema changes. The only regression risk is a missed call site if some other consumer switches exhaustively over `ViewerState` without a `default` — grep confirms `ViewerScreen.tsx` is the only consumer.

### Performance impact

None — this is a UI/state-labeling change with no additional network traffic or render cost beyond a small step-indicator component.

### Future extensibility

Once this state machine exists, it's the natural place to add: a server-driven "desktop is offline" push (would need a new signaling message, out of scope here), approval-wait analytics (time-to-approve), and a "resend notification" affordance.

---

## Finding 2: No error taxonomy — raw exceptions and HTTP bodies shown as UI text

### Current implementation

`redeemToken` (`apps/mobile/src/lib/api.ts:9-28`) does a plain `fetch()` with no timeout, no `AbortController`, and on any non-OK response throws `new Error(`redeem failed: HTTP ${res.status} ${text}`)` where `text` is the raw response body (`api.ts:23-26`). The backend's actual 410 response for an expired/reused token is `{ error: 'token_invalid', message: 'pairing token is invalid, expired, or already used' }` (`apps/backend/src/routes/pairing.ts:26-28`, message text from `apps/backend/src/services/pairing.ts:85`) — so a real user sees the literal string `redeem failed: HTTP 410 {"error":"token_invalid","message":"pairing token is invalid, expired, or already used"}`.

`ScannerScreen.connect()` catches whatever `redeemToken` throws and does `setError(e instanceof Error ? e.message : String(e))` (`ScannerScreen.tsx:75-78`), which renders verbatim in `styles.error` red text under the confirmation card (`ScannerScreen.tsx:123,213`). If the device can't reach `apiBaseUrl` at all (wrong network, desktop's LAN IP unreachable over cellular, DNS failure, etc.), React Native's `fetch` polyfill throws its own generic message — commonly surfaced as `"Network request timed out"` or `"Network request failed"` — which flows through the identical path with zero translation. This is precisely the bug that motivated this audit, and it is not an edge case in the code — it is the _only_ code path; every failure (malformed QR at decode time is the sole exception, handled separately at `ScannerScreen.tsx:44-49`) funnels through one unmodified `.message` string.

The same pattern repeats in `ViewerScreen`: `conn.start().catch((e) => setError(String(e)))` (`ViewerScreen.tsx:57`) and `onError: setError` wired directly to `ViewerConnection`'s `cb.onError`, which itself is fed directly from the signaling `error` message's `payload.message` with no local translation (`apps/mobile/src/lib/webrtc.ts:84-85`).

### Problems

- Users cannot act on "Network request timed out" — it doesn't tell them whether to rescan (token expired), check their Wi-Fi (unreachable host), or wait and retry (transient). Different causes need different recovery affordances; today they all look identical.
- Technical jargon ("HTTP 410", raw JSON, stack-trace-adjacent text) actively damages trust in a consumer product competing with Parsec/AnyDesk, which show branded, specific error states ("This code has expired — ask for a new one").
- There is no retry/backoff for transient network errors (DNS blip, desktop briefly asleep) — the user's only recourse is manually tapping Rescan, which doesn't even generate a new code (see Finding 7 for what Rescan actually does).
- No request timeout exists at all: if the desktop's signaling/API host is unreachable but not immediately rejecting (e.g., silently dropped packets, captcaptive portal), `fetch` can hang for the platform's default timeout (frequently 60s+), during which the Connect button spinner (`ScannerScreen.tsx:130-134`) just spins with no cancel option.

### Root cause

There is no error-classification layer between the transport (`fetch`, WebSocket, WebRTC `error` events) and the UI. Every call site treats "the operation threw" as a single undifferentiated case and displays `String(error)`.

### Redesign

Introduce a small shared error taxonomy in `apps/mobile/src/lib/errors.ts` (new file, additive — not a "new feature," a plumbing layer for existing failure modes):

```ts
export type AppErrorCode =
  | 'qr_invalid' // malformed/incompatible QR (already distinguished today)
  | 'token_expired' // HTTP 410 / token_invalid from redeem
  | 'network_unreachable' // fetch threw before getting an HTTP response
  | 'request_timeout' // our own AbortController fired
  | 'server_error' // HTTP 5xx
  | 'signaling_lost' // WS closed unexpectedly
  | 'peer_denied' // pair-denied
  | 'ice_failed' // RTCPeerConnection connectionState === 'failed'
  | 'unknown';

export interface AppError {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
}
```

Then:

1. In `api.ts`, add a request timeout via `AbortController` (e.g. 8s) and classify the failure before throwing: distinguish `res.status === 410` (→ `token_expired`, retryable: false, message: _"This QR code has expired. Ask for a new one on the laptop and scan again."_), `res.status >= 500` (→ `server_error`, retryable: true), and the `fetch` promise itself rejecting (→ `network_unreachable` if `TypeError`/network-layer, `request_timeout` if the abort fired) — each mapped to a specific, user-facing sentence and an internal code for logging/telemetry, never the raw `res.text()` body.
2. `ScannerScreen` renders `error.message` (the friendly string) plus, conditionally, a **secondary action** driven by `error.retryable`/`error.code`: `token_expired` → primary CTA becomes "Scan a new code" (auto-clears `scanned` and reopens the camera) instead of a dead "Connect" retry; `network_unreachable` → "Check your Wi-Fi and try again" with a **Retry** button that re-invokes `connect()` without requiring a rescan.
3. `ViewerConnection`/`ViewerScreen` adopt the same `AppError` shape for `onError`, so `signaling_lost` (see Finding 5) and `ice_failed` get distinct, actionable copy instead of a bare thrown string.
4. Keep raw technical detail (status code, original message) available behind a collapsed "Details" disclosure or in logs only — never as the primary line of copy.

### Tradeoffs

This adds one new module and touches three call sites (`api.ts`, `ScannerScreen.tsx`, `webrtc.ts`); it's a pure refactor of existing error plumbing, not new functionality, so it fits the "perfect what exists" mandate. The tradeoff is upfront taxonomy design cost vs. the alternative of continuing to string-match errors ad hoc at each call site — a shared type is worth it given at least three independent call sites already need this classification.

### Implementation plan

1. Add `apps/mobile/src/lib/errors.ts` with the `AppErrorCode`/`AppError` types and a `classifyFetchError`/`classifyRedeemResponse` helper.
2. Rewrite `redeemToken` in `api.ts` to add an `AbortController` timeout and throw `AppError` instances instead of bare `Error`.
3. Update `ScannerScreen.connect()`'s catch block to branch on `error.code` for CTA selection.
4. Update `ViewerConnection.onError`/`ViewerScreen`'s error rendering analogously.
5. Add a `console.warn`/telemetry hook (if one exists elsewhere in the codebase — none was found in the audited files) logging the original raw message alongside the classified code, so support/telemetry retains full detail even though the user only sees the friendly copy.

### Migration strategy

Purely client-side; no backend or protocol changes required (the backend already returns a distinguishable `410` + `token_invalid` — the mobile app simply needs to read it). Ship as a single PR; no feature flag needed since it can only improve on "raw stack trace shown to user."

### Testing strategy

- Unit tests for `classifyFetchError`/`classifyRedeemResponse` covering: 410 response, 500 response, fetch-rejects-before-response (mock `fetch` to reject with a `TypeError`), and an aborted request.
- Manual test: let a QR code sit for >60s (past `DEFAULT_PAIRING_TOKEN_TTL_SECONDS`, `packages/protocol/src/constants.ts:11`) then scan+connect — confirm the specific "expired, scan a new one" copy and CTA appear, not raw HTTP text.
- Manual test: turn on airplane mode after scanning, before tapping Connect — confirm "check your Wi-Fi" copy with a working Retry button.

### Risk assessment

Low risk — additive typing and copy changes; the underlying request/response logic (URL, method, body) is unchanged, only the error-handling branch is rewritten. Care needed to preserve the currently-working "malformed QR" path (`ScannerScreen.tsx:44-49`) which should map to `qr_invalid` in the same taxonomy for consistency, not be disturbed functionally.

### Performance impact

Negligible — one `AbortController`/`setTimeout` per request; strictly improves perceived performance by bounding worst-case hang time (today unbounded) to a fixed timeout.

### Future extensibility

Once `AppError` exists, it's the natural hook for telemetry (error-code histograms to find the most common real-world failure), for localization (swap the friendly-message table per locale), and for the reconnect logic in Finding 5 (`retryable` flag drives whether an automatic retry is attempted).

---

## Finding 3: No way to type text into the remote session

### Current implementation

The input protocol supports committed text entry (`text_input`, carrying arbitrary IME/autocorrect-composed strings) and raw key events with modifiers (`key_down`/`key_up`, carrying UI-Events `code` values) — `packages/protocol/src/input.ts:64-82,111-122`. `InputSender` on the mobile side already implements both: `text(text: string)` and `keyDown(code, modifiers)`/`keyUp(code, modifiers)` (`apps/mobile/src/lib/input.ts:56-64`). Nothing in `ViewerScreen.tsx` ever calls any of them. The only input paths wired to the UI are: (a) the `PanResponder` for pointer down/move/up (`ViewerScreen.tsx:67-92`), and (b) the fixed nine-button `TOOLBAR` array, whose actions are exclusively `shortcut()` calls for `copy/paste/escape/tab/enter/arrow_*` (`ViewerScreen.tsx:22-32,120-127`). There is no `TextInput` anywhere in the component tree (confirmed: no `TextInput` import or usage in `ViewerScreen.tsx`), no on-screen keyboard summon button, and no listener translating RN `TextInput` composition events into `text()`/`keyDown()` calls.

### Problems

- A user cannot type a URL into a browser address bar, search for a file, enter a password into a remote app, or write an email — i.e., cannot do the majority of what "controlling a laptop" means for a novice. This is arguably the single biggest functional gap in the reviewed surface, and it sits squarely inside "perfect what exists": the transport (`DataChannel`), the wire format (`text_input`/`key_down`), and the sender (`InputSender.text`/`.keyDown`) all already exist and are fully implemented — only the UI trigger is missing.
- The `shortcut` toolbar gives access to a handful of named actions but zero general-purpose alphanumeric input, so it cannot substitute for real typing.
- Because there is no visible way to invoke the system keyboard, a first-time user has no way to discover this gap short of trying every button and finding none of them work — actively contradicts "30-second time to first (successful) session," since the session will feel broken the moment they need to type anything.

### Root cause

`ViewerScreen`'s toolbar was scoped to a fixed set of "dev shortcut" actions (per its own inline comment history: `packages/protocol/src/input.ts:84-86` calls these "Semantic dev shortcut from the mobile toolbar") and was never extended to include a general text-entry affordance, even though the underlying `InputEvent` union already had `text_input`/`key_down`/`key_up` from the start.

### Redesign

Add a **keyboard-summon button** to the toolbar (a `⌨` icon, first position, visually distinguished from the shortcut keys — see Finding 14 for hierarchy) that toggles visibility of an off-screen `TextInput`:

```tsx
const kbRef = useRef<TextInput>(null);
const [composing, setComposing] = useState('');
// off-screen but focusable, positioned outside the visible area or with opacity:0 + height:1
<TextInput
  ref={kbRef}
  style={styles.hiddenKeyboardCapture}
  value={composing}
  onChangeText={(next) => {
    // Diff-based: RN TextInput onChangeText gives the full composed string;
    // send committed text as a single text_input event, matching the protocol's
    // "typed as a unit, IME/autocorrect friendly" design (packages/protocol/src/input.ts:79-81).
    if (next.length > composing.length) {
      connRef.current?.inputSender?.text(next.slice(composing.length));
    }
    setComposing(next);
    // Clear after each event to avoid unbounded buffer growth and stray backspaces
    // being misinterpreted; simplest correct approach: reset to '' each time and
    // treat `next` itself (not the diff) as the increment when composing is cleared
    // synchronously — implementation detail to validate against RN's controlled-input
    // timing, but the direction (buffer-then-diff) is the right one.
  }}
  onKeyPress={(e) => {
    // Handles Backspace/Enter/etc. which onChangeText won't reliably surface as text.
    if (e.nativeEvent.key === 'Backspace') connRef.current?.inputSender?.keyDown('Backspace');
  }}
  autoCorrect={false}
  autoCapitalize="none"
/>;
```

Tapping the keyboard toolbar button calls `kbRef.current?.focus()`; a visible "Hide keyboard" affordance (or tapping the remote-screen area) calls `.blur()`. This reuses `InputSender.text`/`.keyDown` exactly as already implemented (`apps/mobile/src/lib/input.ts:56-64`) — no protocol or transport change.

### Tradeoffs

A hidden-`TextInput` approach is the standard RN pattern for "capture system keyboard, forward as a custom protocol" (used by e.g. most RN terminal/remote-desktop clients) but has known rough edges: autocorrect/predictive text can insert more than one character per `onChangeText` firing, and diffing composed strings against IME composition (CJK input, etc.) requires care. An alternative is a fully custom on-screen keyboard (renders your own QWERTY), which sidesteps IME diffing but loses autocorrect/predictive-text/IME support entirely and is significantly more implementation effort — not recommended given the mandate to avoid new feature surface. The hidden-`TextInput` approach is recommended as the lower-effort, higher-fidelity option consistent with "perfect what exists."

### Implementation plan

1. Add the hidden/hooked `TextInput` and keyboard-summon toolbar button to `ViewerScreen.tsx`.
2. Wire `onChangeText`/`onKeyPress` to `InputSender.text`/`.keyDown` per above, with careful diffing logic validated against real autocorrect behavior on both iOS and Android (this needs hands-on testing against the actual `TextInput` timing, not just code review).
3. Add a visible "keyboard shown" indicator (e.g. toolbar button becomes highlighted/active) and a way to dismiss (tap outside, explicit button, or the RN keyboard's own dismiss).
4. Ensure the remote video's `PanResponder` (`ViewerScreen.tsx:67-92`) doesn't fight for touch priority with the now-visible system keyboard area.

### Migration strategy

No backend/protocol change at all — purely a mobile-app UI addition consuming existing `InputSender` methods. Ship directly; no versioning concerns since `text_input`/`key_down` are already part of `PROTOCOL_VERSION = 1` (`packages/protocol/src/constants.ts:5`) and presumably already handled on the desktop input-injection side (out of this audit's scope, but the schema and comment at `packages/protocol/src/input.ts:1-12` indicate this was the intended design from day one).

### Testing strategy

- Manual: type a sentence with autocorrect enabled on iOS and Android; verify the remote receives the correct final text with no duplicated/dropped characters.
- Manual: type a password (no autocorrect, `secureTextEntry`-style capture is not needed here since it's forwarding, not storing) into a remote password field; verify character-for-character fidelity, including Backspace.
- Manual: verify Enter/Tab (already in the `shortcut` toolbar, `ViewerScreen.tsx:22-32`) still work while the keyboard is open, without duplicate key events.
- Regression: confirm `PanResponder`-driven click/drag control (Finding 10/12 territory) remains unaffected when the keyboard is not summoned.

### Risk assessment

Medium risk in the diffing logic specifically (autocorrect/IME edge cases are notoriously fiddly), low risk everywhere else since it only adds a new UI element and reuses existing, already-tested `InputSender` methods (`apps/mobile/src/lib/input.ts` has no test file today, which is itself worth flagging separately, though out of scope for a UX audit).

### Performance impact

Negligible — each committed keystroke/text chunk is already immediate-flush (`immediate: true` in `InputSender.enqueue`, `apps/mobile/src/lib/input.ts:63`), consistent with existing shortcut/click traffic patterns.

### Future extensibility

Once a keyboard-summon affordance exists, it's the natural place to add modifier-combo entry (Cmd+key chords) and IME candidate-window forwarding, though both are out of scope here per the no-new-features mandate.

---

## Finding 4: Dead stub login screen with non-functional fields

### Current implementation

`LoginScreen` renders an email `TextInput` and a password `TextInput` (`apps/mobile/src/screens/LoginScreen.tsx:23-39`), both fully wired to local state (`email`/`password`, lines 14-15) but **never read** — the only button, "Continue," ignores both fields and calls `navigation.replace('Devices')` unconditionally (`LoginScreen.tsx:41-43`). Below the button, the screen displays the sentence **"Auth is stubbed in M1 (dev mode). Real accounts arrive in M5."** directly to the user (`LoginScreen.tsx:44`). The component's own doc comment confirms this is intentional scaffolding: _"Login/signup — STUB. Real email/password auth (then Google/Apple) lands in Milestone 5. For M1 this just proceeds to the device list."_ (`LoginScreen.tsx:9-12`).

### Problems

- The very first interactive moment of the app presents two text fields that a novice will naturally try to fill in, only to discover neither has any effect — this is the worst possible first impression for the 30-second-time-to-first-session mandate, since it burns time and trust before the user even reaches the part of the app that works.
- The visible string "Auth is stubbed in M1 (dev mode)" is an internal engineering note leaking into user-facing UI. If this build were ever handed to a real user (beta tester, stakeholder demo, App Store reviewer) it reads as unfinished/broken software, not a private beta disclosure.
- There is no actual reason for this screen to exist in its current form at all: it collects no data, validates nothing, and gates nothing — it is pure friction between app launch and the QR scanner.

### Root cause

The screen was built as a placeholder for M5's real auth work and was never revisited once M2/M3 shipped real functionality elsewhere; nothing forced a revisit because it doesn't block the demo flow (`navigation.replace` always succeeds).

### Redesign

Two viable options, both consistent with "no new features":

- **Option A (recommended for M3): remove the screen from the initial route entirely.** Change `App.tsx:34` (`initialRouteName="Login"`) to `initialRouteName="Devices"` and drop `Login` from the stack (or keep the route registered but unreachable, for a fast M5 re-add). This directly serves the 30-second mandate: the first thing a novice sees becomes the "Scan a laptop's QR" screen, not two dead text fields.
- **Option B, if a placeholder screen must stay for branding/onboarding reasons:** strip the non-functional `TextInput`s entirely and replace with a single explanatory screen — logo, one sentence of value prop (already present: `LoginScreen.tsx:21`), and a single "Get started" CTA — with no fields that imply functionality that doesn't exist, and no visible "stubbed/dev mode" language (move that note into a README/internal build flag, not user-facing copy).

Given the audit mandate explicitly says "kill or redesign," and the screen currently does not gate anything, Option A is the lower-risk, higher-impact choice for M3; Option B is the fallback if there's a product reason (e.g. App Store screenshots, brand-intro requirement) to keep an interstitial.

### Tradeoffs

Removing the screen loses a placeholder location for future real auth, but M5 will need to redesign this screen for real auth anyway (email/password plus Google/Apple per the code comment, `LoginScreen.tsx:10`) — keeping a non-functional version around in the meantime provides no migration benefit and actively costs trust today. Option B costs a small amount of extra tap/screen but preserves a "brand moment" if product wants one.

### Implementation plan

1. Decide A vs. B with product (this is the one place in this report I'd flag as needing a quick product call, since it's a navigation/IA decision, not purely engineering).
2. If A: change `initialRouteName` in `App.tsx:34`; remove or comment out the `Login` `Stack.Screen` registration (`App.tsx:35`) and the `LoginScreen` import/file, or leave the file in place but unrouted for a fast M5 revival.
3. If B: delete lines 23-39 (both `TextInput`s) and the stub note (line 44) from `LoginScreen.tsx`, replace with a single CTA.

### Migration strategy

No data migration; this is a pure navigation-graph change. Since `RootStackParamList.Login` is `undefined` params (`apps/mobile/src/types.ts:6`), no deep-link or param-shape concerns.

### Testing strategy

- Manual: fresh app launch lands directly on the (now-first) `Devices` screen (Option A) and reaches the scanner in one tap, timing the full cold-launch-to-QR-scanner interval as a concrete "time to first session" metric.
- Regression: confirm no other code path navigates to `'Login'` expecting to gate on it (grep confirms `navigation.replace('Devices')`/`'Scanner'`/`'Viewer'` are the only cross-screen navigations in the audited files — no code currently depends on Login as a gate).

### Risk assessment

Low risk — this screen has no side effects (no auth call, no state written) so removing/replacing it cannot break any downstream flow; the risk is entirely a product/IA judgment call, not a technical one.

### Performance impact

Slightly positive — one fewer screen mount/transition on cold launch.

### Future extensibility

Whatever M5 auth design lands, it should own its own screen built from scratch against real requirements (email/password validation, OAuth redirect handling, session token storage) rather than resurrecting this stub, since none of the current field-wiring is reusable (the fields are never read).

---

## Finding 5: No reconnect/retry logic; ICE-restart and WS-reconnect plumbing unused

### Current implementation

`MobileSignaling.connect()` sets `ws.onopen`, `ws.onerror`, and `ws.onmessage`, but **no `ws.onclose` handler at all** (`apps/mobile/src/lib/signaling.ts:23-37`) — confirmed by inspecting the full file; there are only these three handler assignments. If the WebSocket drops after the initial connect (network blip, backend restart, phone backgrounding long enough for the OS to kill the socket), nothing in `MobileSignaling` or its consumer `ViewerConnection` is notified; the UI simply stops receiving updates and freezes in whatever `ViewerState` it was last in, with no error surfaced.

`MobileSignaling` does implement a `renegotiate()` method that sends a `{ type: 'renegotiate', payload: { iceRestart: true } }` signal (`apps/mobile/src/lib/signaling.ts:83-91`), matching a real server-side handler in the protocol (`packages/protocol/src/signaling.ts:151-159`, "Ask the desktop to produce a new offer... e.g. resolution/track change, ICE restart"). Nothing calls `renegotiate()` anywhere in the mobile app (grep of `apps/mobile/src` for `renegotiate` returns only its own definition).

On the WebRTC side, `RTCPeerConnection`'s `connectionstatechange` handler maps `'failed'` → `onState('failed')` and `'closed'`/`'disconnected'` → `onState('ended')` (`apps/mobile/src/lib/webrtc.ts:114-119`) — no retry, no ICE restart attempt, no reconnect of any kind is triggered from either state.

`ViewerScreen`'s only UI for the `failed`/`ended` states is the same static placeholder text (`STATE_LABEL`, `ViewerScreen.tsx:34-40`, rendered at lines 104-111) with no button beyond the always-present, unconditional bottom "Disconnect" (`ViewerScreen.tsx:131-135`), which simply navigates back to `Devices` — there is no "Reconnect" or "Retry" action anywhere in the component.

### Problems

- Any transient network hiccup — the single most common real-world failure mode for an "internet-first" remote-desktop product on cellular/Wi-Fi-handoff — permanently ends the session with no automatic or one-tap recovery, forcing the user through the entire re-scan-QR flow from scratch (which additionally requires the desktop to generate a _new_ QR code, since tokens are single-use with a 60-second TTL, `packages/protocol/src/constants.ts:11` — the old QR cannot simply be rescanned).
- A silently-dropped WebSocket (no `onclose` handler) is worse than a visibly failed one: the app gives no error at all, just an indefinitely stuck spinner, which is strictly worse UX than an explicit "Connection lost" message.
- The product already has working ICE-restart plumbing on the wire (`renegotiate`) that is never invoked — this is exactly the kind of "finish what's half-built" gap the M3 mandate is about.

### Root cause

`ViewerConnection`/`MobileSignaling` were built to establish a session, not to maintain one — the `connectionstatechange` and (missing) `onclose` handlers were never extended past updating a status label.

### Redesign

1. **Add `ws.onclose` to `MobileSignaling.connect()`** (`signaling.ts:23-37`): on unexpected close (i.e., not following an explicit local `.close()` call — track this with a `private explicitClose = false` flag flipped by the public `close()` method), invoke a new `onClose` callback that `ViewerConnection` maps to a `signaling_lost` `AppError` (per Finding 2's taxonomy) rather than leaving the UI frozen.
2. **Add bounded automatic reconnect** in `ViewerConnection`: on `signaling_lost` or `connectionstatechange === 'disconnected'` (a transient ICE state distinct from the terminal `'failed'`, which today is incorrectly bucketed together with `'closed'` at `webrtc.ts:118`), attempt `this.sig.renegotiate()` (which requests an ICE restart from the desktop) up to e.g. 3 times with exponential backoff (1s/3s/8s) before surfacing a terminal "Connection lost" state with a manual **Reconnect** button.
3. Fix the `'disconnected'` vs `'closed'` conflation at `webrtc.ts:118`: per the WebRTC spec, `'disconnected'` is often transient (brief network blip) while `'closed'` is terminal — today both map to `'ended'` identically. Split them: `'disconnected'` → attempt the retry sequence above; `'closed'` → terminal `ended`.
4. Add a **Reconnect** button to `ViewerScreen`'s `failed`/`ended`-state placeholder that calls a new `ViewerConnection.reconnect()` method (re-runs `start()` against the same `roomId`/`signalingUrl`/`scopes` already held in `route.params`, `ViewerScreen.tsx:43`) — no new QR scan needed for a same-session reconnect, since the room/scopes are already known and don't require a fresh single-use token (only the _initial_ pairing does).

### Tradeoffs

Automatic retry adds complexity (backoff timers, re-entrancy guards against overlapping reconnect attempts) and needs care to avoid infinite retry loops draining battery on a truly dead network — the bounded 3-attempt cap with a manual fallback button balances recoverability against runaway-retry risk. This is additive logic on top of already-defined protocol messages (`renegotiate`), not a new protocol feature.

### Implementation plan

1. Add `explicitClose` flag + `onclose` handler + `onClose` callback param to `MobileSignaling`.
2. Add `reconnect()` method and bounded-retry state machine to `ViewerConnection`; wire `signaling_lost`/`disconnected` into it.
3. Split `'disconnected'` from `'closed'` in the `connectionstatechange` handler.
4. Add "Reconnect" button to `ViewerScreen`'s failed/ended placeholder, calling the new `reconnect()`.
5. Add a visible (non-blocking) "Reconnecting… (attempt 2/3)" indicator during automatic retries, reusing the step-indicator component from Finding 1.

### Migration strategy

No protocol/schema change — `renegotiate` already exists server-side per its schema definition (`packages/protocol/src/signaling.ts:151-159`); confirm with the backend/desktop teams that the _handler_ for `renegotiate` is actually implemented end-to-end (this audit did not review desktop-side or backend hub handling of `renegotiate`, only the schema and the unused mobile sender — flag this as a cross-team verification item before shipping).

### Testing strategy

- Unit test the bounded-retry backoff logic in isolation (fake timers, assert exactly 3 attempts then terminal state).
- Manual: toggle airplane mode on/off for ~2s mid-session; confirm automatic recovery without user action.
- Manual: kill the backend process mid-session (or block the WS port); confirm the app surfaces "Connection lost" (not a frozen spinner) and offers a working Reconnect after backend restarts.
- Manual: force `pc.connectionState` to `'failed'` (e.g., disable all ICE candidates) and confirm terminal state + Reconnect button, distinct from the transient `'disconnected'` retry path.

### Risk assessment

Medium risk — this is the most behaviorally complex change in this report (bounded retry with backoff, state-machine correctness, avoiding duplicate `RTCPeerConnection`s across silent reconnect attempts). Requires the cross-team confirmation noted above that `renegotiate` is actually handled by the desktop/backend before enabling automatic use.

### Performance impact

Positive for perceived reliability; retry attempts themselves are cheap (a single signaling message) but must be rate-limited (the proposed backoff) to avoid hammering a genuinely offline desktop.

### Future extensibility

This is the natural foundation for a future "seamless roaming" feature (Wi-Fi ↔ cellular handoff without visible interruption), though that itself would be a new feature and is out of scope here.

---

## Finding 6: Camera permission flow doesn't distinguish soft vs. hard denial

### Current implementation

`ScannerScreen` uses `useCameraPermission()` from `react-native-vision-camera`, which exposes only a boolean `hasPermission` (`ScannerScreen.tsx:31`). A `useEffect` unconditionally calls `requestPermission()` whenever `hasPermission` is false (`ScannerScreen.tsx:37-39`). The denied-state render offers two options: a primary "Grant camera access" button that calls `requestPermission()` again (`ScannerScreen.tsx:85-87`), and a secondary, de-emphasized text link "Open Settings" below it (`ScannerScreen.tsx:88-90`).

On iOS, once a user has explicitly denied a permission through the system dialog, platform policy prevents the app from re-presenting that system dialog via a subsequent programmatic request — the app must direct the user to the Settings app to change it manually. (This is standard iOS platform behavior, not a claim about this repo's code — noted so as not to be confused with a file citation.) Given that platform behavior, the "Grant camera access" button at `ScannerScreen.tsx:85-87` will silently do nothing for any user who has already tapped "Don't Allow" once, while remaining the visually primary action, with the only actually-effective path ("Open Settings") presented as a lower-emphasis text link.

### Problems

- A user who denied camera access once (perhaps by accident, or before understanding why it's needed) taps the big primary button, sees nothing happen, and has no visible next step unless they notice the small text link below it — this is a dead-end exactly like Finding 4's login fields, at an even more critical point in the funnel (the scanner is the core feature).
- There's no explanatory pre-permission screen either: the OS dialog fires immediately from the `useEffect` (`ScannerScreen.tsx:37-39`) with no Lilypad-authored context beforehand explaining _why_ camera access is needed, which is a well-established best practice for maximizing first-ask grant rates (reduces "why does this app want my camera" hesitation).

### Root cause

The screen was built against the simplified boolean permission hook without accounting for the specific, well-known iOS re-prompt restriction, and the UI was laid out with "Grant access" as visually primary regardless of whether that action can possibly succeed.

### Redesign

1. Before the first permission request, show a brief one-time explainer (can be part of the same denied-state screen's initial paint, gated on a local "haven't asked yet" flag) — a sentence like _"Lilypad needs your camera to scan the QR code shown on your laptop. We never store or upload anything from your camera."_ — with a single "Continue" that triggers `requestPermission()`. This turns the cold system dialog into a primed one.
2. Track whether this is the _first_ request or a _subsequent_ one (e.g., a local boolean/ref set after the first `requestPermission()` call resolves `false`). If a subsequent `requestPermission()` call resolves to `false` immediately (which, per iOS policy, it will for a hard-denied permission — Android's behavior differs slightly but a request-then-still-false result is a reasonable cross-platform signal), switch the primary CTA to **"Open Settings"** and demote/remove the "Grant camera access" button, since it cannot succeed.
3. Make "Open Settings" (`Linking.openSettings()`, already implemented at `ScannerScreen.tsx:88-90`) the visually primary button once hard denial is detected, matching the visual weight currently given only to the always-attemptable action.

### Tradeoffs

Perfectly distinguishing "soft" (never asked / can still prompt) from "hard" (permanently denied) requires either upgrading to the library's more granular status API (`Camera.getCameraPermissionStatus()`, which vision-camera exposes alongside the simplified hook used today) or inferring hard-denial heuristically from a request resolving to `false` more than once. The former is more precise but is a slightly larger change (bypassing the convenience hook for the lower-level API); the latter is a smaller diff. Given the mandate to perfect rather than expand, I recommend querying the more granular status directly since `react-native-vision-camera` (already a dependency, `apps/mobile/package.json:24`) exposes it — this avoids fragile inference.

### Implementation plan

1. Replace or supplement `useCameraPermission()` with a direct call to the library's granular permission-status API on mount (checking for `'denied'`/`'restricted'` vs `'not-determined'`/`'granted'`), storing the result in local state.
2. Gate the pre-permission explainer copy on `'not-determined'`.
3. Gate primary-CTA choice (Grant vs. Open Settings) on `'denied'`/`'restricted'` vs. not-yet-asked.
4. Reorder/restyle buttons so the actually-effective action is always the visually primary one.

### Migration strategy

Client-only change; no backend/protocol involvement. No versioning concerns.

### Testing strategy

- Manual, iOS: fresh install, deny the permission once, verify the screen now shows "Open Settings" as primary with no dead "Grant access" button shown (or, if still shown, clearly secondary and not misleadingly actionable).
- Manual, Android: repeat, accounting for Android's distinct "don't ask again" checkbox flow, verifying whichever library status value corresponds to that state also triggers the Settings-primary UI.
- Manual: grant on first ask — verify the pre-permission explainer appears before the OS dialog and disappears cleanly once granted, with no dead frame.

### Risk assessment

Low risk — this only changes copy/CTA selection logic gated on a permission-status read; no capture/scanning logic changes.

### Performance impact

None.

### Future extensibility

The same "explain-before-asking, detect-hard-denial" pattern should be reused for any future permission prompt this app adds (e.g., microphone if audio mirroring is ever added), so this is worth extracting into a small shared `usePermissionFlow` hook rather than one-off logic in `ScannerScreen` alone.

---

## Finding 7: Race condition — Rescan doesn't cancel an in-flight redeem

### Current implementation

`connect()` is a `useCallback` closing over `scanned` (`ScannerScreen.tsx:62-79`). It sets `connecting = true`, calls `await redeemToken(scanned.apiBaseUrl, scanned.token)`, and on success calls `navigation.replace('Viewer', { payload: scanned, ... })` using the `scanned` value captured in the closure at call time. The "Connect" button is disabled while `connecting` is true (`ScannerScreen.tsx:128-129`), but the adjacent "Rescan" button has **no such guard** (`ScannerScreen.tsx:136-144`) — its `onPress` unconditionally calls `setScanned(null); setError('')`, which re-enables the camera (`isActive={!scanned}`, `ScannerScreen.tsx:108`) but does **not** cancel the in-flight `redeemToken` fetch (no `AbortController` is passed anywhere in `api.ts`, confirmed by reading the full file — the request has no cancellation mechanism at all).

### Problems

- If a user taps "Rescan" while a slow `redeemToken` call is still pending (e.g., on a slow network — exactly the scenario this audit is about), and that pending call _later_ resolves successfully, `connect()`'s success branch still fires and calls `navigation.replace('Viewer', { payload: scanned, ... })` using the **stale** `scanned` object from before the rescan — silently connecting the user to the laptop they were trying to back out of, and discarding whatever new QR code they may have scanned in the meantime (the new scan would have set a _different_ local `scanned` value via `onValue`, but the async closure holds the old one).
- This is a genuine correctness bug, not just a polish item: the user's explicit "cancel this" action (tapping Rescan) is silently overridden by a stale network response completing afterward.
- There is no `AbortController` anywhere in `api.ts`, so even a deliberate "Cancel" affordance couldn't actually stop the in-flight request today — it could only ignore its result.

### Root cause

`connect()` was written assuming its own lifecycle (state-set → await → navigate) would always run to completion without the user taking a conflicting action mid-flight; the UI never considered that "Rescan" and "in-flight connect" could overlap.

### Redesign

1. Add a `generation`/`requestId` guard: before calling `redeemToken`, capture a locally incremented counter (`const myRequest = ++requestSeq.current`). In the `.then`/success branch, only call `navigation.replace(...)` if `myRequest === requestSeq.current` (i.e., no rescan/new-connect has happened since). Increment `requestSeq.current` again inside the Rescan `onPress` handler so any pending request is invalidated the moment the user backs out.
2. Additionally wire an `AbortController` through `redeemToken` (`api.ts:9-28`, add a `signal` param, pass `{ ...options, signal }` to `fetch`) and call `.abort()` from the Rescan handler, so the network request is actually cancelled, not merely ignored — this also directly enables the "Cancel while connecting" UX described in Finding 2's timeout work, since both need the same plumbing.
3. Disable/relabel the Rescan button while `connecting` is true to make the interaction unambiguous, e.g. change its label to "Cancel" during the connecting phase (same button, contextual label) rather than leaving both "Connect" (spinning, disabled) and "Rescan" (enabled, silently non-cancelling) visible simultaneously as if they were independent, unrelated actions.

### Tradeoffs

The `requestId` guard is a minimal, well-understood React pattern for exactly this class of race condition and adds only a few lines; combining it with real `AbortController` cancellation is slightly more invasive (touches `api.ts`'s signature) but is the more correct fix and is needed anyway for Finding 2's timeout support — recommend doing both together in one pass.

### Implementation plan

1. Add `AbortController` support to `redeemToken`'s signature in `api.ts`.
2. Add a `requestSeq` ref in `ScannerScreen`, increment on both connect-start and on Rescan.
3. Guard the `navigation.replace` call on the ref matching.
4. Relabel/restyle the Rescan button to "Cancel" while `connecting`.

### Migration strategy

Purely client-side; no backend/protocol change.

### Testing strategy

- Unit/integration test (can be done with a mocked `fetch` with a controllable delayed resolve): start `connect()`, tap Rescan before the mocked promise resolves, then resolve it — assert `navigation.replace` was never called and the scanner returns to its pre-scan state.
- Manual: throttle network (Xcode Network Link Conditioner / Android network throttling), scan, tap Connect, then quickly tap Rescan before it resolves — confirm no unexpected navigation to Viewer occurs afterward.

### Risk assessment

Low-medium risk — this is a well-scoped, additive guard; the main risk is forgetting to reset the guard on legitimate success (must not accidentally block the intended-successful `navigation.replace` call), which the "only invalidate on Rescan/new-connect" design avoids by construction.

### Performance impact

None; adds one ref comparison and, once `AbortController` is wired, an actual saved network round-trip when cancelled.

### Future extensibility

The same `requestId`-guard pattern should be applied anywhere else in the app that fires an async operation from a user action that can be superseded by another (e.g., the reconnect logic proposed in Finding 5 needs the identical guard against overlapping reconnect attempts).

---

## Finding 8: No connection-quality HUD (latency/bitrate/packet loss)

### Current implementation

The only persistent on-screen indicator during an active session is a single small badge showing the `ViewerState` label — literally just the word "Connected" once live (`STATE_LABEL.connected`, `ViewerScreen.tsx:37`) — rendered top-left over the video (`ViewerScreen.tsx:112-114,157-166`). Nothing else in `ViewerScreen.tsx` or `ViewerConnection` (`apps/mobile/src/lib/webrtc.ts`) reads or surfaces any WebRTC statistics: there is no call to `RTCPeerConnection.getStats()` anywhere in the reviewed files (confirmed by full-file read of `webrtc.ts`), no bitrate/resolution/framerate display, no round-trip-time/latency number, and no visual indicator of degrading network quality (e.g., a color-coded signal icon).

### Problems

- A user on a poor connection has no way to understand _why_ their session feels laggy — is it their Wi-Fi, the desktop's upload bandwidth, or the TURN relay path? Competing products (Parsec in particular) prominently surface latency/bitrate/FPS as a core trust-and-diagnostics signal; its absence here reads as unfinished/opaque by comparison.
- Without any quality signal, users can't make informed decisions (e.g., "my connection is bad, I should stop screen-sharing video and just do text work," or "I should switch from cellular to Wi-Fi") — the app gives zero telemetry to act on.
- Support/debugging is harder without this: a user reporting "it's laggy" gives the product team nothing to go on if the app itself never captured or displayed the underlying stats.

### Root cause

The M2 prototype's goal was "does the pipe work at all" (get a frame on screen); no work was done yet on the observability layer that a production client needs, even though the source of truth (`RTCPeerConnection.getStats()`) is a standard WebRTC API already available via `react-native-webrtc`, the library already in use (`apps/mobile/package.json:25`).

### Redesign

1. In `ViewerConnection`, add a polling interval (e.g. every 2s, mirroring the cadence of the existing `heartbeat` interval already present at `webrtc.ts:51`) that calls `this.pc?.getStats()` and extracts: current round-trip time (`candidate-pair.currentRoundTripTime`), inbound video bitrate (delta of `inbound-rtp.bytesReceived` over the poll interval), framerate (`inbound-rtp.framesPerSecond`), and packet loss (`inbound-rtp.packetsLost` / `packetsReceived`). Expose these via a new `onStats` callback in `ViewerCallbacks` (alongside the existing `onStream`/`onState`/`onError`, `webrtc.ts:20-24`).
2. In `ViewerScreen`, extend the existing top-left badge (`ViewerScreen.tsx:112-114`) into a small expandable HUD: default collapsed view shows a single color-coded dot (green/yellow/red, thresholded on RTT and packet loss) next to the state label; tapping it expands to show RTT (ms), bitrate (Mbps), and FPS as plain numbers — this reuses the existing badge's position and interaction model rather than adding new screen real estate.
3. Thresholds (starting point, tune with real data): green ≤80ms RTT & <2% loss; yellow ≤200ms RTT & <5% loss; red beyond that — these are product-tunable constants, not hardcoded magic numbers, so put them in a small `quality.ts` constants file.

### Tradeoffs

Polling `getStats()` has a small, well-understood CPU/battery cost; a 2s interval (matching the existing heartbeat cadence) is a reasonable balance recommended by WebRTC stats-polling conventions (sub-second polling is unnecessary for a human-facing quality indicator and wastes battery). Showing raw numbers (vs. only a colored dot) adds minor complexity but meaningfully increases user trust and self-diagnosis ability, which matters directly for the "compete with Parsec" mandate.

### Implementation plan

1. Add `onStats` to `ViewerCallbacks` and the polling/extraction logic to `ViewerConnection`.
2. Add `quality.ts` with threshold constants.
3. Extend the badge component in `ViewerScreen` into the collapsed/expandable HUD described above.
4. Ensure the polling interval is cleared in `ViewerConnection.close()` (`webrtc.ts:144-163`) alongside the existing heartbeat-interval cleanup, to avoid leaking timers.

### Migration strategy

Purely additive/client-side; `getStats()` is a standard `RTCPeerConnection` API already available through the existing `react-native-webrtc` dependency — no new native module or protocol change needed.

### Testing strategy

- Manual: throttle network mid-session and confirm the HUD's color/numbers visibly react within one or two polling intervals.
- Manual: verify the polling interval is torn down on disconnect (no console warnings/leaked timers after repeated connect/disconnect cycles — can be checked via a memory/timer leak check in dev builds).
- Unit test the stat-extraction/delta-bitrate math against a mocked `getStats()` report shape.

### Risk assessment

Low risk — read-only diagnostic addition with no effect on the media/control path; main risk is CPU/battery cost if the interval is set too aggressively (mitigated by the recommended 2s cadence) or if `getStats()`'s report shape differs subtly across platforms (iOS vs. Android `react-native-webrtc` implementations) — needs a quick compatibility check during implementation.

### Performance impact

Small, bounded, and controllable via polling interval; strictly better than the current zero-visibility state for helping users and support diagnose real performance problems.

### Future extensibility

This stats pipe is also the natural foundation for adaptive-bitrate decisions (out of scope here) and for anonymized quality telemetry sent to the backend for fleet-wide monitoring (also out of scope, flagged for awareness only).

---

## Finding 9: No device identity shown at the pairing-confirmation moment

### Current implementation

`QrPayloadSchema` (`packages/protocol/src/qr.ts:11-22`) contains exactly five fields: `v`, `token`, `roomId`, `apiBaseUrl`, `signalingUrl` — **no device name, no platform, no user-facing identity of any kind.** When `ScannerScreen` decodes a scanned QR and shows the "Pair with this laptop?" confirmation card (`ScannerScreen.tsx:118-135`), the only information it can display about the target machine is a truncated room UUID (`scanned.roomId.slice(0, 8)…`, `ScannerScreen.tsx:121`) and the raw API base URL (`scanned.apiBaseUrl`, `ScannerScreen.tsx:122`) — e.g. literally `http://192.168.1.50:4000`.

Notably, a human-readable device name _does_ exist in the system — `PairingRedeemResponse.desktopDeviceName` (`packages/protocol/src/pairing.ts:56`, populated from `PairingRecord.desktopDeviceName` set at `/pairing/create` time, `apps/backend/src/services/pairing.ts:17,46`) — but it is only returned **after** the token has already been redeemed (i.e., burned — tokens are single-use via Redis `GETDEL`, `apps/backend/src/services/pairing.ts:83`). By the time the app knows the device's name (`ViewerScreen.tsx:43`, `desktopDeviceName` prop, displayed only in the connecting placeholder at line 108), the single-use token is already spent — there is no "cancel and back out for free" moment once the name is known.

### Problems

- The one moment where a user is asked to make a trust decision — "Pair with this laptop?" — presents no actual identity signal a human can verify (a room UUID fragment and a raw local-network URL mean nothing to a novice), while the one piece of information that _would_ help (the device's name, e.g. "Kush's MacBook Pro") is deliberately not available at that point because it isn't in the QR payload at all.
- This is a security-legibility gap as much as a UX one: in an environment with multiple nearby Lilypad-enabled machines (an office, a shared house), a user could scan the wrong QR code and have no way to notice before committing (redeeming), because the confirmation card shows no distinguishing human-readable information.
- Showing the raw `apiBaseUrl` (a local IP:port) as if it were meaningful identity information is actively confusing rather than reassuring — it looks like a debug artifact, not a trust signal.

### Root cause

`QrPayloadSchema` was scoped to the minimum needed to make the redeem call (token + routing info) and never extended to carry a display-only device name, even though the backend already tracks and later returns that exact field post-redemption.

### Redesign

1. Add an optional `deviceName: z.string().max(120).nullable()` (matching the existing `MAX_NAME_LEN`-style bound used elsewhere, `packages/protocol/src/signaling.ts:25`) and `platform: PlatformSchema.optional()` field to `QrPayloadSchema` (`packages/protocol/src/qr.ts:11-22`), bumping `QR_PAYLOAD_VERSION` (`packages/protocol/src/constants.ts:8`) since this is a QR schema change that old desktop apps wouldn't populate — the scanner should treat a missing `deviceName` gracefully (fall back to today's "a laptop" copy) rather than hard-reject old QR versions outright, to avoid breaking compatibility unnecessarily.
2. Populate it server-side: `/pairing/create`'s response already has `req.deviceName`/`req.platform` available (`apps/backend/src/services/pairing.ts:41-49` — these are already collected into `PairingRecord`); the desktop's QR-generation step (out of scope for this mobile-only audit, but noted as the dependency) needs to include these two fields when encoding the QR payload via `encodeQrPayload` (`packages/protocol/src/qr.ts:27-29`).
3. In `ScannerScreen`'s confirmation card (`ScannerScreen.tsx:118-135`), replace the raw `apiBaseUrl` line (line 122) with the device name and a small platform icon (macOS/Windows/Linux glyph), and drop the raw URL and truncated room-UUID from the primary display entirely (move them to a collapsed "technical details" disclosure if needed for debugging, not the primary trust-decision copy) — e.g. **"Pair with Kush's MacBook Pro?"** with a Apple-logo glyph, matching the level of clarity a lock-screen Bluetooth-pairing prompt gives.

### Tradeoffs

This requires a QR payload schema version bump and a corresponding desktop-side change (out of this audit's scope but a real cross-team dependency) — it cannot be fixed by the mobile app alone. Given that, this finding should be filed as a paired mobile+desktop+backend ticket; the mobile-side redesign above is what to build once the payload carries the field. The version bump is low-risk since `decodeQrPayload` (`qr.ts:32-34`) already throws on schema mismatch, so an old scanner simply won't accept a new-format code (acceptable during a coordinated rollout) — recommend making the new fields optional precisely so a _new_ scanner can still accept an _old_ QR gracefully during a staged rollout, even though old-scanner-vs-new-QR would need version-gating.

### Implementation plan

1. (Cross-team) Add `deviceName`/`platform` optional fields to `QrPayloadSchema`; bump `QR_PAYLOAD_VERSION`.
2. (Desktop, out of scope here) Populate these fields when generating the QR.
3. (Mobile) Update the confirmation card in `ScannerScreen.tsx` to display device name + platform icon as primary identity, demoting/removing the raw URL and UUID fragment from primary view.
4. (Mobile) Handle the "no deviceName present" fallback gracefully (older QR version) with generic copy, not a hard error.

### Migration strategy

Staged: ship the schema change and desktop QR-generation change together (same release train); ship the mobile display change in the same or a closely following release. Because `decodeQrPayload` validates strictly against the current `QrPayloadSchema`, a mismatched major version should fail with the _friendly_ "That QR code is not a Lilypad pairing code" / "please update your app" copy (tie into Finding 2's error taxonomy) rather than a raw Zod validation error — confirm `ScannerScreen.tsx:44-49`'s existing catch-all already produces reasonably friendly copy here (it does: "That QR code is not a Lilypad pairing code.") though it could be more specific about "update one of your apps" if a version mismatch is detectable.

### Testing strategy

- Manual: scan a QR generated by a desktop build that populates the new fields; confirm the confirmation card shows the device name/icon, not the raw URL.
- Manual: scan a QR from an older desktop build lacking the new fields (or a hand-crafted payload omitting them); confirm graceful fallback copy, not a crash or raw validation error.
- Cross-team: confirm with the desktop team what identity information is actually available at QR-generation time (device name is already collected per `PairingCreateRequestSchema.deviceName`, `packages/protocol/src/pairing.ts:26`, but this audit did not review the desktop-side code that calls `/pairing/create`).

### Risk assessment

Medium risk purely due to the cross-team/schema-version coordination required; the mobile-only display change itself is low risk once the field exists.

### Performance impact

None.

### Future extensibility

Once device identity is in the QR payload, the same field can back a future (M5) "recently paired devices" list with recognizable names instead of raw IDs — noted for awareness, not proposed as in-scope work here.

---

## Finding 10: No pinch-zoom; multi-touch gestures misrouted as single-pointer input

### Current implementation

The remote video is rendered via `RTCView` with `objectFit="contain"` inside a `View` wrapped in a single `PanResponder` (`ViewerScreen.tsx:67-92,101-103`). `onStartShouldSetPanResponder`/`onMoveShouldSetPanResponder` both simply return `canControl` (a boolean based on session scopes, `ViewerScreen.tsx:66,70-71`) — they do not inspect `e.nativeEvent.touches.length` to distinguish a one-finger tap/drag from a two-finger pinch. `onPanResponderGrant`/`Move`/`Release` all read `e.nativeEvent.locationX/locationY` (`ViewerScreen.tsx:75-88`), which RN's gesture responder system populates from a single representative touch even during a multi-touch gesture — there is no scale/rotation gesture recognizer (no `react-native-gesture-handler` `PinchGestureHandler`/`Reanimated` scale transform anywhere in `ViewerScreen.tsx`, despite `react-native-gesture-handler` already being a project dependency, `apps/mobile/package.json:21`, imported for navigation's benefit in `App.tsx:1` but unused for the viewer's own gestures).

### Problems

- There is no way to zoom into a region of the remote screen — a real need on a phone-sized viewport showing a full laptop display, especially for reading small text or interacting with small UI targets (a title bar's window controls, a small icon), which is table-stakes in Parsec/Jump Desktop/AnyDesk.
- Worse than merely "missing": attempting the natural two-finger pinch gesture today doesn't fail silently — it actively sends spurious `pointer_move`/`pointer_down` events to the desktop (since the single `PanResponder` still claims the touch and reads one finger's coordinates), producing an unexpected cursor jump/click on the remote machine exactly when the user was trying to zoom, not click.

### Root cause

`PanResponder` was wired for the simplest case (one-finger tracking → remote cursor) without gating on touch count, and no dedicated pinch recognizer was added despite `react-native-gesture-handler` already being present in the dependency tree for other purposes.

### Redesign

1. Gate the existing `PanResponder`'s `onStartShouldSetPanResponder`/`onMoveShouldSetPanResponder` on `e.nativeEvent.touches.length === 1` (in addition to the existing `canControl` check), so a second touch landing mid-gesture causes the responder to release control-forwarding rather than continuing to emit single-pointer events from whichever touch RN happens to report.
2. Add a `PinchGestureHandler` (from the already-installed `react-native-gesture-handler`) wrapping the video container, driving a `Reanimated`-style (or simple `Animated.Value`, whichever pattern the rest of the codebase already favors — none was found in the audited files, so either is a reasonable first introduction) scale+translate transform applied to the `RTCView`'s container `View`, clamped to a sane range (e.g. 1x–4x) with a double-tap-to-reset-zoom gesture as a common companion affordance.
3. Ensure pinch-zoom and pointer-control are mutually exclusive per-gesture (once a second touch is detected, stop forwarding pointer events for that gesture entirely until both fingers lift and a fresh single-touch gesture begins) rather than trying to support simultaneous zoom-while-clicking, which is unnecessary complexity for the core use case.

### Tradeoffs

Local pinch-zoom (client-side crop/scale of the already-received video frame) is the right scope here — it does not require requesting a higher-resolution stream or changing anything server/desktop-side, keeping this squarely a "perfect what exists" mobile-only change. The tradeoff is that zooming only magnifies the existing stream resolution (no extra clarity beyond the source bitrate/resolution), which is an acceptable, well-understood limitation shared by every competitor's basic pinch-zoom implementation too.

### Implementation plan

1. Add the touch-count gate to the existing `PanResponder` handlers.
2. Add `PinchGestureHandler` + transform state (scale/translateX/translateY) wrapping the `screen` container (`ViewerScreen.tsx:101`).
3. Add double-tap-to-reset (a `TapGestureHandler` with `numberOfTaps: 2}`) and clamp scale bounds.
4. Verify gesture-handler and `PanResponder` don't fight for the responder chain (may require migrating the single-touch control path itself onto `react-native-gesture-handler`'s `PanGestureHandler` for a unified gesture system rather than mixing `PanResponder` and gesture-handler, which is the more robust long-term architecture, though a larger diff — flag as the "do it right" option vs. the touch-count-gate as the "minimal fix" option).

### Migration strategy

Client-only, additive; no protocol change (coordinates sent to the desktop remain normalized 0..1 against the _unzoomed_ frame — zoom is a purely local viewport transform and must not alter the coordinate math fed into `InputSender.pointerMove/Down/Up`, which needs to keep using the underlying layout dimensions, not the zoomed visual ones — this is an important implementation detail: the `layout.current` ref used for normalization, `ViewerScreen.tsx:48,61-63`, must remain the true unzoomed container size, with zoom purely a rendering-layer transform).

### Testing strategy

- Manual: two-finger pinch mid-video, confirm smooth zoom with no stray click/move sent to the desktop (verify on the desktop side, or via the stats/logging added in Finding 8, that no unexpected input events fire during a pinch gesture).
- Manual: after zooming in, perform a single-finger drag; confirm the remote cursor still moves correctly proportional to the _unzoomed_ coordinate space (i.e., zoom is cosmetic-only for the local view, not a change to what's sent over the wire).
- Manual: double-tap resets zoom to 1x.

### Risk assessment

Medium risk — touch-gesture interaction bugs (responder conflicts, coordinate-math regressions in the click/drag path) are easy to introduce; requires careful manual testing across both gesture systems if both `PanResponder` and `react-native-gesture-handler` are used side by side (the "minimal fix" option) rather than unified (the "do it right" option, lower long-term risk but larger diff).

### Performance impact

Negligible — a transform on an already-rendered `RTCView` is cheap; no change to encode/decode/network path.

### Future extensibility

The same zoom-transform layer is the natural place to add a future "fit to width" vs. "fit to screen" toggle, though that's out of scope here.

---

## Finding 11: Zero accessibility semantics app-wide; control surface unusable with VoiceOver

### Current implementation

A full-text search of every audited screen and `App.tsx` for `accessib` (covering `accessibilityLabel`, `accessibilityRole`, `accessibilityHint`, `accessible`, etc.) returns **zero matches**. Every interactive element across all four screens — the Login "Continue" button (`LoginScreen.tsx:41-43`), the Devices "Scan a laptop's QR" button (`DeviceListScreen.tsx:24-26`), the Scanner's permission/connect/rescan buttons (`ScannerScreen.tsx:85-90,125-144`), and the entire Viewer toolbar/disconnect/control surface (`ViewerScreen.tsx:101,120-127,132-135`) — is a bare `Pressable` with only visual (`Text`) content and no accessibility metadata.

The remote-control touch surface specifically (`ViewerScreen.tsx:101`, the `View` with `{...panResponder.panHandlers}`) has no `accessible`/`accessibilityRole` props and relies entirely on raw multi-touch gesture capture via `PanResponder`.

### Problems

- Every button in the app is reachable by VoiceOver/TalkBack only via its literal visible text content (which happens to work passably for text-labeled buttons like "Connect"/"Disconnect," but is a fragile accident of implementation, not a deliberate accessible design — e.g. the toolbar's single-glyph arrow buttons `'←' '↑' '↓' '→'` (`ViewerScreen.tsx:28-31`) have no `accessibilityLabel`, relying entirely on the screen reader's Unicode-glyph-name fallback pronunciation, which is inconsistent across platforms/OS versions).
- Most critically: the core control surface — the `PanResponder`-driven remote-desktop touchpad — has no accessible alternative interaction model at all. A screen-reader user cannot use direct-touch remote control the way a sighted user does, because VoiceOver/TalkBack's own touch-exploration gesture model intercepts raw touches for its own navigation purposes; an app that wants raw touch-through for a "trackpad" surface while VoiceOver is active needs to explicitly opt a region out via `accessibilityViewIsModal`/`accessible={false}`-with-a-declared-custom-gesture-adapter pattern (platform-standard approach for exactly this "canvas-like direct manipulation surface" case) — none of which exists here. In its current state, a screen-reader user attempting to control the remote desktop by touch will find VoiceOver intercepting their gestures instead of forwarding them, effectively locking blind/low-vision users out of the app's core control functionality entirely.
- This is not merely a nice-to-have: for a production remote-desktop product, an unusable-with-VoiceOver control surface is both an ethical/legal exposure (accessibility compliance expectations for consumer apps) and a direct product-quality gap versus mature competitors.

### Root cause

Accessibility was not addressed at any point in the M1/M2 build — there is no partial implementation to build on, only a clean absence.

### Redesign

1. **Baseline pass (all screens):** add `accessibilityRole="button"` and a descriptive `accessibilityLabel` to every `Pressable` (e.g. `"Scan a laptop's QR"` stays as-is since it's already descriptive text; the toolbar arrow buttons get explicit labels like `"Arrow left"`, `"Arrow up"`, etc., `ViewerScreen.tsx:28-31`; the Disconnect button gets `accessibilityHint="Ends the current remote session"`). This is a mechanical, low-risk pass across all four screens.
2. **Scanner screen:** add `accessibilityLabel`/announce-on-scan behavior — e.g. when a QR is successfully decoded, use `AccessibilityInfo.announceForAccessibility('QR code detected. Review the pairing details below.')` so a VoiceOver user navigating a screen dominated by a live camera preview (which has no meaningful accessible content of its own) knows something happened without needing to see the reticle.
3. **Viewer control surface:** this is the substantial piece of work. Two complementary approaches, not mutually exclusive:
   - Provide an explicit, clearly-labeled **"Accessible control mode"** alternative to raw-touch dragging: e.g. a D-pad-style directional nudge control (reusing the same arrow-key `shortcut` actions already in the toolbar, `ViewerScreen.tsx:28-31`, which map to real keyboard arrow presses on the remote machine — already fully accessible today since they're ordinary labeled buttons) plus an explicit "Tap here to click" button that sends a click at the last-known/centered cursor position — this reuses 100% of existing `InputSender` capability (`click`, `shortcut`) with zero new protocol work, just an alternate, fully VoiceOver-navigable set of controls.
   - For the direct-touch surface itself, mark it `accessible={false}` with an adjacent, always-visible (not just VoiceOver-only) **"Switch to accessible controls"** toggle button so screen-reader users have a documented, discoverable path rather than silently failing to use the trackpad — this is more honest than trying to make raw two-dimensional relative-position dragging meaningfully accessible via VoiceOver gestures, which fights the platform's own interaction model.
4. **Touch target sizing:** ensure every interactive element meets the 44×44pt (iOS)/48×48dp (Android) minimum — cross-reference Finding 20 for the specific toolbar measurements that need adjusting.

### Tradeoffs

Building a fully separate "accessible control mode" is real, scoped work (new small components, not a new _capability_ since it only recombines existing `InputSender` methods) — but it's the honest solution; attempting to make a raw drag-surface "accessible" via VoiceOver's own gesture passthrough APIs is fragile, poorly documented across RN versions, and would likely still produce a worse experience than a purpose-built alternative control scheme. Recommend the explicit-alternate-mode approach.

### Implementation plan

1. Mechanical baseline pass: add `accessibilityRole`/`accessibilityLabel`/`accessibilityHint` to every `Pressable` across all four screens.
2. Add `AccessibilityInfo.announceForAccessibility` calls at key state transitions (QR detected, connected, error shown, approval-wait entered per Finding 1).
3. Build the D-pad/click-button "accessible control mode" as an alternate view swapped in via a toggle in `ViewerScreen`, reusing existing `InputSender.shortcut`/`click` calls.
4. Audit and correct touch-target sizes app-wide (ties to Finding 20).

### Migration strategy

Entirely additive and client-side; no protocol or backend changes (the accessible control mode uses existing `InputSender` methods unchanged). Ship the mechanical labeling pass immediately (near-zero risk); ship the accessible control mode as a slightly larger, separately-tested addition.

### Testing strategy

- Enable VoiceOver (iOS)/TalkBack (Android) and navigate every screen end-to-end; confirm every interactive element is announced with a clear, accurate label and role.
- With VoiceOver on, attempt to reach and use the new "accessible control mode" toggle and D-pad; confirm a screen-reader user can navigate the remote desktop (move focus, click, type via Finding 3's keyboard) without needing raw-touch dragging.
- Automated: RN Testing Library / `jest-native`'s accessibility matchers can assert `accessibilityLabel` presence on a snapshot of each screen's interactive elements as a regression guard.

### Risk assessment

Low risk for the mechanical labeling pass; medium effort (not risk) for the accessible control mode, since it's genuinely new UI surface, though built entirely from existing, already-tested input primitives.

### Performance impact

None.

### Future extensibility

Once an "accessible control mode" exists as a distinct, toggleable input scheme, it's also a reasonable fallback UI for any future non-touchscreen input context (e.g. a hypothetical tablet-with-keyboard-only scenario), though that's speculative and out of scope.

---

## Finding 12: Native back-gesture/header conflicts with left-edge touch control

### Current implementation

`App.tsx`'s `Stack.Navigator` registers the `Viewer` screen with only a `title` option (`App.tsx:42`, `options={{ title: 'Session' }}`) — no `headerShown: false` and no `gestureEnabled: false`. `@react-navigation/native-stack` (`apps/mobile/package.json:18`) defaults to showing a native header (with a back button) and, on iOS, enabling the standard edge-swipe-to-go-back gesture, neither of which is overridden anywhere in the codebase (confirmed by reading the full `App.tsx`). Meanwhile, `ViewerScreen`'s remote-control touch surface spans the full width of the video container via `PanResponder`, including its left edge (`ViewerScreen.tsx:101`, `onStartShouldSetPanResponder: () => canControl`, with no exclusion zone near the screen edge).

### Problems

- A user attempting to click or drag near the left edge of the remote screen (e.g., a browser back button, a dock/taskbar pinned to the left, a sidebar) risks the OS/React-Navigation interpreting the touch-start as the system "swipe from edge to go back" gesture instead of (or in addition to) the app's own control gesture — on iOS in particular, edge-swipe-back is a system-level gesture recognizer that can win priority races against a plain `PanResponder`, depending on exact recognizer configuration.
- The header itself ("Session" title + implicit back button) is redundant with, and inconsistent alongside, the app's own explicit bottom "Disconnect" button (`ViewerScreen.tsx:131-135`): there are now two different ways to leave the viewer (header back button/gesture vs. the Disconnect button), which take slightly different code paths (a stack pop triggers cleanup via the `useEffect` unmount cleanup, `ViewerScreen.tsx:58`, while the Disconnect button explicitly calls `connRef.current?.close()` then navigates, `ViewerScreen.tsx:94-97`) — both currently converge on the same underlying `ViewerConnection.close()`, but having two divergent-looking exits is confusing UI, and the more serious issue is the left-edge gesture conflict itself, not the cleanup logic.
- A visible header also permanently consumes vertical space that a full-bleed remote-desktop viewer would rather spend on video, compounding the landscape space-pressure noted in Finding 16.

### Root cause

The `Viewer` screen was registered with the same default `Stack.Screen` options as every other screen (`App.tsx:34-43`) without considering that it's a full-screen, edge-to-edge, gesture-heavy surface fundamentally unlike the other three (list/scanner/form) screens in the stack.

### Redesign

Set `options={{ headerShown: false, gestureEnabled: false }}` specifically on the `Viewer` `Stack.Screen` registration (`App.tsx:42`), removing both the native header and the edge-swipe-back gesture for this screen only (the other three screens keep their current header/gesture behavior, which is appropriate for them). This makes the explicit, always-visible "Disconnect" button (`ViewerScreen.tsx:131-135`) the single, unambiguous way to leave a session — matching the pattern used by Parsec/AnyDesk/Jump Desktop, none of which show a system nav header during an active remote session.

### Tradeoffs

Disabling the back gesture removes a normally-expected iOS affordance; this is the correct tradeoff specifically _because_ the screen already provides its own clearly-labeled exit action, and because the gesture directly conflicts with core in-session touch control — this is the standard, well-precedented pattern for "full-screen immersive/gesture-heavy" screens in RN apps (video players, camera screens, games), not a novel choice.

### Implementation plan

1. Add `headerShown: false, gestureEnabled: false` to the `Viewer` screen's `options` in `App.tsx:42`.
2. Since the header disappears, ensure `ViewerScreen` itself accounts for the status bar area (ties directly into Finding 15's safe-area work — without the native header, the screen's own top content must now handle the top inset that the header used to implicitly provide).
3. Re-verify the Disconnect button remains reachable and unambiguous as the sole exit path (no regression to its existing behavior, `ViewerScreen.tsx:94-97`).

### Migration strategy

Single-line-plus-safe-area-follow-up client-side change; no backend/protocol impact.

### Testing strategy

- Manual, iOS: attempt a left-edge swipe while a session is active; confirm it no longer partially-navigates back or produces any visible transition, and that a click/drag near the left edge of the remote screen behaves purely as remote-control input.
- Manual: confirm the header/title is gone and the screen's top content doesn't collide with the status bar/notch (tie to Finding 15's testing).
- Regression: confirm Disconnect still correctly tears down the connection and navigates to `Devices` (`ViewerScreen.tsx:94-97`).

### Risk assessment

Low risk — this is a well-understood, narrowly-scoped navigation-options change; the main follow-up risk is the safe-area gap it opens up (addressed together with Finding 15).

### Performance impact

Slightly positive (one fewer rendered header view; marginally more screen space for video).

### Future extensibility

None specific; this is a one-time configuration correction.

---

## Finding 13: Disconnect has no confirmation, undo, or intent-guard

### Current implementation

The bottom "Disconnect" button is a single full-width `Pressable` (`ViewerScreen.tsx:131-135`, styled via `styles.disconnect`/`styles.controls`, `ViewerScreen.tsx:178-187`) whose `onPress` immediately calls `connRef.current?.close()` followed by `navigation.replace('Devices')` (`ViewerScreen.tsx:94-97`) — no confirmation dialog, no delay, no undo.

### Problems

- The button sits in the bottom control row, i.e., squarely in the thumb-reach "fat finger" zone of the screen, directly below a scrollable toolbar (`ViewerScreen.tsx:117-129`) that the user is expected to be actively tapping/scrolling through during a session — an accidental tap immediately and irreversibly ends the session with no recovery beyond re-scanning a QR (and, per Finding 5, no reconnect shortcut exists today even if the disconnect were intentional).
- There's no visual/interaction distinction in severity between this destructive, session-ending action and the ordinary toolbar shortcut buttons directly above it, despite it being categorically different (everything else is reversible; this is not, in the current implementation).

### Root cause

The button was implemented as a direct, single-step action with no thought given to accidental-tap protection, likely because the M1/M2 focus was "does teardown work at all," not "is teardown safe to invoke by accident."

### Redesign

Add a lightweight confirmation without adding real friction for the common intentional case: on tap, show an inline confirmation (not a full modal — a quick two-state button, e.g. the button itself morphs to "Tap again to disconnect" for ~2 seconds before reverting, or a small anchored popover with "Disconnect" / "Cancel") rather than a blocking `Alert.alert` dialog (which would be overkill friction for a frequently-used action, but _zero_ confirmation is the wrong other extreme for a destructive, currently-irreversible action). Given Finding 5 will add real reconnect capability, once that ships the urgency of this guard decreases somewhat (an accidental disconnect becomes a one-tap recovery), but the guard is still worth having independently since even a fast reconnect is a worse experience than not having disconnected at all.

### Tradeoffs

A blocking modal (`Alert.alert`) is the simplest implementation but adds real friction to the common, intentional case (ending a session when done) — the two-state "tap again to confirm" pattern (used by e.g. delete-confirmation patterns in many mobile apps) better balances safety against speed, at the cost of slightly more custom UI code than a one-line `Alert.alert` call.

### Implementation plan

1. Add local `confirmingDisconnect` state to `ViewerScreen`; first tap sets it true and starts a 2s timer reverting it to false; while true, button label/style change to a "confirm" state; a second tap while `confirmingDisconnect` is true actually calls `disconnect()`.
2. Ensure the confirming state is visually distinct (e.g., color shift to a more urgent red/pulse) so the two-tap requirement is discoverable, not a hidden trap.

### Migration strategy

Client-only, no backend/protocol impact.

### Testing strategy

- Manual: single accidental tap no longer ends the session; a deliberate double-tap-within-2s does.
- Manual: verify the 2s window resets correctly if the user taps once and then does nothing (button reverts to normal, not stuck in "confirm" state).

### Risk assessment

Low risk — small, self-contained UI state addition with no effect on the underlying teardown logic (`ViewerConnection.close()` itself is unchanged).

### Performance impact

None.

### Future extensibility

The same two-tap-confirm pattern is reusable for any other destructive one-tap action the app adds later.

---

## Finding 14: Toolbar — no haptics, no scroll affordance, no visual hierarchy, no key-repeat

### Current implementation

The control toolbar is a horizontal `ScrollView` (`showsHorizontalScrollIndicator={false}`, `ViewerScreen.tsx:118`) containing nine visually-identical `Pressable` "keys" (`ViewerScreen.tsx:22-32,119-127`, styled uniformly via `styles.key`/`styles.keyText`, `ViewerScreen.tsx:168-177`) — Copy, Paste, Esc, Tab, Enter, and four arrow glyphs. Each `onPress` fires a single, immediate `shortcut()` call (`ViewerScreen.tsx:123`, `apps/mobile/src/lib/input.ts:65-67`, which enqueues-and-immediately-flushes per `enqueue(ev, true)`). A full-text search of the mobile app for `Haptic` returns zero matches — no haptic feedback library is imported or used anywhere.

### Problems

- **No haptics:** every tap on every toolbar key (and every other button in the app) is silent/feedback-less beyond the visual `Pressable` press-state, which on a remote-control surface specifically — where the user has no direct visual confirmation that a _remote_ action occurred, only that they tapped _something_ locally — is a meaningfully worse experience than competitors that confirm key presses with a light haptic tick.
- **No scroll affordance:** with nine equal-width buttons in a horizontally-scrolling row and the scroll indicator explicitly hidden (`showsHorizontalScrollIndicator={false}`), a user on a narrow phone has no visual cue that more keys exist off-screen to the right (or left, once scrolled) — no fade-edge mask, no partial-button peek guarantee, no arrow indicator. Whether all nine fit depends entirely on screen width and is not verified anywhere in the layout.
- **No visual hierarchy:** Copy/Paste/Esc/Tab/Enter/arrows are all styled identically (`styles.key`, `ViewerScreen.tsx:168-176`) despite having very different semantic weight and risk (Enter is extremely high-frequency; Esc frequently cancels something; arrows are directional/low-risk; Copy/Paste bridge clipboards). Nothing distinguishes them visually to speed up recognition/reduce mis-taps.
- **No key-repeat on arrows:** each arrow tap sends exactly one `shortcut('arrow_*')` event (`ViewerScreen.tsx:123`); moving a text cursor several characters/lines requires the same number of discrete taps, with no press-and-hold auto-repeat — a real friction point for a control meant to substitute for a physical arrow key's natural repeat behavior.

### Root cause

The toolbar was built as a flat, uniform list of buttons sufficient to prove the shortcut-forwarding pipeline works end-to-end; no polish pass (haptics, grouping, repeat behavior) followed.

### Redesign

1. **Haptics:** add `expo-haptics` or RN's built-in `Vibration`/community haptics library (whichever the team standardizes on — none is currently in `package.json`, so this is one new small dependency, justified given "haptics" is explicitly named in the audit mandate) and fire a light `impactAsync(Light)` on every toolbar key press and a slightly heavier tick on Disconnect-confirm (Finding 13).
2. **Scroll affordance:** re-enable the scroll indicator (`showsHorizontalScrollIndicator={true}` — cheap, immediate fix) and/or add a subtle linear-gradient fade mask at the trailing edge of the `ScrollView` when there's more content to reveal (a common, low-cost pattern: absolutely-positioned gradient `View`s at both ends, shown/hidden based on scroll-position state from `onScroll`).
3. **Visual hierarchy:** group related keys with spacing/dividers — e.g. `[Copy, Paste]` | `[Esc, Tab, Enter]` | `[← ↑ ↓ →]` as three visually separated clusters (a thin vertical divider or extra margin between groups) rather than one undifferentiated row; consider a subtly different fill color for the arrow cluster (lower-risk, high-frequency directional keys) vs. Esc (higher-consequence).
4. **Key-repeat:** for the four arrow buttons specifically, replace the plain `onPress` with a press-and-hold handler (`onPressIn` starts a repeat interval, e.g. 400ms initial delay then 60ms repeat, calling `shortcut()` on each tick; `onPressOut` clears it) — this directly reuses the existing `InputSender.shortcut` call, no protocol change.

### Tradeoffs

Adding a haptics dependency is the one piece of genuinely new surface area in this finding (a new package), justified because it's explicitly called out in the audit mandate and is a near-zero-risk, purely-local addition; everything else (scroll indicator, grouping, key-repeat) is styling/interaction-only with zero new dependencies.

### Implementation plan

1. Add haptics dependency; wire a single shared `hapticTap()` helper called from every toolbar `onPress` (and other primary buttons app-wide, for consistency).
2. Flip `showsHorizontalScrollIndicator` to `true`; add the fade-mask overlay driven by scroll position.
3. Restructure the `TOOLBAR` array/render into three grouped clusters with visual separation and a distinct arrow-cluster background tint.
4. Implement press-and-hold repeat for the four arrow buttons.

### Migration strategy

Purely additive client-side change; no protocol/backend impact.

### Testing strategy

- Manual: confirm haptic tick fires on every toolbar tap on a physical device (haptics don't simulate in the iOS Simulator — must test on hardware).
- Manual: confirm the scroll-fade/indicator correctly reflects whether more keys exist off-screen at both ends.
- Manual: press-and-hold an arrow key; confirm repeated `shortcut()` events fire at the expected cadence and stop cleanly on release (verify via the desktop side or the stats/logging from Finding 8 that events aren't leaking after release).

### Risk assessment

Low risk — isolated to the toolbar's own rendering/interaction code; the key-repeat interval must be carefully cleared on `onPressOut`/unmount to avoid a leaked interval continuing to fire shortcuts after the user releases (standard `useRef`+`clearInterval` pattern, same caution as the existing heartbeat/flush-timer cleanup already present elsewhere in the codebase, e.g. `apps/mobile/src/lib/input.ts:31-35`).

### Performance impact

Negligible.

### Future extensibility

The grouped-cluster toolbar layout is a natural place to add further shortcuts later without it becoming a wall of undifferentiated buttons (not proposed here, per the no-new-features mandate, but worth noting the redesign doesn't box that in).

---

## Finding 15: Safe-area insets installed but never consumed

### Current implementation

`App.tsx` wraps the entire navigation tree in `SafeAreaProvider` (`App.tsx:6,31`, from `react-native-safe-area-context`, already a dependency, `apps/mobile/package.json:23`). A full-text search of `apps/mobile/src` for `useSafeAreaInsets`/`SafeAreaView`/`insets` returns **zero matches** — no screen consumes the provider it's wrapped in. Every screen uses fixed `padding`/layout values instead: `LoginScreen`'s container uses `padding: 24` (`LoginScreen.tsx:50`), `DeviceListScreen` uses `padding: 24` (`DeviceListScreen.tsx:32`), and — most consequentially — `ViewerScreen`'s root container uses a flat `padding: 16` (`ViewerScreen.tsx:145`) with no adjustment for device-specific safe-area geometry (notch, Dynamic Island, home indicator, punch-hole camera).

### Problems

- On notched/Dynamic-Island iPhones and punch-hole Android devices, fixed padding is either too generous (wasting screen space unnecessarily on devices whose safe inset is smaller than the hardcoded padding) or insufficient (risking content sitting under a notch/home-indicator on devices whose safe inset is larger) — the current implementation happens to "work" only by accident/luck on whichever devices were used for development, not by design.
- This bites hardest exactly on `ViewerScreen` once Finding 12's `headerShown: false` change lands: today the native header (which React Navigation itself safe-area-adjusts automatically) incidentally protects the top of the screen from notch collision; removing that header without adding explicit inset-handling would expose this latent gap immediately.
- For a remote-desktop viewer specifically, safe-area handling isn't just about avoiding collisions — it's about _choosing_ how much of the notch/home-indicator area to reclaim for video. A production-quality viewer (per the "compete with Parsec" mandate) should deliberately go edge-to-edge for the video itself while keeping interactive controls (toolbar, disconnect) safely inset, which requires explicit insets consumption, not fixed padding, to do correctly on every device.

### Root cause

`SafeAreaProvider` was added (likely boilerplate from a React Navigation template) but no screen was ever updated to actually read `useSafeAreaInsets()`; fixed padding values were used instead throughout.

### Redesign

1. In each screen, replace fixed container padding with `useSafeAreaInsets()`-derived values where the container touches a screen edge — e.g. `ViewerScreen`'s root `container` style (`ViewerScreen.tsx:145`) should apply `paddingTop: Math.max(16, insets.top)`, `paddingBottom: Math.max(16, insets.bottom)`, `paddingLeft/Right: Math.max(16, insets.left/right)` (the `Math.max` preserves the existing 16px minimum visual breathing room while additionally respecting a larger true device inset where one exists).
2. Specifically for `ViewerScreen` post-Finding-12 (no native header), make the _video container_ extend into the top safe area (behind the notch/status bar) for maximum immersion — matching Parsec/AnyDesk's edge-to-edge video convention — while keeping the toolbar and Disconnect button's own padding safe-area-aware so they never sit under a home indicator or side bezel in landscape.
3. Apply the same `insets`-derived padding pattern to `LoginScreen`/`DeviceListScreen`/`ScannerScreen` containers for consistency, even though their fixed-padding risk is lower (they're simpler, centered layouts) — worth doing in the same pass since the hook is being introduced anyway.

### Tradeoffs

Making the video go edge-to-edge behind the status bar/notch while keeping controls inset requires slightly more careful layering (two different padding treatments within the same screen) than a single uniform padding value — the added complexity is justified by the direct visual/immersion payoff for the screen users spend the most time on.

### Implementation plan

1. Import and call `useSafeAreaInsets()` in each of the four screens.
2. Replace fixed `padding` container styles with insets-aware equivalents per the `Math.max` pattern above.
3. For `ViewerScreen`, split the layout into an edge-to-edge video region and an inset-respecting control region (toolbar + disconnect).
4. Re-verify against Finding 12's header removal together, since the two changes interact directly (removing the header removes its automatic top-inset handling, exactly when this fix supplies an explicit replacement).

### Migration strategy

Client-only; no backend/protocol impact. Should land in the same PR/review pass as Finding 12 given the direct interaction.

### Testing strategy

- Manual, on a notched/Dynamic-Island device and a punch-hole Android device, in both portrait and landscape: confirm no control (toolbar, disconnect button, badge/HUD) is ever obscured by or overlapping a physical sensor housing or the home-indicator gesture area.
- Manual: confirm the video itself extends further toward the physical screen edges than before (visual before/after comparison), consistent with the edge-to-edge goal.

### Risk assessment

Low risk — `react-native-safe-area-context` is a mature, already-integrated dependency; the change is additive layout math, not new interaction logic.

### Performance impact

None.

### Future extensibility

Once insets are consistently consumed, any future full-screen/immersive-mode work (e.g., auto-hiding chrome, Finding 16) builds directly on top of correct inset math rather than needing to retrofit it.

---

## Finding 16: Landscape layout not optimized; no immersive/auto-hide chrome

### Current implementation

iOS is configured to support portrait and both landscape orientations (`apps/mobile/ios/LilypadMobile/Info.plist:43-47`, `UISupportedInterfaceOrientations` lists `Portrait`, `LandscapeLeft`, `LandscapeRight`), and Android is configured to handle orientation config changes without restarting the activity (`apps/mobile/android/app/src/main/AndroidManifest.xml:20`, `android:configChanges` includes `orientation|screenSize|...`) — so rotation is enabled at the platform level. However, `ViewerScreen`'s layout is a single fixed vertical `View` stack regardless of orientation: video container (`flex: 1`), then the toolbar (`maxHeight: 52`), then the controls row (`ViewerScreen.tsx:100-135,144-187`) — there is no `useWindowDimensions`/orientation-aware branching anywhere in the file (confirmed by full-file read) that would, for example, reduce or hide the toolbar/controls in landscape to reclaim vertical space for video.

### Problems

- In landscape — precisely the orientation where a remote desktop viewer is used most, since laptop screens are landscape — the fixed-height toolbar (52pt) and controls row (disconnect button + its padding) remain permanently visible, consuming a fixed amount of the already-scarcer vertical space in landscape, on top of the (currently non-existent, per Finding 15) safe-area padding on the sides.
- There is no "immersive mode" (tap-to-reveal, auto-hide-after-idle chrome) of the kind virtually every competing remote-desktop and video-player app implements for exactly this reason — video content is what deserves the pixels; controls should be summonable, not permanently resident, especially in landscape.

### Root cause

The layout was built once, in a portrait-first mental model, and never revisited for the orientation that will actually dominate real usage of the product it's building toward.

### Redesign

1. Use `useWindowDimensions()` to detect landscape (`width > height`) and, when landscape, default the toolbar + controls row to a **hidden, tap-to-reveal overlay** state: a single tap anywhere on the video (that isn't consumed by an active drag/pinch gesture) toggles a semi-transparent overlay containing the toolbar and Disconnect button, auto-hiding again after a few seconds of inactivity (standard video-player/immersive-mode pattern). In portrait, keep the current always-visible layout (vertical space is comparatively less scarce there, and the mandate is about fixing landscape specifically, not eliminating the persistent-controls option project-wide).
2. Ensure the reveal/hide animation doesn't interfere with the `PanResponder`/pinch gestures from Finding 10 — the "tap to reveal" recognizer must be a distinct, lower-priority tap gesture that only fires on a tap that isn't already claimed by a drag/pinch.

### Tradeoffs

An auto-hide overlay adds real interaction-state complexity (timers, gesture-priority coordination with Findings 10/13) but is the standard, expected pattern for this exact category of app in landscape; keeping controls permanently visible in landscape (the simpler option) meaningfully under-serves the primary-orientation use case for a product positioned against Parsec/AnyDesk/Jump Desktop, all of which implement some form of this pattern.

### Implementation plan

1. Add `useWindowDimensions()`-driven orientation detection to `ViewerScreen`.
2. Build the tap-to-reveal overlay state (visible/hidden + auto-hide timer) wrapping the existing toolbar+controls views, active only in landscape.
3. Coordinate gesture priority with the pinch/drag work from Finding 10 so a control-surface tap-to-reveal doesn't fight with in-progress remote-control gestures.

### Migration strategy

Client-only, additive; no backend/protocol impact. Recommend sequencing this after Finding 10 (pinch/gesture work) and Finding 15 (safe-area insets) land, since all three touch the same screen region and gesture-priority interactions are easier to get right once done together rather than layered independently.

### Testing strategy

- Manual: rotate to landscape mid-session; confirm toolbar/controls auto-hide after a few seconds and reappear on tap, without interfering with an active drag/pinch/click.
- Manual: confirm portrait behavior is unchanged (always-visible controls, no regression).

### Risk assessment

Medium risk given the gesture-priority coordination required with Findings 10/13; recommend implementing and testing this together with those rather than in isolation.

### Performance impact

Slightly positive in landscape (marginally larger effective video area most of the time); negligible cost from the timer/animation itself.

### Future extensibility

The same auto-hide overlay mechanism is reusable if a future picture-in-picture or fullscreen-toggle feature is ever added, though neither is proposed here.

---

## Finding 17: Dark-only theme, not adaptive to system appearance

### Current implementation

`apps/mobile/src/theme.ts` defines exactly one palette object (`bg`, `panel`, `ink`, `muted`, `accent`, `danger`, `line`, all fixed hex values, `theme.ts:1-9`) with no light-mode counterpart and no `useColorScheme()`/`Appearance` API usage anywhere in the audited files. `App.tsx` hardcodes `DarkTheme` from React Navigation as the base theme (`App.tsx:4,17-27`) and hardcodes `<StatusBar barStyle="light-content" .../>` (`App.tsx:32`) regardless of the device's system appearance setting.

_(Note: I computed the WCAG contrast ratios for `theme.muted` (#8fb3a3) and `theme.danger` (#ff5c5c) against `theme.bg` (#0e1512) — both exceed 6:1, comfortably passing WCAG AA for normal text — so this finding is scoped to appearance-preference adaptivity, not a contrast defect; I am not raising a contrast problem I did not verify.)_

### Problems

- The app entirely ignores the system-level light/dark preference — for a subset of users (bright outdoor environments, personal preference, or vendor/OS-level "always light mode" accessibility settings), a forced-dark UI is a real, if moderate, usability friction, and diverges from standard iOS/Android platform conventions that most polished consumer apps follow.
- There is no evidence in the codebase that dark-only was a deliberate, documented product decision (no comment/doc noting "intentionally dark-only for glare reduction," etc.) — as written, it reads as an oversight (never built the light variant) rather than an intentional design stance either way.

### Root cause

The app was built with a single hardcoded palette from the start and light-mode support was never added.

### Redesign

Two legitimate paths, and this finding should be resolved by an explicit product decision rather than defaulting to "build light mode" reflexively:

- **Option A:** Add a proper light palette to `theme.ts` (a `lightTheme`/`darkTheme` pair) and drive selection via `useColorScheme()`, updating `App.tsx`'s `navTheme` and `StatusBar barStyle` to react to the live scheme (including live updates if the user toggles system appearance while the app is foregrounded, which `useColorScheme()` supports).
- **Option B:** If product intentionally wants dark-only (a legitimate choice for this product category — many remote-desktop/streaming apps default dark to reduce glare and match the "technical tool" aesthetic), then explicitly document that decision (a code comment in `theme.ts` stating the rationale) so a future engineer doesn't mistake it for an oversight, and optionally still respect the OS-level "Increase Contrast"/"Reduce Transparency" accessibility settings even within a dark-only palette.

### Tradeoffs

Option A is more work (a full second palette, careful contrast-verification of every color pair in light mode, live-toggle testing) but matches broader platform conventions and user expectation; Option B is near-zero engineering work but requires an explicit product sign-off to be a legitimate choice rather than an accidental gap. Given the mandate to "compete with Parsec/Jump Desktop/AnyDesk" — of which at least one ships both themes — I'd lean toward recommending Option A, but this is a product call, flagged accordingly rather than prescribed unilaterally.

### Implementation plan (Option A, if chosen)

1. Add a `lightTheme` object to `theme.ts` alongside the existing (renamed) `darkTheme`, with equivalent semantic keys.
2. Add a `useColorScheme()`-driven theme-selection hook/context consumed by all four screens (replacing the current direct `theme.*` imports) and by `App.tsx`'s `navTheme`/`StatusBar`.
3. Verify contrast ratios for every color pair in the new light palette (reuse the same WCAG-ratio verification approach used above for the existing dark palette) before shipping.

### Migration strategy

Client-only; no backend/protocol impact. Can ship as a self-contained follow-up PR independent of every other finding in this report.

### Testing strategy

- Manual: toggle system appearance while the app is foregrounded; confirm live theme switch with no stale colors/flicker.
- Automated: contrast-ratio check (can be scripted, as done manually for this report) for every text/background pair in both palettes.

### Risk assessment

Low risk technically; the only real risk is under-scoping the light-palette contrast work and shipping a light mode with poor legibility — mitigate by verifying every pair, not just spot-checking.

### Performance impact

None.

### Future extensibility

A proper theme-context (rather than the current static `theme.ts` module-level export) also makes any future white-label/branding work easier, though that's speculative and not proposed here.

---

## Finding 18: Device list is permanently empty; copy overpromises persistence

### Current implementation

`DeviceListScreen` is a static component with no data fetching, no local state, and no persistence read — it unconditionally renders the empty-state illustration ("No paired laptops yet" / "Click the Lilypad bubble on your laptop...") every single time it's shown (`DeviceListScreen.tsx:13-29`), regardless of whether the user has successfully paired before in this app session or a previous one. The component's own doc comment confirms this is intentional scaffolding: _"Device list — STUB. Trusted-device persistence lands in M5. For M1 it just launches the QR scanner..."_ (`DeviceListScreen.tsx:9-12`). This matches the backend/protocol design: every pairing requires a fresh single-use, 60-second-TTL token (`packages/protocol/src/constants.ts:11`, `apps/backend/src/services/pairing.ts:83-86` — `GETDEL` makes tokens strictly single-use) — there is currently no server-side "trusted device" concept to persist against even if the mobile app wanted to.

### Problems

- Every session, including a second connection to the _same_ laptop five minutes after the first, requires the full QR-scan-and-approve ritual again, since there's no persisted identity to reconnect against and the backend enforces single-use tokens by design — this works against the "30-second time to first session" mandate for the (likely common) case of a _returning_ user, even though it's expected/correct behavior for a genuinely new pairing.
- This is explicitly called out as deferred to M5 in the code's own comments, so it is not a bug — but it is worth flagging precisely because the audit mandate names "empty/error/loading states everywhere" and a perpetually-empty list with no state variation is worth a deliberate, documented decision rather than silent deferral, especially since the _screen's own copy_ ("No paired laptops yet") implies a list that could, in principle, become non-empty — setting an expectation the current architecture cannot fulfill without the M5 trusted-device backend work.

### Root cause

Intentional, documented M1 scaffolding (`DeviceListScreen.tsx:9-12`) that has not yet been revisited, correctly deferred pending the backend trusted-device model that doesn't exist yet (out of scope for this mobile-only audit).

### Redesign

This finding does not recommend building persistence now (that would be a new feature, explicitly out of scope per the audit mandate, and would require backend/protocol changes this audit did not review). Instead, recommend a low-cost, mobile-only copy/expectation fix: soften the empty-state copy so it doesn't imply an unfulfilled promise — e.g. change "No paired laptops yet" (which reads as "you'll see them here once you have some," setting an expectation the app can't currently meet even after pairing) to copy that's honest about the current model, e.g. **"Scan your laptop's QR code to start a session"** as the primary framing, with "no saved laptops yet" as secondary/smaller text only if a genuine roadmap commitment exists to surface it later. This is a one-line copy change with no functional implication, explicitly flagged as low-effort and low-severity, included here only because the audit mandate asked for exhaustive coverage of empty-state handling.

### Tradeoffs

None of consequence — this is a copy-only change.

### Implementation plan

1. Update the empty-state heading/body copy in `DeviceListScreen.tsx:18-21` to remove the implication of an eventually-populated list, or add a one-line note like "Lilypad will remember your laptops in a future update" if that's an accurate, committed roadmap statement (verify with product before adding this specific claim).

### Migration strategy

Trivial copy change; no functional migration needed.

### Testing strategy

- Manual: read the updated copy in context and confirm it doesn't imply functionality (persisted device list) that doesn't exist yet.

### Risk assessment

Negligible.

### Performance impact

None.

### Future extensibility

When M5's trusted-device backend work lands, this screen will need a real rebuild (data fetching, loading/error states for that fetch, a populated-list render path) — none of which is proposed here, consistent with the "no new features" mandate; this finding is scoped purely to today's copy accuracy.

---

## Finding 19: Scan reticle gives no liveness/success feedback

### Current implementation

The scanner overlays a static, fixed-position rounded-rectangle "reticle" (`ScannerScreen.tsx:111,163-172`, `styles.reticle`) that never changes appearance regardless of scan state — it looks identical whether no QR is in frame, a QR is partially visible, or a QR was just successfully decoded. The only feedback on a successful decode is the appearance of the confirmation card sliding in from the bottom (`ScannerScreen.tsx:118-147`) — there is no color change, animation, or haptic tied to the reticle itself at the moment of detection, and (per Finding 14's grep) no haptics library exists in the app at all.

### Problems

- A user pointing their camera at a QR code gets no incremental feedback that the code is _being read_ versus simply _in frame_ — the reticle is purely decorative, not diagnostic — so if decoding is slow or the code is at a bad angle, the user has no signal to adjust (get closer, reduce glare, hold steadier) before the confirmation card either appears or doesn't.
- The transition from "scanning" to "scanned" is a single UI change (the card appearing) with no accompanying micro-feedback (haptic tick, reticle flash to the accent color) at the exact moment of success — a small but real polish gap versus, e.g., most native QR/barcode scanning UIs (including the OS camera app's own QR detection) which flash/pulse on detection.

### Root cause

The reticle was implemented as a static visual guide (a reasonable, simple MVP choice) and was never revisited with a "detected" state once decoding worked end-to-end.

### Redesign

1. On successful decode (`onValue`'s success branch, `ScannerScreen.tsx:44-46`), briefly animate the reticle border color from `theme.accent` to a brighter flash-and-settle (a simple `Animated.timing` color/opacity pulse, ~200ms) and fire a light haptic tick (reusing the haptics dependency proposed in Finding 14) at the same moment, before the confirmation card slides up.
2. On a decode _failure_ specifically (malformed QR recognized as a QR but rejected by `decodeQrPayload`, `ScannerScreen.tsx:47-49`), give the reticle a brief red-tinted flash distinct from the success flash, reinforcing the existing text error message ("That QR code is not a Lilypad pairing code.") with an immediate visual cue at the point of attention (the reticle, where the user is already looking) rather than only text below it that requires a glance down.

### Tradeoffs

Purely additive polish; the only cost is the small haptics dependency already justified in Finding 14 (no new cost if that finding is implemented alongside this one, which is recommended).

### Implementation plan

1. Add success/failure `Animated` color-flash states to the reticle, triggered from `onValue`'s two branches.
2. Fire the corresponding haptic (success tick / error buzz) alongside each flash, reusing Finding 14's shared haptics helper.

### Migration strategy

Client-only, no backend/protocol impact.

### Testing strategy

- Manual: scan a valid Lilypad QR; confirm the reticle briefly flashes/pulses and a haptic fires before the card appears.
- Manual: scan a non-Lilypad QR code (any other QR); confirm the distinct failure flash/haptic accompanies the existing error text.

### Risk assessment

Negligible — purely visual/haptic polish with no logic changes to the decode path itself.

### Performance impact

None.

### Future extensibility

None specific.

---

## Finding 20: Toolbar touch targets borderline below 44pt minimum

### Current implementation

Toolbar "key" buttons use `paddingHorizontal: 16, paddingVertical: 12` (`ViewerScreen.tsx:168-176`, `styles.key`) with no explicit `minWidth`/`minHeight`. For the single-glyph arrow buttons specifically (`'←' '↑' '↓' '→'`, `ViewerScreen.tsx:28-31`), the rendered width is glyph-width (roughly 10–16px at the default `keyText` font size, no explicit `fontSize` override visible in `styles.keyText`, `ViewerScreen.tsx:177`, so it inherits RN's default `Text` size) plus `2 × 16px` horizontal padding — arriving in the neighborhood of 42–48pt total width depending on exact glyph metrics and platform font rendering, which straddles Apple's 44×44pt Human Interface Guidelines minimum and Android's comparable 48×48dp recommendation without reliably clearing either.

### Problems

- Small, single-character buttons are exactly the case where marginal touch-target sizing matters most (a full word like "Copy" naturally renders wider than its minimum tap area needs to be, but a single glyph like "→" does not) — a borderline-sized target increases mis-tap rate, which is directly costly on a _remote control_ surface where a mis-tap doesn't just mis-tap locally, it sends the wrong shortcut to the user's laptop.
- This compounds with Finding 14's proposed press-and-hold repeat behavior for arrows: a slightly-too-small repeatedly-tapped/held target is more error-prone than a single discrete tap, so this should be fixed as part of the same pass.

### Root cause

Padding values were chosen uniformly for all nine buttons without accounting for the fact that word-labeled buttons (Copy/Paste/Esc/Tab/Enter) and glyph-labeled buttons (arrows) need different minimum-width treatment to hit the same effective tap-target size.

### Redesign

Add explicit `minWidth: 44, minHeight: 44` (iOS baseline; also comfortably covers Android's 48dp at typical device densities once padding is included) to `styles.key`, and for the arrow buttons specifically, consider a slightly larger `fontSize` on the glyph itself (purely for legibility/visual weight, not required for the touch-target fix, since `minWidth`/`minHeight` handles the tappable area independent of visible glyph size) alongside the group-separation treatment already proposed in Finding 14.

### Tradeoffs

None of consequence — this is a minimum-size floor, not a layout redesign; it can only ever increase (never decrease) an existing button's tappable area, so there's no regression risk to word-labeled buttons that already exceed the minimum.

### Implementation plan

1. Add `minWidth: 44, minHeight: 44` to `styles.key` (`ViewerScreen.tsx:168-176`).
2. Re-verify with the grouped-cluster layout from Finding 14 that the now-slightly-wider arrow buttons still fit the intended visual grouping without overflow surprises.

### Migration strategy

Trivial, single-property style change; no functional impact.

### Testing strategy

- Manual: measure the on-screen tap area of each toolbar button (via a debug overlay or simple visual inspection against a 44pt reference grid) and confirm all nine meet the minimum.
- Manual: repeat the mis-tap-rate check informally by having a few testers rapid-tap the arrow keys before/after the change.

### Risk assessment

Negligible.

### Performance impact

None.

### Future extensibility

Adopting a shared `MIN_TAP_TARGET = 44` constant (rather than a magic number inline) makes it trivial to apply the same floor to any future button added to the app.

---

## Cross-Cutting Observations

A few threads recur across multiple findings above and are worth naming explicitly as themes for whoever picks up this report:

1. **The transport/protocol layer is consistently ahead of the UI layer.** `renegotiate` (Finding 5), `text_input`/`key_down` (Finding 3), and `desktopDeviceName` (Finding 9) are all fully implemented at the protocol/service level and simply never invoked or surfaced by the screens in this audit. The fastest, lowest-risk path to a large chunk of the M3 quality bar is wiring up capability that already exists end-to-end, not building anything new — consistent with the audit's own framing.
2. **Error handling was never designed as a system**, only as "catch and stringify" at each call site independently (Findings 2, 6, 7). A single shared `AppError` taxonomy (proposed in Finding 2) should be built once and then threaded through every one of the other findings that touches error UI, rather than each finding inventing its own local error-copy convention.
3. **Nothing in the app has been tested with an assistive technology enabled**, and it shows uniformly (Finding 11) — this should be treated as a dedicated workstream with its own test pass, not a checkbox added to each screen's existing PR.
4. **The Viewer screen is where essentially all of the highest-severity findings concentrate** (1, 3, 5, 8, 9, 10, 12, 13, 15, 16 all touch `ViewerScreen.tsx`/`webrtc.ts` directly) — this is expected, since it's where users spend all their time, but it also means several of these findings share layout/gesture-priority/safe-area dependencies on each other (explicitly noted in Findings 10/12/15/16's "implementation plan"/"migration strategy" sections) and should be sequenced as a coordinated pass on that one screen rather than as fully independent tickets.
