# Changelog

All notable changes to Lilypad are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Work from the v0.1.33 product review and its 2026-09-10 follow-up. Not released,
not tagged, not on any device yet.

### Removed

- **Ask can no longer run scripts.** A script could start a background process
  that detached itself and kept running after you pressed Stop, and macOS gives
  Lilypad no way to guarantee it has ended: the two mechanisms that would have
  provided one were both tried and neither works on current macOS. Rather than
  leave a capability whose Stop cannot be trusted, this build does not offer it.
  Everything else Ask does is unchanged: opening apps, creating folders, reading
  the screen, pressing buttons and taking screenshots. Such a process was always
  confined to the same restricted sandbox, so what could not be guaranteed was
  when it stopped, not what it could reach.

### Changed

- **Ask needs the current version on both your Mac and your phone.** Your phone
  now tells your Mac which AI destination it agreed to, and your Mac refuses a
  task aimed at a different one. An older phone cannot do that, so it will say
  it needs updating rather than sending the task.
- **Ask tells you what it is waiting for.** Opening Ask used to show the same
  screen whether your Mac was still checking its settings, had no AI provider
  set up, could not open its keychain, or was simply too old to answer. All four
  looked like a permission request you could not complete, and closing and
  reopening Ask was the only way through. Each now says which one it is, offers
  Check again, and your Mac follows up on its own when it finishes checking. You
  are only asked about sending your screen once there is somewhere to send it.
- **"Let Ask take screenshots" is your setting again.** It used to share one
  field with the result of the connection test, so testing a model could tick a
  box you never ticked, and changing your provider could untick one you did.
  They are separate now: you decide whether screenshots are allowed, the test
  reports whether the model can actually read one, and Ask sends an image only
  when both are true.
- **Ask creates the folders it says it creates.** Asking for a folder several
  levels deep used to fail at the first level that did not exist yet, although
  the description promised otherwise. It now makes each missing level, still
  refusing to follow a link or replace a file on the way, and refuses a path
  more than 32 folders deep rather than making it.
- **Approving an action no longer expires because a clock ticked.** The check
  that runs before Ask presses a button compared the whole screen, so a clock,
  a progress bar or an unread count in another window could reject the same
  action over and over. It now compares the window the button is in and ignores
  only a short, named list of things that change by themselves. A changed
  amount, a changed recipient, a rearranged window or a different button still
  asks you again.

### Security

- **A frozen picture no longer looks like a working session.** Video that
  arrived but could not be decoded kept the connection reported as healthy,
  because "video is arriving" was measured by counting bytes rather than
  decoded frames. Your phone now watches the picture, the network and the
  controls separately: it retries a frozen picture a bounded number of times,
  and says "picture frozen, retrying" or "controls not connected" instead of
  showing a good connection.
- **Your saved AI settings can no longer be read half-written.** Saving them
  replaced the file in place, so anything reading at that moment could see a
  partly written file and fall back to defaults, and a provider change could be
  briefly attributed to the wrong version of the settings. Settings are now
  written whole and read one at a time.
- **A connection test can no longer overwrite a newer setting.** If you changed
  the address, replaced the key or disconnected while a test was running, the
  test's result used to be written back over what you had just done. A late
  result is now discarded rather than applied, and a result earned by a key you
  have since replaced is never recorded against the new one.
- **Reading the screen is now bounded in time, not only in size.** Ask limited
  how much of an app's structure it would read but not how long it would wait
  for it, so an application that had stopped responding could hold the step. It
  now gives up on a single unanswered request after half a second and on the
  whole read after three, using what it has.
- **A provider address could redirect your key and your screen to someone
  else.** If the endpoint you configured answered with a redirect, Lilypad
  followed it — and while the usual authorization header is dropped when the
  destination host changes, the header Anthropic uses is not, so the key went
  with it. A redirect that preserves the request body would have carried what
  Ask read from your screen too. Lilypad no longer follows redirects for
  anything to do with your AI provider; it tells you where the address wanted to
  send you, and you decide.
- **Your Mac could tell your phone one AI provider and use another.** A
  developer environment override took priority when the request was actually
  made, while the disclosure your phone saw came from the saved settings. They
  are now the same answer, resolved once. Your phone also confirms which
  destination it agreed to on every task, and your Mac refuses a task if that no
  longer matches — so changing the provider on the Mac asks you again rather
  than quietly redirecting what leaves it.
- **A script could redirect one of Lilypad's own writes onto a file it was
  never granted.** Every Ask run leaves its script, its sandbox profile and its
  captured output on disk so that what happened can be checked afterwards.
  Those files sat in the same folder the script itself could write to, and a
  script could replace the output file's name with a link pointing anywhere in
  your home folder. Lilypad then wrote its record through that link, with its
  own permissions rather than the script's. The audit files now live outside
  everything a script can touch, and Lilypad refuses to write through a link.
- **A script could rewrite files it was not even allowed to read.** Reading
  your keys, tokens and browser data was already blocked. Writing to them was
  not, so a script that was given permission to save a file somewhere could
  point that at your SSH configuration and put a command in it that would run
  the next time you used git. Credential files, anything your shell loads at
  login, startup items and Lilypad's own records are now protected against
  being changed, not only against being read.
- **A key you saved for one provider could be sent to a different one.** Keys
  were filed by the kind of API rather than by the service, so changing the
  address in the settings pointed Lilypad at a new server while still sending
  the old key to it. A key now belongs to the exact address it was saved for,
  and an address with no key of its own simply has none. If you had saved a key
  against a custom address you will be asked for it once more.
- **Ask could read windows on a screen you were not sharing.** Screenshots were
  already limited to the shared display; reading the screen's contents through
  accessibility was not, so on a Mac with two monitors Ask could read a
  document on the other one and send it to your model provider. It is now
  limited to windows on the screen you are sharing, and password fields are
  never read at all.
- **Your phone's agreement to share screens is now tied to what it agreed to.**
  It was one yes, forever, for any Mac and any provider, while the phone's own
  wording named two companies the Mac was not obliged to use. It now names the
  provider and address your Mac actually reports, and asks again if either
  changes or if you connect a different Mac.
- **Withdrawing that agreement now survives a restart.** If the phone could not
  delete the stored answer, the next launch read it back and carried on
  sharing. Withdrawal is now recorded separately, and if it cannot be saved at
  all the phone says so and offers to try again instead of reporting success.

### Added

- **Provider setup you can follow.** Named choices for Anthropic, OpenAI,
  Google Gemini, OpenRouter and a local model through Ollama, plus an entry for
  any other OpenAI-compatible address, each with its own address filled in and
  a plain sentence about which credential it takes. A subscription login is not
  an API key, and the setup screen now says so before you try one.
- **A Test connection button that actually tests something.** It asks the model
  to use a tool and, if you turned screenshots on, to read an image Lilypad
  generates in memory. Your screen is never captured to check a key. Saved,
  tested and ready are now three different words, and only the last one means
  Ask will work.
