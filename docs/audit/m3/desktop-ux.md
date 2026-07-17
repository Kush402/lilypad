# Lilypad Desktop — UX Engineering Audit (M3 → M5 Readiness)

**Scope:** `apps/desktop` (Tauri v2 shell + React frontend). Read in full: `src/App.tsx`, `src/components/Bubble.tsx`, `src/components/QrOverlay.tsx`, `src/components/Control.tsx`, `src/lib/tauri.ts`, `src/styles.css`, `src/main.tsx`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/state.rs`, `src-tauri/src/permission.rs`, `src-tauri/tauri.conf.json`. Also read for grounding: `src-tauri/src/session.rs`, `src-tauri/src/os/{mod,macos}.rs`, `src-tauri/src/plugins/{mod,screen_capture,input_injection,dev_shortcuts,audit_log}.rs`, `src-tauri/src/input/macos.rs`, `src-tauri/src/media/capture/screencapturekit.rs`, `src-tauri/capabilities/default.json`, `src-tauri/Cargo.toml`, `apps/backend/src/routes/pairing.ts`.

**Author framing:** every finding below cites the exact lines that establish it. Where I state something does _not_ exist (no window-close handler, no relaunch call, no theme media query, no event listener), that is based on an exhaustive `grep` across `apps/desktop/src` and `apps/desktop/src-tauri/src` for the relevant symbols, not absence-of-evidence-as-evidence-of-absence.

---

## Executive Summary

Lilypad's desktop shell just proved the hard part — a real ScreenCaptureKit → VideoToolbox → webrtc-rs → react-native-webrtc pipeline works end-to-end on a LAN. But the _shell around_ that pipeline — the part a human actually touches — is still M1/M2 scaffolding wearing M2 clothes: a debug plugin-health dump doubles as the approve/deny screen (`Control.tsx:73-86`), permission failures surface only as a `"degraded: <reason>"` string in that dump with no path to fix them (`plugins/screen_capture.rs:44-50`, `plugins/input_injection.rs:40-47`), and the one control surface a user touches most — the floating bubble — will silently tear down a live remote-control session if clicked, because its click handler has no session-state guard (`Bubble.tsx:37-46`). Two windows (`qr-overlay`, `control`) have no close-request handling at all, so the native traffic-light button leaves sessions in unrecoverable or invisible states rather than cleanly denying/disconnecting. The frontend polls `get_state` on 800–1000ms timers (`Bubble.tsx:30`, `Control.tsx:29`) despite the Rust session runner already emitting a fully event-driven `lilypad://session` stream (`commands.rs:156`) that nothing in the frontend ever subscribes to (`grep` for `listen(` across `src/` returns zero hits) — the plumbing for a snappy, event-driven UI already exists and is simply unused.

None of this is a "missing feature" in the sense the mandate rules out — every fix below is _finishing what's already half-built_: the permission enum, the health-check plumbing, the event channel, the audit log, the tray menu, all exist. They just don't yet add up to software a person outside the team could self-serve through. The highest-leverage work is (1) a first-run permission wizard that turns two passive TCC preflight checks into an active, prompt-and-poll-until-granted flow with deep links and auto-relaunch; (2) replacing the debug list with a real approve/deny consumer screen that shows who's asking and for what; (3) closing the three session-integrity holes (bubble click during active session, unhandled window-close, tray items enabled with no state guard) that can silently kill or corrupt a live session; and (4) switching the UI from polling to the event stream that already exists. Everything else in this report — theming, focus states, tray icon template mode, window anchoring, color semantics — is real but secondary polish that should follow once the above no longer make the product feel broken under normal use.

18 findings follow, ordered by user-impact severity: 4 critical, 6 high, 5 medium, 3 polish.

---

## Finding 1 — No guided permission onboarding; TCC failures surface only as a debug-list string

**Severity: Critical**

### Current implementation

- `PermissionStatus` is a bare 3-variant enum with no supporting UX (`permission.rs:1-12`).
- Screen Recording is checked via `CGPreflightScreenCaptureAccess()` — a _passive_ preflight, never `CGRequestScreenCaptureAccess()` (the _prompting_ variant) — cached for 500ms (`media/capture/screencapturekit.rs:43-50, 141-151`).
- Accessibility is checked via `AXIsProcessTrusted()` — again the passive variant, never `AXIsProcessTrustedWithOptions` with the `kAXTrustedCheckOptionPrompt` key that triggers the native "Lilypad would like to control this computer" dialog (`input/macos.rs:29-36`).
- The only place either status reaches the user is `ScreenCapturePlugin::health_check` / `InputInjectionPlugin::health_check`, which map `NotGranted` to `HealthStatus::Degraded("Screen Recording permission not granted")` / `Degraded("Accessibility permission not granted")` (`plugins/screen_capture.rs:44-50`, `plugins/input_injection.rs:40-47`).
- That `HealthStatus` is only ever surfaced as a raw string in the `.debug` list at the bottom of the Control window (`Control.tsx:73-86`), a window that is not shown until a phone has already scanned a QR and requested control (`commands.rs:195-197`).
- `grep -rn "relaunch|opener|CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions|x-apple.systempreferences" apps/desktop/src-tauri/src` returns **zero matches** — there is no code anywhere in the desktop app that prompts the OS, deep-links to a Settings pane, polls until granted, or relaunches the app.
- `Cargo.toml` has no `tauri-plugin-opener` and no shell-based `open` invocation for `x-apple.systempreferences:` URLs (confirmed via the same grep and by reading `Cargo.toml:1-42` in full).

### Problems

1. A user who denies (or has never granted) Screen Recording gets no signal until they scan a QR, get approved, and then the stream simply never starts — the failure surfaces as `session.rs:157` (`"Screen Recording permission not granted — grant Lilypad access in System Settings ▸ Privacy & Security ▸ Screen Recording, then reconnect"`), which is constructed in Rust but **never reaches the UI**: it is only reachable via `SessionEvent::Error` (`session.rs` construction path through `map_shareable_content_error`), and nothing in `src/` calls `listen()` on `lilypad://session` (see Finding 8) — so even this one good error string is dropped on the floor today.
2. There is no active request. macOS will only show its permission dialog if the app calls the _prompting_ API. Lilypad never does, so first launch produces silence, not a prompt — the exact "struggled through manual TCC settings for an hour" failure mode already observed.
3. Even if a user finds System Settings unaided, granting Accessibility does not take effect without relaunching the app in most TCC flows for compiled (non-notarized-dev) builds, and there's no relaunch anywhere in the codebase to recover automatically.
4. The only visible artifact of a permission problem is a raw enum-derived string (`"degraded: Accessibility permission not granted"`) sitting under a heading called "Plugin health" (`Control.tsx:74`) next to seven other plugin names — indistinguishable, to a non-engineer, from an error they can't do anything about.

### Root cause

Permission status was built purely as _health-check plumbing_ for engineers driving the pipeline manually (module doc: "the common 3-state result both report through their respective backend traits, so the UI/plugin-health story is uniform across capabilities" — `permission.rs:3-5`). It was never connected to a product-facing request/remediation flow because M1–M2 didn't need one (dev grants permissions once, manually, and moves on).

### Redesign

