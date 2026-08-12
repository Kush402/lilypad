---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-12
summary: REST + WebSocket API reference.
---

# Lilypad — API Reference

Backend base URL defaults to `http://localhost:8080` (`PUBLIC_BASE_URL`).
Request/response bodies are zod-validated from
[`@lilypad/protocol`](../packages/protocol/src).

Legend: ✅ implemented · 🔜 later milestone.

## `GET /health` ✅

Liveness + dependency checks.

```json
200 OK
{
  "status": "ok",              // "degraded" (503) if a dep is down
  "uptimeSeconds": 42,
  "checks": { "postgres": "up", "redis": "up" },
  "version": "0.1.0"
}
```

## `POST /pairing/create` ✅

Called by the **desktop** to mint a single-use QR token (60s TTL in Redis).
Rate-limited per IP: **30 requests/minute** (tighter than the global limiter —
this endpoint is unauthenticated pre-M5 and mints Redis state per call).

```jsonc
// request
{ "deviceId": "desktop-…", "deviceName": "macos desktop", "platform": "macos",
  "scopes": ["view","control"] }   // scopes optional; defaults to view+control
// 201 Created
{ "token": "…", "roomId": "uuid", "apiBaseUrl": "http://…",
  "signalingUrl": "ws://…/ws/signal", "expiresInSeconds": 60 }
```

## `POST /pairing/redeem` ✅

Called by the **mobile** app after scanning. Atomically burns the token.

```jsonc
// request
{ "token": "…", "deviceId": "mobile-…", "deviceName": "ios phone", "platform": "ios" }
// 200 OK
{ "roomId": "uuid", "signalingUrl": "ws://…", "scopes": ["view","control"],
  "desktopDeviceName": "macos desktop" }
// 410 Gone  — token invalid, expired, or already used
{ "error": "token_invalid", "message": "…" }
```

## `POST /connect/request` ✅ (M5.4 — no-QR reconnect)

Called by a **trusted phone** to ring its desktop without a QR. The backend
verifies the pair, mints a room-auth-bound session room, and delivers a
`connect-request` over the desktop's presence channel. The response
deliberately mirrors `POST /pairing/redeem`, so the phone's downstream session
flow is identical either way. Rate-limited **30/minute per IP**. Schemas:
[`connect.ts`](../packages/protocol/src/connect.ts).

```jsonc
// request
{ "desktopDeviceId": "desktop-…", "mobileDeviceId": "mobile-…",
  "mobileDeviceName": "ios phone",   // optional
  "pairSecret": "…" }                // per-pair secret; optional only for
                                     // legacy pairs made before secrets existed
// 200 OK
{ "roomId": "uuid", "signalingUrl": "wss://…", "scopes": ["view","control"],
  "desktopDeviceName": "macos desktop" }
// 404 not_trusted   — no pair, or a bad pairSecret (reported identically on
//                     purpose, so device-id guessing can't probe for existence)
// 403 revoked       — the pairing was revoked; re-pair with a QR
// 503 desktop_offline — the desktop has no live presence channel
```

## Trusted-pair management ✅ (M5.4)

Consumed by the desktop's **Trusted Devices** dashboard and the phone's
"Forget". Pre-M5-keys these are as unauthenticated as the rest of the pairing
surface (device ids are self-asserted); the M5 device-identity upgrade gates
them behind a key signature without changing their shape. Mutating routes are
rate-limited **30/minute per IP**.
Handlers: [`routes/devices.ts`](../apps/backend/src/routes/devices.ts).

| Route                                  | Purpose                                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /devices/pairs?desktopDeviceId=…` | Every pair for a desktop → `{ pairs: TrustedPairListing[] }`.                                                                                                                                              |
| `PATCH /devices/pairs/:pairId`         | Flip "connect without approval" — body `{ "autoApprove": bool }` → `{ ok: true }`.                                                                                                                         |
| `DELETE /devices/pairs/:pairId`        | Desktop-side **Revoke**. Row kept as audit trail; the connect gate fails closed and any live session for the pair is ended immediately with reason `revoked`.                                              |
| `POST /devices/unpair`                 | Mobile-side **Forget** — body `{ desktopDeviceId, mobileDeviceId }`. Idempotent. Ends a live session with the neutral reason `unpaired` (not `revoked`, which is reserved for the desktop-initiated case). |

A `TrustedPairListing` is
`{ pairId, mobileFingerprint, displayName, autoApprove, revoked, lastConnectedAt, createdAt }`.

## `GET /ws/signal` ✅

WebSocket signaling — **fully implemented**: room-routed relay, session state
machine, per-peer time-limited TURN credentials, mid-session re-register grace,
and graceful `session-end` on shutdown. Transport guards: per-IP connection cap,
per-socket message-rate limit, unregistered-socket idle close, room cap, and a
64 KB frame-size limit. See [signaling-protocol.md](./signaling-protocol.md).

## `GET /metrics` ✅ 🔒

Operational snapshot for scrapers/operators: `activeRooms` (live gauge) plus
monotonic counters `sessionsStarted`, `sessionsEnded`, `roomsRejectedAtCapacity`,
`peersReaped`.

Requires `Authorization: Bearer $METRICS_BEARER_TOKEN`; returns **401** without
it. The token is optional in development and **required in production**
(enforced at boot by the env safety guard).

## Auth 🔜 M5 remainder

`POST /auth/signup` · `POST /auth/login` · `POST /auth/refresh`. Not built —
see [m5-auth-design.md](./m5-auth-design.md).

## Sessions 🔜 M5 remainder

`GET /sessions` · `POST /sessions/:id/end`. (Device/pair management shipped in
M5.4 — see **Trusted-pair management** above.)

## Admin 🔜 M6

`/admin/*` — users, devices, active sessions, failed pairings, TURN usage,
billing.

## Errors

`400 invalid_request` (zod issues array) · `401 unauthorized` (`/metrics`
without a valid bearer token) · `410 token_invalid` · `429` (rate limit) ·
`503` (health degraded). Rate limiting: a generous global default (120/min per
IP) plus a tighter per-route limit on `POST /pairing/create` (30/min per IP);
auth-route limits land with M5.
