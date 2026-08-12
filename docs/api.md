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

## Account authentication ✅ (M8)

The only routes reachable without a token, because they are how a caller gets
one. See [ADR-0001](adr/0001-account-authentication.md). There are no passwords
and no signup endpoint: a first sign-in creates the account.

Two rules apply across all of them:

- **Failures do not distinguish themselves.** Expired, forged, replayed, and
  unknown all answer `401 invalid_token`. The audit log records which it really
  was; the response does not, because a caller that can tell them apart has an
  oracle for probing.
- **Every attempt is audited** — `login` on success, `login_failed` with the
  real reason in `metadata` otherwise.

### `POST /auth/oauth` ✅

Sign in with an Apple or Google ID token the client already obtained from the
platform SDK. Lilypad never handles the provider password or the
authorization-code exchange; it verifies what the SDK produced: signature
against the provider's JWKS, issuer, **audience against our own client ids**,
and a pinned algorithm list. Rate-limited to **20/minute** per IP.

```jsonc
// request
{ "provider": "apple", "idToken": "eyJ…" }
// 200 OK
{ "accessToken": "eyJ…", "expiresInSeconds": 600, "refreshToken": "…", "userId": "uuid" }
// 401 — token invalid, expired, forged, or minted for another app
{ "error": "invalid_token" }
// 403 — actionable by the user, and neither answer reveals whether an account exists
{ "error": "email_unverified" }   // or "email_required"
// 503 — this server has no client ids configured for that provider
{ "error": "provider_not_configured", "message": "…" }
```

### `POST /auth/magic-link/request` ✅

Ask for a sign-in link. Answers **202 whether or not the address has an
account**, deliberately: a response that differed would be an
account-enumeration oracle. Rate-limited to **5/minute** per IP.

```jsonc
{ "email": "ada@example.com" }   // → 202 { "ok": true }
// 503 — no email sender is configured on this server (see below)
{ "error": "magic_link_unavailable", "message": "…" }
```

> **Delivery is dev-only today.** The token flow is complete and tested, but the
> only sender that exists writes the link to the server log. A production sender
> (SES/Resend/SMTP) is chosen with the rest of the hosting in **M13**, and the
> clickable-link/deep-link UX lands in **M14**. Until then this endpoint answers
> 503 outside development rather than accepting sign-ins whose email never
> arrives.

### `POST /auth/magic-link/verify` ✅

Redeem the single-use token. Burned with `GETDEL`, so a replay finds nothing;
15-minute TTL. Possession of the inbox is the proof, so there is no separate
email-verification step. Rate-limited to **20/minute** per IP.

```jsonc
{ "token": "…" } // → 200 (same session shape as /auth/oauth) · 401 invalid_token
```

### `POST /auth/refresh` ✅

Exchange a refresh token for a fresh pair. **Single-use:** the presented token
is retired by the exchange, and presenting it again revokes every live token for
that user+device — a retired token in an attacker's hands and in the client's
hands are indistinguishable from the server, so the safe response is to force a
re-sign-in. Clients MUST replace their stored copy with the returned one.
Rate-limited to **60/minute** per IP.

```jsonc
{ "refreshToken": "…" } // → 200 (same session shape) · 401 invalid_token
```

## Device identity ✅ (M8)

A device proves who it is by signing a server-issued challenge with an Ed25519
private key that never leaves it ([ADR-0002](adr/0002-device-identity.md)). The
self-asserted `deviceId` string survives as a label and as `devices.fingerprint`,
but stops being the thing anything trusts.

Clients sign the UTF-8 bytes of `lilypad-device-auth:v1:` + the challenge. The
prefix is domain separation: the same key also binds the desktop's LAN TLS
certificate ([ADR-0006](adr/0006-lan-first-connectivity.md)), and a signature
made for one purpose must not be valid for the other.

Public keys and signatures are **base64url of the raw bytes** — 43 characters
for a 32-byte key, 86 for a 64-byte signature.

> **No device refresh token, on purpose.** A device renews by signing a fresh
> challenge, so its durable credential is a non-exportable, hardware-backed
> private key rather than a stored bearer string that grants device access to
> anyone who copies it.

### `POST /devices/challenge` ✅

Issue a single-use nonce. Unauthenticated by necessity — a device that has no
token yet is the entire point. **120-second TTL**, burned on use.
Rate-limited to **60/minute** per IP.

```jsonc
// 201 Created
{ "challenge": "…43 base64url chars…", "expiresInSeconds": 120 }
```

### `POST /devices/enroll` ✅ 🔒 account token

Bind a device's public key to the signed-in account. This is the moment a
machine gains an owner, so an owner must be present to gain: it requires an
**account** access token from `/auth/*`. Rate-limited to **20/minute** per IP.

Also **claims a pre-account row with the same fingerprint** if one exists, so
trust relationships created before accounts survive rather than being orphaned.

```jsonc
// request
{ "challenge": "…", "publicKey": "…", "signature": "…",
  "kind": "desktop", "fingerprint": "desktop-…",
  "name": "Work Mac", "platform": "macos" }     // name/platform optional
// 200 OK
{ "accessToken": "eyJ…", "expiresInSeconds": 600,
  "deviceId": "uuid",       // devices.id — a real server-side uuid
  "userId": "uuid" }
// 401 — unknown, expired, already-spent, or wrongly-signed challenge
{ "error": "invalid_signature" }
// 409
{ "error": "device_owned_by_another_account" }  // or "public_key_in_use"
```

Re-enrolling the same device on the same account is idempotent, rotates the
stored key, and lifts a revocation — that is how a user restores a device they
revoked, and how a device recovers after a reinstall.

### `POST /devices/token` ✅

Exchange proof of key possession for a device access token — how a device signs
itself back in after a restart, with no user interaction. Rate-limited to
**60/minute** per IP.

```jsonc
{ "challenge": "…", "publicKey": "…", "signature": "…" }
// 200 OK — same shape as /devices/enroll
// 401 { "error": "invalid_signature" }
// 403 { "error": "device_revoked" }   // or "device_not_enrolled"
```

403 rather than 401 for the last two: the credential is valid, the _device_ is
not allowed. Retrying with the same key will never help, and a client that
cannot tell those apart retries forever.

Both proof-carrying routes **burn the challenge before checking the
signature**. The other order would leave a failed attempt's nonce spendable,
handing an attacker unlimited tries against one challenge.

## Sessions 🔜 M5 remainder

`GET /sessions` · `POST /sessions/:id/end`. (Device/pair management shipped in
M5.4 — see **Trusted-pair management** above.)

## Admin 🔜 M6

`/admin/*` — users, devices, active sessions, failed pairings, TURN usage,
billing.

## Errors

`400 invalid_request` (zod issues array) · `401 unauthorized` (`/metrics`
without a valid bearer token) · `401 invalid_token` (any auth failure) ·
`403 email_required` / `email_unverified` · `410 token_invalid` · `429` (rate
limit) · `503` (health degraded, `provider_not_configured`,
`magic_link_unavailable`).

Rate limiting: a generous global default (120/min per IP), a tighter per-route
limit on `POST /pairing/create` and `/connect/request` (30/min), and tighter
still on the auth routes — 20/min for the two token-verifying endpoints, 60/min
for refresh, and **5/min for magic-link requests**, which are the only endpoint
that causes mail to be sent on an unauthenticated caller's say-so.