- **Disconnect.** You can remove a saved key and forget a provider. If the
  removal fails, it says so rather than claiming to have worked. Remote control
  keeps working either way, because it never used a provider.
- **List models.** Where the provider supports it, the model can be picked from
  a list instead of typed. A model appearing in that list is not a promise that
  it can use tools or read images; only the test answers that.

### Fixed

- Testing a provider now tests what a real task does: it asks the model to use
  a tool, sends the result back, and requires it to carry on. An endpoint that
  accepted the first step and rejected the second used to pass setup and fail on
  your first real task.
- A test result is now tied to the exact key it was run with, so testing a key
  you have not saved yet can no longer mark a different saved key as working,
  and replacing a key clears what was verified about the old one. If the result
  cannot be saved, it says so instead of appearing to have been.
- Setting up the default provider on a new Mac now has a Continue button. It was
  possible to reach a first screen with no way forward at all.
- Try again on a failed settings load now actually retries, and clears the error
  when it succeeds. It previously left the same error on screen.
- Listing models now gives up if the endpoint stops responding, instead of
  leaving Listing running indefinitely.
- A locked keychain no longer leaves a stuck helper process behind each time
  Lilypad asks it, and a keychain that will not answer is no longer reported as
  "no provider configured".
- Stopping a task now reports whether it was confirmed. A script could start a
  process that detached itself and outlived being stopped; macOS gives Lilypad
  no way to guarantee that cannot happen, so it now checks afterwards and never
  calls a task finished when the check does not come back clean.
- Setting up a provider can no longer freeze a session. Reading the key from
  the keychain happened on the same path as your keyboard, mouse and the Stop
  button, so a keychain waiting for a permission box took all of them with it.
- Saving a change to your provider settings no longer silently turns
  screenshots off.
- The setup card no longer says "Configured" before it has read anything.
- A failing provider now says what failed. An HTML error page from a gateway
  used to end the request at "response was not JSON", losing the rate limit or
  outage underneath it. Oversized replies are refused rather than loaded.
- A model asking for several actions at once is refused rather than having all
  but the first quietly dropped, which used to leave it convinced work had
  happened that never did.
- Ask no longer holds an unbounded amount of memory while reading a very large
  window.

### Changed

- The website now says plainly that Ask sends what it reads to the provider you
  chose, and that a local model keeps it on the Mac. "Runs on the Mac" was true
  of the actions and easy to read as a claim about the data.

## [0.1.33] — 2026-09-09

### Fixed

- Video quality no longer collapses to the minimum bitrate and stays there. One
  bandwidth estimate from the phone — sometimes as low as 5 kbps, on links that
  had just carried 2.9 Mbps with no packet loss at all — was enough to cap the
  Mac's encoder at its floor for the rest of the session, because the adaptive
  bitrate loop could never probe back above a cap it had accepted. Those
  estimates are not measurements of the network: they are what the phone's
  estimator reports when its measurement window opens on a gap in the video,
  which is exactly what switching displays or capture modes creates. An
  estimate below the encoder's own floor is now discarded rather than believed;
  packet loss and send-queue congestion still lower the bitrate as before.

### Security

- Ask scripts now request explicit file-read grants on their approval cards,
  and each grant is tied to the file itself rather than to its name. A name can
  be pointed at something else between your tap and the script running, so
  Lilypad records which file you approved and refuses if it changed. Runtime
  permissions exclude broad temporary and application-data directories. Hard
  links out of a granted folder are refused by the sandbox — measured, not
  assumed. Not yet a promise about every channel: the inter-process lookup
  service a script can reach has not been narrowed, and startup on a Mac with
  no developer tools installed has not been exercised.
- Model-chosen links require approval. The card includes the full URL and a
  normalized origin using standard URL parsing, including backslash and encoded
  host handling. Browser redirects can still change the final destination.
- Ask protocol version 2 requires both peers to support the same read/navigation
  disclosures. Older peers retain manual control but cannot start Ask work.
- Ask execution ownership now persists across task replacement, drain timeouts
  and reconnect-created controllers. A new runner waits for the old owner's
  lease; an already-issued OS effect cannot be recalled by this mechanism.
- Creating a folder can no longer be redirected out of your home folder.
  Lilypad used to check the path and then hand that text to `mkdir`, which
  looks it up again — and a link placed in the way between those two steps sent
  the folder elsewhere. The folder is now created relative to a directory
  Lilypad opened itself, one step at a time, following no links, so there is no
  gap to slip into.
- **"Open this file" and "show in Finder" are unavailable in this build.** Both
  work by handing a path to macOS to launch, and macOS looks that path up
  again, so nothing checked beforehand can be tied to the file that actually
  opens — and a launch cannot be taken back. We would rather drop a small
  convenience than keep one we cannot make a promise about. Opening apps,
  creating folders, and everything you do by hand are unaffected. This note
  will change when the feature returns on a footing that holds.
- Files an Ask run leaves behind are now bounded and private to you. Every run
  kept its script and its captured output forever, and captured output is
  whatever you allowed the script to read. The store is owner-only and expires
  by count, size and age.

### Reliability

- Recovery uses bounded cursor scanning and validates stored scope, identity,
  timestamp and schema version before admitting a room, and every read is now
  bounded in time rather than only the loop around them. A Redis that stops
  answering mid-read used to leave the backend starting forever, with a healthy
  connection and nothing in the log; it now gives up and starts with whatever
  it recovered. A byte bound on a hostile reply is still follow-up work.
- Non-ASCII script output is truncated without splitting a UTF-8 character.
- A single unreadable record in the backend's session store no longer stops the
  server from starting. Recovery trusted whatever was stored; a `null` left
  behind by a bad write crashed the boot sequence, and stayed crashed on every
  restart, because the record was still there. Invalid records are now skipped
  one by one, and a good record alongside them still recovers.
- Assistant runs hold on to less memory: screenshots older than the last two
  are released rather than kept for the whole task, under an explicit size
  ceiling as well as a count, and repeated approve/deny taps from the phone are
  bounded instead of queueing without limit.

## [0.1.32] — 2026-09-08

### Fixed

- The iOS release lane no longer re-runs `pod install` on a sandbox that is
  already current. Its guard resolved `Pods/Manifest.lock` against the
  `fastlane/` folder rather than the project folder, so it never matched and
  every release re-ran the command that fails intermittently in pnpm
  monorepos — which is why the `mobile-v0.1.31` build never reached
  TestFlight.
- The phone's software keyboard survives tapping the Mac's screen. Clearing
  the typing buffer was implemented by replacing the hidden text field, which
  destroys the field the keyboard belongs to, and it ran twice for every tap,
  on every toolbar key, and on every held-key repeat. A focused field is now
  left alone; the buffer is cleared the next time the keyboard is down.
