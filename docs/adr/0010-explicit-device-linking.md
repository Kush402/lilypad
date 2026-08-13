---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-13
summary: Why an account never discovers devices, and an explicit linking ceremony establishes ownership.
---

# ADR-0010 — Explicit device linking establishes ownership

**Supersedes [ADR-0003](0003-same-account-device-visibility.md).**

## Context

[ADR-0003](0003-same-account-device-visibility.md) decided the opposite of this:
_"For devices owned by the same account, there is no pairing ceremony. The phone
lists the account's laptops and connects."_ It was accepted on 2026-08-12 and
assigned to milestone M9.

It was never implemented. A repo-wide search for the concept finds it only in
`docs/` — no route, no query, no client code. So this reverses a decision, not
working software.

Three facts drove the reversal:

- **Account compromise would become total compromise.** With same-account
  discovery, a phished magic link or a stolen OAuth session hands the attacker
  every computer the victim owns, instantly and silently. Linking requires
  possession of a screen displaying a short-lived code, which is a genuine
  second factor on the single highest-privilege action in the product.
- **Shared and work machines.** A laptop that someone signs into once must not
  silently join that person's personal account.
- **The ceremony is already the shipped behaviour.** M5.4 trusted devices, the
  QR flow, and `README.md`'s promise — _"pair once with a QR, reconnect forever
  without one"_ — all describe explicit linking. ADR-0003 was the planned
  deviation away from what works.

## Decision

**An account is customer identity. It never, on its own, reveals or authorizes
a computer. An explicit linking ceremony establishes the
account ↔ computer relationship, and only then does the computer exist for that
customer.**

1. **Three device states**, derived from facts that already exist rather than
   stored as a fourth source of truth (`auth/deviceState.ts`):
   - `unlinked` — no account owns it. Holding a keypair is **not** linkage: a
     desktop generates one on first run, long before anyone approves it.
   - `linked` — an account owns it **and** it can prove its identity
     (`user_id` and `public_key` both present).
   - `revoked` — ownership withdrawn. Outranks both of the above.
2. **Signing in never changes state.** A desktop that has signed in is
   `unlinked` until a phone approves it, and both clients must render that
   honestly rather than implying availability.
3. **Every resource is owned by exactly one account.** Authorization resolves
   the actor from the token and compares against the resource's owner
   (`auth/ownership.ts`). Never a body value, query string, or path parameter.
4. **An unowned row belongs to nobody**, not to whoever asks first. Enrolling
   claims a pre-accounts row; asking about one never does.

## Alternatives

**Same-account discovery (ADR-0003).** Rejected above. Its own strongest
argument — that two parallel trust systems are a maintenance burden — is real
and stands; this decision accepts that cost deliberately in exchange for the
blast-radius reduction.

**Linking without accounts (status quo before M8).** Rejected: without an owner
there is nothing to authorize against, no revocation story across devices, and
no entitlement subject.

**Trust on first use.** Rejected: the first use is exactly when an attacker
would like to be trusted.

## Consequences

- **Both trust systems persist.** `devices.user_id` carries ownership;
  `trusted_devices` carries reachability. They answer different questions and
  the linking ceremony must establish **both** — see
  [ADR-0008](0008-desktop-enrollment-via-phone.md)'s 2026-08-13 amendment,
  which fixes a defect where it established only the first.
- **A phone is required to link a computer.** Stated as an ordering constraint
  in onboarding rather than discovered.
- **Milestone M9 is rewritten** from "same-account device visibility" to
  ownership and authorization enforcement.
- **Knowing an identifier stops being sufficient**, which is the whole of SEC-3
  and the product requirement that a user can never see, reach, or revoke
  another user's computer.

## Status

Accepted (2026-08-13). Implemented in full: device states
(`auth/deviceState.ts`), the ownership rule (`auth/ownership.ts`), the
authorization decision (`auth/authorize.ts`), every HTTP route, the WebSocket
presence `register` gate, and both clients.

**How the gate is conditional, and why that is not a hole.** Authorization keys
on the RESOURCE, not the route: a device an account owns demands a matching
token; a device NOBODY owns has no account to protect and keeps its
pre-accounts behaviour. The alternative — demanding a token everywhere at
once — would have broken pairing for every existing install, since the sign-in
UI does not exist until M10. Instead both clients send a device token whenever
they can mint one, and the backend requires one whenever the resource is owned,
so the two halves meet per-device with no flag day. When M10 makes enrolment
mandatory, `lane: 'unowned'` becomes unreachable and is deleted.

**Two questions, deliberately not one.** _Acting as_ a device (ringing a
laptop, redeeming a QR, unpairing, claiming a presence room) requires that
device's own token — owning it is not enough, or one compromised device could
impersonate every sibling. _Managing_ a device or pair (listing, Always-allow,
revoking) requires owning it, which is what lets a phone manage its laptop's
pairs in M11.

Denials answer `404`, never `403`: a caller that could tell "not yours" from
"does not exist" could enumerate other accounts' devices.
