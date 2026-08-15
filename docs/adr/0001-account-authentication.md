---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: Why account auth is OAuth + magic link rather than passwords or passkeys.
---

# ADR-0001 — Account authentication: OAuth + magic link, no passwords

## Context

Lilypad has no accounts. The `users` table has existed since M1 with a
`password_hash` column, and nothing has ever read or written it. Every resource
in the system is therefore unowned, which is the root cause of most of the
security gaps in [`../PROJECT-INDEX.md`](../PROJECT-INDEX.md): with no owner,
there is nothing for an authorization check to compare against.

Turning Lilypad into a consumer product where many users control their own
laptops requires accounts first. Everything else — authorization, multi-user
isolation, billing, device management — depends on this choice.

Constraints:

- The product spans macOS, iOS, Android, Windows, and a web dashboard. Whatever
  is chosen must work on all five without a separate implementation per platform.
- Apple requires **Sign in with Apple** to be offered on iOS if any other
  third-party sign-in is offered.
- The team is very small. Every auth mechanism shipped is one that must be
  maintained, monitored, and incident-responded forever.

## Decision

**OAuth with Apple and Google, plus email magic link as the fallback. No
passwords.**

- `users.password_hash` stays in the schema, nullable, and unused.
- Sessions are short-lived JWT access tokens with rotating opaque refresh tokens.
- Account identity is separate from device identity — see
  [ADR-0002](0002-device-identity.md).

## Alternatives

**Email + password.** Rejected. It drags in password reset, breach liability,
credential-stuffing defence, and password-strength UX — a large permanent
surface — and delivers the worst mobile sign-in experience of the options. The
`password_hash` column's existence is not a reason to use it.

**Passkeys / WebAuthn as the primary factor.** Rejected _for V1_, not on merit.
Passkeys are the right long-term answer and should be added after GA as an
upgrade. The blocker today is recovery: a user who signs in on a Mac, an iPhone,
an Android phone, and the web needs a recovery story that does not end in "you
have lost your account", and cross-ecosystem passkey sync in 2026 still has
enough sharp edges that it should not be the only door.

**Magic link only (no OAuth).** Rejected. Simplest to build, but sign-in latency
depends on email delivery, which is the least reliable dependency available and
one we would not control. Kept as the fallback for users who want neither Apple
nor Google.

## Consequences

- Sign in with Apple is not optional; it must ship with the iOS app.
- We depend on two identity providers for the primary path. The magic-link
  fallback exists specifically so an Apple or Google outage is degraded service,
  not a total sign-in outage.
- No password means no password-reset support burden — a real ongoing saving.
- Access tokens verify **by signature**, not by a database lookup. This is
  deliberate: it means an unavailable Postgres blocks new sign-ins but does not
  break sessions or reconnects that are already running.
- Adding passkeys later is additive and does not invalidate this ADR.

## Status

Accepted (2026-08-12). Implemented in milestone M8.

**Amended by [ADR-0012](0012-password-authentication.md) (2026-08-15):** email +
password is now a first-class method alongside OAuth and magic link, and
`users.password_hash` is load-bearing. Everything else here still holds — the
"Email + password" alternative below records the cost that decision knowingly
takes on, and ADR-0012's Context records what changed to make it worth taking.