- The Mac actually asks for updates. The only automatic check lived in the
  dashboard window, which is not open at launch, so a Mac whose owner works
  from the floating bubble never checked and stayed on an old version
  indefinitely. The check now runs from the bubble at launch and every six
  hours — a launch-only check was not enough either, for an app that starts at
  login and then runs for weeks. A waiting update shows on the bubble itself;
  installing it is still a deliberate click in the dashboard.
- The phone build carries the v0.1.31 mobile fixes that never reached
  TestFlight: WiFi-to-cellular handoff recovery, and a quality indicator that
  reads the current interval rather than the whole session.

## [0.1.31] — 2026-09-07

Published on the Mac only. The iOS build for this version failed to upload and
is not on TestFlight, so phones remain on the 0.1.30 build; the mobile fixes
below are in the tag and not yet on a device.

### Fixed

- The desktop's LAN server delivers its registration refusal before closing the
  socket, instead of aborting the writer with the terminal error still queued
  and leaving the phone to retry an expired room.
- WiFi-to-cellular handoff recovers. A connected-to-connected network change is
  detected, and when no new video arrives over cellular for five seconds the
  phone requests an authenticated cloud room through the existing resume flow —
  a LAN room's signaling endpoint is not reachable from cellular. Working media
  is kept, duplicate requests are suppressed, and handoff is deferred while the
  app is backgrounded.
- The mobile quality indicator reads packet loss per polling interval and picks
  frame rate from newly arriving bytes, so a retired or damaged stream can no
  longer keep a recovered connection looking poor. This corrects the reading,
  not picture quality.

### Verification

- Five real LAN integration tests, including the refusal-delivery regression
  that fails on 0.1.30. 629 mobile tests (11 intentional skips) and 409 Rust
  unit tests.

## [0.1.30] — 2026-09-06

### Fixed

- A phone whose iOS background suspension outlasted the desktop's 15-second
  grace no longer sits in Reconnecting forever. A rejected room ends and
  disposes the viewer immediately, foreground recovery measures suspension by
  wall clock rather than by timers the OS froze, and resume is re-sent after
  re-registration.
- Typing is one grapheme-aware edit stream: no resend of earlier text after
  hiding and reopening the keyboard, IME and autocorrect replacements are
  forwarded, Return is sent once, and Backspace is never left held.
- A retired input sender cannot flush buffered or late input into the peer that
  replaced it, and long pasted text is split without breaking surrogate pairs.
- An interrupted touch no longer registers as a click, held toolbar repeat stops
  when the app leaves the foreground, and releasing a drag releases where the
  drag ended rather than where it started.
- A replacement peer's input is no longer suppressed by the previous peer's
  deduplication history; ordering is reset in the worker before input is
  re-enabled, while an ordinary pause keeps replay protection.

## [0.1.29] — 2026-09-05

### Fixed

- Force-closing the phone no longer leaves the Mac showing Active and
  capturing. A closed input DataChannel immediately gates input, marks the peer
  unavailable, stops capture and encode, stops clipboard polling and cancels a
  running Ask, while preserving the same trusted phone's bounded rejoin.
- Callbacks from a replaced peer cannot act on its replacement, on either side.
- Teardown no longer leaves detached Ask or media tasks alive, and one
  pipeline's failure cannot end the pipeline that replaced it.
- A registered LAN socket cannot send into another authorized room, and a
  superseded seat cannot still route.
- A repeated cloud pair-request can no longer widen an approved view-only grant
  during a trusted rejoin.
- Input revocation takes effect immediately instead of waiting behind input
  already queued.
- Mac-to-phone clipboard text travels on the encrypted DataChannel rather than
  through cloud signaling, matching the documented privacy boundary. Automatic
  sync requires both apps at this version or later.
- A device-token or enrollment response can no longer repopulate mobile
  credentials after sign-out or reset.
- Concurrent desktop rings can no longer split room ownership, consent, control
  sender and task between them.
- ICE disconnection with only stale peer traffic stops capture and Ask instead
  of leaving them running, and a resumed transport no longer undoes an explicit
  viewer pause.

### Security

- Tagged desktop releases require signing, notarization and updater credentials.
  Artifacts stay draft until notarization and Gatekeeper validation succeed, so
  a release can no longer become public before it has been validated.

## [0.1.28] — 2026-09-04

### Fixed

- Pairing approval is available in the QR window, and QR creation waits for the
  desktop signaling seat before telling the user to scan.
- Desktop presence now treats only a `pong` as proof that its outbound
  signaling path is alive, preventing unrelated inbound frames from masking a
  dead connection.
- A stale QR timeout can no longer terminate a newer trusted reconnect that
  replaced it.
- LAN signaling rooms can only be joined by the desktop and mobile identities
  authorized by `connect_request`; callers cannot mint rooms or claim seats.
- CI uses a pinned `cargo-audit` command instead of the RustSec wrapper that
  failed while attempting to create an issue despite a clean audit.
- Patched transitive `browserslist` and `fast-uri` releases clear the new high
  severity dependency advisories. Fastify 5.12.1 is included separately with
  its numeric proxy-trust behavior migrated to address-bound local proxy
  ranges.

### Verification

- Added two-account HTTP and signaling isolation coverage, LAN authorization
  tests, pairing-timeout concurrency tests, and QR approval UI tests.
- Full TypeScript, Rust, documentation, workflow, and dependency verification
  passes. The signed website download and TestFlight build receive a clean-install
  Mac + iPhone/iPad validation immediately after publication, before this release
  is declared validated.

## Cumulative development record through v0.1.27

### P8 — every screen a Mac has, and names people recognise

A Mac with a monitor plugged into it showed only its main display, and both
device lists named every machine after its operating system.

#### Added

- **The screen switcher.** A Mac's displays are enumerated with
  `CGDisplay::active_displays` (cheap, local, and — unlike
  `SCShareableContent` — needing no Screen-Recording grant to answer), reported
  on `frame-size`, and chosen from the phone with a new `set-display` message.
  The row appears only when there is more than one screen, because a laptop
  with one has nothing to switch between. Three things beyond showing a
  different picture: input coordinates are mapped against the CAPTURED
  display's global rect rather than the main display's size, so a tap lands on
  the screen the viewer is looking at; unplugging the captured monitor rebuilds
  capture on the main display instead of ending the session; and the Mac's own
  dashboard names the screen being shared, since a remote phone moving the view
  is not something to leave silent.
- **`GET /auth/methods`** — which ways in a server can actually perform. Both
  clients hide the flows it marks unavailable and fail open, so a server that
  cannot be reached still shows every method. Production has never had a mail
  sender, so the phone's "Email me a sign-in link" and "Forgot your password?"
  and the Mac's "Forgot password" were three buttons whose only possible
  outcome was a 503.

#### Fixed

