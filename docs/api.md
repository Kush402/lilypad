# Lilypad — API Reference

Backend base URL defaults to `http://localhost:8080` (`PUBLIC_BASE_URL`).
Request/response bodies are zod-validated from
[`@lilypad/protocol`](../packages/protocol/src).

Legend: ✅ implemented in M1 · 🔜 later milestone.

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

## `GET /ws/signal` ✅

WebSocket signaling — **fully implemented**: room-routed relay, session state
machine, per-peer time-limited TURN credentials, mid-session re-register grace,
and graceful `session-end` on shutdown. Transport guards: per-IP connection cap,
per-socket message-rate limit, unregistered-socket idle close, room cap, and a
64 KB frame-size limit. See [signaling-protocol.md](./signaling-protocol.md).

## `GET /metrics` ✅

Operational snapshot for scrapers/operators: `activeRooms` (live gauge) plus
monotonic counters `sessionsStarted`, `sessionsEnded`, `roomsRejectedAtCapacity`,
`peersReaped`.

## Auth 🔜 M5

`POST /auth/signup` · `POST /auth/login` · `POST /auth/refresh`.

## Devices & sessions 🔜 M5

`GET/POST/DELETE /devices` · `GET /sessions` · `POST /sessions/:id/end`.

## Admin 🔜 M6

`/admin/*` — users, devices, active sessions, failed pairings, TURN usage,
billing.

## Errors

`400 invalid_request` (zod issues array) · `410 token_invalid` · `429` (rate
limit) · `503` (health degraded). Rate limit is a generous global default in M1;
per-route tightening (especially pairing/auth) lands in M6.