Add a first-run **Setup** window (new `WebviewWindowKind = "setup"`, shown automatically before the bubble on first launch and any time both permissions aren't granted) that:

1. **Explains why**, per permission, in plain language ("Lilypad needs Screen Recording to show your screen to the phone that connects to it" / "...needs Accessibility to move your mouse and type on your behalf").
2. Has a **"Grant" button per row** that calls a new Tauri command `request_permission(kind)`. On macOS this calls the _prompting_ variants — `CGRequestScreenCaptureAccess()` and `AXIsProcessTrustedWithOptions(@{kAXTrustedCheckOptionPrompt: true})` — instead of today's passive preflight-only calls.
3. **Live-polls** status every ~700ms (matching the existing 500ms cache TTL) via a new `permission_status_stream` — expose as a Tauri event (`lilypad://permission`) emitted from a `tokio::time::interval` task started in `setup()`, not by adding another frontend poll loop.
4. When Accessibility is granted but the running process's cached trust bit is stale (known macOS behavior: some grants only take effect after relaunch), **auto-relaunch**: add `tauri-plugin-process`'s `restart()` (or a manual `Command::new(current_exe()).spawn()` + `std::process::exit(0)`) gated behind a detection heuristic — if `AXIsProcessTrusted()` still reports false 3 consecutive polls after the user closed System Settings, show "Finish setup — Lilypad needs to restart once to pick up the new permission" with a Restart button, rather than guessing silently.
5. **Deep-links to the exact pane**, not just "System Settings": `open` (via `tauri_plugin_shell`, already a dependency — `Cargo.toml:16`) the URL `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` and `...?Privacy_Accessibility` respectively — one click lands the user directly on the correct row, no navigating "Privacy & Security" themselves.
6. Blocks pairing (dims/disables the bubble's pair action) while either required permission is missing, with a persistent small badge on the bubble itself explaining the block on hover — never let a user QR-pair into a session that will silently fail.

### Tradeoffs

- Calling the _prompting_ permission APIs on every `request_permission` click (rather than just once at startup) means re-triggering the OS dialog if the user dismissed it — this is the correct behavior (macOS itself rate-limits/no-ops repeat prompts appropriately) but must be tested against macOS's "don't ask again this session" quirk.
- Auto-relaunch is disruptive if over-triggered; gate it strictly behind "permission still reads false after the Settings pane was demonstrably opened and closed," not on a timer alone.
- A dedicated Setup window adds one more window kind to manage (see Finding 5's window-close-handling fix — this new window needs it from day one, not bolted on later).

### Implementation plan

1. Rust: add `request_permission(kind: PermissionKind) -> Result<(), String>` command calling the prompting FFI variants; add `PermissionStatus` broadcast via a background task + `app.emit("lilypad://permission", …)`.
2. Rust: `os/macos.rs` gains `x-apple.systempreferences` URL constants; wire through `tauri_plugin_shell::ShellExt::open`.
3. Frontend: new `Setup.tsx` window, added to `App.tsx`'s `WindowKind` union and `currentWindowKind()`.
4. Rust `lib.rs::setup()`: after `host.initialize_all`, check both permissions; if either is `NotGranted`, open the Setup window before the bubble is interactive (or before `build_tray` even, so the user can't dodge it via the bubble).
5. Gate `create_pairing` (commands.rs:81) to return an explicit `Err("permissions_required")` if either is not granted, and have the Bubble surface that as a non-silent state (ties to Finding 10).

### Migration strategy

Ship behind no flag — this only adds capability, it doesn't remove the passive preflight path (still used for the ongoing health check during a live session, which is the correct check to keep cheap). Existing users who already granted permissions in earlier builds see the Setup window never appear (status already `Granted`), so this is a no-op for anyone past onboarding.

### Testing strategy

- Manual: fresh macOS user account (guaranteed `NotGranted` for both), full first-run walkthrough, confirm both deep links land on the correct Settings row (macOS pane anchors changed across macOS 13/14/15 — verify on at least two OS versions).
- Automated: unit test the `PermissionKind → x-apple.systempreferences URL` mapping table; unit test the relaunch heuristic's 3-strikes counter in isolation (inject a fake status source).
- Regression: confirm a user who already granted both permissions in a prior build never sees the Setup window (state machine test: `Granted, Granted → no setup window opened`).

### Risk assessment

Medium risk, high reward. The FFI calls are already proven safe (their passive counterparts are in production use); the new surface is the prompting variant of the same API family. Primary risk is macOS version drift in Settings deep-link anchors — mitigate by falling back to opening the top-level Privacy & Security pane (`x-apple.systempreferences:com.apple.preference.security`) if the specific anchor 404s (Settings silently ignores unknown anchors and opens the parent pane, so this fallback is actually automatic — verify empirically per OS version during testing).

### Performance impact

Negligible — one-time preflight/prompt calls, not hot-path. The background poll during Setup should stop once both permissions read `Granted` (don't leave a 700ms interval running for the rest of the app's life).

### Future extensibility

Same `request_permission` + deep-link table extends directly to Windows (Windows 10/11 doesn't gate Accessibility, per `input/windows.rs:9`, but does gate things like camera/mic if Lilypad ever adds audio — the pattern generalizes). The Setup window becomes the natural home for any future first-run step (e.g., firewall/network permission prompts if LAN discovery is added later).

---

## Finding 2 — Approve/Deny screen is a debug plugin-health dump, not consumer UI, and discards who's asking

**Severity: Critical**

### Current implementation

- `Control.tsx:38-89` renders one component for three purposes: header/status badge, approve/deny, active-session controls, **and** a permanent `.debug` section titled "Plugin health" listing all 8 raw plugin names and their health strings (`Control.tsx:73-86`), including internal implementation names like `DevShortcutsPlugin` and `AuditLogPlugin` (`plugins/dev_shortcuts.rs:12-14`, `plugins/audit_log.rs:20-22`) that mean nothing to an end user.
- The approve prompt itself is one static sentence: `"A phone is requesting to view and control this laptop."` (`Control.tsx:47`) — no device name, no timestamp, no distinction between "view" and "control" scope.
- The backend _does_ send this information: `SessionEvent::PairRequested { device_name: Option<String>, requested_scopes: Vec<String> }` (`session.rs:37-40`), populated from the real `PairRequestPayload` (`session.rs:521-526`).
- But `apply_session_event` in `commands.rs:169-198`, the only place that consumes `PairRequested`, pattern-matches it as `SessionEvent::PairRequested { .. } => s.session = SessionStatus::AwaitingApproval` (`commands.rs:173`) — the `device_name` and `requested_scopes` fields are captured by the `{ .. }` wildcard and **thrown away**. `AppState` (`state.rs:25-36`) and `AppStateDto` (`state.rs:55-63`) have no field to hold them, so `get_state` (`commands.rs:67-77`) has nothing to give the frontend even if it wanted to show them.
- The raw `SessionEvent` (which _does_ still carry `device_name`/`requested_scopes` in its `Serialize` form) is emitted via `app_ev.emit("lilypad://session", ev)` (`commands.rs:156`) — but nothing in `src/` ever calls `listen("lilypad://session", …)` (confirmed by grep), so this data is unreachable from either path today.

### Problems

1. A user has no way to tell _which_ of their devices (or someone else's) is asking to connect — the single largest trust decision in the entire product ("should I let this control my laptop right now") is presented with strictly less information than a Bluetooth pairing dialog.
2. "View and control" is stated as fixed prose regardless of `requested_scopes` — if scope negotiation ever becomes meaningful (view-only vs. view+control), the UI is already wrong for it, and today it's simply inaccurate marketing copy dressed as a security prompt.
3. The debug list undermines trust: presenting `DevShortcutsPlugin: ok` / `AuditLogPlugin: ok` next to a security decision reads as "this app is unfinished," which is a real credibility cost during exactly the moment (a stranger asking for remote control) where credibility matters most.

### Root cause

`Control.tsx`'s docstring says it plainly: "Also hosts the plugin health debug overlay so you can see the plugin host booted the eight M1 plugins" (`Control.tsx:13-14`) — this window was built as an engineer's session-driving harness first, consumer surface never. The event carrying rich pairing metadata was wired end-to-end on the Rust side and then dropped at the exact last hop into UI state.

### Redesign

1. **Plumb the discarded fields through.** Add `pending_request: Option<PendingRequest { device_name: Option<String>, requested_scopes: Vec<String>, requested_at: DateTime }>` to `AppState`/`AppStateDto`; populate it in `apply_session_event`'s `PairRequested` arm instead of discarding via `{ .. }`.
2. **Redesign the approve screen** as a single-purpose modal-style window (not sharing a component with the active-session view): large device icon, `"{device_name or "An unknown device"} wants to view and control this Mac"`, a scope chip row (View / Control) driven by `requested_scopes` rather than hardcoded prose, and two full-width buttons (Approve primary, Deny secondary) — pattern-matched on macOS's own "Screen Sharing" system prompt for family-of-product consistency.
3. **Remove the plugin-health list from any window a user sees during normal operation.** Move it behind a `⌥`-click on the tray icon or a `Help ▸ Diagnostics` menu item, explicitly labeled as a developer/support diagnostics panel, with plugin names re-labeled to consumer terms (e.g. `DevShortcutsPlugin` → "Keyboard shortcuts", `AuditLogPlugin` → "Activity log") even in that hidden view.
4. Show `requested_at` as "requesting since Xs ago" so a stale, expired PairRequested (e.g., the window was backgrounded) is visually distinguishable from a fresh one.

### Tradeoffs

Hiding the plugin-health list from normal users removes a debugging convenience the team currently relies on day-to-day; mitigate by keeping it one keystroke away (diagnostics menu) rather than deleting it, and by teeing its content into the structured log (already happening via `log::info!` in `PluginHost::initialize_all`, `plugins/mod.rs:113-117`) so `rtk`/log-tailing workflows aren't disrupted.

### Implementation plan

1. `state.rs`: add `PendingRequest` struct + `Option<PendingRequest>` field to `AppState`/`AppStateDto`.
2. `commands.rs::apply_session_event`: populate/clear it on `PairRequested`/`Ended`.
3. `Control.tsx`: split into `ApproveDialog.tsx` (new, purpose-built) and `ActiveSession.tsx`; `Control.tsx` becomes a thin router on `session` status.
4. Move the debug list to a new `Diagnostics.tsx` window, gated behind a tray "Diagnostics…" item (`lib.rs::build_tray`) rather than always-rendered.

### Migration strategy

Additive on the Rust side (new struct/field), replacement on the React side. Ship in one PR since the two sides are coupled (new DTO field is the enabling change for the new component). No data migration — this is in-memory session state, not persisted.

### Testing strategy

- Rust: unit test `apply_session_event` asserts `pending_request` is populated with the exact `device_name`/`requested_scopes` from a synthetic `PairRequested` event, and cleared on `Ended`.
- Frontend: snapshot/interaction test for `ApproveDialog` with device name present vs. `None` (renders "An unknown device"), and with `requested_scopes = ["view"]` vs `["view","control"]` rendering the correct chip set.
- Manual: pair from a real phone, confirm the device name shown matches the phone's actual name as sent by `PairRequestPayload`.

### Risk assessment

Low risk — purely additive plumbing plus a component split; no changes to session lifecycle logic or WebRTC/signaling behavior.

### Performance impact

None measurable; one extra small struct copied through an already-existing mutex-guarded state update.

### Future extensibility

`PendingRequest` is the natural place to later add a device fingerprint/trust-on-first-use indicator ("first time this device has connected" vs. "connected 4 times before") without touching the session runner again.

---

## Finding 3 — Bubble click has no session-state guard: can silently tear down or restart a live session

**Severity: Critical**

### Current implementation

- `Bubble.tsx:37-46`: `onPair` unconditionally calls `api.createPairing()` on every click, regardless of `status`. There is no `if (status === 'active') return` or any branch at all — the only state read in the component is used to color the dot (`Bubble.tsx:16, 24, 57`), never to gate the click handler.
- `create_pairing` (`commands.rs:81-128`) always calls `spawn_session_runner` (`commands.rs:123, 132-166`), which does:
  ```rust
  let mut s = lock_state(&state);
  s.control_tx = Some(control_tx);   // commands.rs:145 — overwrites the Option
  s.current_room_id = Some(room_id.clone());
  s.offered_scopes = offered_scopes;
  s.session = SessionStatus::Pairing;
  ```
  (`commands.rs:143-149`). Assigning `Some(control_tx)` over the previous `Option<UnboundedSender<Control>>` **drops** the old sender. In an active session, the old `run_session` task's `control_rx.recv()` (`session.rs:259`) then resolves to `None` on its next poll, which the code treats identically to `Control::Disconnect` (`session.rs:275-279`) — it sends a `disconnect` envelope, emits `Ended`, and tears the whole session down.
- Net effect: **clicking the bubble while a remote session is active (dot is red, `STATUS_COLOR.active`, `Bubble.tsx:8`) silently disconnects the connected phone** and starts a brand-new pairing flow, with zero confirmation, zero undo.

### Problems

1. This is the single control surface a user is most likely to reflexively click (it's the always-on-top floating bubble, the app's entire "chrome" — `tauri.conf.json:16-31`). Any accidental click during an active session — muscle memory, a mis-click while reaching for another window — ends the session the user is actively relying on, with no warning.
2. It directly contradicts the product's own privacy framing: the bubble's dot turns red specifically to signal "a session is active" (`STATUS_COLOR.active = '#ff5c5c'`), yet the same UI element that displays that warning is _also_ the trigger that destroys the thing it's warning about.
3. Compounds Finding 4 (panic discoverability): the one interactive affordance on the bubble does something destructive-but-unlabeled instead of offering the obvious "disconnect/panic" action a user reaching for the bubble during an active session most likely wants.

### Root cause

`Bubble.onPair` was written for the M1 world where the bubble had exactly one job ("show me a QR") and no notion of concurrent state existed yet. The state-polling loop was added later for the status dot without anyone revisiting the click handler's assumptions.

### Redesign

Make the bubble a **state machine**, not a single action button:

- `idle` → click starts pairing (today's behavior, unchanged).
- `pairing` / `awaiting_approval` → click **reopens** the existing QR/Control window (`show_qr_overlay`/`show_control`, already implemented as idempotent window-focus helpers in `commands.rs:259-265, 288-302`) instead of starting a second pairing flow. Never call `create_pairing` again while already mid-flow.
- `active` → click opens a small popover (anchored to the bubble, see Finding 15) showing "Connected to {device_name} since {time}" with a single **Disconnect** button — i.e., surface the panic/disconnect action, don't restart pairing.
- Add a `force_new_pairing()` path only reachable from an explicit secondary action (e.g. right-click ▸ "New pairing code"), which itself must first confirm ("This will disconnect the current session — continue?") if `status === 'active'`.

### Tradeoffs

Introduces a small branch of UI states on what was a one-button component, and a right-click menu the bubble didn't have before — modest scope growth, but it's the minimum needed to make the control safe. Alternative considered: disable the bubble's click entirely during `active` (simplest) — rejected because it removes the one place a user could otherwise get a quick disconnect, worsening Finding 4.

### Implementation plan

1. `Bubble.tsx`: replace the single `onPair` with a `switch (status)` dispatch as above.
2. `commands.rs`: add `reopen_active_window()` no-op-safe helper (already exists as `show_qr_overlay`/`show_control`; just call the right one per status) and a new `disconnect_with_confirmation` is not needed server-side — confirmation is a frontend concern; `disconnect` command already exists (`commands.rs:241-245`) and is safe to call directly once confirmed.
3. Add a tiny anchored popover window (`bubble-popover`, reuse `open_window` helper, `commands.rs:288-302`) for the active-state click target.

### Migration strategy

Frontend-only change plus one new (optional) popover window; no protocol/schema changes. Ship as a single PR; safe to land independently of Findings 1–2.

### Testing strategy

- Unit: `Bubble` component test — simulate `status = 'active'`, click, assert `api.createPairing` is **not** called and the disconnect popover path is invoked instead.
- Integration: drive a real session to `active` (or use `simulate_pair_request` gated appropriately, see Finding 7), click the bubble, assert the session survives (no `Ended` event, `control_tx` unchanged).
- Regression: `status = 'idle'`, click, assert existing pairing flow is unaffected.

### Risk assessment

Low risk to implement, but this is the most severe _existing_ defect in the report — treat as a stop-ship item for anything described as "M5 production quality," since it is a live-session-destroying bug reachable by a single accidental click today.

### Performance impact

None.

### Future extensibility

The state-machine dispatch on the bubble is also where a future "quick actions" menu (mute clipboard sync, screen-lock-on-disconnect, etc.) would naturally live per status.

---

## Finding 4 — Panic disconnect has no reliable, always-reachable affordance during an active session

**Severity: Critical**

### Current implementation

- The only in-app panic control is the "⛔ Panic" button inside the Control window's `.control__active` section (`Control.tsx:59-69`), which only renders while that specific window is open and `session === 'active'`.
- The Control window is opened automatically once, when a pair request arrives (`commands.rs:195-197`, calling `show_control`), but nothing reopens it if the user (or the OS) closes it afterward — there is no window-close handler at all (see Finding 5) and no way to reopen it from the bubble (see Finding 3, current behavior).
- The tray menu also exposes "⛔ Panic disconnect" (`lib.rs:59, 92-94`) unconditionally enabled — this is the one dependable path today, but it requires the user to know to open the macOS menu bar, find the Lilypad icon (which, per Finding 16, isn't even a template icon so it may be hard to spot against the current menu bar), and read a text menu — several more steps and higher discovery cost than a single click on the always-visible bubble.

### Problems

1. If a user closes the Control window (native red traffic-light button — no confirmation, no handler) during an active session, their only remaining path to disconnect is the tray menu — which they have no reason to know contains a panic option, especially under time pressure (the scenario "panic disconnect" exists for).
2. The bubble — the one UI element guaranteed visible at all times (`alwaysOnTop: true`, `tauri.conf.json:25`) — currently does the opposite of helping (Finding 3): clicking it during an active session doesn't offer disconnect, it silently restarts pairing.
3. This is a safety-critical gap for a remote-desktop product: "how do I immediately stop someone from controlling my computer" must be reachable in one click from the one control that's always on screen, with zero prior context needed.

### Root cause

Panic/disconnect was built as a feature of the Control window (which itself only exists transiently, opened by an inbound pairing event) rather than as a property of the persistent bubble. No one revisited "what if the Control window isn't open" once approve/deny stopped being the only reason that window existed.

### Redesign

Combine with Finding 3's bubble redesign: the bubble's `active`-state click target _is_ the panic/disconnect surface (popover with device name + a red Disconnect button, one click away, always). Additionally:

- Add a `Cmd+Option+Esc`-style global-ish local shortcut (scoped to the app, not truly global — avoid clobbering OS shortcuts) that fires `panic_disconnect` whenever any Lilypad window has focus, as a secondary path.
- Make the tray icon itself visually indicate "session active" (e.g., swap to a filled/red variant, see Finding 16) so the tray path is also discoverable without reading menu text first.

### Tradeoffs

A global-ish shortcut risks accidental firing or conflicting with other apps' bindings; scope it to app-focused windows only (safe, standard Tauri shortcut-on-focus, not `tauri-plugin-global-shortcut`) to avoid that class of bug entirely.

### Implementation plan

1. Ship Finding 3's bubble popover first (it subsumes most of this).
2. Add tray icon state swap: extend `build_tray` (`lib.rs:54-100`) to accept an `AppHandle` reference it can call `tray.set_icon(...)` on from `apply_session_event` when transitioning to/from `Active`.
3. Add local (window-focused) `Cmd+Shift+Escape` → `panic_disconnect`, registered per-window in the frontend via a `keydown` listener calling `api.panic()`.

### Migration strategy

Additive; no removal of the existing tray/Control-window panic buttons — this is about adding reachable paths, not consolidating away existing ones.

### Testing strategy

- Manual: start a session, close the Control window via the traffic light, confirm the bubble popover can still disconnect in one click.
- Manual: confirm the local keyboard shortcut fires only when a Lilypad window has OS focus, not system-wide.
- Visual regression: tray icon swap renders correctly in both macOS light and dark menu bars (ties to Finding 16).

### Risk assessment

Low technical risk; high product-safety upside. This and Finding 3 should ship together as they share the bubble popover component.

### Performance impact

None.

### Future extensibility

A visually distinct "active" tray icon is also the natural place to later add a live bitrate/latency tooltip without new UI surface.

---

## Finding 5 — `qr-overlay` and `control` windows have no close-request handling; native close leaves sessions stuck or silently orphaned

**Severity: High**

### Current implementation

- Both windows are created via the shared `open_window` helper (`commands.rs:288-302`), which sets `resizable(false)` and `always_on_top(true)` but registers no `on_window_event`/`WindowEvent::CloseRequested` handler.
- `grep -rn "on_window_event|CloseRequested|WindowEvent" apps/desktop/src-tauri/src` returns **zero matches** anywhere in the codebase — confirmed absent, not merely unread.
- Consequences differ by window and by session phase:
  - **`qr-overlay` closed during `Pairing`:** the session runner keeps running (`run_session`, `session.rs:126` onward) with no window to show the code. It is bounded only by `pairing_timeout()` (120s, `session.rs:81-93`), so the runner and its signaling WebSocket + heartbeat task linger for up to two minutes with no UI in sight and no way to know it's still "live."
  - **`control` closed during `AwaitingApproval`:** far worse — once a `pair-request` arrives, `paired = true` is set (`session.rs:191-193`), which **disarms the pairing-expiry timeout entirely** (the `if !paired` guard on that `select!` arm, `session.rs:182`). With the Control window gone, there is now **no window offering Approve/Deny and no timeout that will ever end the wait** — the runner sits in `AwaitingApproval` indefinitely. The only recovery path is the tray's "Approve"/"Deny" items, which work because they call the commands directly against `app.state()` (`lib.rs:83-87`) rather than needing the window — but nothing tells the user that path exists once their window vanished.
  - **`control` closed during `Active`:** the live session (media + input) keeps running untouched — correct in isolation — but the user has lost their only in-app disconnect/panic affordance (compounds Finding 4).

### Problems

1. The single most common way a user dismisses a floating utility window — clicking the native close button — produces different, all-bad outcomes depending on timing, none of which are communicated.
2. The `AwaitingApproval`-with-no-timeout case is a genuine correctness bug, not just UX: a session can be left in a state that never self-terminates and is invisible to the user, consuming a signaling room + heartbeat task server-side indefinitely (until the phone gives up or the desktop app quits).

### Root cause

Window lifecycle and session lifecycle were built as two separate concerns (`open_window`/`close_window` in `commands.rs:288-308` vs. the `Control`-channel-driven state machine in `session.rs`) with no code connecting "user closed this window" to "send a Control message." The pairing-expiry timeout's `paired` disarm logic (`session.rs:182,191-193`) was designed around "a device is engaged, don't time out the pairing step" — a reasonable assumption for the scan step, but it silently also disarms the _approval_ step, which has no timeout at all today regardless of window state.

### Redesign

1. Register `on_window_event` for both `qr-overlay` and `control` in `open_window` (or a wrapper), handling `WindowEvent::CloseRequested`:
   - `qr-overlay` close while `Pairing` → call `deny_session`-equivalent (or a new lighter `cancel_pairing` command) so the runner tears down immediately instead of idling to the 120s timeout.
   - `control` close while `AwaitingApproval` → call `deny_session` (treat "user dismissed the approval window" as an implicit deny — the safe default for a security prompt).
   - `control` close while `Active` → do **not** end the session (correct today), but show a one-time toast/tray balloon on close: "Session still active — reopen from the tray or bubble to disconnect," so the user isn't left wondering where their controls went.
2. Independently of the above, add a bounded **approval timeout** (e.g. 45s, configurable like `pairing_timeout()`) so an unattended `AwaitingApproval` never lasts forever even if a window-close handler bug is reintroduced later — defense in depth, mirroring the existing `PAIRING_TIMEOUT`/`RECOVERY_TIMEOUT` pattern (`session.rs:79-93`).

### Tradeoffs

Treating "closed the approval window" as an implicit deny is a judgment call — an alternative is to treat it as "keep waiting, just hide the window," but that reintroduces the exact invisible-hang problem this finding is about. Implicit-deny is the safer default for a security-sensitive prompt (fails closed, matches how OS permission dialogs behave when dismissed).

### Implementation plan

1. `commands.rs::open_window`: after `WebviewWindowBuilder::build`, call `.on_window_event(move |event| if let WindowEvent::CloseRequested { .. } = event { /* dispatch per label */ })`.
2. Add `cancel_pairing` command (thin wrapper around `send_control_or_reset(&state, Control::Disconnect)`, same as today's `disconnect` — can likely just reuse `disconnect`/`deny_session` directly rather than adding a new command).
3. Add `APPROVAL_TIMEOUT` constant + `select!` arm in `session.rs` mirroring `pairing_deadline`, active only while `AwaitingApproval` and disarmed once `Approve`/`Deny` is received.

### Migration strategy

Purely additive Rust-side behavior; no schema/protocol change. Land the close-handler fix and the approval-timeout defense-in-depth as two small, independently reviewable commits.

### Testing strategy

- Integration test (extend `session/stateMachine.test.ts`-equivalent on the Rust side, or a new `session.rs` test): assert that after `PairRequested` with no `Approve`/`Deny` within `APPROVAL_TIMEOUT`, the runner emits `Ended`.
- Manual: open QR overlay, close via traffic light, confirm the bubble dot returns to idle within one poll interval (and, post-Finding 8, immediately via the event stream) rather than lingering "pairing" for up to 120s.
- Manual: get to `AwaitingApproval`, close the Control window, confirm the tray's Approve/Deny still function and that the session ends on its own if ignored past the new timeout.

### Risk assessment

Medium — touches the session state machine's timeout logic, which is exactly the kind of code covered by `session/stateMachine.test.ts` and `session/manager.test.ts` already in the repo; extend those rather than hand-testing only.

### Performance impact

None; one more cheap timer, symmetric with the existing pairing-expiry timer.

### Future extensibility

The per-window close-handler dispatch table is also where Finding 1's new Setup window and Finding 3's bubble popover should register their own close semantics from day one.

---

## Finding 6 — Tray menu items are unconditionally enabled regardless of session state, producing "ghost" sessions

**Severity: High**

### Current implementation

- `build_tray` (`lib.rs:54-68`) constructs `approve`, `deny`, `disconnect`, `panic` as `MenuItem::with_id(app, id, label, true, None::<&str>)` — the fourth argument (`enabled`) is hardcoded `true` for every item, for the lifetime of the app; `build_tray` runs exactly once, in `setup()` (`lib.rs:123`), and nothing subsequently calls `MenuItem::set_enabled` anywhere in the codebase (confirmed by grep for `set_enabled` — zero hits).
- `approve_session` (`commands.rs:216-230`), when there is no active runner (`state.control_tx` is `None` — true whenever `session == Idle`), does **not** error — it takes the `None` branch and does `lock_state(&state).session = SessionStatus::Active;` (`commands.rs:225-227`) directly, with no peer connection, no media pipeline, nothing behind it.
- Same pattern in `deny_session`/`disconnect`/`panic_disconnect` via `send_control_or_reset` (`commands.rs:271-286`): absent a runner, they just call `reset_to_idle`, silently no-op-ing from the user's point of view.

### Problems

1. A user (or an accidental click) selecting "Approve" from the tray while idle flips the _entire app_ into `SessionStatus::Active` — the bubble dot turns red, the Control window (if open) shows "Session active" with Disconnect/Panic buttons — for a session that doesn't exist. Nothing is streaming, no input works, and there is no way to tell this apart from a real active session by looking at the UI.
2. This "ghost active" state can only be escaped by clicking Disconnect/Panic (which happens to work, via the same `None`-branch reset), but a less technical user has no reason to suspect their "active session" is fake, and no confirming signal reveals the difference.
3. More broadly, the tray menu's information architecture presents four mutually-exclusive-by-state actions (Approve/Deny only make sense in `AwaitingApproval`; Disconnect/Panic only make sense in `Active`/`Pairing`) as if they're always equally valid, which is inconsistent with how every other tray-based utility (Bluetooth, Wi-Fi, Dropbox) contextually greys out inapplicable items.

### Root cause

The tray was wired directly against the always-callable command functions for simplicity (`lib.rs:79-96` calls `commands::approve_session(app.state())` etc. unconditionally) with no consideration of guarding by `AppState.session` before enabling/disabling, and the commands themselves were written permissively (fall back to a local state assignment rather than erroring) to keep the M1 "offline dev, no runner" path convenient.

### Redesign

1. Track the current `SessionStatus` in a place `build_tray`'s menu-event closure and a state-refresh function can both reach (already available via `app.state::<SharedState>()`), and call `MenuItem::set_enabled(matches!(status, ...))` for each item whenever `apply_session_event` runs (i.e., piggyback the existing state-transition hook, `commands.rs:169-198`, with a tray-menu refresh call).
   - `approve`/`deny` enabled only during `AwaitingApproval`.
   - `disconnect`/`panic` enabled only during `Pairing | AwaitingApproval | Active`.
   - `show_qr`/`quit` always enabled.
2. Additionally (defense in depth, since menu state can theoretically race a click): make `approve_session`'s `None` branch return an `Err` instead of faking `Active`, and surface that error via a native notification ("Nothing to approve right now") rather than corrupting `AppState`.

### Tradeoffs

Requires threading a tray-menu handle (or the individual `MenuItem`s) into the same code path that mutates `AppState.session`, slightly increasing coupling between `commands.rs` and `lib.rs`'s tray setup — acceptable, since Tauri already expects tray items to be updated from app-wide state changes (this is the standard pattern for tray-based utilities).

### Implementation plan

1. `lib.rs::build_tray`: return the constructed `MenuItem` handles (or store them in a small `TrayMenuItems` struct managed alongside `AppState`).
2. `commands.rs::apply_session_event`: after updating `s.session`, call a new `refresh_tray_menu(app, s.session)` helper that toggles `set_enabled` per the table above.
3. `commands.rs::approve_session`: change the `None` arm to `Err("no pending approval".into())` instead of faking `Active`; same audit for `deny_session`/`disconnect`/`panic_disconnect`'s reset-to-idle fallbacks — at minimum, don't silently succeed when there was nothing to disconnect either (a no-op `Ok` is fine there since it's already idle; the risk is specifically `approve_session` fabricating `Active`).

### Migration strategy

Rust-only, additive; no frontend changes required (the frontend already just reflects whatever `session` state it's given). Land as one PR alongside Finding 5, since both touch `apply_session_event`.

### Testing strategy

- Unit test: `approve_session` with `control_tx = None` returns `Err`, and `AppState.session` remains unchanged (not flipped to `Active`).
- Manual: while idle, open the tray menu, confirm Approve/Deny/Disconnect/Panic render visually disabled (greyed) and are unclickable.
- State-machine test: extend `session/stateMachine.test.ts` (or the Rust equivalent) to assert tray-enablement table matches each `SessionStatus` transition.

### Risk assessment

Low-medium — changing `approve_session`'s fallback from a silent state mutation to an `Err` is technically a behavior change; audit any test (`session/manager.test.ts`, `protocol.test.ts`) that might depend on the old fake-active fallback before changing it.

### Performance impact

None — `set_enabled` is a cheap synchronous menu update.

### Future extensibility

The `refresh_tray_menu` hook is also where a future "connected device count" or bitrate readout in the tray label would be added.

---

## Finding 7 — Dev-only "Simulate phone scan" button is shipped in the production UI and always registered as a callable command

**Severity: High**

### Current implementation

- `QrOverlay.tsx:88-91` renders, unconditionally, in every build:
  ```tsx
  {
    /* DEV-only (M1): simulate a phone redeeming, so Approve/Deny is drivable. */
  }
  <button className="btn btn--ghost" onClick={() => void api.simulatePairRequest()}>
    Simulate phone scan
  </button>;
  ```
  There is no `import.meta.env.DEV` guard, no build-time exclusion, no feature flag — the comment says "DEV-only" but nothing in the code enforces that.
- `tauri.ts:27-28` exposes `simulatePairRequest: () => invoke<void>('simulate_pair_request')` with the same "DEV-only" comment, equally unenforced.
- The Rust side registers it unconditionally in the production `invoke_handler!` list: `commands::simulate_pair_request` (`lib.rs:129`), and the command itself (`commands.rs:203-213`) has no `#[cfg(debug_assertions)]` gate — it is compiled into release builds and directly callable from any webview, including via `withGlobalTauri: true` (`tauri.conf.json:14`), which exposes `window.__TAURI__.core.invoke` to arbitrary page script.

### Problems

1. Any real user, in a shipped build, can click a labeled "Simulate phone scan" button that fabricates a fake pairing request and opens the Approve/Deny window with no phone involved — at minimum confusing, at worst a way to induce an approve action against a session the user didn't actually initiate from a real device (there is no binding to a real device identity when this path is used).
2. Because `withGlobalTauri` is on and the command is registered in every build, `simulate_pair_request` is invokable from **any** script that gets to run in a Lilypad webview context, not just via the visible button — this is a materially larger attack surface than "a stray dev button" once considered from a security-review angle, since it means the production binary ships an unauthenticated command that mutates session state without any real pairing having occurred.
3. Undermines the entire premise of the approve/deny trust screen (Finding 2): if "approval requested" can be self-triggered with no real remote party, the audit log (`plugins/audit_log.rs`) records `pair_request — phone requested control` (`commands.rs:211`) events that never corresponded to an actual device — a false trail in exactly the log meant to be the source of truth for "who connected and when."

### Root cause

Built explicitly to make the Approve/Deny flow drivable before a real phone client existed (module comment: "Removed once M2 lands" — `commands.rs:202`). M2 landed (real QR pair, approve, live mirror per the mandate's own framing) and the dev shim was never removed.

### Redesign

1. Delete the button from `QrOverlay.tsx` entirely — the real pairing flow is now provable end-to-end, so the shim's stated purpose is complete.
2. Delete `simulate_pair_request` from the production `invoke_handler!` list; if the team wants to keep it for local dev/e2e-test convenience, gate the **command registration itself** behind `#[cfg(debug_assertions)]` in `lib.rs`, and gate the **button** behind `import.meta.env.DEV` in `QrOverlay.tsx` as defense in depth (two independent gates, since a debug build could still ship the button to a tester who shouldn't see it, and vice versa).
3. If e2e tests currently invoke `simulate_pair_request` (check `apps/desktop/src-tauri/tests/` and `examples/headless_offer.rs` for usage before deleting), replace those call sites with a proper test harness that drives a real (or test-double) signaling client, so removing the shim doesn't regress test coverage.

### Tradeoffs

If tests currently depend on this shim, removing it costs some test-writing effort to replace with a real signaling-based fixture — but shipping a state-mutating, unauthenticated command in a remote-desktop product's release build is not an acceptable tradeoff to avoid that cost.

### Implementation plan

1. Grep `apps/desktop/src-tauri/tests/` and `apps/desktop/src-tauri/examples/` for `simulate_pair_request` usage; inventory call sites.
2. Add `#[cfg(debug_assertions)]` above the command definition (`commands.rs:203`) and its `invoke_handler!` registration (`lib.rs:129`).
3. Remove the button from `QrOverlay.tsx:88-91` and the `simulatePairRequest` export from `tauri.ts:27-28` in the same change (no reason for a debug-only Rust command to have a permanently-shipped frontend binding).
4. Update any dependent tests to use a real signaling round-trip fixture instead.

### Migration strategy

Single PR; this is a pure removal/gating change with no data or protocol implications. Should ship independently and immediately — this is close to a security-review blocker on its own, separate from the broader UX polish work.

### Testing strategy

- Build the release configuration and confirm `simulate_pair_request` is absent from the compiled binary's invoke handler (e.g., attempt to invoke it from a webview devtools console against a release build and confirm it errors as "command not found").
- Confirm debug builds retain the shim if the team wants it for local dev, gated correctly.
- Re-run whatever test suite currently exercises the Approve/Deny flow via the shim, now via the real-signaling fixture, and confirm equivalent coverage.

### Risk assessment

Low technical risk (deletion + a `cfg` gate), but flag as **high priority** independent of the rest of this report given the security angle above.

### Performance impact

None.

### Future extensibility

Establishes the pattern (`#[cfg(debug_assertions)]` + `import.meta.env.DEV`, both gates) that any future dev-only affordance in this codebase should follow.

---

## Finding 8 — Frontend polls `get_state` on fixed timers instead of consuming the event stream the backend already emits

**Severity: High**

### Current implementation

- `Bubble.tsx:19-35`: `setInterval(poll, 1000)` calling `api.getState()`.
- `Control.tsx:18-34`: `setInterval(poll, 800)` calling the same `api.getState()`.
- Meanwhile, `commands.rs:151-158` already spawns a task that forwards every `SessionEvent` from the runner to the frontend: `app_ev.emit("lilypad://session", ev)` — covering `Registered`, `PairRequested`, `SessionStarting`, `ConnectionState`, `SignalingReconnecting/Reconnected`, `Ended`, `Error`, all with rich payloads (`session.rs:33-58`).
- `grep -rn "listen(" apps/desktop/src` returns **zero matches** — the frontend never subscribes to this event at all; the entire mechanism is dead code from the UI's perspective today.

### Problems

1. Every state transition (a phone scanning a QR, a connection dropping, a session ending) takes up to 800–1000ms to reach the UI, purely because it's on a polling timer, when the actual event is already available instantly via Tauri's IPC event bus.
2. Two independent windows (`Bubble`, `Control`) each run their own poll loop against the same underlying `Mutex<AppState>`, meaning every open window pays its own lock-contention + IPC round-trip cost indefinitely, for state that changes far less often than once per second in steady state (most of the time, nothing is changing).
3. This directly blocks Finding 2's and Finding 5's fixes from feeling instant — e.g., a `PairRequested` event with a device name is already flowing through `emit`, but because nothing listens, the UI has to wait for the next poll tick and re-derive everything from `get_state`'s coarse snapshot, which (per Finding 2) doesn't even carry the device name today.
4. Battery/CPU: two setInterval-driven IPC round-trips per second, forever, while the app is simply sitting idle in the menu bar, is measurable overhead for zero benefit versus an event-driven push model — small in absolute terms, but exactly the kind of "little inefficiencies everywhere" that separates M2-prototype feel from Apple-grade polish.

### Root cause

`get_state`/polling was the simplest thing to build first (one command, one `setInterval`, works from any window without coordinating event subscriptions) and the event-emission plumbing was added later (for the Rust-side session runner's own needs) without anyone circling back to replace the original polling loops.

### Redesign

1. Frontend: replace both `setInterval(poll, …)` loops with `listen<SessionEvent>('lilypad://session', (event) => { /* reduce into local state */ })`, using a small reducer that mirrors `apply_session_event`'s Rust-side logic (status transitions per event kind) directly in the frontend, so the UI updates the instant the event arrives.
2. Keep exactly **one** `get_state` call per window, on mount, to establish the initial snapshot (covers the case where a window opens mid-session and needs the current state before any new event fires) — this replaces "poll forever" with "fetch once, then subscribe."
3. Retain `get_state` as a command (useful for the Diagnostics window from Finding 2, and for tests), just stop calling it on a timer for live UI state.

### Tradeoffs

Event-driven state requires the frontend reducer to correctly mirror every transition the Rust side's `apply_session_event` performs, creating a second place that logic must stay in sync — mitigate by keeping the frontend reducer intentionally dumber (map event kind → status directly, matching the `SessionStatus` enum 1:1) rather than reimplementing business rules, and by covering it with a table-driven unit test mirrored against the Rust `apply_session_event` test.

### Implementation plan

1. Add a small `useSessionEvents()` hook in `src/lib/` that calls `listen('lilypad://session', …)` and exposes a reducer-derived `SessionStatus` (+ any new fields from Finding 2's `PendingRequest`).
2. Replace the poll loops in `Bubble.tsx` and `Control.tsx` with this hook, keeping a single `getState()` call on mount for the initial snapshot.
3. Remove the `setInterval` calls entirely once the hook is verified to cover every transition currently observable via polling.

### Migration strategy

Frontend-only; ship after Finding 2's DTO changes land (so the event payload the hook consumes already carries the richer `PendingRequest` data) to avoid a second frontend pass.

### Testing strategy

- Unit: feed a sequence of synthetic `SessionEvent`s into the reducer, assert the resulting `SessionStatus` sequence matches what `apply_session_event`'s Rust test suite asserts for the same sequence (parity test).
- Manual: time-to-UI-update from a real phone scan, before/after — should visibly drop from "up to 1s" to "next frame."
- Regression: open a window mid-session (e.g., reopen Control after closing it during Active), confirm the one-time `getState()` call correctly hydrates it rather than showing stale/idle state until the next event fires.

### Risk assessment

Low-medium — the main risk is reducer/backend drift over time; mitigated by the parity test above. No changes to the Rust session runner itself.

### Performance impact

Net positive: removes two indefinite per-second IPC+lock round trips, replaced by push-only updates that fire only on real transitions (which are rare in steady state).

### Future extensibility

Once event-driven, adding new live-updating UI (e.g., a live bitrate/latency readout during Active, fed by `PeerEvent::VideoRemb`-derived metrics already computed in `media/metrics.rs`) becomes a matter of emitting one more event kind, not adding another poll loop.

---

## Finding 9 — QR regenerate/"New code" can silently discard an in-flight pairing request with no confirmation

**Severity: High**

### Current implementation

- `QrOverlay.tsx:85-87`: the "New code" / "Regenerate" button calls `generate()` (`QrOverlay.tsx:23-39`), which calls `api.createPairing()` unconditionally, with no check of current session state.
- As established in Finding 3, `create_pairing` → `spawn_session_runner` (`commands.rs:123, 132-166`) always overwrites `AppState.control_tx`, which drops the previous runner's control sender and causes that runner's event loop to treat it as `Control::Disconnect` (`session.rs:275-279`) — ending it immediately, regardless of what state it was in.
- Concretely: if a phone has already scanned the _current_ QR and is sitting at `AwaitingApproval` (the Control window is showing "Approval requested," a real device is waiting on the other end), and the user clicks "New code" on the (still-open) QR overlay — perhaps out of habit, or because they didn't realize a scan had already landed — the in-flight approval is torn down with **no confirmation dialog and no explanation to either party**. The phone simply sees its request die; the desktop silently starts over with a new code.

### Problems

1. This is a real, reachable data-loss/trust-loss scenario: a legitimate pairing attempt in progress can be invisibly cancelled by an action on an unrelated window, with the two windows (QR overlay and Control) not coordinating at all on this point.
2. The countdown UI (`QrOverlay.tsx:71-82`, showing `secondsLeft`) gives no indication that a scan has already happened — a user watching the QR overlay countdown has no way to know a phone is, at that moment, waiting on their approval in a different window.
3. Even in the simple case (no pending request, just an expired code), "Regenerate" reads as a safe, idempotent action — nothing in the copy or interaction model signals that it might affect anything beyond the QR image itself.

### Root cause

The QR overlay and Control window are separate windows with no shared awareness of each other beyond both reading `get_state`; "regenerate" was implemented as "just call create_pairing again," which is correct for the common case (nothing has scanned yet) but was never audited against the case where a scan already landed and a second window is mid-approval.

### Redesign

1. Before invoking `createPairing()` from "New code"/"Regenerate," check current session status (available via the event-driven state from Finding 8, or a fresh `getState()` call): if `session === 'awaiting_approval'` or a pairing is otherwise in flight, show a confirmation ("A device is currently waiting for your approval — generating a new code will cancel that request. Continue?") before proceeding.
2. Disable/hide the "New code"/"Regenerate" button entirely once the code has been scanned (i.e., once `AwaitingApproval` is reached) — at that point the QR image is moot (a scan already happened), and the overlay should instead show "Scanned — check the approval request" with a button that focuses the Control window, rather than continuing to offer a QR-regeneration action that no longer makes sense.
3. Only allow true no-confirmation regeneration while genuinely `Pairing` with no request yet received (the safe case today).

### Tradeoffs

Adds a confirmation step to what's currently a zero-friction button — acceptable given the downside (silently killing a real pairing attempt) is strictly worse than one extra click in the rare case someone actually wants to cancel a pending approval.

### Implementation plan

1. `QrOverlay.tsx`: subscribe to session status (via Finding 8's hook) rather than being state-blind.
2. Swap the button's label/action once `status !== 'pairing'`: show "Scanned — go to approval" (focuses Control window via a new lightweight `focus_control` command, or reuse `show_control`) instead of "New code."
3. Add a native confirm (Tauri's `dialog` plugin, or a small in-app modal) gating `createPairing()` re-invocation to only the genuinely-safe case.

### Migration strategy

Frontend-only, dependent on Finding 8 landing first (needs live status in the QR overlay, which today never reads session status at all — `QrOverlay.tsx` has no `api.getState()` call whatsoever, confirmed by reading the full file).

### Testing strategy

- Manual: reach `AwaitingApproval` from a real or test scan, attempt "New code," confirm the confirmation dialog appears and cancelling it leaves the pending approval intact.
- Unit: state-gated button label/action test — `pairing` → "New code" direct action; `awaiting_approval` → "Scanned — go to approval" action, no destructive call made.

### Risk assessment

Low — purely additive guard/confirmation logic layered onto an existing button.

### Performance impact

None.

### Future extensibility

The same "does this destructive action need confirmation given current session state" pattern should be applied uniformly (bubble's force-new-pairing path in Finding 3 already follows it; this finding brings the QR overlay's equivalent action in line).

---

## Finding 10 — Pairing failures are swallowed silently; errors shown to the user are raw stringified exceptions

**Severity: Medium**

### Current implementation

- `Bubble.tsx:37-46`: `onPair`'s `catch` block does `console.error('createPairing failed', err);` and nothing else — `busy` resets to `false` in `finally`, and the bubble simply returns to its resting appearance. There is no user-visible error state anywhere in this component.
- `QrOverlay.tsx:36-38`: `catch (err) { setError(String(err)); }`, rendered as `Could not reach backend: {error}` (`QrOverlay.tsx:69`) — `String(err)` on a JS error/Tauri IPC rejection typically yields something like `"Error: could not reach backend at http://localhost:8080/pairing/create: error sending request"` — accurate, but written for a developer, not a user.

### Problems

1. If the backend is unreachable (a very real production scenario — the mandate explicitly notes this is an "internet-first" product, so backend reachability is not a given) and the user clicks the bubble, they get: the pulse animation for a moment, then... nothing. No toast, no error state, no retry affordance on the bubble itself — the failure is invisible unless they happen to also have the QR overlay open (which, per `create_pairing`'s ordering in `commands.rs:81-128`, wouldn't even open yet since the window-open call happens after the network request in this flow, meaning a failed request never even gets a window to show an error in).
2. The QR overlay's error string, while at least visible, is not actionable or reassuring — it doesn't distinguish "your Wi-Fi is off," "the backend is down," "your firewall is blocking this," or suggest a next step beyond implicitly "click New code again" (which will fail identically).

### Root cause

Error paths were built to "not crash," not to inform — reasonable for an M1 prototype being driven by its own engineers (who can read `console.error`), insufficient for a shipped product whose users have no console open.

### Redesign

1. `Bubble.tsx`: on `createPairing` failure, transition to a visible error state — e.g., the dot turns a distinct amber/grey "offline" color (add a 5th semantic state distinct from the existing four, or reuse a "degraded" treatmensynt) with a native tooltip/toast: "Can't reach Lilypad's server — check your connection and try again," plus a lightweight retry affordance (the bubble remains clickable to retry, rather than silently reverting to indistinguishable-from-idle).
2. `QrOverlay.tsx`: replace `String(err)` with a small classifier — network-unreachable vs. HTTP error vs. malformed response (the three cases `create_pairing`'s Rust side already distinguishes via distinct `Err(format!(...))` messages, `commands.rs:103,106,110`) — mapped to plain-language copy with a concrete next step ("We couldn't reach the Lilypad server. Check your internet connection, then tap Regenerate.").

### Tradeoffs

Requires defining and testing a small error-taxonomy mapping (network vs. HTTP vs. parse failure) rather than just passing strings through — modest added code, but this is table-stakes for any production app's error handling and directly serves the "loading/error/empty states" item explicitly called out in the audit mandate.

### Implementation plan

1. `commands.rs::create_pairing`: keep its three distinct error strings (already well-separated by call site) but consider returning a small structured error (`{ kind: "network" | "http" | "parse", message }`) instead of a flat `String`, so the frontend can classify without string-matching.
2. `Bubble.tsx`/`QrOverlay.tsx`: consume the structured error, map `kind` to copy + iconography.
3. Add a visible "offline"/error dot color distinct from the existing four `SessionStatus` colors (`Bubble.tsx:4-9`).

### Migration strategy

The Rust-side error-shape change is a breaking change to the `Result<T, String>` command signature — coordinate with the TypeScript `invoke<T>` call sites in `tauri.ts` in the same PR (both sides are in this repo, no cross-repo versioning concern).

### Testing strategy

- Unit: mock `reqwest` failures at each of the three call sites in `create_pairing`, assert the correct structured `kind` is returned for each.
- Manual: stop the backend locally, click the bubble, confirm a visible, plain-language error appears (not just a console log) and the bubble remains usable/retryable afterward.

### Risk assessment

Low — additive error-shape refinement, no behavior change to the success path.

### Performance impact

None.

### Future extensibility

The structured-error pattern generalizes to any future command that talks to the backend (e.g., a future "check for updates" or telemetry call).

---

## Finding 11 — QR expiry countdown is a bare number with a dead zone; no visual urgency, no auto-regenerate

**Severity: Medium**

### Current implementation

- `QrOverlay.tsx:45-55`: a plain `setInterval` decrementing `secondsLeft` once per second; displayed as `dd` text `{secondsLeft}s` inside a `<dl>` (`QrOverlay.tsx:74-76`).
- On expiry (`secondsLeft <= 0`), the QR image is grayscaled/blurred with an "Expired" badge overlaid (`QrOverlay.tsx:64-66`, CSS `.qr__frame--expired`, `styles.css:133-144`) — a good, clear treatment for the _expired_ state itself.
- However, nothing marks the _approaching_ expiry (e.g., last 10 seconds) — the countdown just ticks down as plain text with no color change, no pulsing, no visual progress indicator, until it flips straight from "12s" to the fully-blurred "Expired" state.
- Backend token TTL is 60s (`apps/backend/src/routes/pairing.ts:6` comment: "Desktop mints a single-use QR token (60s TTL in Redis)"), while the desktop's own `pairing_timeout()` is 120s (`session.rs:81-93`) — so between t=60s (QR dead) and t=120s (runner gives up), the overlay correctly shows "Expired," but the underlying signaling room/session runner is still alive for up to another 60 seconds doing nothing useful if the user simply leaves the window open without clicking Regenerate.

### Problems

1. No countdown urgency cues means a user glancing away and back gets no warning before the code goes dead — a plain number requires active reading/attention to notice "12... 11... 10," which is worse than a shrinking ring or color shift that's perceivable peripherally.
2. The 60s dead zone (expired-but-runner-still-alive) is invisible to the user but represents an open signaling WebSocket + heartbeat task with nothing to show for it — small but real waste that a "regenerate automatically" behavior would avoid.

### Root cause

The countdown was implemented as the minimum viable "does this even work" version (a `setInterval` and a number) with no design pass on urgency/affordance, and the desktop-side pairing timeout (120s) was deliberately set longer than the token TTL (60s) as a grace window for "a last-second scan still works" (`session.rs:82-86`) — a reasonable server-side safety margin that was never paired with a corresponding frontend behavior (auto-regenerate) to avoid the dead zone being user-visible/wasteful.

### Redesign

1. Replace the plain-text countdown with a circular progress ring around (or behind) the QR code itself, filling/depleting over the 60s window, color-shifting (e.g., accent green → amber in the last 10s) — communicates urgency peripherally, not just via a number a user has to read.
2. Auto-regenerate: when `secondsLeft` hits 0 and no scan has occurred (`status === 'pairing'` still), automatically call `generate()` again after a short pause (e.g., 1.5s, enough to let the "Expired" state register) rather than waiting for a manual "Regenerate" click — removes the dead zone and the extra click entirely for the common "I was slow to scan" case. Suppress auto-regenerate if a scan already landed (mirrors Finding 9's guard).
3. Keep the manual "Regenerate" button for the case where the user wants a fresh code before expiry (e.g., they suspect the current one was captured by the wrong device).

### Tradeoffs

Auto-regeneration means the code in the QR image changes without explicit user action, which could be surprising if someone is mid-way through typing the numeric fallback (if one exists) or has already started scanning as it flips — mitigate with the 1.5s pause and by not regenerating if a scan/redeem is already in flight (same guard as Finding 9).

### Implementation plan

1. `QrOverlay.tsx`: add an SVG/CSS conic-gradient ring component driven by `secondsLeft / expiresInSeconds`.
2. Add the auto-regenerate `useEffect` keyed on `expired && status === 'pairing'`.
3. Reuse Finding 9's "don't regenerate over a pending approval" guard.

### Migration strategy

Frontend-only, no backend changes; independent of other findings though best sequenced after Finding 9 (shares the "don't regenerate over a live request" guard logic).

### Testing strategy

- Unit: countdown ring renders proportional fill at t=45/60, t=10/60, t=0/60.
- Unit: auto-regenerate fires exactly once per expiry when no scan has landed; does not fire when `status !== 'pairing'`.
- Manual: let a code expire untouched, confirm a new one appears automatically within ~2s with no manual click.

### Risk assessment

Low.

### Performance impact

Negligible (one more CSS-driven ring, one more timer already covered by the existing countdown interval).

### Future extensibility

The same ring component is reusable for any other bounded-time affordance the product adds later (e.g., a future "session will auto-lock in Xs" idle-timeout indicator).

---

## Finding 12 — Session-active state shows no "who / since when," and windows open with no spatial relationship to the bubble

**Severity: Medium**

### Current implementation

- `Control.tsx:59-62`: the entire "active" UI is `<p className="muted">Streaming + input arrive in M2–M4. You are in control.</p>` (stale M1/M2-era copy, now inaccurate since streaming/input are real per the mandate) plus Disconnect/Panic buttons — no device name, no connected-since timestamp, anywhere.
- `AppState` (`state.rs:25-36`) has no field for session-start time or the connected device's identity — there is nothing to display even if the component were rewritten, independent of Finding 2's `PendingRequest` (which only covers the _pre_-approval phase, not the ongoing active phase).
- Window positioning: `qr-overlay` and `control` are built via `WebviewWindowBuilder::new(...).inner_size(w, h)` (`commands.rs:294-299`) with no `.position(x, y)` call — they open wherever the OS/Tauri defaults place a new window (typically cascaded or centered), with no relationship to the bubble's fixed anchor at `x: 40, y: 120` (`tauri.conf.json:28-30`) that the user just clicked.

### Problems

1. Directly fails the mandate's explicit ask ("session-active indicator and privacy affordances (who is connected, since when...)") — there is currently no way, anywhere in the UI, to see who is connected or for how long during an active session.
2. The stale "Streaming + input arrive in M2–M4" copy actively misinforms a user reading it today, post-M2/M3/M4 landing — it describes the product as not-yet-working when it is, in fact, actively streaming and accepting input at that exact moment.
3. New windows appearing disconnected from the bubble's location breaks the sense of "one coherent object" a polished menu-bar-style utility should have — every popover-driven macOS utility (Bluetooth, Wi-Fi, Control Center modules) anchors its detail view to the control that spawned it; Lilypad's QR/Control windows instead behave like unrelated top-level app windows.

### Root cause

`AppState` was scoped to exactly what `SessionStatus` needed for the coarse state machine (`state.rs` docstring: "Coarse session lifecycle shown in the UI"); richer session metadata (who, since when) was never added because the debug list (Finding 2) was considered sufficient during M1–M2 development. Window positioning was left at OS defaults because M1's priority was "does the window open at all," not spatial polish.

### Redesign

1. Add `connected_device_name: Option<String>` and `session_started_at: Option<DateTime<Utc>>` (or a monotonic `Instant` converted to a display string) to `AppState`/`AppStateDto`, populated when `ConnectionState { state: "connected" }` first transitions to `Active` (`commands.rs:182-186`) and cleared on `Ended`.
2. Rewrite `Control.tsx`'s active section: `"Connected to {device_name ?? 'a device'} — active for {elapsed}"` with a live-updating elapsed-time readout (ties naturally into Finding 8's event-driven refresh, or a lightweight local 1s ticker purely for the elapsed-time display, which is fine to keep as a timer since it's cosmetic, not state-driving).
3. Position `qr-overlay`/`control`/the Finding-3 popover windows explicitly relative to the bubble's known position (read from the `bubble` window's current position via `get_position()`, or simply hardcode an offset since the bubble's own position is currently static in `tauri.conf.json`) — e.g., open 12px to the right of the bubble, matching its vertical center, so the two visually read as one connected object.

### Tradeoffs

Anchoring windows to the bubble's position becomes more complex once the bubble itself is made draggable/repositionable (not currently the case — no drag-persistence code exists — but worth flagging as a coupling point for that future feature) — get the bubble's _live_ position via the Tauri window API at open-time rather than hardcoding the `tauri.conf.json` default, so this doesn't rot the moment the bubble becomes movable.

### Implementation plan

1. `state.rs`: add the two new fields.
2. `commands.rs::apply_session_event`: populate on the `connected` transition (need the device name from `PendingRequest`, established in Finding 2 — this finding depends on that one landing first for the name; the timestamp is independent).
3. `Control.tsx`: rewrite the active section's copy and add an elapsed-time ticker.
4. `commands.rs::open_window`: add an optional `anchor: Option<(f64, f64)>` parameter, computed from the bubble window's live position at call sites in `create_pairing` and `show_control`.

### Migration strategy

Additive Rust fields + one frontend rewrite; sequence after Finding 2 (for the device name) but can ship the elapsed-time and window-anchoring parts independently/first if desired.

### Testing strategy

- Unit: `apply_session_event` sets `session_started_at` exactly once on the `Pairing/AwaitingApproval → Active` transition, not on every subsequent `ConnectionState` event (e.g., an ICE-restart reconnect blip shouldn't reset the "since when" clock).
- Manual: visually confirm the QR overlay/Control window open adjacent to the bubble, not centered on screen.
- Manual: verify the active-session copy accurately reflects device name + a plausible elapsed time against a wall clock.

### Risk assessment

Low.

### Performance impact

Negligible (one more small ticker for elapsed-time display).

### Future extensibility

`session_started_at` is also the natural field to drive a future "session duration" entry in the audit log / activity history UI.

---

## Finding 13 — No dark/light mode adaptation; hardcoded dark palette regardless of system appearance

**Severity: Medium**

### Current implementation

- `styles.css:1-15` defines a single, hardcoded dark palette (`--bg: #0e1512`, `--ink: #e8f5ee`, etc.) at `:root`, with no `@media (prefers-color-scheme: light)` block and no light-mode variable set anywhere in the file (confirmed by reading the full 249-line file — there is exactly one `:root` block).
- Every window (bubble, QR overlay, Control) inherits this fixed dark theme unconditionally, regardless of the user's macOS/Windows system appearance setting.

### Problems

1. On a system set to Light mode, Lilypad's small utility windows (QR overlay, Control) will look visually foreign against every other light-mode system dialog and app chrome the user sees around them — directly contrary to "should feel like Apple designed it," since first-party and well-made third-party Mac utilities adapt to the system appearance by default.
2. The mandate explicitly calls out "dark/light mode" as an audit focus area — there is currently zero support for it.

### Root cause

Dark-only styling was the fastest path to a "looks intentional" prototype (a single fixed palette avoids needing to design/test two themes) and was never revisited once the basic windows worked.

### Redesign

1. Restructure `styles.css`'s custom properties into a light default + `@media (prefers-color-scheme: dark)` override (or vice versa, whichever the team wants as default), covering `--bg`, `--panel`, `--ink`, `--muted`, `--accent`, `--danger`, `--line` — every variable already centralized at `:root` today, so this is a scoping change, not a rewrite of every rule.
2. Pick an accent/danger pairing that still reads correctly on both backgrounds — verify contrast ratios (WCAG AA, 4.5:1 for text) in both modes, not just the current dark one.
3. Since these are `transparent`/`decorations: false` custom-chrome windows (`tauri.conf.json:23-24`), also confirm the transparent bubble window's drop-shadow/gradient (`styles.css:49-52`) still reads correctly against both a light and dark desktop background behind it.

### Tradeoffs

None significant — this is a scoping change to already-centralized CSS custom properties, not a structural redesign.

### Implementation plan

1. `styles.css`: split `:root` into a light-default block and a `@media (prefers-color-scheme: dark)` override block with the current dark values.
2. Manually re-verify every hardcoded non-variable color in the file (e.g., `.qr__frame` hardcodes `background: #fff` at `styles.css:125`, which happens to already suit both themes since the QR code itself needs a white quiet-zone regardless of app theme — confirm this and any other hardcoded literals are intentionally theme-independent, not accidentally so).

### Migration strategy

CSS-only change; no component logic changes needed since everything already reads from custom properties. Ship as an isolated, easily-reviewable PR.

### Testing strategy

- Manual: toggle macOS system appearance between Light/Dark with the app running, confirm all three window types (bubble, QR overlay, Control) restyle correctly without a restart (CSS media queries update live).
- Automated: a contrast-ratio check (e.g., via a small script or `axe-core` if introduced) against both palettes for the text/background pairs actually used.

### Risk assessment

Low.

### Performance impact

None.

### Future extensibility

Once themed via `prefers-color-scheme`, adding an explicit in-app theme override (light/dark/system) later is a small additive step (a stored preference toggling a `data-theme` attribute, same mechanism artifact-hosted pages in this workflow already use) rather than a rearchitecture.

---

## Finding 14 — Accessibility gaps: color-only status encoding, static/misleading labels, no visible focus states, no reduced-motion handling

**Severity: Medium**

### Current implementation

- `Bubble.tsx:57`: the status dot is a `<span>` with only a `backgroundColor` style and no `aria-label`/text alternative — a screen-reader user gets no information about session status from it at all; the button's own `aria-label` (`Bubble.tsx:54`, `"Lilypad — pair a phone"`) is static and doesn't change with state, so it's actively misleading during an active session (it still announces "pair a phone" when a session is, in fact, already live and the correct action per Finding 3's redesign would be to disconnect, not pair again).
- `styles.css`: no `:focus` or `:focus-visible` rule anywhere in the file (confirmed by full read) — `.btn` and its variants rely entirely on browser/WebView default focus rendering, which in many WebKit/Tauri webview contexts is subtle-to-invisible, making keyboard navigation of the Approve/Deny/Disconnect/Panic buttons hard to visually track.
- `.bubble--busy`'s `pulse` animation (`styles.css:63-64, 79-83`) has no `@media (prefers-reduced-motion: reduce)` guard — it will run unconditionally for users who've set that system accessibility preference specifically to avoid this class of animation.

### Problems

1. Color-only status encoding fails WCAG 1.4.1 (Use of Color) and specifically fails colorblind users, who are a real fraction of any user base, for the one indicator (session active = someone else has control of your computer) where a missed signal has the highest privacy stakes in the whole product.
2. A static `aria-label` that says "pair a phone" during an active session is worse than no label at all for assistive-technology users — it recommends exactly the wrong action (Finding 3's fix must update this label per state as part of that redesign).
3. No visible focus rings make the Approve/Deny/Disconnect/Panic buttons — the most consequential buttons in the app — hard to operate confidently via keyboard, which matters specifically for the security-sensitive approve/deny decision (Finding 2).
4. Ignoring `prefers-reduced-motion` on the pulse animation is a small but real miss for a product that otherwise wants to be judged as "Apple-quality" — Apple's own HIG treats honoring this preference as a baseline requirement, not an extra.

### Root cause

Accessibility wasn't in scope for the M1/M2 "does the pipeline work" milestones and nothing has circled back; the component styling was written fast, using only color for state (simplest implementation) with no parallel text/pattern channel added.

### Redesign

1. Add a visually-hidden (`sr-only`-pattern) text description alongside the dot reflecting `STATUS_LABEL`-equivalent text (the label map already exists in `Control.tsx:4-9` — reuse/hoist it into a shared constant both components import), and make the button's `aria-label` state-dependent (`"Lilypad — {status === 'active' ? 'session active, click to disconnect' : 'click to pair a phone'}"`).
2. Add an explicit `:focus-visible` style to `.btn` and its variants in `styles.css` (a visible outline or ring in the accent color, distinct enough to track by eye and to pass contrast checks against both themes from Finding 13).
3. Wrap the `pulse` keyframe usage in `@media (prefers-reduced-motion: no-preference) { .bubble--busy { animation: pulse 1s ease-in-out infinite; } }`, with a static (non-animated) busy indicator (e.g., a fixed dimmer/border treatment) as the reduced-motion fallback.

### Tradeoffs

None significant — these are additive, low-risk accessibility fixes with no functional tradeoff against the existing design.

### Implementation plan

1. Hoist `STATUS_LABEL`/`STATUS_COLOR` into a shared `src/lib/status.ts` consumed by both `Bubble.tsx` and `Control.tsx` (currently duplicated/divergent — `Bubble.tsx:4-9` defines colors only, `Control.tsx:4-9` defines labels only, for the same enum).
2. Add the `sr-only` text span + dynamic `aria-label` to `Bubble.tsx`.
3. Add `:focus-visible` rules to `styles.css`'s `.btn` block.
4. Wrap `.bubble--busy`'s animation declaration in the `prefers-reduced-motion` media query.

### Migration strategy

Frontend/CSS-only, no backend involvement; low-risk, ship independently at any point.

### Testing strategy

- Manual: VoiceOver walkthrough of the bubble across all four `SessionStatus` values, confirm the announced label is accurate and non-misleading for each.
- Manual: Tab through the Control window's buttons, confirm a visible focus indicator at every stop.
- Manual: enable "Reduce Motion" in macOS Accessibity settings, confirm the busy-pulse animation is suppressed in favor of the static fallback.

### Risk assessment

Low.

### Performance impact

None.

### Future extensibility

The shared `status.ts` constants (label + color + now aria text) become the single source of truth for any future surface (e.g., Finding 3's bubble popover, Finding 4's tray icon swap) that needs to represent `SessionStatus` consistently.

---

## Finding 15 — Tray icon is the full-color app icon, not a template image; doesn't adapt to macOS menu bar appearance/selection states

**Severity: Polish**

### Current implementation

- `lib.rs:74-76`: `if let Some(icon) = app.default_window_icon() { builder = builder.icon(icon.clone()); }` — the tray uses the same full-color app icon as the dock/window icon (from `tauri.conf.json:41-45`'s `bundle.icon` list), with no separate template-mode asset and no `icon_as_template(true)` call on the `TrayIconBuilder` (confirmed absent by reading `build_tray` in full, `lib.rs:54-100`).

### Problems

Every native macOS menu bar icon from Apple's own apps, and from well-made third-party utilities, uses a monochrome "template" image that macOS automatically inverts/tints for light/dark menu bars and for the highlighted (clicked) state. A full-color icon in that position looks visually out of place next to Wi-Fi, Bluetooth, Control Center, etc. — small in isolation, but exactly the class of detail the mandate's "feel like Apple designed it" framing is about.

### Root cause

The default window icon was reused for the tray as the path of least resistance; no separate monochrome tray asset was ever created.

### Redesign

Add a dedicated monochrome (black-with-alpha) tray icon asset sized per Apple's menu bar guidance (typically an 18×18pt / 36×36px @2x template PNG), load it via `Image::from_bytes`/`from_path` instead of `default_window_icon()`, and call `.icon_as_template(true)` on the `TrayIconBuilder`. Combine with Finding 4's proposal to swap to a filled/accented variant while a session is active (macOS templates can still convey state via shape/fill even though color is system-controlled).

### Tradeoffs

Requires designing one additional small asset (and an "active" variant) — minor design effort, no engineering risk.

### Implementation plan

1. Add `icons/tray-icon-Template.png` (+ `@2x`) monochrome asset to `src-tauri/icons/`.
2. `lib.rs::build_tray`: load it explicitly and call `.icon_as_template(true)` before `.build(app)`.
3. Add a second `tray-icon-active-Template.png` variant for Finding 4's active-state swap.

### Migration strategy

Additive asset + one-line builder change; no risk to existing functionality.

### Testing strategy

Manual: verify the tray icon renders correctly (properly inverted/tinted) in both macOS Light and Dark menu bar modes, and while the tray icon is actively clicked (highlighted state).

### Risk assessment

Low.

### Performance impact

None.

### Future extensibility

Establishes the asset pipeline for any future tray-icon state (e.g., a distinct icon for "permission needed" from Finding 1).

---

## Finding 16 — `SessionStatus.active` reuses the same red used for destructive/danger actions, creating semantic ambiguity

**Severity: Polish**

### Current implementation

- `Bubble.tsx:8`: `active: '#ff5c5c'` — identical to `--danger: #ff5c5c` in `styles.css:7`, which is also the color for `.btn--danger` (Deny/Panic buttons, `styles.css:185-190`) and the `.badge--active` border/text color (`styles.css:207-210`).

### Problems

The same red hue is asked to mean three different things depending on context: "a session is actively connected" (arguably a _neutral-to-positive_, expected state once approved) and "this action is destructive/irreversible" (Deny, Panic). While a red "you're being watched" indicator is a defensible, even desirable, privacy-forward choice on its own (similar to a webcam recording light), reusing the exact same token as the danger-button color blurs the two meanings and makes the design system's color vocabulary less legible over time as more states are added.

### Root cause

A single `--danger` variable was the most convenient existing red to reach for when adding the `active` status color; no separate semantic token was introduced for "session active / being observed."

### Redesign

Introduce a distinct `--live` (or `--recording`) token, visually related to but distinguishable from `--danger` (e.g., a slightly warmer/more saturated red-orange, or keep red but pair it with a distinct icon/pulse treatment so "active" is never conflated with "destructive" at a glance), and repoint `STATUS_COLOR.active` and `.badge--active` to it, leaving `--danger` exclusively for Deny/Panic/error affordances.

### Tradeoffs

Minor — a new token plus updating two references; no functional risk.

### Implementation plan

1. `styles.css`: add `--live: #ff7847` (or team's preferred choice) alongside `--danger`.
2. `Bubble.tsx`/`Control.tsx`: repoint the `active` color reference (after hoisting to shared `status.ts` per Finding 14) to `--live`.

### Migration strategy

CSS/constant-only change, ship anytime.

### Testing strategy

Visual review only — confirm the new color is still clearly legible against the (now dual-theme, per Finding 13) backgrounds and passes contrast checks.

### Risk assessment

Low.

### Performance impact

None.

### Future extensibility

Keeps the door open for a richer status-color vocabulary (e.g., a distinct "reconnecting" amber already implied by `SignalingReconnecting`/`SignalingReconnected` events that exist in the protocol, `session.rs:50-51`, but have no corresponding `SessionStatus` variant or color today at all — worth a follow-up finding of its own if the team wants transient-reconnect states surfaced to the user rather than being silently absorbed into "Active").

---

## Finding 17 — QR overlay and Control windows are `resizable(false)` with fixed pixel dimensions, risking clipped content for longer device names/locales

**Severity: Polish**

### Current implementation

- `commands.rs:294-299`: both windows are built with fixed `inner_size(w, h)` and `.resizable(false)`; `open_window`'s only two call sites use `360.0 × 500.0` (QR overlay) and `400.0 × 560.0` (Control).
- Once Finding 2 and Finding 12 add device names and richer approval/active-session copy into these windows, that content is free-form string data (a phone's Bluetooth/device name, which can be arbitrarily long — e.g., "Alex's iPhone 15 Pro Max (Work)").

### Problems

A fixed, non-resizable window with dynamically-sized text content (device names, future localized strings) risks visual clipping or overflow the moment a name is longer than whatever fit the design during testing — and because the window can't be resized by the user, there's no user-side recovery if it happens.

### Root cause

Fixed dimensions were reasonable when all rendered content was fully known/static (status labels, fixed button copy); this stops being true the moment Finding 2/12's dynamic device-name content ships.

### Redesign

Keep `resizable(false)` (appropriate for this kind of small utility window) but make the _content_ robust to overflow: apply `text-overflow: ellipsis` + `white-space: nowrap` with a `title` attribute (full name on hover) to any dynamic string slot (device name, room id), and size-test the layout against a deliberately long synthetic device name during implementation of Findings 2/12 rather than only the short names used in current manual testing.

### Tradeoffs

None significant — this is a CSS robustness pass that should simply be part of implementing Findings 2/12, not a standalone architectural change.

### Implementation plan

Apply ellipsis truncation + `title` tooltips to the new device-name/room-id display elements added by Findings 2 and 12 at the time those are implemented.

### Migration strategy

Bundle into Findings 2/12's implementation PRs rather than a separate change.

### Testing strategy

Manual: test both windows with a synthetic 60+ character device name, confirm graceful truncation with a hover tooltip revealing the full string, no layout overflow/clipping.

### Risk assessment

Low.

### Performance impact

None.

### Future extensibility

Establishes a "always test dynamic strings at their reasonable maximum length" habit for any future field added to these windows.

---

## Finding 18 — `withGlobalTauri: true` exposes the full Tauri IPC surface to any script in every webview

**Severity: Polish (flagged for cross-reference with Finding 7's security note)**

### Current implementation

`tauri.conf.json:14`: `"withGlobalTauri": true` — combined with `"csp": null` (`tauri.conf.json:34`), this exposes `window.__TAURI__` (including raw `invoke`) globally in every window's JS context, with no Content-Security-Policy restricting what scripts may run there.

### Problems

While this repo's own frontend code is trusted, `withGlobalTauri` + `csp: null` together mean that if any future code path ever loads remote/third-party content into one of these webviews (even inadvertently, e.g., an `<a>` opened via `shell:allow-open`, `capabilities/default.json:11`, targeting an untrusted URL that then gets rendered rather than opened externally), that content would have unrestricted access to every registered Tauri command, including the ones flagged as sensitive in Finding 7. Today, with `simulate_pair_request` still present (Finding 7) and no CSP at all, this is a materially larger surface than a minimal, hardened Tauri app should carry into an "M5 production quality" review.

### Root cause

`withGlobalTauri: true` and `csp: null` are convenient defaults during early development (no import boilerplate, no CSP debugging) that were never tightened before this milestone.

### Redesign

1. Set `withGlobalTauri: false` and switch all frontend `invoke`/`listen` calls to the scoped `@tauri-apps/api` imports (`tauri.ts` already imports `invoke` from `@tauri-apps/api/core` — `tauri.ts:1` — so this is likely a no-op for existing code and only removes the _additional_, redundant global exposure).
2. Add a real CSP (`app.security.csp`) restricting `script-src`/`connect-src` appropriately instead of `null`.

### Tradeoffs

None expected — the codebase already uses the scoped import style everywhere observed (`tauri.ts:1`, `App.tsx:1`), so disabling the redundant global should be a no-op functionally, just a hardening change.

### Implementation plan

1. `tauri.conf.json`: `"withGlobalTauri": false`.
2. `tauri.conf.json`: replace `"csp": null` with an explicit policy (start restrictive: `default-src 'self'; connect-src 'self' http://localhost:8080 ws://localhost:8080` for dev, tightened further for the real backend origin in production config).
3. Grep the codebase for any remaining `window.__TAURI__` usage before flipping the flag (none found in the files read for this audit, but re-verify against the full `src/` tree before shipping).

### Migration strategy

Config-only change; verify no runtime code depends on the global before flipping, then ship.

### Testing strategy

Manual: after the change, attempt `window.__TAURI__` in a webview devtools console, confirm it's `undefined`; confirm the app's own functionality (pairing, approve/deny, disconnect) is unaffected since it already goes through the scoped imports.

### Risk assessment

Low, given the scoped-import pattern is already in universal use — but treat as a genuine hardening item, not pure polish, given Finding 7's overlap.

### Performance impact

None.

### Future extensibility

A real CSP is the prerequisite for safely loading any future remote content (e.g., a hosted help/onboarding page) inside a Lilypad window without reopening this exact risk.

---

## Summary Table

| #   | Finding                                                                   | Severity |
| --- | ------------------------------------------------------------------------- | -------- |
| 1   | No guided permission onboarding (prompt/deep-link/poll/relaunch)          | Critical |
| 2   | Approve/Deny is a debug list; discards device name & scope                | Critical |
| 3   | Bubble click has no session-state guard — can kill active session         | Critical |
| 4   | Panic disconnect not reliably reachable during active session             | Critical |
| 5   | No window-close handling on qr-overlay/control — stuck/orphaned sessions  | High     |
| 6   | Tray menu items always enabled — fake "ghost" active sessions             | High     |
| 7   | Dev-only "Simulate phone scan" shipped in production, unauthenticated     | High     |
| 8   | Frontend polls get_state; ignores existing event stream                   | High     |
| 9   | QR regenerate can silently cancel an in-flight approval                   | High     |
| 10  | Pairing failures swallowed silently / raw error strings                   | Medium   |
| 11  | QR countdown has no urgency cues, no auto-regenerate, dead zone           | Medium   |
| 12  | No "who/since when" during active session; windows not anchored to bubble | Medium   |
| 13  | No dark/light mode adaptation                                             | Medium   |
| 14  | Accessibility: color-only status, no focus states, no reduced-motion      | Medium   |
| 15  | Tray icon not a template image                                            | Polish   |
| 16  | `active` status reuses the danger/red color token                         | Polish   |
| 17  | Fixed-size windows risk clipping dynamic device-name content              | Polish   |
| 18  | `withGlobalTauri`/`csp:null` unnecessarily broaden IPC surface            | Polish   |
