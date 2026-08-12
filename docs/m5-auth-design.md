---
status: Planned
owner: @kushsharma024
last-verified: 2026-08-12
summary: Forward spec for accounts + Ed25519 device identity. Not built.
---

# Lilypad — M5 Auth & Device-Trust Design

**Status (checked 2026-08-12):** still design-only — **accounts and Ed25519
device keys are not implemented.** Partially superseded in _scope_ by M5.4,
which shipped the trusted-devices layer described in
[`m5.4-trusted-devices-audit.md`](./m5.4-trusted-devices-audit.md) using
**self-asserted `deviceId` strings** plus a per-pair connect secret. This
document remains the forward spec for the cryptographic upgrade that replaces
those self-asserted strings (the `devices.publicKey` column in
[`schema.ts`](../apps/backend/src/db/schema.ts) is already reserved for it),
plus email/password accounts. It is
the forward spec Phase 2 of [`docs/audit/m3/ROADMAP.md`](audit/m3/ROADMAP.md)
(item 14) calls for, so that Phase 2's own seat-binding fix (item 8, the
`RoomAuthStore` design in
[`docs/audit/m3/backend-security.md`](audit/m3/backend-security.md) Finding 1)
is forward-compatible with this system instead of needing to be redesigned
when M5 actually lands. The full analysis this doc formalizes lives in that
audit's Finding 15; this is the standalone, implementation-ready version of
it, meant to be the thing an engineer actually opens when M5 starts.

## Why this exists before M5's implementation does

Every identity in Lilypad today — `deviceId` in pairing and signaling
messages ([`packages/protocol/src/pairing.ts`](../packages/protocol/src/pairing.ts),
[`packages/protocol/src/signaling.ts`](../packages/protocol/src/signaling.ts))
— is a bare, self-asserted, unauthenticated string. `users`, `devices`, and
`trusted_devices` already exist in the schema
([`apps/backend/src/db/schema.ts`](../apps/backend/src/db/schema.ts))
but are unused by any route; `devices.fingerprint` is documented in its own
comment as "Stable client-generated id (dev mode) / device fingerprint" —
explicitly acknowledged as a placeholder.

This is the root enabler behind two Phase 2 findings:

- **Seat hijack** (backend-security.md Finding 1): the Phase 2 fix (a
  Redis-backed `RoomAuthStore` binding a room to the pairing flow's
  `desktopDeviceId`/`mobileDeviceId`) closes the _acute_ race — a second
  device can no longer register into a room mid-pairing just by knowing its
  `roomId` — but it can only verify "the same string the pairing flow saw,"
  not "the same physical device the user paired with previously." An
  attacker who learns a valid `deviceId` string (e.g. via a plaintext leak,
  or by observing traffic) can still impersonate that device, because the
  string alone is the entire credential.
- **Audit/accountability**: sessions and audit-log rows can be tied to a
  device string today, but not to a person, and there is no way to
  distinguish "the same device reconnecting" from "someone who copied that
  device's id."

A production remote-desktop product competing with Parsec/AnyDesk needs
persistent, revocable device trust (pair once, reconnect without re-scanning
a QR every time) and user accounts to tie sessions and audit logs to a
person, not just a device string. That's what this document specs.

## Design summary

Two independent upgrades, designed to compose:

1. **User accounts + session tokens** (standard JWT access/refresh) — who is
   using the product.
2. **Cryptographic device trust** (Ed25519 keypairs, challenge-response) —
   which physical device is connecting, replacing the bare `deviceId` string
   as the unit of trust.