- **Every machine had the same name.** Desktops enrolled as the literal
  `"macos desktop"` and phones as `"ios phone"`, so an account with several
  listed rows that were word-for-word identical. A Mac now sends what `scutil
--get ComputerName` reports — the name macOS itself shows in Sharing settings
  — and a phone sends its form factor. Existing rows heal themselves on the
  next `/devices/token`, which carries the name the way it already carries
  `appVersion`; a name the user typed is never overwritten, enforced in the
  UPDATE's own CASE.
- **Neither device list had an order.** `GET /devices` had no `ORDER BY` and
  rendered the heap order; "Your laptops" rendered the order they were paired
  in. Both now lead with what the reader is using and what they used last.
- **Test budgets that were about the machine.** `waitFor` at one second and a
  media-pipeline sample at five made `pnpm -w test` fail on a loaded laptop
  while passing alone.

### P7 — consumer onboarding

Both clients now present the product in the order it is actually used, and both
can sign in ([ADR-0012](docs/adr/0012-password-authentication.md), which amends
[ADR-0001](docs/adr/0001-account-authentication.md)).

#### Added

- **Email + password sign-in** — `POST /auth/signup`, `POST /auth/password`, and
  `POST /auth/password/reset/{request,confirm}`. scrypt from the standard
  library (`N=32768, r=8, p=1`), stored as `scrypt$N$r$p$salt$hash` so the cost
  can be raised later without invalidating a row. Policy is NIST SP 800-63B:
  12–200 characters, NFKC-normalised, no composition rules. `users.name` is a
  new column; `users.password_hash`, nullable and unused since M1, is now
  load-bearing.
- **The desktop can sign in.** It never could: ADR-0008 gives it no OAuth client
  and production has no mail sender, so every method in ADR-0001 was unreachable
  there. `src-tauri/src/account.rs` plus six Tauri commands, and an account panel
  on the dashboard and the first-run wizard.
- **The phone remembers who is signed in** (`src/lib/session.ts`) — a record,
  not a credential: nothing there authenticates anything, and the Ed25519 key in
  the Keychain remains the only durable credential. It exists so the launch gate
  can answer "is somebody signed in?" without a network round trip.
- **The app ships a backend address** (`src/config/backend.ts`). It shipped none
  before, which is precisely why sign-in could only be reached _from_ the
  scanner and "Your devices" stayed hidden until a laptop was paired.
- **Sign out**, on both clients. Phone-side it forgets the session and the saved
  pairs; desktop-side it forgets the account session. Neither revokes a device —
  that is an account-level act, done from "Your devices".

#### Fixed

- **A second `pair-approved` minted a second session.** Nothing in the room
  refused a repeat approval: it minted a fresh session id, re-sent
  `session-start` to both peers — which tears down the peer still negotiating
  the first — persisted a second session record that nothing would ever end, and
  with `trust: true` fired a second trust write racing the first to decide which
  connect secret the pair actually keeps. When those two disagree the phone can
  never reconnect without another QR. The desktop client already refused to send
  one, after the handshake was observed failing off-LAN where a phone re-sends
  `pair-request` on a lossy link and the desktop re-prompts; the rule now lives
  in the room, where every client inherits it.
- **Trust could be established twice at once, and the loser hit the unique
  index.** `establishTrustForDeviceIds` read the pair and then chose between an
  insert and an update, but two entry points write the same pair with no lock
  between them — linking a laptop (`/devices/enrollment-code/approve`) and
  approving its QR pairing with "Trust this device". Both saw no row, both
  inserted, and `trusted_devices_pair_idx` failed one: a 500 out of the HTTP
  route, and on the signaling path (fire-and-forget) a logged error plus a phone
  that never received its connect secret. Now one
  `INSERT … ON CONFLICT DO UPDATE`, which also still leaves `auto_approve` alone
  so a user who turned "Always allow" back off keeps it through a re-pair.
- **Two overlapping enrollments of one device returned a 500.** `enroll` looks a
  device up and then inserts it; the unique indexes on `devices` are what stop a
  second row, so a concurrent enrollment made the loser raise a constraint
  violation — on the first thing a new account does, and reached by nothing more
  exotic than a retry (the phone abandons a request after 8s, the user taps Sign
  in again). The insert is conflict-tolerant now and resolves again against the
  row that won. Two racers converge on one device; two devices racing for one
  key still get `public_key_in_use`.
- **Pairing was offered on a computer no account owned.** The tray's "Show QR /
  Pair", the dashboard's "+", and the wizard's last step all worked on a Mac
  nobody had signed into or linked. A pair made in that state belongs to no
  account — it appears in no "Your devices" list and can be revoked from
  nowhere, which [ADR-0010](docs/adr/0010-explicit-device-linking.md) rejected
  outright and which `docs/api.md` recorded as ending "when P1 makes enrolment
  mandatory". `create_pairing` now refuses, and every surface that could reach
  it disables itself with the reason. `unknown` link state deliberately still
  passes: it means the backend could not be **asked**, not that the machine is
  unowned. The backend's unowned lane is still open and still needs its own pass.
- **The linking QR was offered before anyone had signed in**, directly beneath
  the sign-in form, with nothing relating the two panels. Linking waits for
  sign-in now.
- **Signing in on the phone did nothing visible.** The signed-out gate and the
  signed-in stack both had a screen named `SignIn`; React Navigation keeps a
  focused route across a conditional-screen swap when its name survives, so the
  session flipped, the stack swapped, and the navigator went on rendering the
  same route. Sign-in itself had been succeeding the whole time — 200 on
  `/auth/password` and 200 on `/devices/enroll`, six times over.
- **A pairing QR was the desktop's front door.** Clicking the bubble minted a
  pairing code and put a QR on screen as the app's first act, before any account
  existed and before the user had seen a screen explaining what Lilypad is. It
  opens the dashboard now, which carries its own "Pair a new device" button.
- **The phone had no authentication gate.** It opened on the paired-laptop list,
  pairing worked entirely signed out, and sign-in appeared only when the scanner
  happened to hit a `DeviceAuthError`. Signed out, `SignIn` is now the only
  route in the stack — expressed as which screens exist, so there is no
  protected route left to reach by mistake.
- **`POST /devices/enroll` accepted `kind: "desktop"`.** Unreachable while no
  desktop could hold an account token — and about to stop being unreachable.
  A computer must be adopted by a phone approving its enrollment code
  ([ADR-0010](docs/adr/0010-explicit-device-linking.md)); it may never put itself
  on an account however well it proves who is signed in. Now a 403, checked
  before the signature is. The desktop's unused self-enrol method was removed
  rather than left to compile and fail.
- **A test's Keychain mock ignored `service`.** One slot for three namespaces,
  so writing a session destroyed the device key — a failure that could only
  happen in the mock, and one that would have hidden real ones.

#### Security

- Password sign-in is **constant-answer and constant-time**: unknown address,
  wrong password, and an account with no password all return
  `401 invalid_credentials`, and the branches with nothing to verify still
  verify against a dummy hash. Either half alone leaves an account-existence
  oracle.
