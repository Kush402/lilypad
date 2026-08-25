---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-25
summary: Signing in on a device is what puts it on the account, on every platform; pairing is a separate relationship between two devices that already belong to one.
---

# ADR-0015 — Ownership follows sign-in

**Reverses the central rule of [ADR-0010](0010-explicit-device-linking.md).**
Everything else ADR-0010 established — one owner per device, ownership-gated
routes, no unowned lane in `actAsDevice`, revocation as a first-class act —
stands unchanged. This ADR changes only _when_ a machine gains its owner.

## Context

Under ADR-0010 a phone joined an account the moment someone signed in on it
(`POST /devices/enroll`, `kind: "mobile"`), and a Mac could not: the same route
answered `403 desktop_enrollment_requires_approval` to `kind: "desktop"`.
A computer became owned only when a signed-in phone scanned an enrollment code
displayed on its screen. The stated reason was that linking should cost a
physical-possession second factor.

The customer-visible consequence, reported on 2026-08-25 after a clean
first-run test:

> I created an account on my laptop. Then I opened the phone app and logged into
> the same account BEFORE pairing. The phone app showed only the phone as a
> device under the account.

That report is accurate and the product was behaving as designed. The design
was wrong, for two independent reasons.

### The refusal protected nothing

The capability withheld from a desktop was a **device access token** — the
credential `requireDevice` routes accept. A device token unlocks `GET /devices`,
device rename, device revocation, and `POST /devices/enrollment-code/approve`.

The same account password already minted one, through the same route, with
`kind: "mobile"`: install the iOS app, sign in, self-enrol. Nothing about that
path was privileged. So an attacker holding a stolen password had every
`requireDevice` capability regardless of the desktop guard; the guard
constrained _one client_, never the capability it was named after.

### It made "ownership" mean two different things

A phone was owned at sign-in. A Mac was owned at pairing. A customer who signed
in on both — the exact thing the product asks them to do — saw a device list
that omitted half of what they had signed in on, with nothing on any screen
explaining why. Two platforms, two definitions of the same word, is not a
security property.

### It cost a duplicate ceremony

Because adoption and pairing were both QR ceremonies with separate codes, the
desktop's setup wizard had four steps and asked the customer to pick up their
phone twice: once to scan the _enrollment_ code (step 3) and again to scan the
_pairing_ code (step 4). Step 3's approve handler already wrote the
`trusted_devices` row and returned the connect secret, so for the phone that
performed it, step 4 changed nothing.

## Decision

**Signing in on a device is what puts that device on the account** — the same
rule on macOS, iOS, and anything added later. `/devices/enroll` treats every
`kind` identically: an account token plus a proof of key possession enrols the
key that was proved.

**Pairing is a separate relationship between two devices that already belong to
one account.** It is created by the QR ceremony, it writes `trusted_devices`
with a per-pair connect secret, and it is the only thing `/connect/request`
consults.

**A pair joins two devices on the same account.** `/pairing/redeem` refuses when
both sides are owned by different accounts (`403 different_account`). Previously
unreachable from this ceremony — a Mac had no owner until a phone gave it one —
and reachable now that both machines join their own accounts independently.

The vocabulary collapses accordingly: a Mac is **on your account** (automatic,
at sign-in) and **paired** with phones (deliberate, once, per phone). The word
"linked" is retired from every customer-facing surface.

## Consequences

**The physical-possession factor is unchanged, because it never lived where
ADR-0010 said it did.** Ownership buys no reach. `/connect/request` authorizes
on a `trusted_devices` row plus a per-pair secret and does not read
`devices.user_id`; the QR pairing ceremony is what creates that row, and it
requires standing in front of the screen. A stolen password still cannot see a
screen.

**What a stolen password now additionally reaches: nothing.** It could already
mint a device token through the mobile path. The change removes an asymmetry,
not a control.

**Account switching on a shared Mac is now reachable and is refused.** One
device has one owner (`devices.user_id` is a single column), so the second
account to sign in on a machine gets `409` and a message naming the remedy:
remove it from the first account's "Your devices", then sign in again.

**The enrollment-code ceremony survives as the recovery path**, not the front
door. It is what adopts a Mac whose sign-in enrollment failed, and what restores
one that was revoked. `AccountPanel` offers it only in those states.

**Setup drops from four steps to three**: your account → permissions → pair your
phone. The phone is picked up once.

## Verification

- `apps/backend/src/routes/enrollmentGuard.test.ts` — desktop and mobile enrol
  identically, and a desktop that cannot prove key possession is still refused.
- `apps/backend/src/routes/pairSameAccount.test.ts` — cross-account pairing is
  refused; same-account is not.
- `apps/desktop/src-tauri/src/commands.rs` — sign-in enrols, and reports the
  failure rather than silently leaving the Mac ownerless.
