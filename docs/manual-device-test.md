---
status: Implemented
owner: @kushsharma024
last-verified: 2026-09-04
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

### v0.1.29 candidate: signed-device gate (NOT RUN)

Do not run against an unsigned development build and mark the release tested.
After publication, quit/remove the installed Mac app, download the v0.1.29
DMG from the public website, install it in Applications, and update the phone
to v0.1.29 in TestFlight. Confirm both displayed versions and sign in to the
same account. Removing the app bundle does not erase saved account or pairing
state; use the existing in-app unpair/sign-out flows for a fresh-pair test.

1. Pair from scratch with explicit Mac approval. Test view-only first: screen
   works, but gestures, typing, paste and Ask cannot control the Mac. End it,
   then approve a control session and test those capabilities normally.
2. On Wi-Fi, force-close the phone during an active session. Once the control
   channel closes, the Mac must leave Active, stop screen capture, suspend
   clipboard polling, and cancel Ask. Reopen promptly: trusted reconnect may
   recover without a new trust grant. Old callbacks must not end the new session.
3. Repeat on cellular, including Wi-Fi → cellular → Wi-Fi transitions and two
   consecutive reconnects. A signaling-only interruption must not end a working
   video/control path. If the OS delays reporting loss, record the observed
   delay; do not assume swipe-kill is detected instantaneously.
4. Repeat phone-close while dragging/holding a modifier and while Ask is waiting
   for approval. No stuck keys/buttons or later unapproved Ask action should
   remain. An action already executed cannot be undone by disconnecting.
5. Briefly switch apps, return, then background longer and return. Check pause,
   reconnect, display switching, and normal End Session on both devices. After
   the Mac ends its 15-second no-peer-traffic grace, returning to the phone must
   show the session ended as soon as the room rejects re-registration. If the
   transport never replies, the foreground check ends within 10 seconds.
   Reconnect must obtain an authorized room using the existing pairing, without
   looping on the expired room or asking for a new QR scan. Repeat over LAN and
   cloud, including returning before grace expires and quickly switching apps
   again while recovery is pending. End
   Session must stop capture and leave no active session indicator.
6. Test trusted LAN access with the internet unavailable. Record that it uses
   the LAN path; repeat phone-close/rejoin. With both apps updated, copy new
   text on the Mac and verify phone clipboard sync. View-only and paused
   sessions must not receive it; text copied before connect/resume must not
   arrive afterward. Mixed old/new app versions do not support this direction
   of automatic sync; phone → Mac paste still works.
7. Test the built-in updater separately from an installed signed v0.1.28.

Send PASS/FAIL for each step, both versions, LAN/cellular path, observed delay
after phone-close, and timestamps/timezone for any failure. Never include copied
clipboard contents, account credentials, or private screen contents in reports.
These are instructions only; no v0.1.29 signed-device result is recorded yet.

