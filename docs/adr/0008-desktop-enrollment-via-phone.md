---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: Why the desktop is enrolled by an already-signed-in phone instead of having its own OAuth client.
---

# ADR-0008 — The desktop enrolls through an authenticated phone

## Context

[ADR-0001](0001-account-authentication.md) chose OAuth with Apple and Google,
and the backend verifies a **client-supplied ID token** — it never performs an
authorization-code exchange and holds no client secrets. That works cleanly on
iOS and Android, where the platform SDK hands the app an ID token directly.

It does not work on the desktop, and the obstacle is not ours to remove:

- **Google removed the implicit ID-token flow for installed apps.** A desktop
  app can obtain a Google ID token only via `response_type=code` plus PKCE,
  exchanged at Google's token endpoint. No configuration avoids this.
- Google does issue a "client secret" for Desktop-app clients while documenting
  it as **not confidential** — it ships inside the binary, and PKCE is what
  actually protects the exchange. Shipping a value called a secret that is not
  one is its own liability.
- Sign in with Apple on macOS _can_ return an identity token natively via
  `ASAuthorizationAppleIDProvider`, but reaching it from Tauri needs
  Objective-C interop, and it would only solve one of the two providers.

Meanwhile the desktop already has a QR surface, and the phone is already signed
in. The pairing flow already teaches users to scan a code on the laptop screen.

## Decision

**The desktop has no OAuth client and performs no sign-in of its own. A phone
that is already enrolled approves it onto that phone's account.** This is the
WhatsApp Web / Steam model.

1. The desktop proves it holds its Ed25519 keypair
   ([ADR-0002](0002-device-identity.md)) and receives a single-use enrollment
   code, **bound server-side to that public key**, with a 120-second TTL in
   Redis.
2. The desktop shows the code as a QR.
3. The phone scans it and calls `POST /devices/enrollment-code/approve` with its
   own **device token**. The account the desktop joins is the token's subject.
4. The desktop learns it worked because its next `POST /devices/token` succeeds.
   There is no completion endpoint, no push channel, and no polling protocol to
   specify.

## Alternatives

**Give the desktop its own Google Desktop-app client and do PKCE locally.**
Rejected, though it is defensible: the backend would still only ever receive an
ID token, so ADR-0001 would survive intact. It costs an extra OAuth client, a
loopback HTTP listener inside the desktop app, a browser round-trip, and a
shipped non-secret "client secret" — all to reach a state the phone can grant in
one scan.

**Native Sign in with Apple on macOS only.** Rejected as a complete answer: it
covers one provider, needs Objective-C interop from Rust, and leaves Google
unsolved, so the QR path would have to exist anyway.

**Type an account email and password on the desktop.** There are no passwords
([ADR-0001](0001-account-authentication.md)).

**Magic link on the desktop.** Rejected. It works, but it makes desktop sign-in
depend on email delivery — the least reliable dependency available — for a
device that is sitting next to an already-authenticated phone.

## Consequences

- **A phone must be enrolled before a desktop can be.** This is a real ordering
  constraint on onboarding and must be stated in the UI rather than discovered.
- **No desktop OAuth client, no client secret, no redirect URI, no browser.**
  The desktop's entire auth surface is its keypair.
- **An intercepted code is useless for stealing a machine.** The code is bound
  to the desktop's public key at mint time, so approving it can only enroll that
  exact key. An attacker cannot substitute their own laptop.
- **The residual risk is device-code phishing**: a user tricked into scanning a
  code displayed by someone else's screen would add that stranger's computer to
  their own account, which is full remote-control access. Mitigations: the phone
  shows the device name and requires explicit approval, the window is two
  minutes, and the desktop's own trusted-devices list shows what was added. This
  is the same class of attack as every device-code flow and is **not fully
  eliminated** — it is a known, accepted residual risk that belongs in the
  refreshed threat model (M12).
- **This is also the mechanism M9 needs.** [ADR-0003](0003-same-account-device-visibility.md)
  repurposes QR to desktop sign-in; that is exactly this flow, so M9 inherits it
  rather than building its own.
- The desktop still needs an account to exist. A user with no phone cannot
  currently create one — acceptable for a phone-first product, and the web
  dashboard (M14) removes the constraint.

## Status

Accepted (2026-08-12). Backend and both client libraries implemented in M8; the
desktop QR screen and the phone's approval screen are UI work that has not
shipped yet.
