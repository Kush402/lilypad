---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: Why devices authenticate with an Ed25519 keypair instead of a self-asserted id.
---

# ADR-0002 — Device identity: Ed25519 keypair with challenge-response

## Context

Every device in Lilypad today identifies itself with a **string it chose for
itself**. The desktop writes `desktop-<uuid>` to
`~/Library/Application Support/com.lilypad.desktop/device_id`; the phone mints
`mobile-<random>` into its keychain. The backend stores that string as
`devices.fingerprint` and treats it as identity.

The consequences are not theoretical:

- `GET /devices/pairs?desktopDeviceId=…` returns a laptop's trusted pairs to
  anyone who supplies the id.
- The signaling register gate authorizes a presence-room claim purely by
  comparing the self-asserted id to the room suffix — and a claim by the _same_
  id evicts the incumbent socket, so knowing a laptop's id lets an attacker knock
  it offline and receive its connect requests.
- The per-pair connect secret partially compensates, but only for
  `POST /connect/request`, and pairs created before secrets existed authorize
  with no secret at all.

The `devices.public_key` column was added in migration `0001_new_umar.sql` in
anticipation of this change and has never been populated.

## Decision

**Every device generates an Ed25519 keypair on first run and proves possession of
the private key via challenge-response. The backend issues a short-lived device
access token; the self-asserted `deviceId` leaves the trust path entirely.**

- Private key never leaves the device: Keychain/Secure Enclave on Apple
  platforms, Android Keystore, DPAPI+TPM on Windows.
- The public key is registered during an **authenticated enrollment** — the user
  is already signed in ([ADR-0001](0001-account-authentication.md)), so a device
  is bound to an account at the moment it is created.
- Every REST call and every WebSocket `register` carries the device access token.
  Authorization reads the **token subject**, never a value from the request body.

## Alternatives

**Keep self-asserted ids, add secrets everywhere.** Rejected. This is the current
trajectory and it does not converge: each new endpoint needs its own bearer
secret, each secret needs its own distribution, rotation, and revocation story,
and every one of them is a new way to leak access. The per-pair connect secret
already demonstrates the pattern's cost.

**Bind devices to the account session token only (no device key).** Rejected. A
stolen account token would then grant full control of every device on the
account, and there would be no way to revoke a single lost laptop without
invalidating the user's whole session. A per-device key makes per-device
revocation a one-row change.

**mTLS.** Rejected. Equivalent security, far worse ergonomics — certificate
provisioning and renewal on four client platforms plus a load balancer that must
be configured to pass client certs through, for no gain over signed challenges.

## Consequences

- Knowing any device id, pair id, room id, or session id becomes worthless. This
  is the property that makes the multi-user isolation test suite (milestone M12)
  meaningful rather than aspirational.
- `devices.public_key` finally gets populated; `fingerprint` keeps its existing
  self-asserted meaning for historical rows rather than being reinterpreted.
- Enrollment requires the user to be signed in, so device setup now depends on
  account sign-in — a real UX ordering constraint for onboarding.
- Losing a device's private key (disk wipe, reinstall without backup) means
  re-enrolling that device. Acceptable, and the same as every comparable product.
- Token verification is signature-based, so device auth keeps working during a
  Postgres outage.

## Status

Accepted (2026-08-12). Implemented in milestone M8.