Both plug into the **existing** signaling/pairing call sites without
requiring those call sites to be redesigned again — see
["Interaction with the seat-hijack fix"](#interaction-with-the-seat-hijack-fix-phase-2-item-8)
below for exactly why.

### User accounts & session tokens

- **Password storage**: `users.passwordHash` uses **Argon2id**, not bcrypt,
  with a per-install pepper stored outside the DB (env-configured, following
  the `TURN_SECRET`-style pattern already established in
  [`packages/shared/src/env.ts`](../packages/shared/src/env.ts), with the
  same production fail-fast treatment this repo already applies to other
  secrets — see that file's `productionSafetyProblems`).
- **Access tokens**: short-lived (10–15 min) JWTs, signed with an asymmetric
  key (**Ed25519/EdDSA**, not HMAC) — lets the signaling hub, and any future
  horizontally-scaled service, _verify_ tokens without holding the _signing_
  secret, which only the auth-issuing service needs. Claims:

  ```jsonc
  {
    "sub": "<user.id>", // uuid
    "deviceId": "<devices.id>", // the VERIFIED, DB-backed device row id — not the client-asserted string
    "tokenVersion": 3, // must match users.tokenVersion at verify time
    "iat": 1731000000,
    "exp": 1731000900, // 15 min
  }
  ```

- **Refresh tokens**: opaque, high-entropy (`randomBytes(24)`, matching the
  existing pattern in
  [`apps/backend/src/services/pairing.ts`](../apps/backend/src/services/pairing.ts)),
  stored **hashed** (SHA-256 — sufficient for a high-entropy random token,
  unlike a password) in Postgres with `deviceId`, `expiresAt`, `revokedAt`,
  and a `familyId` for **rotation with reuse detection**: each refresh
  exchanges the old token for a new one and immediately invalidates the old
  value. If a _revoked_ refresh token is ever presented again — a device
  double-using a stale token, or a stolen-and-already-used token being
  replayed by an attacker — the entire `familyId` is revoked immediately.
  This is the standard pattern (Auth0, Google's OAuth refresh flow use it)
  that turns "a refresh token was stolen at some point" into a detectable,
  containable event rather than a silent, permanent compromise.

### Device trust (cryptographic, not string-based)

This is the mechanism `trusted_devices`
([`schema.ts:42-54`](../apps/backend/src/db/schema.ts)) was scaffolded for.

- On first install, each device (desktop and mobile) generates an **Ed25519
  keypair locally**; the private key never leaves the device (OS
  keychain/Secure Enclave on macOS, Android Keystore, platform-equivalent on
  Windows).
- `devices.fingerprint` becomes the device's **public key** (base64), not a
  client-chosen opaque string. (Migration: add `publicKey` as a new column
  rather than repurposing `fingerprint` in place, so any dev-mode data
  doesn't need a lossy in-place reinterpretation.)
- **Device registration** is a signed challenge-response: the server issues
  a random nonce, the device signs it with its private key, the server
  verifies the signature against the claimed public key before creating the
  `devices` row. This is what makes `deviceId` in the signaling `register`/
  `pair-request` messages _provable_ rather than merely _asserted_.
- `trusted_devices` rows are created only after an explicit user approval of
  a _new_ device pairing — reusing the existing Approve/Deny UX
  ([`apps/desktop/src-tauri/src/commands.rs`](../apps/desktop/src-tauri/src/commands.rs)).
  Once trusted, subsequent connections from that device's verified key
  _could_ skip the QR/pairing-token bootstrap entirely — a legitimate UX
  improvement this schema was clearly designed to enable. Whether/when to
  actually build that "skip re-pairing" flow is a **product decision**
  outside this design's scope; this document only specs the identity
  primitive that would make it safe to build.

### Revocation

- **Per-user**: a new `tokenVersion` counter column on `users`, bumped on
  "log out everywhere" / password change / suspected compromise. Every JWT
  embeds the `tokenVersion` it was issued under; verification checks it
  against the current DB value. This is the standard way to get real-time
  revocation out of otherwise-stateless JWTs without a distributed
  blacklist.
- **Per-device**: deleting a `trusted_devices` row (explicit "remove this
  device" action) cascades to revoke any outstanding refresh tokens tied to
  that `deviceId` (via the `familyId`/`deviceId` relationship below), and is
  audit-logged as a `device_revoked` event (the audit-log write path Phase 2
  item 13 implements against today's pre-auth events is the same one this
  plugs into — no new logging mechanism needed, just a new event type).

## Data model additions

Additive only — no existing column is removed or repurposed destructively.

```ts
// New column on users
tokenVersion: integer('token_version').notNull().default(0),

// New column on devices (fingerprint stays as-is for any pre-M5 dev data)
publicKey: text('public_key'), // base64 Ed25519 public key, set once verified

// New table
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(), // sha256(opaque refresh token)
  familyId: uuid('family_id').notNull(), // shared across a token's rotation chain
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('refresh_tokens_family_idx').on(t.familyId),
  index('refresh_tokens_hash_idx').on(t.tokenHash),
]);
```

## API surface

| Route               | Method | Purpose                                                                                              |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `/auth/register`    | POST   | Create a user (email + password, Argon2id hash).                                                     |
| `/auth/login`       | POST   | Verify password, issue access + refresh token pair.                                                  |
| `/auth/refresh`     | POST   | Rotate a refresh token; reuse of a revoked token revokes its whole family.                           |
| `/auth/logout`      | POST   | Revoke the presented refresh token's family.                                                         |
| `/auth/logout-all`  | POST   | Bump `users.tokenVersion` — invalidates every outstanding access token immediately.                  |
| `/devices/register` | POST   | Challenge-response device registration (issue nonce, verify signature, create/update `devices` row). |
| `/devices/:id`      | DELETE | Revoke a trusted device — cascades to that device's refresh tokens; audit-logs `device_revoked`.     |

## Signaling integration

The WS `register` message
([`packages/protocol/src/signaling.ts:52-59`](../packages/protocol/src/signaling.ts))
gains an **optional** `authToken` field (a short-lived access JWT).
`SignalingHub.register()`
([`apps/backend/src/signaling/hub.ts`](../apps/backend/src/signaling/hub.ts))
verifies it (signature + `tokenVersion` + `deviceId` match) before granting a
seat, once a caller chooses to authenticate.

### Interaction with the seat-hijack fix (Phase 2 item 8)

Phase 2's own fix for backend-security.md Finding 1 introduces a
`RoomAuthStore` — a Redis-backed record binding a `roomId` to the
`desktopDeviceId`/`mobileDeviceId` the pairing flow actually issued it to,
so `SignalingHub.register()` checks "does this connection's claimed
`deviceId` match the one THIS room's pairing flow expects" before granting a
seat. That check is deliberately written against a **bare `deviceId`
string**, because that's all the pre-auth system has today.

This design is forward-compatible with that check, not a replacement for
it, by construction: `RoomAuthStore.verify()` takes a `deviceId` string as
its whole interface. When this design lands, the _string_ it's handed
becomes the JWT's _verified_ `deviceId` claim instead of the raw,
self-asserted wire value — the call site in `register()` doesn't change
shape, only what's proven about the value flowing into it does. Concretely:

```
Today  (Phase 2 item 8):  register()  →  RoomAuthStore.verify(claimedDeviceId)
                                          claimedDeviceId = "whatever the client wrote in the message"

Later  (this design):     register()  →  verifyAuthToken(authToken) → provenDeviceId
                                          RoomAuthStore.verify(provenDeviceId)
                                          provenDeviceId = "cryptographically proven by Ed25519 signature"
```

The room-auth record proves "this room's pairing flow expects this device";
the JWT proves "this connection really is that device." They're
complementary checks over the same string, not two systems that need to be
reconciled later — which is exactly the property item 14 asked this
document to guarantee.

## Rollout

Additive alongside the existing anonymous pairing flow, not a day-one
replacement: existing QR pairing keeps working for unauthenticated
"quick share" use cases if the product wants to keep that tier. Gate
`control` scope or persistent trusted-device reconnect behind an
authenticated account, migrating power users incrementally. Full cutover
timing is a product decision, not something this design prescribes.

## Testing plan

- Unit: login/refresh/rotation/reuse-detection (a revoked token presented
  again must revoke its whole family); device-registration signature
  verification (valid signature accepted, tampered/wrong-key signature
  rejected); revocation propagation (bump `tokenVersion`, confirm a
  previously-issued JWT is rejected mid-lifetime even though it hasn't
  expired).
- Integration: end-to-end pairing using a trusted device's signed
  `register` message; `RoomAuthStore` interaction test proving a room bound
  to device A's pairing flow rejects a _different_, even validly
  authenticated, device B.

## Risks & sizing

Full auth stack, key management, rotation/reuse-detection logic, and
revocation plumbing is a substantial scope — appropriately its own
milestone, not a drop-in patch. Asymmetric signing keys add key-management
operational overhead (rotation procedure, secure storage for the signing
key) beyond today's single-shared-secret model (`TURN_SECRET`). Client-side
keypair generation and secure storage require platform-specific work
(Keychain/Keystore/Secure Enclave APIs) on both Tauri desktop and React
Native mobile — nontrivial but well-trodden ground on both platforms.

Execution risk (scope, timeline) dominates over security-design risk here,
provided the well-established patterns above (Argon2id, refresh rotation
with reuse detection, asymmetric JWT signing, `tokenVersion`-based
revocation) are followed rather than reinvented.

## Future extensibility

This design is intentionally the foundation for SSO/enterprise identity
federation, per-organization device-management dashboards (a natural fit for
`apps/admin`), and fine-grained per-device scope policies layered on top of
the `trusted_devices` relationship already modeled in the schema.

---

_Full originating analysis: [`docs/audit/m3/backend-security.md`](audit/m3/backend-security.md),
Finding 15. This document is the standalone, implementation-ready version of
that finding, cross-referenced from
[`docs/threat-model.md`](threat-model.md) and
[`docs/audit/m3/ROADMAP.md`](audit/m3/ROADMAP.md) (Phase 2, item 14)._
