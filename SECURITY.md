# Security Policy

## Reporting a vulnerability

Email **kush.sharma@lofty.com** with a description, reproduction steps, and
impact assessment. You will get an acknowledgment within 72 hours. Please do
not open public issues for security reports.

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

- No user accounts yet (M5): possession of a QR + desktop approval is the
  whole trust model. Suitable for personal/single-operator use only.
- Desktop/mobile builds are not yet notarized/App Store distributed.
