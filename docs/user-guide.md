---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-29
summary: End-user guide for the Mac + iPhone apps.
---

# Lilypad User Guide

Control your Mac from your iPhone — see the screen live, tap to click, type
with your phone keyboard. Nothing connects without your explicit approval on
the Mac.

## First run (Mac)

Three steps, and only the last one needs your phone in your hand.

1. **Launch Lilypad.** A small green bubble appears floating on your screen,
   and the **Setup** window opens. (The bubble can be turned off later —
   dashboard → **This Mac** → _Show the floating bubble_. The menu bar icon
   opens everything either way.)

2. **Make an account** (step 1 in the window). Signing in here is what puts
   this computer on your account — that is how you can see it, rename it, and
   remove it from your phone later. Nothing else is needed to claim the
   machine.

3. **Allow two macOS permissions** (step 2):
   - **Screen Recording** — so the phone can see the screen.
   - **Accessibility** — so the phone can move the mouse and type.

   Click **Grant** for each and confirm the system prompt. If a permission
   doesn't register, use **Open Settings**, flip the toggle, and click
   **Restart Lilypad** when offered.

4. **Pair your phone** (step 3) — below.

Once all of that is done, the same window reopens as **Lilypad Settings**: no
steps, no numbers, and everything still editable — your account, the two
permissions, your paired phones, and the **Ask AI** provider. Reach it from the
menu bar icon → **Settings…**, or from **Settings** in the dashboard.

## Pairing your phone

Being signed in on both devices is deliberately _not_ enough to connect. A
phone reaches a Mac only through a pairing you made by standing in front of
that Mac, which is why a stolen password is not a stolen laptop.

1. On the iPhone, open Lilypad and **sign in with the same account**.
2. On the Mac: Setup step 3 → **Show pairing code**, or click the bubble. The
   code refreshes every 60 seconds and each one works exactly once.
3. On the iPhone: **Scan a laptop's QR** → point at the code.
4. Your Mac shows **Approve / Deny** with the phone's name. Click **Approve**.
5. The live screen appears on the phone within a couple of seconds.

Once per phone. After that the Mac appears under **Your laptops** and
reconnects with a tap — no QR, even from cellular.

## Your account, your devices, your pairings

Three different things, and the app keeps them apart on purpose.

| Thing       | What it is                                | Where you see it                     |
| ----------- | ----------------------------------------- | ------------------------------------ |
| **Account** | You. An email and a password.             | "Your account", on both apps         |
| **Device**  | A computer or phone you signed in on      | **Your devices**, on the phone       |
| **Pairing** | Permission for one phone to reach one Mac | **Your laptops** / **Paired phones** |

- **Signing out on a phone** ends that phone's pairings — on the laptops too —
  but leaves the phone on your account.
- **Signing out on a Mac** takes that Mac _off_ your account. A session running
  at that moment ends, and your paired phones stop being able to reach it.
  Signing back in on that Mac restores everything, pairings included — you will
  not need to scan a code again. It is the right thing to do before handing a
  Mac to somebody else.
- **Removing a device** from _Your devices_ does the same thing from the other
  end: it loses access immediately, including a session running at that moment,
  and signing in on it again restores it.
- **Unpairing** — from _Your laptops_ on the phone, or _Paired phones_ on the Mac —
  ends just that one pairing, from either side.

A phone that rings a Mac which is not on the account any more is told exactly
that, and told the remedy: sign in to Lilypad on that Mac. It is not told the
Mac is offline (it may be sitting switched on in front of you) and not told to
pair again (pairing refuses a computer no account owns).

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

## Several screens

If your Mac has more than one display, a row of buttons — **Display 1**,
**Display 2**, and so on — appears above the controls, left to right in the
Mac's own arrangement. Tap one to switch mid-session; the video changes in
about a second and the Mac keeps running.

A Mac with a single screen shows no such row, because there is nothing to
choose. Unplug a display mid-session and Lilypad falls back to the main one
rather than ending the session.

## Disconnecting

- Phone: tap **Disconnect** (twice — the first tap arms it, so a stray touch
  can't kill your session).
- Mac: menu bar icon → **Disconnect**, or **Panic disconnect** to instantly
  kill the session and capture. The same two buttons are on the dashboard while
  a session is live, and opening another Lilypad window never hides it —
  Lilypad shows one window at a time, except when that window is the one
  holding your Approve/Deny or your Disconnect.

## FAQ

**Does someone need to be at the Mac to start a session?**
The FIRST time a phone connects, yes: pairing always ends with Approve on the
Mac. After that the pairing is what lets that phone reconnect on its own, which
is the point of pairing — and you can turn that off per phone, or unpair it,
under **Paired phones** on the Mac.

(This answer used to read "every session requires clicking Approve on the Mac …
and cannot be disabled". That was true before pairings existed and has been
wrong since; the setting it denied is a checkbox on the Mac's own dashboard.)

**Does it work away from home?**
The architecture is internet-first (WebRTC + TURN relay), and the same app
works unchanged; a reachable backend + TURN deployment is what enables it
(see docs/operations.md).

**Why does the image soften when I zoom far in?**
You're magnifying a compressed video stream. Switch to **Text** mode for a
sharper source when reading.

**The session drops when I leave the app.**
Switching away briefly does not end the session: the phone pauses the stream
and keeps the signaling socket. Coming back resumes control. iOS may freeze or
kill the process if you stay away long enough — that looks like the phone
disappearing, and the Mac goes Idle after the signaling timeout (about 25
seconds if the socket did not close, then 15 seconds of quiet media). Force-
closing Lilypad is the same: there is often no chance to say goodbye. Reopen
the app while the Mac is still Active and it reconnects to **that** session.
After the Mac is Idle, go to **Your laptops** and tap **Connect** — that starts
a new session. You never re-scan a QR for a Mac you have already paired with.
The screen stays awake during an active session, so it won't drop from
auto-lock.

**My Mac's screen turns off and the stream dies.**
It shouldn't: Lilypad holds a display-wake assertion during sessions. If you
see it anyway, report a bug with desktop logs.

## Troubleshooting

| Problem                                  | Fix                                                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QR scan does nothing                     | Phone and Mac must reach the same backend — on LAN dev, same Wi-Fi. Regenerate the code (they expire in 60s).                                                        |
| "Pairing declined"                       | Someone clicked Deny on the Mac. Re-scan and approve.                                                                                                                |
| Black screen after approve               | Screen Recording permission missing/stale — rerun Setup on the Mac.                                                                                                  |
| Taps land in the wrong place             | Toggle zoom fully out (two-finger double-tap) and re-try; if it persists, reconnect.                                                                                 |
| Typing does nothing                      | Accessibility permission missing/stale — rerun Setup on the Mac.                                                                                                     |
| "Your laptops" is empty after signing in | Expected. Signing in puts computers on your **account**; pairing is the separate step that lets this phone reach one. Your Macs are under **Your devices**.          |
| The Mac says it isn't on your account    | Sign in again on the Mac. If it says the computer belongs to a different account, remove it from that account's **Your devices** first — one computer has one owner. |
| The phone says the laptop is offline     | The Mac is asleep, quit, or off the network. Wake it and try again; a sleeping Mac reconnects on its own once awake.                                                 |
