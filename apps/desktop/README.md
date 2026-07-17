# @lilypad/desktop

Tauri v2 + React. Floating bubble, tray menu, QR overlay, approve/deny control
window, first-run permission wizard, and the Rust media/input engine
(ScreenCaptureKit capture → VideoToolbox H.264 encode → webrtc-rs transport;
CGEvent input injection) with per-OS backends behind traits (macOS real,
Windows compile-complete stubs).

## Run

Requires the **Rust toolchain + Tauri v2 prerequisites** (see the root README).

```bash
pnpm --filter @lilypad/desktop dev     # tauri dev (spawns Vite on :5174)
pnpm --filter @lilypad/desktop build   # production bundle
```

Point the app at a non-default backend with `LILYPAD_BACKEND_URL` (defaults to
`http://localhost:8080`). Useful dev env vars: `RUST_LOG=info` (structured
logs), `LILYPAD_CAPTURE_KIND=synthetic` (no Screen Recording permission
needed), `LILYPAD_ENCODER_KIND=software` (skip VideoToolbox).

## Windows (label-based)

One bundle, rendered by window label:

- `bubble` — always-on-top floating pad; click to start pairing.
- `qr-overlay` — shows the QR from a real `POST /pairing/create`; 60s countdown.
- `control` — approve/deny + session badge + subsystem-health debug panel.
- `setup` — first-run Screen Recording / Accessibility permission wizard.

The QR overlay keeps a **"Simulate phone scan"** dev button so the
approve/deny flow is drivable without a phone.

## Icons

`src-tauri/icons/` holds generated placeholder icons. Replace with your logo via:

```bash
pnpm --filter @lilypad/desktop tauri icon path/to/logo.png
```

## Layout

```
src/                    React UI (App routes by window label)
src-tauri/src/
  lib.rs                app builder, tray, device id, logger, permission gate
  commands.rs           create_pairing, approve/deny, disconnect, panic, restart
  state.rs              shared AppState
  permission.rs         Screen Recording / Accessibility status + request
  power.rs              display-sleep prevention while a session runs
  health.rs             per-subsystem health for the debug panel
  media/                pipeline: capture/ (screencapturekit, synthetic),
                        encoder/ (videotoolbox, software), abr, metrics, mode
  input/                dispatcher (gating/scope/dedup), worker, protocol,
                        macos (CGEvent), windows (stub), metrics
  rtc/                  webrtc-rs peer, tracks, DataChannel, RTCP feedback
  session/              session FSM, media controller, input gate, runner
  signaling/            WS client + serde mirror of @lilypad/protocol
```
