# Security Policy

## Reporting a vulnerability

Email **support@takedia.com** with a description, reproduction steps, and
impact assessment. You will get an acknowledgment within 72 hours. Please do
not open public issues for security reports.

This is the same address the [privacy policy](https://lilypadhome.takedia.com/privacy)
and [terms](https://lilypadhome.takedia.com/terms) publish, and those already
name security reports as one of the things it is for. Two different addresses
for the same promise is one address too many.

## Scope & model (summary)

Lilypad's full threat model lives in [docs/threat-model.md](docs/threat-model.md).
The load-bearing guarantees:

- **No silent access.** A session cannot start without a human clicking
  Approve on the desktop; a visible indicator runs for the session's
  lifetime; the tray has a panic disconnect.
- **Pairing tokens** are single-use, 60-second, Redis-backed, and burned on
  redeem. Minting is rate-limited per IP.
- **Transport** is DTLS-SRTP (WebRTC) for media/input and WSS for signaling
  in production; production boots refuse plaintext `http`/`ws` public URLs.
- **TURN credentials** are minted per session/role with short TTLs from a
  server-side shared secret that never reaches clients.
- **Input scope** (`view` vs `control`) is enforced at the desktop's
  injection boundary — not just in the phone UI — and every rejected event
  is accounted for in metrics.
- **Signaling abuse controls**: per-IP connection caps, per-socket rate
  limiting, heartbeat reaping, same-host-origin enforcement, length-bounded
  message schemas.
- `/metrics` is bearer-token gated; the token is mandatory in production.

## Known gaps (pre-1.x, tracked)

_Last checked against the code and against
[docs/apple-setup.md](docs/apple-setup.md) on 2026-08-31._

- **iOS has no public App Store listing.** It ships through TestFlight to an
  invited internal group only ([docs/apple-setup.md](docs/apple-setup.md)) —
  there is no public link and no store page a stranger could find or install
  from.
- **One person, one server.** No dedicated security team, no third-party audit,
  and the control plane is a single machine. Stated the same way on the
  [privacy policy](https://lilypadhome.takedia.com/privacy).
- **Rate limits are per-IP.** Everyone behind one NAT — a dorm, an office —
  shares a budget. Deliberate: loosening an abuse control ahead of evidence is
  how a safeguard becomes a hole ([docs/kanban.md](docs/kanban.md), L-31).

Accounts are no longer a gap, and this section listed them as one until
2026-08-23 — describing possession of a QR plus desktop approval as the whole
trust model. That had not been true for some time: accounts, Ed25519 device
identity and explicit device linking all shipped, and the unowned-device lane,
where a device belonging to nobody could still act, was closed. A security
policy that understates what exists hands a researcher the wrong scope.

Build distribution is also no longer what this section claimed until
2026-08-31: it said builds were "not notarized or store-distributed," the
macOS bundle ad-hoc signed with a Gatekeeper warning on every launch, and iOS
shipping no store build at all. Since 2026-08-24 the macOS build is signed
with a Developer ID Application certificate, notarized, and stapled
(`release.yml`) — Gatekeeper accepts it with no warning — and the same day an
iOS build reached TestFlight. What has **not** changed is that TestFlight is
invitation-only, not the public App Store; that is why iOS stays listed above
as a real, narrower gap rather than dropping off the way accounts did.