| You need                      | Notes                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A Mac, macOS 12.3 or newer    | `minimumSystemVersion` in `tauri.conf.json`. Below this the app will not install.                                                   |
| An iPhone                     | Install from **TestFlight** — see [Installing on the iPhone](#installing-on-the-iphone). Need v0.1.19+ for LAN-direct connectivity. |
| Two networks                  | Home Wi-Fi and phone cellular, at minimum. A second Wi-Fi network is better still.                                                  |
| An email address you can read | Needed for the email sign-in and password-reset checks. Confirm production advertises email auth before relying on delivery.        |

Production is `https://api.takedia.com`. Confirm it is up before you start —
if this is not `ok`, stop, because every failure below will be this one:

```bash
curl -s https://api.takedia.com/health
# {"status":"ok","checks":{"postgres":"up","redis":"up","mail":…},"revision":"<sha>"}
```

## Installing on the iPhone

**TestFlight (recommended for new users).** Builds ship from CI on every
`mobile-v*` tag (e.g. `mobile-v0.1.19`). To install as a first-time tester:

1. Email **support@takedia.com** with subject **TestFlight invite** (or use the
   link on [lilypadhome.takedia.com](https://lilypadhome.takedia.com/#get)).
2. Accept the invite in Mail, install **TestFlight** from the App Store if needed,
   then install **Lilypad**.
3. Confirm **Settings → About** (or the device list footer) shows **v0.1.19** or
   newer — not v0.1.18, which predates LAN-direct connectivity.

Grant **Local Network** when prompted — required for mDNS discovery and LAN TLS
pinning on your home Wi‑Fi.

### USB build from source (developer fallback)

Use this only when TestFlight is unavailable. The steps below were written for
a personal-team USB install and remain valid for local development.

### The one thing that blocks a plain build

```
error: Cannot create a iOS App Development provisioning profile for
"com.takedia.lilypad". Personal development teams, including "Kush Sharma",
do not support the Sign In with Apple capability.
```

`LilypadMobile.entitlements` requests `com.apple.developer.applesignin`, and a
personal team may not provision it. Passing `CODE_SIGN_ENTITLEMENTS=` on the
command line does **not** help — Xcode reads the capability while gathering
provisioning inputs, before build settings apply. The entitlements file itself
has to be empty for the duration of the build.

Nothing else in the app needs an entitlement: the camera and local-network
prompts come from `Info.plist` usage descriptions, not from entitlements. The
only thing lost is Sign in with Apple, which no step of this test uses.

**The button for it is still there, and it will fail.** `SignInScreen` shows
"Continue with Apple" whenever `Platform.OS === 'ios'`, not when the entitlement
is present, so this build offers a method it cannot perform. Tapping it shows an
error rather than crashing. Use email + password, which is the method that needs
neither a provider nor a delivered email — and record the dead button as a
finding about **this build**, not about the product.

### Rebuilding it

> **Do not stage anything while this runs.** Step 1 empties a file that git
> tracks. A `git add -A` landing in that window commits the emptied version,
> which is exactly how the Sign in with Apple entitlement vanished from `main`
> for one commit on 2026-08-21.

> **DerivedData must not live under `~/Desktop`.** That folder is synced by an
> iCloud file provider, which stamps every file with an empty
> `com.apple.FinderInfo`. rsync carries it into the `.app` and codesign refuses
> the framework with _"resource fork, Finder information, or similar detritus
> not allowed"_. `xattr -cr` cannot clear it in place — the provider re-adds it
> within the second. Step 0 is what makes the build possible at all; the real
> fix is to move this repository somewhere that is not synced.

```bash
cd ~/Desktop/lilypad
git checkout main && git pull
git diff --cached --quiet || { echo "unstage first"; exit 1; }

# 0. CocoaPods signs the embedded WebRTC framework without stripping the
#    attribute the file provider put on it. Strip it at signing time, where
#    stripping sticks because DerivedData is outside the synced tree. Pods/ is
#    gitignored, so `pod install` will undo this and it has to be redone.
S="apps/mobile/ios/Pods/Target Support Files/Pods-LilypadMobile/Pods-LilypadMobile-frameworks.sh"
grep -q 'xattr -cr "$1"' "$S" || \
  sed -i '' 's|    local code_sign_cmd=|    xattr -cr "$1" 2>/dev/null \|\| true\n    local code_sign_cmd=|' "$S"

# 1. Empty the entitlements for the build, keeping the real one safe.
#    A personal Apple team cannot provision com.apple.developer.applesignin,
#    and Xcode reads capabilities before any CODE_SIGN_ENTITLEMENTS= override
#    on the command line applies — so the file itself has to be empty.
cp apps/mobile/ios/LilypadMobile/LilypadMobile.entitlements /tmp/ent.orig
printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
  '<plist version="1.0">' '<dict/>' '</plist>' \
  > apps/mobile/ios/LilypadMobile/LilypadMobile.entitlements

# 2. Build RELEASE, not Debug. A Debug build has no embedded JS bundle and
#    loads it from a Metro dev server, so it would die the moment the phone
#    moves to cellular — which is most of section 4.
cd apps/mobile/ios
xcodebuild -workspace LilypadMobile.xcworkspace -scheme LilypadMobile \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/ios-release \
  DEVELOPMENT_TEAM=AR2Q4Y465L CODE_SIGN_STYLE=Automatic build

# 3. Put the real entitlements back, immediately, and check it took.
cp /tmp/ent.orig LilypadMobile/LilypadMobile.entitlements
git -C ../../.. diff --quiet -- apps/mobile/ios/LilypadMobile/LilypadMobile.entitlements \
  && echo "entitlements restored" || echo "ENTITLEMENTS STILL MODIFIED — fix before committing"

# 4. Install over USB.
xcrun devicectl device install app --device <YOUR-DEVICE-ID> \
  /tmp/ios-release/Build/Products/Release-iphoneos/LilypadMobile.app
```

Confirm the build is standalone before installing it — a missing bundle is the
failure that only shows up once the phone is off Wi-Fi:

```bash
ls -l /tmp/ios-release/Build/Products/Release-iphoneos/LilypadMobile.app/main.jsbundle
# ~2.7 MB. If this file does not exist, you built Debug.
```

`xcrun devicectl list devices` prints the device id. Developer Mode must be on
(Settings → Privacy & Security → Developer Mode); it already is on this phone.

The build that is currently installed is also saved at
`~/Desktop/lilypad-test-build/LilypadMobile.app`.

### What the installed build talks to

Verified by reading the strings in the shipped `main.jsbundle`, not by reading
the source:

| Host                                              | Occurrences |
| ------------------------------------------------- | ----------- |
| `api.takedia.com`                                 | 1           |
| `lilypad.takedia.com` (the dev tunnel)            | 0           |
| `lilypadhome.takedia.com` (the website)           | 0           |
| `trycloudflare`, `ngrok`, `192.168.`, `127.0.0.1` | 0           |

---

## 1. Installation

> **Start at the website, not at a local build.** This run is a customer
> journey, so the app has to arrive the way a customer's would.
>
> For most of this document's life that was impossible, for two reasons.
> `releases/latest` was `v0.1.1`, published from commit `ea55653`, while `main`
> moved forty-two commits past it — no Delete account, no Diagnostics "Last
> connection" pane, none of the security pass. And the link went to GitHub, on a
> repository that is **private**, so it answered 404 to everyone who was not
> signed in with access. The download, the releases page, the source link and
> the updater manifest were all dead for every real visitor, and all four looked
> fine from inside because an authenticated browser resolves them.
>
> Downloads are now served from the site itself. `v0.1.3` is cut from `main`,
> and `docs/deployment.md` § Distribution records why GitHub is not the
> customer's path.
>
> Before starting, confirm the Mac has no Lilypad state left from a previous
> run — `/Applications/Lilypad.app`, `~/Library/Application Support/`,
> `~/Library/Caches/`, `~/Library/WebKit/` (all `com.takedia.lilypad.desktop`),
> the `com.takedia.lilypad.desktop.device-key` keychain item, the
> `~/Library/LaunchAgents/com.takedia.lilypad.desktop.plist` login item, and the
> permission grants (`tccutil reset All com.takedia.lilypad.desktop`). A leftover
> device key is the one that matters most: the Mac would rejoin its old identity
> and the pairing steps would not be testing what they claim to.

| #   | Do                                                                  | Expect                                                                                                                                           |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1 | Open <https://lilypadhome.takedia.com>, then **Download for macOS** | The site serves `Lilypad.dmg` from `/download/` — universal (`x86_64 arm64`), **v0.1.19** or newer. No GitHub account, no sign-in.               |
| 1.2 | Double-click the DMG                                                | It mounts and shows `Lilypad.app` next to an Applications alias.                                                                                 |
| 1.3 | Drag Lilypad to Applications                                        | Copies without error.                                                                                                                            |
| 1.4 | Double-click Lilypad in Applications                                | **v0.1.19+ is notarized** — it should open with no “unidentified developer” warning. If macOS still blocks, check the site version is current.   |
| 1.5 | (Only if blocked) Right-click → **Open** → **Open**                 | It launches.                                                                                                                                     |
| 1.6 | Look at the screen                                                  | A small green **bubble** floats near the top-left.                                                                                               |
| 1.7 | Look at the menu bar                                                | A Lilypad **menu bar icon**, with: Open Dashboard, Pair a phone…, Approve, Deny, Disconnect, Panic disconnect, Settings…, Diagnostics…           |
| 1.8 | Leave it running for 10 minutes while you use the Mac normally      | No crash, no beachball, no runaway CPU (check Activity Monitor: idle should be low single-digit %).                                              |
| 1.9 | Tray → **Diagnostics…**                                             | A window opens showing Health, Last connection, and `backend: https://api.takedia.com`. **If the backend is anything else, stop and report it.** |

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
asked for it. What follows from that, measured rather than assumed:

- **A bundle with no signature cannot hold a grant at all.** 0.1.3 shipped
  that way — no `_CodeSignature`, `Info.plist=not bound`, `Sealed
Resources=none`, and an entirely unsigned x86_64 slice. The customer granted
  both permissions, TCC recorded both as allowed, System Settings showed both
  switches on, and `CGPreflightScreenCaptureAccess()` / `AXIsProcessTrusted()`
  returned false through every restart. The requirement TCC had stored named
  two cdhashes; the installed binary's was neither. Restarting cannot fix this,
  because a restart is not what is broken.
- **Builds from 0.1.4 on are ad-hoc signed**, which seals the bundle and gives
  TCC something to bind to. The release workflow fails rather than publishing
  a build that is not.
- **An ad-hoc cdhash changes every build**, so replacing `Lilypad.app` with a
  new version invalidates both grants and they must be granted again. Expected
  until a Developer ID certificate exists.
- Moving to a Developer ID build invalidates them once more, for the same
  reason. After that, signed → signed **keeps** them as long as the identity
  does not change. Verifying that is §9, and it cannot be done until signed
  builds exist.

If a permission reads ungranted after a restart, check the app rather than the
toggle:

```sh
codesign --verify --deep --strict /Applications/Lilypad.app   # must print nothing
codesign -d -r- /Applications/Lilypad.app                     # the requirement TCC will store
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "select service,client,auth_value from access where client='com.takedia.lilypad.desktop';"
```

`auth_value=2` with the app still denied means the stored requirement does not
match the installed binary. The repair is `tccutil reset ScreenCapture
com.takedia.lilypad.desktop` (and `Accessibility`), then grant once more.

**Local Network is not asked for on macOS 14 or earlier** — Apple introduced
that prompt in macOS 15 (Apple TN3179). On macOS 14 the LAN path simply works,
and the absence of a prompt is not a failure.

## 3. Pairing

| #   | Do                                                         | Expect                                                                            |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 3.1 | On the Mac, click the bubble (or menu bar → Pair a phone…) | A QR code appears with a countdown. It expires in **60 seconds**.                 |
| 3.2 | On the iPhone, open Lilypad → **Scan**                     | The camera opens. Point it at the QR.                                             |
| 3.3 | Watch the Mac                                              | An **Approve / Deny** card appears naming the phone.                              |
| 3.4 | Click **Approve**                                          | The phone shows the Mac's screen within a couple of seconds.                      |
| 3.5 | Let a QR expire without scanning it                        | It shows **Expired** and scanning it afterwards does nothing. Generate a new one. |
| 3.6 | Scan the same QR twice                                     | The second attempt fails. Codes are single-use.                                   |

### Putting the Mac on an account

Ownership and pairing are different things and the test covers both. Signing in
is what puts a device on the account
([ADR-0015](adr/0015-ownership-follows-sign-in.md)); pairing is what lets one
device reach another.

| #    | Do                                                                                      | Expect                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.7  | On the Mac: **Your account** → create an account (or sign in)                           | Signed in, and the card below flips to **On your account** without anything else being done.                                                                 |
| 3.8  | On the iPhone: sign in with the same account                                            | Signed in. **Your devices** is reachable.                                                                                                                    |
| 3.9  | iPhone → **Your devices**, before pairing anything                                      | **Both the Mac and the iPhone are listed.** This is the 2026-08-25 regression: only the phone used to appear, because a Mac gained an owner only at pairing. |
| 3.10 | iPhone → **Your laptops**, still before pairing                                         | Empty, and it explains why: the computers are on the account, pairing is the separate step. The two screens must not contradict each other.                  |
| 3.11 | On the Mac: sign out, then sign in again                                                | Signed back in and still **On your account**. Signing out is local; it does not remove the device.                                                           |
| 3.12 | On a second Mac (or after clearing this one's keychain): sign in to a DIFFERENT account | Refused with a message naming the remedy — remove it from the first account's **Your devices**, then sign in again. One device has one owner.                |

### Account state

Sign-in now carries ownership, and pairing is still separate, so the account's
own behaviour gets its own rows. Nothing here needs a delivered email — that is the point of
password auth ([ADR-0012](adr/0012-password-authentication.md)), and it is why
the journey is testable at all while Resend is unconfigured.

| #    | Do                                                                        | Expect                                                                                    |
| ---- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 3.13 | Create the account with a password shorter than 12 characters             | Refused, and it says so before the request is sent.                                       |
| 3.14 | Try to create a second account on the same address                        | Refused: an account already exists for that address.                                      |
| 3.15 | Sign in with the right address and a wrong password                       | Refused. The message must not reveal whether the address has an account.                  |
| 3.16 | Sign in with an address that has no account                               | Refused with the **same** message and no noticeable difference in how long it takes.      |
| 3.17 | Quit the app entirely and reopen it                                       | Still signed in and still on the account. Neither should need doing twice.                |
| 3.18 | iPhone → Your devices → **Remove** the Mac, then sign in on the Mac again | It comes back. Removal is reversible by signing in, which is what the message on it says. |

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
| 7.8  | Mid-session, menu bar → **Panic disconnect**                                                             | The session dies instantly and capture stops.                                                                                       |
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

### Post-v0.1.30 network handoff checks

Pending signed-build validation:

- Start on LAN, turn Wi-Fi off while viewing, and keep the phone app active.
  After video stops, expect a cloud connection attempt without manually tapping
  Reconnect. Existing pairing and approval rules still apply; record recovery
  time and the resulting Direct/Relayed path.
- Switch Wi-Fi off and back on quickly. A working stream should remain intact,
  without repeated connection requests. Repeat with a VPN if available.
- Switch to cellular while backgrounded: no new session should start until
  returning to the app. Tap Disconnect during a handoff: a late response must
  not reopen the viewer.
- Leave the phone backgrounded until the LAN room expires, then reopen it.
  Expect an ended session with a usable Reconnect action, without repeated
  registration attempts against the expired room.
- On cellular, compare scrolling and static text in both Motion and Text mode.
  Record visible blockiness separately from the quality badge. Collect the
  Mac's receiver-loss/bandwidth-estimate bitrate messages around degradation.
  Mild blockiness reported on v0.1.30 has not yet been proved fixed.

### v0.1.30 keyboard and control regressions

On the signed website DMG and TestFlight build, use a disposable text document:

1. Type `hello`, hide/reopen the phone keyboard, then type `!`. The Mac must
   contain `hello!` exactly once. Repeat rapid hide/show and fast typing.
2. Delete within the phone buffer and keep deleting after it becomes empty.
   Each action deletes once, with no held Backspace. Return inserts one return
   and keeps the keyboard usable. Test dictation/IME replacement and accented
   text, emoji, pasted paragraphs and a long Unicode paste in an appropriate editor.
3. Use Tab, arrows and a click to choose another text field, then type. Old
   native text must not appear there. Repeat while a native edit is pending.
4. Drag to a new location and release, cancel, or add a second finger. Release
   must stay at the last drag position. Interrupt a tap with an OS gesture;
   no click should fire. Background while holding an arrow; repeat must stop.
5. Rejoin an existing room and type/click immediately. New-peer sequence
   numbers must work from their first event; old queued text must never replay.

These checks are pending until recorded against the signed v0.1.30 artifacts.

### Post-v0.1.31 keyboard and updater regressions

1. **The keyboard survives aiming (L-225).** Open ⌨, then tap into a text field
   on the Mac's screen, then type. The keyboard must still be up after the tap,
   and the typed text must land in the field you tapped. Repeat with several
   taps between sentences, with a toolbar key (Tab, an arrow, Enter) pressed
   mid-sentence, and with an arrow held long enough to auto-repeat. The keyboard
   must not blink, close, or need a second ⌨ tap at any point. Then check what
   item 3 above checks — no old native text in the new field.
2. **The Mac asks for updates on its own (L-226).** From a signed build one
   version behind, launch Lilypad and do NOT open the dashboard. Within a few
   seconds the bubble must show a second dot at its lower-left, and hovering it
   must name the available version. Clicking through to the dashboard must show
   the existing banner, and Download & install → Restart must land on the new
   version. Confirm `~/Library/Logs/Lilypad/lilypad.log` and the Diagnostics
   panel agree on the version afterwards.

These two are pending until recorded against signed artifacts that contain them.

### Post-v0.1.32 bitrate regression

3. **Quality does not collapse and stay collapsed (L-227).** Start a session on
   a link with real headroom (LAN is easiest) and put motion on the shared
   screen — scroll a long page, or play a video. Watch
   `~/Library/Logs/Lilypad/lilypad.log`: `bitrate retargeted` must climb and
   keep climbing while `receiver loss` reads 0.0%. Now switch displays or
   capture modes several times, which is what creates the gap in the video the
   phone's estimator used to read as a dead link. After each switch the rate
   must climb again. A run that drops to **1250 kbps and never moves after**,
   with no loss reported and no further log lines, is the defect returning.
   The one legitimate cap still applies: a genuinely narrow link should settle
   somewhere sensible under its capacity, not at the floor.

This one is pending until recorded against a signed artifact that contains it.

### v0.1.32 hardware result — 2026-09-08

Kush installed the signed 0.1.32 DMG by hand and took TestFlight build
0.1.32 (34). The session ran 20:10:36-20:14:01 UTC.

Working: pairing and trusted auto-approve, LAN and direct-internet paths,
capture on both displays, live display switching, control gating, the
suspend-on-DataChannel-close path, and the display-sleep assertion — all with
zero dropped frames across 11 pipeline starts and no error-level line.

Found: **L-227.** Every one of those 11 starts climbed cleanly and then
collapsed to the 1250 kbps floor within seconds, and eleven reconnects in three
and a half minutes is what that looks like from the user's side. Fixed after
this session; not yet released, so it has no hardware credit.

Still not run: L-225 and L-226 were not exercised — no typing reached the Mac
in this session (`events_received: 0`), and the updater cannot be checked from
the newest build. Both remain pending as written above.

## 8. Recovery

| #   | Do                                                              | Expect                                                                                                                                                       |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8.1 | Mid-session, turn the iPhone's Wi-Fi off and on                 | Reconnects on its own within ~30 seconds.                                                                                                                    |
| 8.2 | Mid-session, background the phone app for 10 seconds, come back | Reconnects. (iOS suspends backgrounded apps — the drop itself is the OS.)                                                                                    |
| 8.3 | Background it for 2 minutes, come back                          | Shows the session ended promptly if its room expired. Reconnect uses the saved pairing to authorize a new room; no new QR scan and no stale-room retry loop. |
| 8.4 | Mid-session, close the Mac's lid for 30 seconds, reopen         | Session resumes or ends cleanly. It must never be "connected" on the phone while the Mac is asleep.                                                          |
| 8.5 | Restart the Mac, reopen Lilypad                                 | Bubble and tray return. Permissions still granted. Still linked. Pairing works.                                                                              |
| 8.6 | Restart the iPhone, reopen Lilypad                              | Still signed in. Still enrolled. Connects without re-pairing.                                                                                                |
| 8.7 | Quit Lilypad mid-session from the tray                          | The phone is told the session ended — it does not sit on a frozen frame.                                                                                     |

## 9. After signing — re-run these

Run these against the signed, notarized website download after each release.
They must not be credited from a local or ad-hoc build: the published artifact
and its stable Developer ID signature are what these checks exercise.

| #   | Do                                                                                       | Expect                                                                                               |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 9.1 | Install the signed DMG on a Mac that has never seen Lilypad                              | Opens on the first double-click. **No** "unidentified developer" warning.                            |
| 9.2 | Grant Screen Recording and Accessibility, then install the **next** signed build over it | Both permissions **persist**. No re-granting. This is the whole reason signing matters for this app. |
| 9.3 | Same, for Local Network on macOS 15+                                                     | Persists.                                                                                            |
| 9.4 | Pair and connect after the update                                                        | Works, with no re-pairing.                                                                           |
| 9.5 | Check Your devices after the update                                                      | The same device row — the update must not create a second one.                                       |
| 9.6 | Let the built-in updater find and apply a release                                        | Downloads, verifies its signature, relaunches on the new version.                                    |

## Password reset

Password reset and magic-link sign-in need the production mail provider.
`GET /health` reports `checks.mail`, and `GET /auth/methods` reports whether
`email` is available. If either says it is unavailable, skip these and record
them as blocked rather than failed:

- Mac → Sign in → _Forgot password_ → expect a code by email.
- Enter the code plus a new password → expect to be signed in.

## v0.1.33 gate-4 sheet — what to check on the signed build

The general procedure above still applies. This section is the _short_ list for
this release: the things that changed, and the failures a real user actually
reported. Record pass/fail per row in [Results](#results).

Two facts that shape the test before you start:

- **Ask needs both halves.** Ask is protocol version 2 and both peers must
  agree. A phone on 0.1.32 will refuse to start an Ask task against a
  0.1.33 Mac, and say so. That is correct behaviour, not a bug to report.
  Manual control works across the mismatch.
- **Ask is smaller.** "Open this file" and "reveal in Finder" are gone. Asking
  for them should produce a clear refusal, not a hang or a crash.

### Install the build this sheet is about

v0.1.33 is published on both halves (2026-09-09, release commit `507804f5`).
Unlike the earlier untagged dispatch build, the version now actually
distinguishes it:

- **Mac** — <https://lilypadhome.takedia.com/download/Lilypad.dmg>. The site
  page should read v0.1.33; if it reads 0.1.32 you have a cached page.
- **iPhone** — TestFlight, build **36** under version 0.1.33.

Ignore the `v0.0.0-dispatch.42` release and any DMG downloaded from it — that
was the pre-tag build and it reports itself as 0.1.32.

**Row 3 is now testable, and it is the one row with an order requirement.** The
updater can only be seen updating _from_ something older, so if you want to
check it: install **0.1.32 first**, run it, leave the bubble up, and let it find
0.1.33. Installing 0.1.33 directly makes row 3 untestable — mark it blocked
rather than passed in that case.

If you already ran Lilypad on this Mac, do the full clean-state wipe in
[§ 1. Installation](#1-installation) first — the device key especially. The
signature has not changed, so the privacy grants and the old identity both
carry straight over and you would not be testing as a new user. Do the wipe
_after_ the row-3 check, not before, since that check needs the old install.

### The user-reported failures this release claims to fix

| #   | Scenario                                                                                                           | Expected                                                                                                  | Why it is here                                              |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Type a long sentence, with Unicode/emoji, an IME if you use one, paste, backspace, and hold a key until it repeats | Every character arrives once, in order. No duplicated committed text, no stuck modifier, nothing replayed | L-225. The keyboard fix has never met a device              |
| 2   | Tap the Mac's screen mid-typing, then keep typing                                                                  | The software keyboard stays up and the buffer is intact                                                   | L-225                                                       |
| 3   | Leave the Mac running for a while with only the floating bubble open                                               | An available update appears on the bubble itself; installing it is still a deliberate click               | L-226. The updater fix has never met a device               |
| 4   | Watch a screen over cellular for a few minutes                                                                     | Picture stays readable. It must not collapse to a blur and stay there                                     | L-227. This is the failure that started this whole sequence |
| 5   | Wi-Fi → cellular → Wi-Fi, mid-session                                                                              | Video recovers each way; status text tells the truth throughout                                           | L-227 sibling                                               |
| 6   | Background the phone, wait, foreground it                                                                          | Session resumes or ends honestly. No "connected" over a dead stream                                       |                                                             |
| 7   | Sleep the Mac, wake it                                                                                             | Same                                                                                                      |                                                             |
| 8   | Switch the Mac between two displays mid-session                                                                    | The phone follows the shared display. Ask's screenshots must follow it too                                | L-230                                                       |
| 9   | A session that actually selects a TURN relay pair                                                                  | Relay is genuinely selected — check the selected candidate pair, not an advertised TURN URL               | Never once verified                                         |

### The Ask changes

| #   | Scenario                                                        | Expected                                                                                                                                                        |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | Ask the assistant to open a file                                | A clear refusal naming why, not a hang                                                                                                                          |
| 11  | Ask it to open a web page                                       | An approval card appears. It names the receiving site separately from the rest of the link, and says so when the link carries data. Nothing opens until you tap |
| 12  | Ask for something needing a script that reads one of your files | The card lists that exact file under "can read". Approving runs it; the script cannot read anything else of yours                                               |
| 13  | Approve a script, and tell it to make a folder                  | The folder is created where you asked                                                                                                                           |
| 14  | Start a task, then start a second one before the first finishes | The second waits for the first to stop, or says the previous task is still stopping. Never both acting at once                                                  |
| 15  | Withdraw AI-sharing consent mid-run                             | The run stops. Stop stays reachable while it is stopping                                                                                                        |

### What this build does _not_ claim

- The inter-process lookup channel a sandboxed script can reach has not been
  narrowed. Reads are bounded; this channel is not.
- Script startup on a Mac with **no Xcode installed** has not been exercised.
  If you have such a Mac, item 12 there is worth more than anywhere else.
- Redis recovery is covered by fake-store tests, not a real Redis.

## v0.1.34 gate sheet — what to check on the signed candidate

The general procedure above still applies. This is the short list for the
v0.1.34 candidate, and it is the gate the independent reviews have repeatedly
called unperformed. Nothing in this release is verified by source tests alone.

Two facts that shape the test before you start:

- **Ask is protocol version 3 now.** Both halves must agree. A phone on 0.1.33
  against a 0.1.34 Mac must say it needs updating and offer a way forward — not
  sit on a screen you cannot complete. Test the mismatch in both directions.
- **Ask still cannot run scripts.** They were withdrawn in this cycle and stay
  withdrawn. Asking for one should produce a clear refusal, not a hang.

### The first-use journey, start to finish

| #   | Scenario                                                                           | Expected                                                                                                                 |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Clean Mac, no provider configured. Open Ask on the phone                           | The phone says which state the Mac is in — checking, not configured, unavailable or too old — and offers Check again     |
| 2   | Set up the default provider from nothing, following only what the screen tells you | You reach a saved, tested configuration without leaving the app for instructions                                         |
| 3   | Make the first configuration read fail, then retry                                 | Try again clears the error and shows the real state. The error screen must not survive a successful retry                |
| 4   | Complete one genuinely useful Ask task end to end                                  | The task finishes and the result is visible on the phone                                                                 |
| 5   | Turn on Let Ask take screenshots, then change the provider                         | Your screenshot choice stays yours. Changing the provider clears only the tested-capability result, never the permission |

### Approval context after L-272

| #   | Scenario                                                                                 | Expected                                                                                                          |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 6   | Approve a press, then change a value in the same window before it happens                | You are asked again. This is the release blocker that was reopened at P1, so try an amount, a time and a quantity |
| 7   | Approve a press with an unrelated window visible whose clock or unread count is changing | You are not asked again for that                                                                                  |
| 8   | Approve a press in a window that has its own clock in it                                 | You are asked again. Documented cost of exactness, not a bug — record it if it is annoying in practice            |

### Connection, input and recovery

| #   | Scenario                                                                  | Expected                                                                                                             |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 9   | LAN to cellular and back, mid-session                                     | Video recovers each way and the status text tells the truth throughout                                               |
| 10  | Background the phone, wait, foreground it                                 | The session resumes or ends honestly. Never connected over a dead stream                                             |
| 11  | Type a long sentence with Unicode, emoji, paste, backspace and a held key | Every character arrives once, in order                                                                               |
| 12  | Provoke a frozen picture while bytes still arrive                         | The phone says picture frozen, retrying, retries a bounded number of times, and does not report a healthy connection |
| 13  | Pull the control channel down mid-session                                 | The phone says controls not connected rather than showing a good connection                                          |
| 14  | Press Stop during an Ask task                                             | The run stops and Stop stays reachable while it is stopping                                                          |

### Provider validation

| #   | Scenario                                                                        | Expected                                                                                       |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 15  | A real provider account, with credentials you supply deliberately for this test | Setup, connection test and one real task all succeed. Record which provider and which model    |
| 16  | A local or compatible endpoint                                                  | Same, without a hosted account. Do not claim compatible-endpoint support until this row passes |
| 17  | An endpoint that answers with a redirect to another origin                      | Refused, naming where it was being sent. Nothing reaches the second origin                     |

### Distribution

| #   | Scenario                                                                 | Expected                                                                                                                           |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 18  | Download the Mac build from the site, signed out and in a private window | The download works anonymously and the page states this version. See the note above about cached pages                             |
| 19  | Install over an older version and let the updater find this one          | The update appears on the bubble and installing it is still a deliberate click. Install the older build first or mark this blocked |
| 20  | Install the phone build from TestFlight                                  | Record the build number against the version                                                                                        |

### Recording the result

Use the Results block below, and add the two identifiers this gate turns on:
the candidate commit the builds were made from, and the desktop and mobile
version and build numbers as the installed apps report them. A row without
those is not evidence about this candidate.

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
§9 After signing         pass / fail / not run    notes:
Password reset           pass / fail / blocked / not run    notes:
Sign in with Apple       pass / fail / not run    notes:
```

### v0.1.28 published-artifact result — 2026-09-04

Kush tested the website DMG and the TestFlight build using the same account on
both devices. Installation, pairing, LAN streaming, direct internet streaming,
trusted reconnect, viewing, and control were smooth in the observed sessions.
Desktop and backend logs corroborated three balanced session starts/ends, one
LAN path, two direct internet paths, and no session left live in production.

Force-closing the phone exposed L-204: the Mac kept showing Active and captured
briefly after the control DataChannel closed. Input was already blocked and the
same trusted phone successfully reclaimed the room, but the remaining local
capabilities should have suspended immediately. That fix is after v0.1.28 and
needs a new published desktop build before it can receive hardware credit.

This was not an exhaustive execution of every row above. Relay-selected
transport, Sign in with Apple, password reset, destructive revoke/account
flows, the built-in updater, and the post-L-204 desktop fix remain **not run**
unless a later dated result says otherwise.
