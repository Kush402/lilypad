---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-15
summary: Why email + password is now a first-class sign-in method, amending ADR-0001.
---

# ADR-0012 — Email + password sign-in

**Amends [ADR-0001](0001-account-authentication.md).** OAuth and magic link
both remain exactly as specified there; this ADR reverses only its "no
passwords" clause and the accompanying claim that `users.password_hash` stays
unused.

## Context

ADR-0001 rejected passwords on a cost argument that was correct at the time:
password reset, breach liability, credential stuffing, and strength UX are a
large permanent surface, and OAuth plus magic link covered every platform the
product then had a client for.

Two facts have since changed the arithmetic.

**1. There is no way to sign in on a Mac.** [ADR-0008](0008-desktop-enrollment-via-phone.md)
gives the desktop no OAuth client of its own — deliberately, because a desktop
app cannot keep a client secret. Magic link would work in principle, but
`createMailSender()` returns `null` outside development, so the only
desktop-usable method in ADR-0001 answers 503 in production. The practical
result is that the desktop has no account identity at all: `DeviceAuth::enroll`
has existed since M8 with zero callers. A consumer product whose desktop app
cannot tell you who you are signed in as is missing a floor, not a feature.

**2. Sign-in is the first screen of the product.** Both clients are being
reordered so account identity comes before device work. That makes the sign-in
method's reachability a launch dependency rather than a preference: a first
screen that offers only Apple, Google, and an email that never arrives is a
dead end for anyone who wants none of the three.

Passwords are the one mechanism that works on every platform, needs no
third-party availability, needs no client secret, and needs no mail delivery on
the sign-in path.

## Decision

**Add name + email + password as a first-class sign-in method, alongside — not
instead of — Apple, Google, and magic link.**

- `users.password_hash` becomes load-bearing. `users.name` is added, because a
  consumer signup form that asks for a name must have somewhere to put it.
- **scrypt** for hashing, from the Node standard library: `N=32768, r=8, p=1`,
  16-byte random salt, 64-byte output, stored as
  `scrypt$N$r$p$salt$hash` so the parameters travel with the hash and can be
  raised later without invalidating existing rows. Verification is
  `timingSafeEqual`.
- **Password policy follows NIST SP 800-63B**: 12–200 characters, NFKC
  normalised, **no composition rules**. Length is the only requirement that
  survives contact with evidence; forced symbol/digit classes measurably push
  users toward predictable substitutions.
- **Recovery reuses the magic-link primitive** — 24 CSPRNG bytes, `GETDEL` on
  redemption, 15-minute TTL — under a **separate Redis namespace**
  (`lilypad:password-reset:`). A reset token must never be spendable as a
  sign-in token: those are different authorizations, and one key space would
  make them the same one.
- **Sign-in is constant-answer.** An unknown address and a wrong password both
  return `invalid_credentials`, and the unknown-address path still performs a
  verification against a dummy hash so the two cost the same wall-clock time.
- **Signup is not constant-answer**: an address that already has an account
  gets `409 email_in_use`. This is a deliberate, bounded enumeration oracle —
  see Consequences.
- **A password never links a computer.** `/devices/enroll` now refuses
  `kind: 'desktop'` outright, so the only route from an account to an owned
  desktop remains the enrollment code a phone approves
  ([ADR-0010](0010-explicit-device-linking.md)). This guard is what makes
  desktop sign-in safe to add at all.

## Alternatives

**argon2id.** The stronger primitive, and the one to move to if password
hashing ever becomes the bottleneck. Rejected for now because every Node
implementation is a native module — a compiled dependency in the deploy path,
for a difference that does not change any attack this product plausibly faces.
The stored-parameter encoding above means switching later is a migration, not a
rewrite.

**bcrypt.** Also native, and silently truncates at 72 bytes, which turns the
200-character maximum into a lie.

**Magic link as the desktop's only method.** This is what ADR-0001 implies, and
it does not work: no production mail sender exists (M13 still owes one), so it
answers 503. Shipping a sign-in screen whose only usable button is broken in
production is worse than shipping no screen.

**Passkeys.** Still the right long-term answer, still blocked on the
cross-ecosystem recovery story ADR-0001 describes. Unchanged by this ADR, and
still additive when it lands.

## Consequences

- **The support burden ADR-0001 avoided is now taken on**, knowingly: reset
  flows, credential-stuffing exposure, and breach liability for a hash we now
  store. Rate limiting on the sign-in route is the mitigation that must not be
  weakened.
- **Recovery is implemented but not deliverable until M13.** The reset routes
  and their tests are real; the email that carries the token is not, because no
  production sender exists. Until one does, password reset works in development
  and answers `503 magic_link_unavailable` in production — the same honest
  failure magic link already gives.
- **Signup leaks whether an address has an account.** The alternative — answer
  identically and send a "you already have an account" email — needs the mail
  sender that does not exist. Revisit with M13, at which point the honest
  answer becomes available. Sign-in, the route an attacker would actually
  automate, does not leak.
- **A user may end up with several ways into one account** (Apple, Google,
  password, magic link, all on one verified address). That was already true of
  the first three; ADR-0001's rule stands unchanged — an unknown identity may
  only attach to an existing account when the provider says the email is
  verified.
- **Setting a password on an OAuth-created account is not offered here.** It is
  a real gap and a small one, but it is account _management_, not sign-in, and
  nothing in the current clients has a place to put it.

## Status

Accepted (2026-08-15).

## References

- [ADR-0001 — Account authentication](0001-account-authentication.md) (amended by this)
- [ADR-0008 — Desktop enrollment via phone](0008-desktop-enrollment-via-phone.md)
- [ADR-0010 — Explicit device linking](0010-explicit-device-linking.md)
- NIST SP 800-63B, §5.1.1.2 (memorized secret verifiers)