- **Reset tokens live in their own Redis namespace.** Same entropy, TTL, and
  single-use `GETDEL` as a magic link — but one key space would make a reset
  token redeemable at `/auth/magic-link/verify`, so an email saying "reset your
  password" would silently be a full sign-in.
- Signup is the **one** auth route that reveals whether an address is taken, and
  says so in the docs. The enumeration-safe alternative needs the mail sender
  M13 still owes.

### P1 — first-run onboarding

The **Setup** window now carries the whole first run in order — **permissions →
link this computer → pair a phone** — rather than stopping after the
permissions.

#### Fixed

- **The wizard claimed to be finished when it was not.** It ended with _"All set
  — you can start pairing now"_ as soon as the two permissions were granted,
  which is the one thing P1's definition of done forbids: the desktop announcing
  it is ready before a phone has approved it. Permissions say what the machine
  can do; they say nothing about whose it is. The final card now states
  whichever of two things is true — set up **and on your account**, or set up
  and **not on an account yet**. The regression test was mutation-checked
  against the exact old behaviour.

#### Changed

- Steps 2 and 3 stay hidden until the permissions are granted: offering to put a
  computer on an account, or pair a phone with it, before it can capture or type
  is a step that cannot work.
- Linking is **offered, not demanded** — pairing genuinely works on an unlinked
  computer, so blocking on it would be a lie in the other direction.
- Step 2 reuses the existing `AccountPanel` and step 3 the existing pairing
  window; nothing new was built for either.

### P4 — the marketing site

`apps/site` — one HTML file and one stylesheet, no framework and no JavaScript
shipped. Colour comes from `@lilypad/design`, so the site follows the visitor's
light/dark preference and cannot drift from the product it describes.

#### Added

- The page: what Lilypad is, the LAN → P2P → relay path in order, what the
  security model actually promises, Ask, an honest platform table, and plans.
- **A claims test.** A marketing page does not crash when it goes wrong — it
  keeps rendering a claim that stopped being true. `src/claims.test.ts` asserts
  the page against the rules the repo sets: macOS and iOS supported,
  Windows and Android **not**, `$XXXX` as the only price on the page, no legal
  pages linked, and Ask's internal tier names absent. Mutation-checked, both
  ways.

#### Deliberately absent

- **A download button.** There is no tag and no published release, so the page
  says there is no public release yet and links to the Releases page instead of
  promising a binary that does not exist.
- **Legal pages.** Privacy and terms need real answers about retention and
  jurisdiction. The footer says they are not written rather than linking a
  policy that does not exist.
- **Real prices and quotas.** `$XXXX` throughout, and the page says outright
  that prices are not set.

#### Note

The site's hostname is **`lilypadhome.takedia.com`**, deliberately not
`lilypad.takedia.com` — that name is already live as the cloudflared tunnel
serving the development backend for cellular testing, and pointing it at a
static site would break off-LAN testing. Two separate names, so nothing has to
move for the site to ship. P4 touches no DNS; hosting is M13's.

### P3 — design system

One source of truth for colour, in a new `@lilypad/design` package
([ADR-0011](docs/adr/0011-design-tokens.md)).

#### Added

- `@lilypad/design` — colour tokens for both schemes, corner radii and the
  system font stack. Web surfaces `@import '@lilypad/design/tokens.css'`; mobile
  imports the TypeScript module. The only colour literals left in the codebase
  are three documented exemptions: the vendor sign-in buttons, the floating
  bubble (which overlays an arbitrary desktop and must not follow the theme),
  and the QR code's white frame (which must stay scannable).
- A drift test that parses the shipped `tokens.css` and fails if it disagrees
  with `tokens.ts` — including a custom property the TypeScript does not
  declare, which is drift arriving from the side mobile cannot see.

#### Changed

- The palette no longer exists three times. `apps/mobile/src/theme.ts` is now a
  re-export, and both stylesheets import the shared tokens instead of declaring
  their own `:root`.
- **`SignInScreen` is on the palette.** It previously set no background colour
  at all, so the first screen a new user sees rendered white in a product that
  is dark green everywhere else, with `#ccc` borders and a Material red error.
  The Apple and Google buttons keep their vendor colours; Apple's switches to
  its white style, which is the permitted style that stays legible on a dark
  background.
- **The admin dashboard follows the OS colour scheme.** It hardcoded dark; every
  rule already read `var(--*)`, so importing the shared tokens gave it the
  desktop's light/dark behaviour. Rendered values are unchanged — which set
  applies is not.
- Two accidental colours converged: `#04140d` → `onAccent` and `#e0a83e` →
  `pending`. The desktop's status dots stop using Apple's system green and amber
  for meanings the palette already had colours for.

#### Not done, deliberately

Font sizes and spacing stay per surface. They are not duplicated; they differ
because a phone is held at arm's length and a laptop is not, and one shared
numeric scale would have to re-tune shipped screens.

### P2 — device management

An authenticated "my devices" surface, built on M9's ownership rule.

- **`GET /devices`, `PATCH /devices/:id`, `DELETE /devices/:id`**, all
  `requireDevice` and ownership-gated. Unlike the pairing routes there is no
  unowned lane: the resource _is_ an account's device list, so an anonymous
  caller gets 401 rather than an empty array — "we do not know who you are" and
  "you own nothing" are different claims.
- **Revocation is immediate.** The backend ends the device's live rooms _and its
  presence room_, then its next `/devices/token` fails. Without that, a
  ten-minute access token would leave a stolen laptop controllable for ten more
  minutes — the exact window revocation exists to close. Killing presence too
  matters: a revoked machine must stop being reachable, not merely stop being
  connected.
- **Active-session state comes from the signaling hub, not the `sessions`
  table** — that table is still never written, and rendering it as "no active
  sessions" would state something false rather than omit something missing. A
  presence seat deliberately does not count: a laptop sitting in one is
  reachable, not busy.
- **Revoking a device does not delete its pairs**, deliberately. Revocation is
  enforced at the identity layer, so the pair rows are inert; re-enrolling the
  device un-revokes it and its trust relationships come back intact, which is
  the recovery a user expects after "I found my laptop".
- **Phone "Your devices" screen** — list, rename, remove — with copy that keeps
  it apart from "Your laptops": forgetting a laptop ends one pairing, removing a
  device withdraws ownership. Removing the phone in your hand warns that it
  signs you out.
- Fingerprints are masked in listings, the same treatment pair listings already
  get: a full fingerprint is an input to the pairing surface.
- **Fixed before it shipped, by live testing:** the mobile client set
  `content-type: application/json` on every request including bodiless ones, and
  Fastify rejects that with `FST_ERR_CTP_EMPTY_JSON_BODY` before the route runs
  — so every device removal would have failed with a 400 the UI reported as
  "Could not remove that device". Tests that mock `fetch` cannot catch this.

### P1 — the account layer is connected on both ends

