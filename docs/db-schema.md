---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-12
summary: Postgres schema owned by Drizzle migrations.
---

# Lilypad — Database Schema

Postgres 16, owned by Drizzle migrations
([`apps/backend/src/db/schema.ts`](../apps/backend/src/db/schema.ts)).

**What lives where.** Short-lived, single-use credentials (pairing tokens,
magic-link tokens, device challenges) and signaling room state live in **Redis**
— they expire by TTL and must not outlive a restart. Anything that must be
_revoked_, _listed_, or _audited_ lives in Postgres.

## Tables

### `users` (M8)

| column        | type                      | notes                                     |
| ------------- | ------------------------- | ----------------------------------------- |
| id            | uuid PK                   | `gen_random_uuid()`                       |
| email         | text unique               |                                           |
| password_hash | text nullable             | **deliberately unused** — see ADR-0001    |
| tier          | enum(`free`,`pro`,`team`) | default `free`; no billing is wired (M18) |
| created_at    | timestamptz               |                                           |

`password_hash` predates [ADR-0001](adr/0001-account-authentication.md), which
chose OAuth + magic link and no passwords. The column is kept nullable and
unwritten; its existence is not a plan to use it.

### `oauth_identities` (M8)

One row = one **third-party** provider identity linked to one account.

| column     | type                    | notes                      |
| ---------- | ----------------------- | -------------------------- |
| id         | uuid PK                 |                            |
| user_id    | uuid FK→users (cascade) | indexed                    |
| provider   | enum(`apple`,`google`)  |                            |
| subject    | text                    | the provider's `sub` claim |
| created_at | timestamptz             |                            |

Magic-link sign-in has **no row here**: its identity _is_ `users.email`, so a
linking row would only duplicate it. A user's available sign-in methods are
therefore `users.email` (always) plus whatever rows exist in this table.

**`UNIQUE (provider, subject)`** is a security control, not an optimisation:
without it a race could link one provider identity to two accounts and sign-in
would pick between them arbitrarily. The subject — not the email — is the stable
key, because Apple's Hide My Email can change the address a provider reports
while `sub` stays fixed.

### `devices`

| column       | type                                            | notes                                      |
| ------------ | ----------------------------------------------- | ------------------------------------------ |
| id           | uuid PK                                         |                                            |
| user_id      | uuid FK→users (cascade)                         | nullable — NULL = pre-account (M1) row     |
| name         | text                                            |                                            |
| platform     | enum(`macos`,`windows`,`linux`,`ios`,`android`) |                                            |
| kind         | enum(`desktop`,`mobile`)                        |                                            |
| fingerprint  | text                                            | client-generated stable id; indexed        |
| public_key   | text nullable, **unique**                       | base64url raw Ed25519 (32 bytes)           |
| revoked_at   | timestamptz nullable                            | per-device revocation ("I lost my laptop") |
| last_seen_at | timestamptz                                     |                                            |
| created_at   | timestamptz                                     |                                            |

Two uniqueness rules, both added in `0003`:

- **`UNIQUE (kind, fingerprint)`** — `upsertDevice` is select-then-insert, so
  concurrent first-contacts used to be able to create two rows for one device and
  split its trust across them. The constraint is what prevents that; the
  application's `ON CONFLICT DO NOTHING` + re-select is only the friendly path.
  Verified against a live Postgres: 8 concurrent upserts → one row, one id.
- **`UNIQUE (public_key)`** — a public key must name exactly one device or it is
  not an identity. Postgres treats NULLs as distinct, so unenrolled rows are
  unaffected.

`DeviceRegistry.enroll` is a select-then-insert against both of them, so it
inserts with `ON CONFLICT DO NOTHING` and, on losing the race, resolves again
against the row that won and re-applies the ownership rules. Two overlapping
enrollments of one device converge on one row; two devices racing for one key
still get `public_key_in_use`, which is the same answer the sequential case
gives. The ordinary way in is a retry — the phone abandons a request after 8
seconds and the user taps Sign in again — and the loser used to raise a
constraint violation the route reported as a 500, on the first thing a new
account does. Verified against a live Postgres: 8 concurrent enrollments of one
device → one row, one id; two devices racing for one key → one row and one
`public_key_in_use`. Before the fix the same script raised
`23505 … devices_public_key_idx` out of the route.

