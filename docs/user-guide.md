# Lilypad User Guide

Control your Mac from your iPhone — see the screen live, tap to click, type
with your phone keyboard. Nothing connects without your explicit approval on
the Mac.

## First run (Mac)

1. Launch Lilypad. A small green bubble appears floating on your screen.
2. The **Setup** window asks for two macOS permissions:
   - **Screen Recording** — so the phone can see the screen.
   - **Accessibility** — so the phone can move the mouse and type.

   Click **Grant** for each and confirm the system prompt. If a permission
   doesn't register, use **Open Settings**, flip the toggle, and click
   **Restart Lilypad** when offered.

3. When both show **Granted**, you're ready to pair.

## Pairing your phone

1. Click the bubble on the Mac → a QR code appears (it refreshes every 60
   seconds; each code works exactly once).
2. Open Lilypad on the iPhone → **Scan** → point at the QR.
3. Your Mac shows **Approve / Deny** with the phone's name. Click
   **Approve**.
4. The live screen appears on the phone within a couple of seconds.

## Controlling the Mac

| Gesture               | Action                                 |
| --------------------- | -------------------------------------- |
| Tap                   | Click (where you tap)                  |
| Double-tap            | Double-click (opens files/folders)     |
| Long-press            | Right-click                            |
| Drag                  | Move / drag with the mouse button held |
| Two-finger drag       | Scroll                                 |
| Pinch                 | Zoom your view in/out (up to 6×)       |
| Two-finger double-tap | Reset zoom                             |

- **Zoom lock** (toggle in the toolbar): while on, one-finger drag pans your
  zoomed view instead of dragging on the Mac — nothing is sent to the Mac.
- **Motion / Text**: Motion favors smooth 30 fps; Text captures at higher
  resolution for reading dense content (great while zoomed).
- **⌘ ⇧ ⌥ ⌃ chips**: tap to arm a modifier for your next tap (Cmd-click,
  Shift-click…). It clears itself after use.
- **⌨ button**: opens your phone keyboard; everything you type goes to the
  Mac (autocorrect works). Exit with the green **Done** above the keyboard.
- **Landscape**: rotate the phone for a full-screen view; the **⌃** handle
  opens the control tray.
- **Copy on the Mac** and it lands on your phone clipboard automatically
  ("Copied from Mac" toast). Paste sends your phone clipboard to the Mac.

## Disconnecting

- Phone: tap **Disconnect** (twice — the first tap arms it, so a stray touch
  can't kill your session).
- Mac: tray menu → **Disconnect**, or **Panic disconnect** to instantly kill
  the session and capture.

## FAQ

**Does someone need to be at the Mac to start a session?**
Yes — every session requires clicking Approve on the Mac. That's by design
and cannot be disabled.

**Does it work away from home?**
The architecture is internet-first (WebRTC + TURN relay), and the same app
works unchanged; a reachable backend + TURN deployment is what enables it
(see docs/operations.md).

**Why does the image soften when I zoom far in?**
You're magnifying a compressed video stream. Switch to **Text** mode for a
sharper source when reading.

**The session drops when I leave the app.**
iOS suspends backgrounded apps — that's the OS, not a bug. Lilypad
reconnects automatically when you come back (within ~30 seconds; after
that, re-pair). The screen stays awake during an active session, so it
won't drop from auto-lock.

**My Mac's screen turns off and the stream dies.**
It shouldn't: Lilypad holds a display-wake assertion during sessions. If you
see it anyway, report a bug with desktop logs.

## Troubleshooting

| Problem                      | Fix                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| QR scan does nothing         | Phone and Mac must reach the same backend — on LAN dev, same Wi-Fi. Regenerate the code (they expire in 60s). |
| "Pairing declined"           | Someone clicked Deny on the Mac. Re-scan and approve.                                                         |
| Black screen after approve   | Screen Recording permission missing/stale — rerun Setup on the Mac.                                           |
| Taps land in the wrong place | Toggle zoom fully out (two-finger double-tap) and re-try; if it persists, reconnect.                          |
| Typing does nothing          | Accessibility permission missing/stale — rerun Setup on the Mac.                                              |