Closes PROD-1. A user could previously install Lilypad, grant permissions and
pair a phone without ever having an account: the desktop had no enrollment UI,
`SignInScreen.tsx` had no route, and `approveDesktopEnrollment()`'s only caller
was a test.

- **Desktop "This computer" panel.** Shows `Not linked` until a phone has
  actually approved this machine, mints an enrollment QR, and polls for the
  approval — which happens on the phone, so there is nothing local to react to.
  It distinguishes `unknown` (backend unreachable) from `not linked`: telling a
  linked user their computer is not linked because the wifi dropped would invite
  them to redo a ceremony they had already completed.
- **One camera, two codes.** The phone's scanner now classifies a **pair** code
  and a **link** code and confirms them in deliberately different words —
  "Pair with…" versus "Add … to your account?". Pairing starts one session;
  linking hands a computer to an account permanently, and presenting them
  identically would be the product's most consequential ambiguity.
- Linking stores the one-time connect secret, so a linked computer is
  **reachable**, not merely owned — and it does **not** start a session, because
  owning a computer and choosing to control it are separate acts.
- **`POST /devices/enrollment-code` now returns `apiBaseUrl`.** The QR schema
  already required it and the desktop had no way to obtain it; a laptop talking
  to `http://localhost:8080` cannot ask a phone to reach that. It comes from the
  same `advertisedUrls()` seam `/pairing/create` uses.
- **Sign-in is reached from the act that needs it.** Verified in the repo: the
  phone ships no default backend address, so "sign in, then find your computer"
  cannot exist. Scanning a link code without an account routes to sign-in at the
  address that code named, and returns to the still-mounted card to finish.
- `SignInScreen`'s subtitle promised "your laptops appear here once you sign in
  on both devices" — the ADR-0003 behaviour ADR-0010 reversed. Corrected.

### Roadmap — a separate product completion track (P1–P6)

The consumer-product plan and the platform milestones had begun claiming the
same numbers for different work: `milestones.md` had M10 as desktop security
hardening while the product plan had M10 as the auth UI. Rather than renumber
either, the product work now runs as **P1–P6** on its own axis.

- **P1** account-connected clients · **P2** device management · **P3** design
  system · **P4** `lilypadhome.takedia.com` · **P5** Ask productisation ·
  **P6** entitlements (blocked on pricing).
- **Nothing was deleted or renumbered.** M14 (Consumer UX) and M18's Ask half
  are marked superseded in place and say which P-milestone took them; M13 keeps
  DNS, TLS and hosting, and P4 is only the site's content and build.
- New gap **PROD-1** records what P1 closes: the account layer is built on both
  ends and connected on neither, so a user can install Lilypad, grant
  permissions and pair a phone without ever having an account.
- Pricing stays `$XXXX`. The repository contains three tier names and two
  principles — LAN is never paywalled, only relay minutes and managed AI are
  metered — and no price point, quota or allowance anywhere. That is a product
  decision, recorded as an open one rather than guessed.

### Security — ownership authorization on every route (M9, SEC-3/4/7)

Knowing a device id, a pair id, or a room id is no longer worth anything.
See [ADR-0010](docs/adr/0010-explicit-device-linking.md).

- **One rule, two questions** (`auth/authorize.ts`, pure and DB-free). _Acting
  as_ a device — `/pairing/create`, `/pairing/redeem`, `/connect/request`,
  `/devices/unpair`, presence `register` — requires **that device's own
  token**; owning it is not enough, or one compromised device could impersonate
  every sibling. _Managing_ a device or pair — the three `/devices/pairs`
  routes — requires **owning** it, which is what will let a phone manage its
  laptop's pairs.
- **Presence rooms need a token now (SEC-4).** `presence:<deviceId>` was
  authorized by a suffix match alone, so knowing a laptop's device id was
  enough to take its presence seat — evicting the real machine as a
  "same-device reconnect" and receiving every ring meant for it. The claim must
  now be backed by a device token on the WebSocket upgrade. Session rooms are
  unchanged: they were already bound to a server-minted room record.
- **Denials answer 404, never 403**, so "not yours" cannot be told apart from
  "does not exist". A present-but-invalid token is still a 401 — silently
  downgrading an expired token to anonymous would tell a client its device had
  vanished when its session had merely lapsed.
- **Both clients send a device token whenever they can mint one.** The desktop
  attaches one to all four backend calls and to its presence socket; the phone
  attaches one to redeem, connect and unpair. Neither treats its absence as an
  error — a computer no account owns has nothing to prove, and pairing one
  works exactly as before.
- **The gate keys on the resource, not the route.** A device row with no owner
  keeps its pre-accounts behaviour, so nothing breaks for existing installs
  while the sign-in UI is still P1. Both halves meet per-device with no flag
  day; when enrolment becomes mandatory the unowned branch is deleted.
- **SEC-7 is answered by tests, not by assertion:** a table of every actor Bob
  can be against every resource Alice owns on every gated route
  (`auth/authorize.test.ts`), plus a per-route wiring suite that catches the
  failure a rule test cannot — a route that simply forgot its `preHandler`
  (`routes/authorization.test.ts`).
- The phone now memoizes "this device has no account" so pairing does not pay
  for a challenge and a rejection on every scan.
- **Pre-secret trust pairs are refused (SEC-5).** A pair with no
  `connect_secret_hash` predates per-pair secrets and used to be admitted with
  no secret whatsoever, so knowing two device ids was enough to ring a
  laptop — on exactly the pairs whose owners never had a chance to opt in.
  Migration `0005` revokes them (revoked, not deleted, so the row stays an
  audit trail) and `authorizeConnect` refuses a null hash outright. Verified
  against a live Postgres: one seeded legacy row revoked, two secret-bearing
  pairs untouched. Affected phones re-pair once with a QR, which issues a
  secret and un-revokes the row.

### Deployment — control plane artifacts (not yet deployed)

- **Production image.** `apps/backend/Dockerfile`, multi-stage, non-root,
  `linux/amd64` + `linux/arm64` (the $0 tier is ARM, the paid tier is x86).
  Verified locally: boots under real production configuration and reports
  `{"status":"ok","checks":{"postgres":"up","redis":"up"}}`.
- **Production stack.** `infra/production/docker-compose.yml` — backend,
  Postgres, Redis and a Cloudflare tunnel on one VM. Nothing is published to
  the host; cloudflared dials outward, so the VM opens **no inbound ports**.
- **Deploy pipeline.** `.github/workflows/deploy.yml`: gate (test, typecheck,
  lint, build, docs, format, audit) → multi-arch image → migrate → deploy →
  health-check → automatic rollback on failure.
- **Documentation.** [`docs/deployment.md`](docs/deployment.md) and
  [ADR-0009](docs/adr/0009-control-plane-deployment.md) record the staged
  $0 → ~€9/mo → scale path, a cost model from 0 to 100,000 users, and recovery
  procedures. Egress pricing is the deciding factor: 1 TB of TURN relay is €0
  on Hetzner, $20 on Fly, ~$90 on AWS.