A device is **enrolled** exactly when `public_key` and `user_id` are both
non-NULL ([ADR-0002](adr/0002-device-identity.md)).

### `refresh_tokens` (M8)

Rotating opaque refresh tokens for **account** sessions
([ADR-0001](adr/0001-account-authentication.md)).

| column         | type                    | notes                                        |
| -------------- | ----------------------- | -------------------------------------------- |
| id             | uuid PK                 |                                              |
| user_id        | uuid FK→users (cascade) | indexed                                      |
| token_hash     | text unique             | SHA-256 of the token; plaintext never stored |
| expires_at     | timestamptz             |                                              |
| revoked_at     | timestamptz nullable    | set on rotation or explicit sign-out         |
| replaced_by_id | uuid nullable           | the token that superseded this one           |
| created_at     | timestamptz             |                                              |

**Deliberately not per-device.** An enrolled device renews by signing a fresh
challenge with its Ed25519 key ([ADR-0002](adr/0002-device-identity.md)), so
giving it a refresh token too would add a second, weaker, copyable credential
for a job a non-exportable hardware-backed key already does. A `device_id`
column was added in `0003` and dropped again in `0004` for exactly that reason —
it would have been permanently NULL. These rows belong to browser sessions and
to the window between sign-in and enrollment.

In Postgres rather than Redis precisely because they must be revocable and
enumerable: "sign out everywhere" is a query, and a Redis flush must not
silently un-revoke a stolen token.

`replaced_by_id` is what makes **replay detectable**: presenting an
already-rotated token means it leaked or was replayed, so the whole chain is
revoked. Only the SHA-256 is stored — the token is 32 bytes of CSPRNG output, so
a plain hash is correct (nothing low-entropy to stretch), the same reasoning as
the per-pair connect secret.

### `trusted_devices` (M5.4)

One row = one persistent desktop↔mobile trust relationship. Created when a
desktop approval carries `trust: true`, read by `POST /connect/request`, severed
by Forget (phone) / Revoke (desktop) — which **sets `revoked_at` rather than
deleting**, so the row remains the audit trail.

| column                               | type                      | notes                                   |
| ------------------------------------ | ------------------------- | --------------------------------------- |
| id                                   | uuid PK                   |                                         |
| user_id                              | uuid FK→users (cascade)   | **always NULL — see below**             |
| desktop_device_id / mobile_device_id | uuid FK→devices (cascade) | **`UNIQUE` together**; `mobile` indexed |
| display_name                         | text nullable             | what each side calls the pair           |
| auto_approve                         | boolean, default `false`  | desktop-side "Always allow"             |
| last_connected_at                    | timestamptz nullable      |                                         |
| revoked_at                           | timestamptz nullable      | set by Forget/Revoke; gate fails closed |
| connect_secret_hash                  | text nullable             | SHA-256 of the per-pair connect secret  |
| created_at                           | timestamptz               |                                         |

**`user_id` is always NULL**, and the note that used to say "nullable until M8
backfills it" was wrong: M8/M9 shipped and the backfill never happened.
`establishTrustForDeviceIds` inserts a pair without an owner, and no query
filters on the column. Verified against production 2026-08-20 — every row has
it NULL.

Its `ON DELETE CASCADE` is therefore inert, which sounds like an orphan bug and
is not. `desktop_device_id` and `mobile_device_id` are NOT NULL and cascade from
`devices`, which itself cascades from `users`, so deleting an account removes
its devices and their pairs. Confirmed by deleting three accounts and watching 4
devices and 2 pairs go with them, leaving 0 orphans. The column is kept as the
natural home for ownership if a pair ever needs to outlive a device row, and
carries no index while it holds nothing.

