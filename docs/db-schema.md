---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-12
summary: Postgres schema owned by Drizzle migrations.
---

# Lilypad — Database Schema

Postgres 16, owned by Drizzle migrations
([`apps/backend/src/db/schema.ts`](../apps/backend/src/db/schema.ts)). Ephemeral
pairing tokens and signaling room state live in **Redis**, not Postgres.

The full schema is defined now; most columns populate across later milestones
(auth = M5).

## Tables

### `users` (M5)

| column        | type                      | notes               |
| ------------- | ------------------------- | ------------------- |
| id            | uuid PK                   | `gen_random_uuid()` |
| email         | text unique               | citext-ready        |
| password_hash | text nullable             | set at signup (M5)  |
| tier          | enum(`free`,`pro`,`team`) | default `free`      |
| created_at    | timestamptz               |                     |

### `devices`

| column       | type                                            | notes                               |
| ------------ | ----------------------------------------------- | ----------------------------------- |
| id           | uuid PK                                         |                                     |
| user_id      | uuid FK→users                                   | nullable in dev mode (M1)           |
| name         | text                                            |                                     |
| platform     | enum(`macos`,`windows`,`linux`,`ios`,`android`) |                                     |
| kind         | enum(`desktop`,`mobile`)                        |                                     |
| fingerprint  | text                                            | client-generated stable id; indexed |
| last_seen_at | timestamptz                                     |                                     |
| created_at   | timestamptz                                     |                                     |

### `trusted_devices` (M5)

Pairs a user's desktop with a mobile they've chosen to trust (skip re-approval).
`user_id`, `desktop_device_id`, `mobile_device_id` (all FKs), `created_at`.

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

### `audit_logs`

| column              | type        | notes                                                                                                                    |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| id                  | uuid PK     |                                                                                                                          |
| user_id / device_id | uuid FK     | nullable                                                                                                                 |
| event_type          | text        | `login`, `login_failed`, `device_paired`, `session_start`, `session_end`, `pair_denied`, `panic_disconnect`, … (indexed) |
| metadata            | jsonb       | default `{}`                                                                                                             |
| ip                  | inet        |                                                                                                                          |
| created_at          | timestamptz |                                                                                                                          |

## Redis keys (ephemeral)

| key                          | value                                                                    | TTL                      |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------ |
| `lilypad:pairing:<token>`    | JSON `{ roomId, desktopDeviceId, desktopDeviceName, scopes, createdAt }` | 60s, single-use (GETDEL) |
| `lilypad:room-auth:<roomId>` | device-binding record consulted at `register` time (seat-hijack defense) |
| `lilypad:room:<roomId>`      | signaling room membership/state                                          | session lifetime (M2)    |

## Migrations

```bash
pnpm --filter @lilypad/backend db:generate   # drizzle-kit: schema → SQL
pnpm --filter @lilypad/backend db:migrate     # apply to Postgres
```
