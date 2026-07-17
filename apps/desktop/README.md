# @lilypad/desktop

Tauri v2 + React. Floating bubble, tray menu, QR overlay, approve/deny control
window, and the Rust **plugin host** (8 plugins; capture/encode/input delegate to
per-OS backends for macOS + Windows).

## Run

Requires the **Rust toolchain + Tauri v2 prerequisites** (see the root README).

```bash
pnpm --filter @lilypad/desktop dev     # tauri dev (spawns Vite on :5174)
pnpm --filter @lilypad/desktop build   # production bundle
```

Point the app at a non-default backend with `LILYPAD_BACKEND_URL` (defaults to
`http://localhost:8080`).

## Windows (label-based)

One bundle, rendered by window label:

- `bubble` — always-on-top floating pad; click to start pairing.
- `qr-overlay` — shows the QR from a real `POST /pairing/create`; 60s countdown.
- `control` — approve/deny + session badge + plugin-health debug panel.

In M1 the QR overlay has a **"Simulate phone scan"** dev button so the
approve/deny flow is drivable without a phone (removed when M2 signaling lands).

## Icons

`src-tauri/icons/` holds generated placeholder icons. Replace with your logo via:

```bash
pnpm --filter @lilypad/desktop tauri icon path/to/logo.png
```

## Layout

```
src/                 React UI (App routes by window label)
src-tauri/src/
  lib.rs             app builder, tray, device id, plugin host boot
  commands.rs        create_pairing, approve/deny, disconnect, panic
  state.rs           shared AppState
  plugins/           Plugin trait + 8 plugins
  os/{macos,windows} capture/encode/input backends (stubbed → M3/M4)
```