- **Verified security posture** on the image: the production guard refuses dev
  defaults, short secrets, a passwordless Redis and non-HTTPS public URLs;
  `/metrics` answers 401 without a bearer token; CORS fails closed.
- **Not deployed.** No VM, no `api.takedia.com`, no TURN host. Route
  authorization (SEC-3) has since landed — see the security entry above.

Cellular-stability hardening on top of 1.0.0 driven by live-hardware findings
(2026-07-19 → 2026-07-20), plus the release-engineering pass that makes the
apps shippable and self-updating.

### Architecture — LAN-first, cloud as control plane only

Two hard requirements were adopted and the architecture and roadmap revised
around them: **a LAN session must work with no internet at all**, and **cloud
spend must be minimized aggressively**.

- **Audit finding that changed the plan.** The media path is already LAN-direct
  (host ICE candidates win on-LAN), but the _control_ path is not: a session
  cannot start without the backend. It works offline today only because the
  backend runs on the laptop — a development artifact, not a designed
  capability. There is **no LAN discovery of any kind** in the codebase. Most
  importantly, the previous roadmap's plan to move signaling to
  `signal.takedia.com` **would have regressed LAN capability**, making every
  same-room session depend on the public internet.
- **New milestone M9.5 — LAN-direct connectivity**, sequenced _before_ the cloud
  deployment milestone so the cloud is added beside a working local path rather
  than in front of it. The desktop gains an embedded signaling server (TLS bound
  to its Ed25519 identity, pinned at pairing), and discovery is a cached
  last-known address first, then native mDNS — no new wire protocol and no iOS
  multicast entitlement. Release-blocking DoD: an automated cloud-unreachable
  scenario proving discovery, video, input, and clipboard all work with **zero
  cloud requests**.
- **New docs:** [NETWORKING.md](docs/NETWORKING.md) (connection algorithm,
  discovery decision, failure modes, privacy boundary),
  [INFRASTRUCTURE-COST-MODEL.md](docs/INFRASTRUCTURE-COST-MODEL.md) (cost drivers
  and per-scale estimates), [REUSE-INVENTORY.md](docs/REUSE-INVENTORY.md)
  (build-vs-buy with costs at 1K/10K/100K users).
- **New ADRs:** [ADR-0006](docs/adr/0006-lan-first-connectivity.md) (the laptop
  is its own control plane) and
  [ADR-0007](docs/adr/0007-cloud-is-control-plane-only.md) (the cloud never
  carries the data plane).
- **M13 revised for cost.** Self-hosted coturn on bandwidth-inclusive VPS is
  roughly **1000× cheaper** than managed TURN at scale (~€36/mo vs ~$59,000/mo of
  relay at 100k users) — the difference between a sustainable free tier and none.
  Phase 1 targets a footprint under €30/month with no Redis, no Kubernetes, and
  no managed observability.

### Fixed — desktop crash

- **`NSPasteboard` data race that killed the app mid-session.** The clipboard
  watcher polls the OS clipboard every 750ms on the session tick, while the
  `InputWorker` writes it whenever the phone pastes — two threads, neither the
  main one, both constructing their own `arboard::Clipboard`. `NSPasteboard` is
  not thread-safe: concurrent access corrupted AppKit's internal type cache and
  aborted the process inside `-[NSPasteboard _updateTypeCacheIfNeeded]`. It
  reproduced as a SIGSEGV in roughly **one run in three** of the
  `session_connect_lifecycle` integration test, which drives exactly that pair
  of threads, and would have crashed the desktop app whenever a real poll raced
  a real paste.

  All clipboard access now funnels through a new `clipboard` module that owns a
  process-wide lock and exposes `read_text`/`write_text` **rather than the lock**
  — handing callers a mutex they must remember to take would leave the same bug
  one forgotten line away. `arboard` is referenced nowhere else in the crate;
  that is the invariant to preserve. New regression test
  `tests/clipboard_race.rs` hammers both paths concurrently, and was verified to
  kill the process when the lock is neutered. The previously-flaky binary now
  passes 12/12.

### Security — dependencies

- **Cleared every high and critical dependency advisory** (19 findings) and made
  the CI audit **blocking**. Direct bumps: `drizzle-orm` 0.38.4 → 0.45.2 and
  `fastify` 5.2 → 5.11.3 (both backend **runtime**), `vitest` 2.1.9 → 3.2.7
  (clears a critical), `vite` 6.0.7 → 6.4.3, `drizzle-kit` 0.30 → 0.31.10.
  Transitives that their parents already permit — `find-my-way`, `fast-uri`,
  `postcss`, `nanoid`, `js-yaml`, `brace-expansion`, `esbuild`,
  `fast-xml-parser` — are pinned via `pnpm.overrides` rather than waiting on a
  parent re-release. Versions were chosen as the **minimum that clears the
  advisory within the existing major**, not "latest", to keep the change
  reviewable. All 537 JS/TS tests, typecheck, lint, build, and format pass
  unchanged.
- Two `image-size` advisories (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq) are
  explicitly ignored with the reasoning recorded in `ci.yml`: no patched release
  exists, and it reaches us only through React Native's bundler at build time.

### Engineering process

- **Documentation is now enforced by CI** (`pnpm docs:check`). It fails the build
  on three specific drifts, each of which had already happened in this repo:
  a doc under `docs/` without `status`/`owner`/`last-verified` frontmatter, a
  broken relative link, or an HTTP route that exists in the backend but not in
  `docs/api.md` (or the reverse). Rules and the what-to-update-when table are in
  `CONTRIBUTING.md`.
- **Architecture Decision Records** (`docs/adr/`). ADR-0001..0007 record the
  decisions behind the consumer-product track: OAuth-with-no-passwords account
  auth, Ed25519 device identity, replacing same-account QR pairing with account
  ownership, scaling signaling via Redis pub/sub while keeping rooms in memory,
  running TURN on dedicated regional VMs rather than Kubernetes, LAN-first
  connectivity, and the cloud as a control plane only.
- **Security scanning in CI**: CodeQL plus a dependency audit (now blocking —
  see "Security — dependencies" above).
- `docs/PROJECT-INDEX.md` gained a verified gap register (`SEC-*`, `OPS-*`,
  `NET-*`, `OBS-*`, `DEP-*`) and a roadmap position, and `docs/milestones.md`
  gained the M7–M18 consumer-product track.

### Distribution & CI/CD

- **Desktop auto-update**: the Tauri v2 updater plugin checks a signed
  `latest.json` published to GitHub Releases (minisign pubkey pinned in
  `tauri.conf.json`). The client lifecycle is one explicit state machine
  (`useUpdater.ts`: idle → checking → available → downloading → ready →
  relaunch), surfaced as a "check now" panel in Diagnostics.