**The `UNIQUE (desktop_device_id, mobile_device_id)` index is a correctness
control, not a tidiness one**, and the write is shaped around it. Trust is
established from two entry points with no lock between them — a phone approving
a laptop's enrollment code, and a QR approval carrying `trust: true` — so
reading the pair and then choosing between an insert and an update is a
check-then-act that both paths can lose. `establishTrustForDeviceIds` therefore
issues one `INSERT … ON CONFLICT (desktop, mobile) DO UPDATE`, which re-arms
`connect_secret_hash`, clears `revoked_at`, and deliberately leaves
`auto_approve` alone so a user who turned "Always allow" back off keeps it
through a re-pair. Verified against a live Postgres: 8 concurrent ceremonies for
one pair → one row, nothing raised, and exactly one of the eight issued secrets
authorizes it. Before the fix, 7 of the 8 raised.

A **NULL `connect_secret_hash`** is a pair created before per-pair secrets
existed. It used to authorize with no secret at all — SEC-5. Migration `0005`
revokes every such row, and `authorizeConnect` refuses a null hash outright, so
the affected phones re-pair once with a QR (which issues a secret and un-revokes
the row). The column stays nullable: a secret is known only to the phone it was
issued to, so it cannot be backfilled.

### `sessions`

| column                               | type                             | notes                 |
| ------------------------------------ | -------------------------------- | --------------------- |
| id                                   | uuid PK                          |                       |
| user_id                              | uuid FK                          | nullable              |
| desktop_device_id / mobile_device_id | uuid FK                          |                       |
| scopes                               | text[]                           | e.g. `{view,control}` |
| status                               | enum(`pending`,`active`,`ended`) | indexed               |
| started_at / ended_at                | timestamptz                      |                       |
| created_at                           | timestamptz                      |                       |

> **Not yet written.** Live session state is Redis-only; no code inserts here.
> Tracked as SEC-3 / F9, closed in M8.

### `audit_logs`

| column              | type        | notes                                                                                                                    |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| id                  | uuid PK     |                                                                                                                          |
| user_id / device_id | uuid FK     | nullable                                                                                                                 |
| event_type          | text        | `login`, `login_failed`, `device_paired`, `session_start`, `session_end`, `pair_denied`, `panic_disconnect`, … (indexed) |
| metadata            | jsonb       | default `{}`                                                                                                             |
| ip                  | inet        |                                                                                                                          |
| created_at          | timestamptz |                                                                                                                          |

The one unbounded table, and the only one that needs a retention policy — see
[ADR-0007](adr/0007-cloud-is-control-plane-only.md).

## Redis keys (ephemeral)

| key                                    | value                                                                    | TTL                      |
| -------------------------------------- | ------------------------------------------------------------------------ | ------------------------ |
| `lilypad:pairing:<token>`              | JSON `{ roomId, desktopDeviceId, desktopDeviceName, scopes, createdAt }` | 60s, single-use (GETDEL) |
| `lilypad:magic-link:<token>`           | the email address the token proves                                       | 15m, single-use (GETDEL) |
| `lilypad:device-challenge:<challenge>` | presence marker only — the value carries nothing                         | 2m, single-use (GETDEL)  |
| `lilypad:room-auth:<roomId>`           | device-binding record consulted at `register` time (seat-hijack defense) | session lifetime         |
| `lilypad:room:<roomId>`                | signaling room membership/state                                          | session lifetime (M2)    |

## Migrations

```bash
pnpm --filter @lilypad/backend db:generate   # drizzle-kit: schema → SQL
pnpm --filter @lilypad/backend db:migrate     # apply to Postgres
```

`0003` is **hand-edited**: before adding `UNIQUE (kind, fingerprint)` it deletes
duplicate device rows that nothing references, then aborts with an actionable
message if any referenced duplicate remains. Merging two referenced device rows
merges their trust grants — a security decision a migration must not make
silently.

`0004` drops `refresh_tokens.device_id` — see that table's note above.
