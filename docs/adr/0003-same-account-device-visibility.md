---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: Why QR pairing is replaced by same-account visibility and repurposed to sign-in and sharing.
---

# ADR-0003 — Same-account device visibility replaces QR pairing

## Context

Lilypad's pairing model was designed before accounts existed. Because there was
no notion of an owner, the only way to establish that a phone was allowed to
control a laptop was a physical-presence ceremony: the laptop shows a QR, the
phone scans it, the human approves on the laptop. M5.4 then added persistence on
top — a `trusted_devices` row plus a per-pair connect secret — so the ceremony
only had to happen once.

That machinery is well-built and it works. But it exists **to answer a question
that accounts answer directly**: "is this phone allowed to control this laptop?"

Once [ADR-0001](0001-account-authentication.md) and
[ADR-0002](0002-device-identity.md) land, both devices are cryptographically
bound to a user account. Keeping QR pairing as the primary path would leave two
independent trust systems — account ownership and pair secrets — that must agree
with each other forever, and would have to be kept in sync by every future
feature.

## Decision

**For devices owned by the same account, there is no pairing ceremony. The phone
lists the account's laptops and connects. QR is repurposed to the two jobs it is
genuinely good at.**

1. **Same-account access** — authorization is "same owner", proven by two
   signed-in, key-authenticated devices. No QR, no `trusted_devices` row, no
   per-pair connect secret.
2. **QR as desktop sign-in** — a signed-out desktop shows a QR; the signed-in
   phone scans it and authorizes that desktop onto the account. This is the
   WhatsApp Web / Steam model and it removes password-typing on a desktop
   entirely, which pairs well with having no passwords at all.
3. **QR as cross-account sharing** — letting _someone else_ control your laptop
   is a genuinely different feature with a different threat model. It keeps the
   pair-grant machinery, which is what that machinery was always actually good at.

`trusted_devices` becomes a **grant** table describing cross-account access,
rather than the primary trust path.

## Alternatives

**Keep QR pairing for same-account devices, layered under accounts.** Rejected —
this was the original brief. It preserves two parallel trust systems, keeps the
per-pair connect secret on the hot path, and means every authorization question
has two possible answers that must be reconciled. It also keeps the legacy
null-secret pair backdoor alive longer than necessary.

**Delete the trusted-devices system entirely.** Rejected. Cross-account sharing
is a real feature, and the existing revoke/forget semantics — including
force-ending live sessions with distinct reasons for each side — are correct and
hard-won. Repurposing is cheaper and better than rebuilding.

**Auto-connect any same-account device with no approval at all.** Rejected as a
default. "No silent remote access" is a stated non-negotiable, and a laptop that
can be viewed without any signal to the person sitting at it breaks it. Same-
account connections still surface a visible session indicator, and the per-device
"require approval" setting remains available.

## Consequences

- **Code is deleted, not added.** The per-pair connect secret leaves the common
  path, and with it a class of self-asserted-id logic.
- Onboarding changes shape: sign in on both devices, and the laptop simply
  appears. This is the consumer experience the product is aiming for and it
  removes the single most confusing step in the current flow.
- Existing pairs need migration. `devices.user_id` and `trusted_devices.user_id`
  are already nullable and were explicitly designed for a backfill `UPDATE`, so
  rows adopt the first account that claims their fingerprint during a grace
  window; unclaimed rows are then purged.
- Users who currently share a laptop across two "identities" by pairing twice
  will need a real shared-access grant. This is a better model, but it is a
  behaviour change.
- The QR scanner, payload schema, and camera permission all stay — they are
  reused by both new jobs.

## Status

Accepted (2026-08-12). Implemented in milestone M9.
