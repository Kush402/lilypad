# Lilypad — Input Protocol

Carried over the WebRTC **DataChannel** (`lilypad-input`, reliable + ordered),
**phone → desktop**. Schemas:
[`packages/protocol/src/input.ts`](../packages/protocol/src/input.ts).

## Rules

- **Coordinates are normalized `0..1`** relative to the streamed frame, so they
  survive resolution/DPR differences between phone and laptop.
- **Pointer moves are coalesced** on the sender (batched, ~120Hz cap /
  `POINTER_COALESCE_MS`). Down/up, clicks, keys, and shortcuts are sent
  **immediately**.
- **Every event is timestamped** (`ts`, ms since epoch on the sender) for
  ordering + input-latency metrics.
- Events are sent in an `input_batch` envelope: `{ kind:"input_batch", events:[…] }`.

## Events

| kind                          | fields                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `pointer_move`                | `x, y`                                                                                             |
| `pointer_down` / `pointer_up` | `x, y, button` (`left`/`right`/`middle`)                                                           |
| `click`                       | `x, y, button, count` (1–3)                                                                        |
| `scroll`                      | `x, y, dx, dy` (CSS px; +dy scrolls down)                                                          |
| `key_down` / `key_up`         | `code` (UI Events `code`, e.g. `KeyA`,`Enter`,`Tab`), `modifiers[]`, `repeat`                      |
| `text_input`                  | `text` (committed IME/autocorrect text)                                                            |
| `shortcut`                    | `action` (`copy`,`paste`,`cut`,`undo`,`redo`,`select_all`,`save`,`escape`,`tab`,`enter`,`arrow_*`) |
| `clipboard`                   | `text` — set desktop clipboard (phone→desktop paste bridge)                                        |

Modifiers are OS-agnostic (`ctrl`,`alt`,`shift`,`meta`); the desktop maps
`meta`→⌘ on macOS / Win key on Windows, and dev shortcuts to the right chord per
platform (e.g. `copy` → ⌘C or Ctrl+C).

## Interaction modes (mobile)

- **Trackpad mode:** relative pointer movement (like a laptop trackpad); good for
  precision on a small screen.
- **Direct touch mode:** tap maps to an absolute pointer position on the frame.

## Injection (desktop) ✅ macOS real, Windows compile-complete

Implemented in `apps/desktop/src-tauri/src/input/`:
`DataChannel bytes → decode → InputDispatcher (gating, dedup, held-key/button
state) → InputBackend → OS`.

- **`InputDispatcher`** ([dispatcher.rs](../apps/desktop/src-tauri/src/input/dispatcher.rs)) is OS-agnostic and fully unit-tested behind a mock: it
  rejects all input unless the gate is open (session Connected **and** the
  input DataChannel open), drops stale/duplicate events by comparing each
  event's `ts` against the last accepted `ts` for its (kind, identifier) key,
  tracks held pointer buttons/keys to emit drag vs. move and to **release
  everything** on disconnect (never leaves a stuck modifier key or a
  mid-drag button held), and maps the `shortcut` action set to a
  primary-modifier chord (Cmd on macOS, Ctrl on Windows).
- **macOS backend** ([macos.rs](../apps/desktop/src-tauri/src/input/macos.rs)) is real: **CGEvent** injection (mouse move/down/up/drag/click, scroll,
  keyboard incl. modifiers, Unicode text typing) mapping normalized
  coordinates to the main display's point space. Gated on **Accessibility**
  permission via `AXIsProcessTrusted()` — checked (with a 500ms cache, since
  the call is an XPC round-trip to `tccd`) before every injection; a missing
  grant surfaces an actionable error rather than failing silently.
- **Windows backend** ([windows.rs](../apps/desktop/src-tauri/src/input/windows.rs)) is compile-complete (SendInput plan documented) — isolated behind the
  same trait, verification pending a Windows machine.
- **Clipboard** (`clipboard` event) uses `arboard`, real cross-platform.
- Runs on a **dedicated OS thread** ([worker.rs](../apps/desktop/src-tauri/src/input/worker.rs)) — CGEvent/SendInput are blocking
  calls, kept off the async runtime — with a bounded queue exposing
  `queue_depth`, drop counters, and average per-event latency as metrics.

Measured (release build, this machine): **~15.8 µs/event** synchronous
dispatch latency (decode+gate+dedup+cached-permission-check), ~63k events/sec
single-threaded — see `cargo run --release --example bench_input`.

## Example

```json
{
  "kind": "input_batch",
  "events": [
    { "kind": "pointer_move", "x": 0.51, "y": 0.42, "ts": 1730000000000 },
    { "kind": "click", "x": 0.51, "y": 0.42, "button": "left", "count": 1, "ts": 1730000000004 },
    { "kind": "shortcut", "action": "save", "ts": 1730000000100 }
  ]
}
```
