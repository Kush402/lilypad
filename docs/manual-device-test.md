---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-20
summary: The step-by-step Mac + iPhone test a human runs before launch, with the expected result for every step.
---

# Manual device test — Mac + iPhone

Everything below has to be done by a person with two real machines. Nothing
here can be automated, and nothing here has been run by a machine: this
document is the procedure, not a record of results. Record the results in
[Results](#results) at the bottom.

Run it end to end in one sitting. Steps depend on earlier steps, and a
half-finished run tells you less than none.

## Before you start

| You need                      | Notes                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A Mac, macOS 12.3 or newer    | `minimumSystemVersion` in `tauri.conf.json`. Below this the app will not install.                                     |
| An iPhone                     | See [Installing on the iPhone](#installing-on-the-iphone) — there is no App Store or TestFlight build.                |
| Two networks                  | Home Wi-Fi and phone cellular, at minimum. A second Wi-Fi network is better still.                                    |
| An email address you can read | Only for the Resend-dependent steps, which are currently **blocked** — see [Password reset](#password-reset-blocked). |

Production is `https://api.takedia.com`. Confirm it is up before you start —
if this is not `ok`, stop, because every failure below will be this one:

```bash
curl -s https://api.takedia.com/health
# {"status":"ok","checks":{"postgres":"up","redis":"up","mail":…},"revision":"<sha>"}
```

## Installing on the iPhone

**There is no TestFlight build and no App Store listing.** Both need Apple
Developer credentials the project does not have yet, so the phone app has to be
built from source and run on a device you own:

```bash
pnpm install
cd apps/mobile/ios && pod install && cd ..
open ios/LilypadMobile.xcworkspace
```

In Xcode: select your iPhone as the destination, set a Signing Team on the
`LilypadMobile` target (a free personal Apple ID works), then Run. A free
personal team's provisioning expires after **7 days**, after which the app will
refuse to launch until you rebuild — that is Apple's limit, not a Lilypad bug.

The app talks to `https://api.takedia.com` by default
(`apps/mobile/src/config/backend.ts`). If sign-in reaches a different backend,
that constant is the first thing to check.

---

## 1. Installation

| #   | Do                                                                         | Expect                                                                                                                                                 |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1 | Download the DMG from <https://github.com/Kush402/lilypad/releases/latest> | `Lilypad_<version>_universal.dmg`, roughly 20 MB.                                                                                                      |
| 1.2 | Double-click the DMG                                                       | It mounts and shows Lilypad next to an Applications alias.                                                                                             |
| 1.3 | Drag Lilypad to Applications                                               | Copies without error.                                                                                                                                  |
| 1.4 | Double-click Lilypad in Applications                                       | **The build is unsigned, so macOS refuses it**: _"Lilypad" cannot be opened because the developer cannot be verified._ This is correct for this build. |
| 1.5 | Right-click Lilypad → **Open** → **Open**                                  | It launches. (Or System Settings → Privacy & Security → **Open Anyway**.)                                                                              |
| 1.6 | Look at the screen                                                         | A small green **bubble** floats near the top-left.                                                                                                     |
| 1.7 | Look at the menu bar                                                       | A Lilypad **tray icon**, with: Open Dashboard, Show QR / Pair, Approve, Deny, Disconnect, ⛔ Panic disconnect, Diagnostics…                            |
| 1.8 | Leave it running for 10 minutes while you use the Mac normally             | No crash, no beachball, no runaway CPU (check Activity Monitor: idle should be low single-digit %).                                                    |
| 1.9 | Tray → **Diagnostics…**                                                    | A window opens showing Health, Last connection, and `backend: https://api.takedia.com`. **If the backend is anything else, stop and report it.**       |

> **Signed builds behave differently at 1.4/1.5.** A Developer-ID-signed,
> notarized build opens on the first double-click with no warning at all. Until
> that build exists, steps 1.4 and 1.5 are the expected behaviour, not a defect.

## 2. Permissions

| #   | Do                                                                  | Expect                                                                                                                                          |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | The Setup window asks for **Screen Recording** → Grant              | The macOS prompt appears. Approve it.                                                                                                           |
| 2.2 | The Setup window asks for **Accessibility** → Grant                 | The macOS prompt appears. Approve it, then Restart Lilypad if offered.                                                                          |
| 2.3 | Re-open Setup                                                       | Both read **Granted**.                                                                                                                          |
| 2.4 | Start a session later (§4) and watch for a **Local Network** prompt | On macOS 15 and later, the first LAN connection triggers _"Lilypad" would like to find and connect to devices on your local network._ Allow it. |
| 2.5 | System Settings → Privacy & Security → Local Network                | Lilypad is listed and enabled.                                                                                                                  |

macOS binds a permission grant to the exact code signature of the app that
asked for it. Three consequences, all expected:

- This unsigned build's grants are tied to **this exact copy**. Replacing
  `Lilypad.app` with a new unsigned build invalidates them, and every
  permission has to be granted again.
- Moving to a signed build invalidates them once more, for the same reason.
- After that, signed build → signed build **keeps** them, as long as the
  signing identity does not change. Verifying this is step §9, and it cannot be
  done until signed builds exist.

**Local Network is not asked for on macOS 14 or earlier** — Apple introduced
that prompt in macOS 15 (Apple TN3179). On macOS 14 the LAN path simply works,
and the absence of a prompt is not a failure.

## 3. Pairing

| #   | Do                                                      | Expect                                                                            |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 3.1 | On the Mac, click the bubble (or tray → Show QR / Pair) | A QR code appears with a countdown. It expires in **60 seconds**.                 |
| 3.2 | On the iPhone, open Lilypad → **Scan**                  | The camera opens. Point it at the QR.                                             |
| 3.3 | Watch the Mac                                           | An **Approve / Deny** card appears naming the phone.                              |
| 3.4 | Click **Approve**                                       | The phone shows the Mac's screen within a couple of seconds.                      |
| 3.5 | Let a QR expire without scanning it                     | It shows **Expired** and scanning it afterwards does nothing. Generate a new one. |
| 3.6 | Scan the same QR twice                                  | The second attempt fails. Codes are single-use.                                   |

### Linking the Mac to an account

Pairing and linking are different things and the test covers both.

| #    | Do                                                                 | Expect                                                                                                                               |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 3.7  | On the iPhone: sign in (or create an account)                      | Signed in. The **Your devices** list is reachable.                                                                                   |
| 3.8  | On the Mac: dashboard → **This computer** → **Link this computer** | A second QR appears — this one is an enrollment code, not a pairing code.                                                            |
| 3.9  | Scan it with the signed-in iPhone and approve                      | The Mac's panel flips to **Linked**.                                                                                                 |
| 3.10 | iPhone → Your devices                                              | Both the Mac and the iPhone are listed.                                                                                              |
| 3.11 | On the Mac: sign in with the same account under **Your account**   | It says signed in — and says explicitly that signing in does **not** link the computer. Both statements should be on screen at once. |

## 4. Connectivity

Run the same test three times on three different network arrangements. After
each one, read the transport off the Mac: **tray → Diagnostics… → Last
connection**.

| #   | Network arrangement                                                                                                                   | Expect                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Mac and iPhone on the **same Wi-Fi**                                                                                                  | Connects. Diagnostics: **Direct, over your local network**.                                                                                 |
| 4.2 | iPhone on **cellular**, Wi-Fi off. Mac on Wi-Fi.                                                                                      | Connects. Diagnostics: **Direct, over the internet** — or **Relayed** if either side is behind a strict NAT. Both are passes; record which. |
| 4.3 | iPhone on cellular **and** Mac on a network that blocks direct paths (a corporate/guest Wi-Fi, or a hotspot with client isolation on) | Connects. Diagnostics: **Relayed through Lilypad's TURN server**.                                                                           |

If 4.3 will not produce a relay on any network you have, say so in the results
rather than recording a pass — it means the relay path is untested, not that it
works. The TURN server itself is separately verified (`pnpm watchdog`), but that
proves the server answers, not that a session used it.

## 5. Remote viewing

| #   | Do                                                 | Expect                                                                                                                           |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | Look at the phone during a session                 | Live video of the Mac's screen.                                                                                                  |
| 5.2 | Watch for 5 minutes without touching anything      | No freeze, no drift to black, no growing lag.                                                                                    |
| 5.3 | Move a window on the Mac                           | The phone reflects it in well under a second on LAN. Note the feel on the relayed path — it will be slower and that is expected. |
| 5.4 | Pinch to zoom, then two-finger double-tap          | Zooms up to 6×, then resets.                                                                                                     |
| 5.5 | Switch **Motion** ↔ **Text**                       | Motion is smoother; Text is sharper when zoomed in.                                                                              |
| 5.6 | Copy text on the Mac                               | "Copied from Mac" appears on the phone and the text is on the phone clipboard.                                                   |
| 5.7 | Leave the Mac untouched for 15 minutes mid-session | The screen does **not** sleep — Lilypad holds a display-wake assertion — and the session stays live.                             |

## 6. Remote input

| #   | Do                                              | Expect                                                                               |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| 6.1 | Tap                                             | Clicks where you tapped.                                                             |
| 6.2 | Double-tap a folder                             | Opens it.                                                                            |
| 6.3 | Long-press                                      | Right-click menu.                                                                    |
| 6.4 | Drag                                            | Drags with the button held.                                                          |
| 6.5 | Two-finger drag                                 | Scrolls.                                                                             |
| 6.6 | ⌨ → type a sentence                             | It appears on the Mac, autocorrect included. Green **Done** dismisses the keyboard.  |
| 6.7 | Tap ⌘, then tap a file                          | Cmd-click. The modifier clears itself afterwards.                                    |
| 6.8 | Turn **Zoom lock** on, zoom in, one-finger drag | Pans your view. **Nothing reaches the Mac** — verify the Mac's cursor does not move. |

## 7. Security

The point of this section is that every failure below should be a _refusal_.
An operation that half-works is worse than one that fails.

| #    | Do                                                                                                       | Expect                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 7.1  | With a session live, iPhone → Your devices → revoke **the Mac**                                          | The session ends immediately on both ends. Not after a delay — immediately.                                                         |
| 7.2  | Try to reconnect from the phone                                                                          | Refused.                                                                                                                            |
| 7.3  | Re-link the Mac (§3.8) and start a session again                                                         | Works. Revocation is recoverable by the owner.                                                                                      |
| 7.4  | On the Mac dashboard, revoke **the iPhone**                                                              | The phone loses access at once and says its access was revoked.                                                                     |
| 7.5  | On the revoked iPhone, try to sign in / re-enroll **without signing in again**                           | Refused. A revoked device cannot restore itself with the credential it already had.                                                 |
| 7.6  | Sign in again on the iPhone, then re-enroll                                                              | Works — a credential minted _after_ the revocation is accepted.                                                                     |
| 7.7  | Start a pairing QR on the Mac and let a **second** phone scan it after the first has already redeemed it | Refused.                                                                                                                            |
| 7.8  | Mid-session, tray → **⛔ Panic disconnect**                                                              | The session dies instantly and capture stops.                                                                                       |
| 7.9  | Phone → **Disconnect**                                                                                   | The first tap arms it, the second ends it. One stray touch must not kill a session.                                                 |
| 7.10 | Mac → **Your account** → **Delete account**                                                              | It asks for the account's email **typed out** and for the password. Neither is pre-filled.                                          |
| 7.11 | Type a different email and confirm                                                                       | Refused: _type the email address on this account to confirm_.                                                                       |
| 7.12 | Type the correct email and a wrong password                                                              | Refused: _that password does not match this account_. You are still signed in.                                                      |
| 7.13 | Type both correctly                                                                                      | The account is deleted. Any live session ends. The Mac returns to the signed-out screen.                                            |
| 7.14 | On the iPhone, open Your devices                                                                         | Refused / signed out. A deleted account must not still list devices.                                                                |
| 7.15 | Try to sign in on either device with the deleted account                                                 | Refused.                                                                                                                            |
| 7.16 | With a **fresh** account: iPhone → Your devices → **Delete account**                                     | It asks for the account email. Nothing is pre-filled, and the confirm button does nothing until something is typed.                 |
| 7.17 | Type a different address                                                                                 | Refused, and the form stays open so the typo can be fixed.                                                                          |
| 7.18 | Type the correct address                                                                                 | The account is deleted and the phone returns to sign-in. This is the path that matters when the **Mac** is the thing that was lost. |

> After 7.13 the account is gone and cannot be recovered. Do §7.10–7.18 last,
> or use a throwaway account for them and re-create the real one afterwards.

## 8. Recovery

| #   | Do                                                              | Expect                                                                                              |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 8.1 | Mid-session, turn the iPhone's Wi-Fi off and on                 | Reconnects on its own within ~30 seconds.                                                           |
| 8.2 | Mid-session, background the phone app for 10 seconds, come back | Reconnects. (iOS suspends backgrounded apps — the drop itself is the OS.)                           |
| 8.3 | Background it for 2 minutes, come back                          | It may need re-pairing. That is the documented boundary, not a bug.                                 |
| 8.4 | Mid-session, close the Mac's lid for 30 seconds, reopen         | Session resumes or ends cleanly. It must never be "connected" on the phone while the Mac is asleep. |
| 8.5 | Restart the Mac, reopen Lilypad                                 | Bubble and tray return. Permissions still granted. Still linked. Pairing works.                     |
| 8.6 | Restart the iPhone, reopen Lilypad                              | Still signed in. Still enrolled. Connects without re-pairing.                                       |
| 8.7 | Quit Lilypad mid-session from the tray                          | The phone is told the session ended — it does not sit on a frozen frame.                            |

## 9. After signing — re-run these

**Cannot be run yet.** Everything here needs a Developer-ID-signed, notarized
build, which needs Apple credentials the project does not have.

| #   | Do                                                                                       | Expect                                                                                               |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 9.1 | Install the signed DMG on a Mac that has never seen Lilypad                              | Opens on the first double-click. **No** "unidentified developer" warning.                            |
| 9.2 | Grant Screen Recording and Accessibility, then install the **next** signed build over it | Both permissions **persist**. No re-granting. This is the whole reason signing matters for this app. |
| 9.3 | Same, for Local Network on macOS 15+                                                     | Persists.                                                                                            |
| 9.4 | Pair and connect after the update                                                        | Works, with no re-pairing.                                                                           |
| 9.5 | Check Your devices after the update                                                      | The same device row — the update must not create a second one.                                       |
| 9.6 | Let the built-in updater find and apply a release                                        | Downloads, verifies its signature, relaunches on the new version.                                    |

## Password reset (blocked)

Password reset and magic-link sign-in return **503** until Resend is configured
in production. `GET /health` reports `checks.mail`; while it says
`unconfigured`, skip these and record them as blocked rather than failed:

- Mac → Sign in → _Forgot password_ → expect a code by email.
- Enter the code plus a new password → expect to be signed in.

## Results

Copy this in and fill it out. "Not run" is a legitimate answer; a guess is not.

```
Date:                    Tester:
macOS version:           Mac model:
iOS version:             iPhone model:
Lilypad version:         Signed: no / yes (identity: …)

§1 Installation          pass / fail / not run    notes:
§2 Permissions           pass / fail / not run    notes:
§3 Pairing + linking     pass / fail / not run    notes:
§4.1 LAN                 pass / fail / not run    transport reported:
§4.2 Internet            pass / fail / not run    transport reported:
§4.3 Relay               pass / fail / not run    transport reported:
§5 Remote viewing        pass / fail / not run    notes:
§6 Remote input          pass / fail / not run    notes:
§7 Security              pass / fail / not run    notes:
§8 Recovery              pass / fail / not run    notes:
§9 After signing         blocked — no Apple credentials
Password reset           blocked — Resend not configured
```
