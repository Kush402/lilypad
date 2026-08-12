---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-12
summary: Desktop capability architecture (replaced the old PluginHost).
---

# Lilypad — Desktop Capability Architecture

> **Status:** this document originally described a generic `Plugin`/`PluginHost`
> lifecycle wrapper. That system was removed in the M3 architecture pass — see
> [`docs/audit/m3/architecture.md`](./audit/m3/architecture.md) (Finding F3) for
> the full rationale. This page now describes what replaced it.

## What existed before, and why it was removed

Every desktop capability used to be a `Plugin` with a uniform
`initialize`/`start`/`stop`/`health_check` lifecycle, owned by a `PluginHost`.
By the time M3/M4 shipped real capture/encode/input implementations, this
wrapper had stopped adding value:

- **Five of eight plugins had no real logic at all** (`AuditLogPlugin`,
  `ClipboardPlugin`, `DevShortcutsPlugin`, `QRPairingPlugin`,
  `WebRTCTransportPlugin`) — `initialize` just set a `ready` flag, so
  `health_check` could never report anything but "ok" for the lifetime of the
  process.
- **Two plugins constructed a second, redundant backend instance**
  (`ScreenCapturePlugin`, `InputInjectionPlugin`) purely to poll a permission
  status — a duplicate of the real `CaptureBackend`/`InputBackend` the actual
  session pipeline already owned.
- **One plugin built and discarded real hardware at every app launch**
  (`EncoderPlugin` constructed a full VideoToolbox encoder session just to
  check "did it build", then threw the result away), adding real startup
  latency for a health value that then never updated again.

None of this logic was reachable from the actual WebRTC/media/input path —
it existed purely to populate the debug health overlay
(`AppStateDto.plugin_health`, rendered in `Control.tsx`).

## What replaced it

Capture, encode, and input each have their own dedicated trait + per-OS
backend, with no generic lifecycle wrapper on top:

- `crate::media::capture::CaptureBackend` — real ScreenCaptureKit on macOS
  (`apps/desktop/src-tauri/src/media/capture/`)
- `crate::media::encoder` — real VideoToolbox (macOS) / openh264 software
  fallback (`apps/desktop/src-tauri/src/media/encoder/`)
- `crate::input::InputBackend` — real CGEvent on macOS, SendInput
  compile-complete on Windows (`apps/desktop/src-tauri/src/input/`)

These are driven directly by the session runner
(`crate::session::media_controller`, `crate::session::input_gate`) — not
through a plugin facade.

The debug health overlay (`crate::health::plugin_health()`,
`apps/desktop/src-tauri/src/health.rs`) reports only the health that was ever
real: the two OS permissions that actually gate functionality, queried fresh
on every poll via cheap, instance-free preflight checks
(`crate::permission::screen_capture_status`/`accessibility_status`) — no
owned backend object kept alive just to be asked a yes/no question, and no
stale boot-time value. `Encoder` reports a static "not yet tested this run"
label rather than a value that could actively lie about a mid-stream failure;
wiring a genuine live per-session encoder-health signal is tracked as a
follow-up (`docs/audit/m3/ROADMAP.md`, Phase 2/3), not something the removal
itself needed to solve.

| Capability | macOS                         | Windows                                  |
| ---------- | ----------------------------- | ---------------------------------------- |
| Capture    | **ScreenCaptureKit (real)**   | Windows Graphics Capture (not yet wired) |
| Encode     | **VideoToolbox H.264 (real)** | Media Foundation H.264 (stub)            |
| Input      | **CGEvent (real)**            | SendInput (compile-complete)             |

## If a future capability genuinely needs a lifecycle

A uniform init/start/stop lifecycle is a good idea for a capability that
really does have that shape — e.g. a future audio capture stream or a
background clipboard-watcher thread. If M5+ needs several independent,
stateful, restartable background capabilities, introduce a lifecycle
abstraction sized to what actually needs one, rather than reintroducing a
single generic wrapper that most registered capabilities never vary.
