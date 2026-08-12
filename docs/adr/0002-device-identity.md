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
`~/Library/Application Support/<bundle id>/device_id`; the phone mints
`mobile-<random>` into its keychain. The backend stores that string as
`devices.fingerprint` and treats it as identity.

> The bundle identifier was `com.lilypad.desktop` when this was written and is
> `com.takedia.lilypad.desktop` from M8 onward — the path is derived from it, so
> renaming the app orphaned the old file. See
> [apps/mobile/docs/RELEASE.md](../../apps/mobile/docs/RELEASE.md) for the full
> rename and what it invalidates.

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

- Private key never leaves the device, stored in the platform's credential
  store: macOS/iOS Keychain (`ThisDeviceOnly`, non-syncing), Android Keystore,
  DPAPI on Windows.

  **Not the Secure Enclave, and this is a correction.** An earlier draft of this
  ADR promised Secure Enclave / TPM storage. That is not achievable for Ed25519:
  Apple's Secure Enclave supports only NIST P-256, Windows' Platform Crypto
  Provider supports only P-256/P-384, and Android Keystore gained Ed25519 only
  in API 33. Hardware-backed Ed25519 is unavailable on three of the four target
  platforms.

  Ed25519 was kept anyway, deliberately. The only attack hardware backing
  prevents is key extraction by code already running as the user on that
  machine — and on the desktop, such code could simply drive the remote-control
  session it already has, so the marginal protection is small. In exchange
  Ed25519 keeps fixed 64-byte signatures, deterministic signing, and no ECDSA
  nonce-reuse failure mode. Moving to P-256 for hardware backing remains
  available later as an additive second algorithm.

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

**Give devices a refresh token too, as account sessions have.** Rejected during
implementation, and this ADR is amended to say so. A device that can sign a
challenge can always mint itself a new access token, so a refresh token would be
a _second_ credential for a job the key already does — and the weaker of the two,
because it is a bearer string that grants device access to anyone who copies it,
whereas the key is non-exportable and hardware-backed. Renewal costs one extra
round trip every ten minutes, which is not a reason to store a copyable secret on
four platforms. `refresh_tokens` therefore belongs to browser sessions and to the
window between sign-in and enrollment.

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
- **Enrollment is where a device gains an owner**, and it is refused if the
  fingerprint already belongs to a different account. A pre-account row is
  claimable by the first account that enrolls it — the documented backfill path,
  and the reason existing trust rows survive the arrival of accounts.
- **A signature is domain-separated** (`lilypad-device-auth:v1:`), because the
  same key will also bind the desktop's LAN TLS certificate
  ([ADR-0006](0006-lan-first-connectivity.md)) and one purpose's signature must
  not be valid for the other.

## Status

Accepted (2026-08-12). Implemented in milestone M8; amended during that
implementation to drop the device-scoped refresh token (see Alternatives).
