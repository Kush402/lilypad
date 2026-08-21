---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-21
summary: A device has two identifiers that are never interchangeable, and account, device, pairing and connection each have their own lifecycle.
---

# ADR-0014 — Two device identifiers, four lifecycles

## Context

On 2026-08-21 a customer installed 0.1.3 from the website, signed in, linked
their iPhone, and could not connect. The phone said _"This laptop hasn't
trusted this phone yet. Scan its QR code once to pair."_ The database said
otherwise: both devices `linked`, neither revoked, one pairing with a valid
connect secret and no `revoked_at`. The phone then Forgot the laptop; the
backend answered `200 ok` and severed nothing.

One line caused both. `POST /devices/enrollment-code/approve` returned the
laptop's `devices.id` — an internal Postgres uuid — and the phone stored it as
the laptop's wire id. `/connect/request` and `/devices/unpair` both resolve
`devices.fingerprint`, so both looked up a device that could not exist, and
both failed in the way they fail for a stranger: `404 not_trusted`, and a
silent no-op.

Nothing caught it. Both values are strings of similar length, both fields are
called some variation of "device id", `z.string().min(8)` accepts either, and
no test crossed the seam between the route that mints a pairing and the routes
that spend it.

The product model was never wrong. Account, authentication, session, device,
pairing and connection were already six distinct concepts with distinct
storage, and multi-laptop / multi-phone already worked. The defect was one
level down, in which of a device's two names crossed the wire.

## Decision

### A device has two identifiers, and they are never interchangeable

| Name                  | Shape                    | Who resolves it                                                                                                                                        |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devices.fingerprint` | `desktop-…` / `mobile-…` | **The wire id.** Every pair-scoped route: `/connect/request`, `/devices/unpair`, `/devices/pairs`, `/pairing/*`, signaling `register`, presence rooms. |
| `devices.id`          | uuid                     | Internal primary key. Account-scoped routes only: `PATCH`/`DELETE /devices/:deviceId`, and the `trusted_devices` columns.                              |

`WireDeviceIdSchema` (`packages/protocol/src/identity.ts`) is the single
definition of the first, and it requires the kind prefix. Both clients have
always minted one, so the two namespaces are distinguishable by shape — which
is what makes a mix-up a `400` naming the mistake instead of a `404` blaming
the user's pairing.

A response that carries both carries them under names that say which is which:
`deviceId` is the uuid, `desktopDeviceId` is the wire id — the same name and
the same meaning `/pairing/redeem` has always used.

### Four lifecycles, and no transition implies another

```
ACCOUNT      created ──> active ──> deleted
                          │
                          └─ deleting cascades: devices ─> pairings

DEVICE       (no row) ──> unlinked ──> linked ──> revoked
                            │            │           │
                            │            │           └─ re-enrolling clears revocation
                            │            └─ owner set by a PHONE approving, never by signing in
                            └─ key generated on first run; a key is not ownership

PAIRING      (none) ──> active ──> revoked
                          │           │
                          │           └─ Revoke (desktop) / Forget (phone); row kept as audit trail
                          └─ re-running the ceremony un-revokes and re-issues the secret

CONNECTION   idle ──> connecting ──> active ──> disconnected
                                        │
                                        └─ ends on network loss, sleep, revoke, unpair, quit
```

The rules that fall out, each of which was a live question:

- **A WebRTC disconnect is not a forgotten device.** Connection is the only one
  of the four that is not persisted in Postgres.
- **A failed reconnect is not a revocation.** `/connect/request` distinguishes
  `not_trusted` (404), `revoked` (403) and `desktop_offline` (503), and the
  phone renders three different sentences.
- **Signing out is not unlinking.** `Account::sign_out` deletes a keychain
  label holding an email and a user id. The device key, the device row and
  every pairing are untouched, so signing back in finds the same machine.
- **Revoking a device is not deleting an account**, and **revoking a pairing is
  not revoking a device.** Device revocation withdraws ownership and ends every
  pairing at once; pair revocation severs one relationship.
- **Reinstalling is not a new device.** Identity lives outside the app bundle —
  the Ed25519 key in the login keychain (`com.takedia.lilypad.desktop.device-key`)
  and the wire id in `~/Library/Application Support/com.takedia.lilypad.desktop/device_id`.
  Deleting `Lilypad.app` and reinstalling keeps both, so the backend sees the
  same laptop and every pairing survives. Deleting Application Support mints a
  new identity: a new device row, and the old one stays on the account until
  revoked. That is the correct trade — an uninstall that silently kept nothing
  would force a re-link on every update, and one that silently kept everything
  would make "remove this computer" unenforceable.

### Multiple laptops and multiple phones

`trusted_devices` is UNIQUE on `(desktop_device_id, mobile_device_id)` — the
relationship needs both endpoints and is stored as both. One account may own
any number of laptops and phones, and any laptop may be paired with any number
of that account's phones without disturbing another pair. Nothing keyed on
`user_id` alone, or on either device alone, decides reachability.

`trusted_devices.user_id` exists, is always NULL, and is read by nothing.
Ownership is reached through `devices.user_id` on both endpoints. It is kept
rather than dropped only as the natural home for ownership if a pairing ever
has to outlive a device row.

## Alternatives

**Accept the uuid on the connect path.** Rejected: it would mean two accepted
namespaces on every pair-scoped route forever, and the next mix-up would be
undetectable rather than merely undetected.

**Rename `deviceId` to `deviceUuid` everywhere.** Rejected as the primary fix:
it is a large rename across three clients for a property that shape validation
enforces directly, and a renamed field is still just a convention.

**A stored `device_state` column.** Rejected — `deviceState()` derives the
state from facts that already exist, and a fourth source of truth is one that
can disagree with the other three.

## Consequences

- Sending a uuid where a wire id belongs is a `400 invalid_request` naming the
  field, not a `404` that reads as an accusation about the user's pairing.
- A phone on an older backend that omits `desktopDeviceId` links the laptop and
  does not remember it, rather than remembering a key that rings nothing.
- `authorization.test.ts` fixtures had to become well-formed wire ids. A
  malformed id now fails validation before the ownership check, which is not an
  enumeration leak: the shape is public and says nothing about existence.

## Status

Accepted (2026-08-21).