- **Signed + notarized macOS release pipeline** (`.github/workflows/release.yml`):
  pushing a `v*` tag builds a universal (aarch64 + x86_64) `.app`/`.dmg`,
  Developer-ID signs, notarizes, staples, and publishes the GitHub Release with
  the updater artifacts. `pnpm release` cuts the tag.
- **Mobile CI/CD**: `mobile-ios.yml` (fastlane → TestFlight) and
  `mobile-android.yml` (fastlane → Play internal track + APK artifact).
  `Gemfile.lock` is committed multi-platform so fastlane resolves identically
  on a developer Mac and on CI Linux.
- **CI** (`ci.yml`): TypeScript (lint + typecheck + test) and Rust (fmt +
  clippy + test) jobs, plus nightly and weekly soak runs. Two flaky media tests
  were made deterministic (an unmocked promise, and a one-frame
  recovery-keyframe race in the drop test) rather than retried.
- **Reproducible fresh clone**: `pnpm bootstrap` now seeds `.env` from
  `.env.example`, and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) documents the full
  lifecycle — fresh clone → running, cutting releases, how updates reach
  installed apps, and reclaiming disk.

### Desktop

- Single-instance guard (`flock`-based advisory lock): the launch-at-login
  LaunchAgent and a manual/dev launch could previously both register the same
  presence room and fight over it, producing a phone-visible ~1 Hz
  "reconnecting" churn. The second instance now exits quietly at startup.
- Tray gains an "Open Dashboard" entry; `show_qr` is now also disabled while
  a session is `Connecting`, not just `Active`.
- Traffic-liveness window widened 22s → 34s: a live cellular capture showed
  the phone's RTCP/REMB return path go silent for ~30s while forward video
  kept flowing — the old window tripped an unnecessary ICE restart on a
  stream that never actually stopped.
- ABR and session-runner resilience refinements from the same cellular
  capture session.

### Backend

- Self-hosted TURN relay support (`infra/coturn-prod/`): coturn behind
  `use-auth-secret`, sharing `TURN_SECRET` with the backend so
  `PUBLIC_TURN_URL` can be advertised with HMAC-derived credentials instead
  of only static ones — fixes the free-tier `metered.ca` relay collapsing
  under a sustained 1–3 Mbps desktop stream. `FORCE_RELAY` forces
  `iceTransportPolicy: relay` once the dedicated relay is deployed.
- `quickTunnel` (dev `TUNNEL=1` cloudflared wrapper) now health-probes its
  own HTTPS origin every 15s and force-restarts after 8 consecutive failures
  (~2 min), catching a "zombie" tunnel (process alive, edge connection dead)
  that previously required a manual restart. Also reaps a cloudflared
  orphaned by a hard-killed (`kill -9`) backend before its first launch.
- `SignalingHub` construction extracted into `createSignalingHubBundle`
  (`signaling/hubBundle.ts`) so `signalingRoutes` and `deviceRoutes` share
  one hub instance instead of risking a second, divergent one.

## [1.0.0] — 2026-07-18

First feature-complete release. The full remote-control loop is verified
end-to-end on real hardware (iPhone ↔ MacBook): pairing, approval, live
streaming, input, clipboard, reconnect.

### Desktop (macOS · Tauri v2 + Rust)

- Floating always-on-top pairing bubble, tray menu (QR, approve/deny,
  disconnect, panic, diagnostics), QR overlay with expiry countdown.
- Real screen capture via **ScreenCaptureKit** at the display's native aspect
  ratio, with change-driven delivery, static-screen keepalive frames, and
  bounded automatic restart when the OS stops the stream.
- Hardware H.264 encoding via **VideoToolbox** (openh264 software fallback),
  low-latency configuration: no B-frames, ~1s GOP, shallow two-frame send
  queue, drop-oldest + forced-IDR overload recovery.
- Loss-based adaptive bitrate (AIMD + REMB cap) between 1–10 Mbps with a
  quality floor that survives conservative initial receiver estimates.
- RTP timestamps track real capture spacing, keeping the receiver's jitter
  buffer aligned with wall time on change-driven capture.
- Input injection via CGEvent: pointer, wheel, keys, shortcuts, text (IME
  paste-through), double/triple-click via `clickState`, all gated per-session
  scope at the injection boundary with full drop accounting.
- Two capture modes switchable mid-session: **Motion** (30 fps, 1920-long-edge
  cap) and **Text** (15 fps, 2560 cap) for reading-heavy work.
- Clipboard sync desktop → phone with change detection.
- First-run permission wizard (Screen Recording + Accessibility) with live
  status, deep links into System Settings, and one-click relaunch.
- Display-sleep prevention (IOPM assertion) held for the lifetime of a session.
- Session state machine with reconnect grace, ICE-restart budget, and panic
  disconnect.

### Mobile (iOS · bare React Native)

- QR scanner → pairing → live viewer with connection-quality HUD
  (RTT/bitrate/fps) and state-specific placeholders (waiting, denied,
  recovering, failed).
- Full touch model: tap/double-tap/triple-tap clicks, settle-window drags,
  long-press right-click, two-finger scroll, pinch-zoom viewport (up to 6×)
  with pan, zoom-lock mode, and two-finger double-tap reset — transforms
  applied atomically for gesture smoothness.
- Landscape full-bleed mode with collapsible control tray.
- Hidden-TextInput keyboard bridge preserving iOS autocorrect/IME, with a
  native accessory "Done" bar (the keyboard covers the on-screen toggle).
- Sticky modifier chips (⌘⇧⌥⌃), shortcut toolbar with press-and-hold repeat,
  Motion/Text/Zoom toggles, two-tap disconnect confirm.
- Keep-awake during sessions; app-lifecycle-aware signaling pause/resume and
  automatic reconnect with ICE restart on network change.

### Backend (Node · Fastify)

- Single-use QR pairing tokens (60s TTL, Redis) with per-IP rate limiting.
- Room-scoped WebSocket signaling with heartbeat reaping, per-IP connection
  caps, per-socket token-bucket rate limiting, same-host origin enforcement,
  and mid-session seat-holding with a reconnect grace window.
- Per-session, per-role time-limited TURN credentials (coturn shared-secret
  HMAC) — the master secret never leaves the server.
- Boot-time LAN-IP auto-detection for QR URLs in development; strict
  https/wss/pinned-URL enforcement for production boots.
- Postgres (Drizzle) schema for users/devices/sessions/audit logs; security
  events (pairing, approval, denial, panic) audit-logged.
- `/health` (Postgres + Redis liveness) and bearer-gated `/metrics`.

### Protocol

- Shared zod schemas (`@lilypad/protocol`) for the QR payload, every
  signaling message, and the full input-event vocabulary — mirrored by serde
  types in Rust with a drift test pinning the two.
- All string fields length-bounded; input batches size-bounded; monotonic
  sequence ordering with stale-event rejection.

[0.1.28]: https://github.com/Kush402/lilypad/releases/tag/v0.1.28
[1.0.0]: https://github.com/lilypad/lilypad/releases/tag/v1.0.0
