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

Legend: ✅ implemented · 🔜 later milestone · 🔒 requires a token.

## Authorization (M9)

Every pairing and trust route is gated by ownership
([ADR-0010](adr/0010-explicit-device-linking.md)). Two rules, applied by
[`auth/authorize.ts`](../apps/backend/src/auth/authorize.ts):

- **Acting AS a device** (`/pairing/create`, `/pairing/redeem`,
  `/connect/request`, `/devices/unpair`, and the presence `register`) requires
  **that device's own token** — `Authorization: Bearer <device access token>`
  from `POST /devices/token`. Naming a device is not being it.
- **Managing a device or pair** (the three `/devices/pairs` routes below)
  requires a token whose subject **owns** the resource. Any of the owner's
  devices qualifies.

The gate is conditional on ownership, not on the route: a device row that **no
account owns** has nothing to protect and keeps its pre-accounts behaviour, so
pairing a fresh install still works with no token at all. The moment a device is
linked, its routes demand a matching token. Clients send one whenever they can
mint one, so the two halves meet with no flag day.

**The desktop no longer uses that lane.** As of P7 it refuses to mint a pairing
for a computer it knows to be `unlinked`, `revoked`, or without an identity, and
neither the tray, the dashboard, nor the setup wizard offers the action —
because a pair made on an unowned computer belongs to no account, appears in no
"Your devices" list, and can be revoked from nowhere, which is the state
[ADR-0010](adr/0010-explicit-device-linking.md) rejected. The server-side
allowance is still open, deliberately: closing it is a contract change that
would strand any install predating linking, and it needs its own pass.

**A denial is always `404 { "error": "not_found" }`** — never 403 — so "not
yours" cannot be told apart from "does not exist". A present-but-invalid token
is `401 { "error": "unauthorized" }`, because a client that cannot tell an
expired session from a missing device cannot know to re-authenticate.

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
it mints Redis state per call). 🔒 device token when `deviceId` is linked.

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
🔒 device token when `deviceId` is linked.

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

🔒 The caller must **be** `mobileDeviceId` when that phone is linked — ringing
someone else's laptop is the highest-value action here, and until M9 the only
thing between an attacker and it was knowing two device ids and a secret.

```jsonc
// request
{ "desktopDeviceId": "desktop-…", "mobileDeviceId": "mobile-…",
  "mobileDeviceName": "ios phone",   // optional
  "pairSecret": "…" }                // per-pair secret; required — a pair
                                     // without one is refused (SEC-5)
// 200 OK
{ "roomId": "uuid", "signalingUrl": "wss://…", "scopes": ["view","control"],
  "desktopDeviceName": "macos desktop" }
// 404 not_trusted   — no pair, or a bad pairSecret (reported identically on
//                     purpose, so device-id guessing can't probe for existence)
// 403 revoked       — the pairing was revoked; re-pair with a QR
// 503 desktop_offline — the desktop has no live presence channel
```

## Account devices ✅ 🔒 device token (P2)

**A different list from the trusted pairs below, answering a different
question** ([ADR-0010](adr/0010-explicit-device-linking.md)): these are the
machines the account **owns**, not which phone may reach which laptop. Revoking
here is strictly stronger than severing a pairing — the device can no longer
authenticate at all, so it loses every pairing at once.

`requireDevice`, not the conditional gate the pairing routes use: there is no
unowned lane, because the resource _is_ an account's device list. Without an
account there is nothing to list, so an anonymous caller gets **401**, not an
empty array. Handlers:
[`routes/devices.ts`](../apps/backend/src/routes/devices.ts).

| Route                       | Purpose                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /devices`              | Every device on the caller's account → `{ devices: AccountDevice[] }`.                                            |
| `PATCH /devices/:deviceId`  | Rename — body `{ "name": "Work MacBook" }` → `{ ok: true }`. A label; nothing authorizes on it.                   |
| `DELETE /devices/:deviceId` | Revoke. Ends the device's live rooms **and its presence room** immediately, then fails its next `/devices/token`. |

```jsonc
// GET /devices → 200
{
  "devices": [
    {
      "id": "uuid",
      "kind": "desktop",
      "platform": "macos",
      "name": "Work MacBook",
      "fingerprint": "…445685", // masked; the full value is a pairing input
      "state": "linked", // unlinked | linked | revoked
      "lastSeenAt": "2026-08-13T…",
      "createdAt": "2026-08-13T…",
      "activeSession": false, // from the signaling hub, not a table — see below
      "isCurrentDevice": false,
    }, // true for the device making the request
  ],
}
```

**`activeSession` comes from the signaling hub, not the `sessions` table.** That
table is still never written, and rendering an empty table as "no active
sessions" would state something false rather than omit something missing. A
device's _presence_ room does not count — a laptop sitting in one is reachable,
not busy. Per-process truth while the backend is single-instance (OPS-1); M11's
scale-out is where this needs a shared view.

**Revoking a device does not delete its pairs**, deliberately. Revocation is
enforced at the identity layer — a revoked device cannot obtain a token and
cannot claim its presence room — so its pair rows are inert. Re-enrolling the
device (a deliberate act) un-revokes it and its trust relationships come back
intact, which is the recovery a user expects after "I found my laptop".

## Trusted-pair management ✅ (M5.4)

Consumed by the desktop's **Trusted Devices** dashboard and the phone's
"Forget". 🔒 Ownership-gated per the rules above: the three `/devices/pairs`
routes need a token that **owns** the resource, `POST /devices/unpair` needs the
token of the phone it names. Mutating routes are rate-limited
**30/minute per IP**.
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

**Registering into a room** is authorized two different ways, because the two
kinds of room are different:

- A **session room** (a uuid) is authorized against the room record the backend
  minted itself during `/pairing/create` or `/connect/request` — both already
  authorized, so the record carries that authorization forward. No token needed
  on the socket.
- A **presence room** (`presence:<deviceId>`, M5.4) has no such record; the
  claim is the only input. 🔒 So when that desktop is linked, the socket must
  carry `Authorization: Bearer <device token>` **on the upgrade request**, and
  it must belong to the device being claimed. A WebSocket has no per-message
  headers, and a bearer token inside a routed signaling frame would spread
  through logs and relay paths — the upgrade is the one private place for it.
  Fails closed if the database is unreachable.

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

### `POST /auth/signup` ✅

Create an account from name + email + password
([ADR-0012](adr/0012-password-authentication.md)). Rate-limited to **5/minute**
per IP.

Password policy is NIST SP 800-63B: **12–200 characters, NFKC-normalised, no
composition rules**. Hashing is scrypt (`N=32768, r=8, p=1`, 16-byte salt),
stored as `scrypt$N$r$p$salt$hash` so the parameters travel with the hash.

```jsonc
// request
{ "name": "Ada Lovelace", "email": "ada@example.com", "password": "…" }
// 201 Created — same session shape as /auth/oauth
{ "accessToken": "eyJ…", "expiresInSeconds": 600, "refreshToken": "…", "userId": "uuid" }
// 400 — password too short, or the email is not an address
{ "error": "invalid_request", "issues": [ … ] }
// 409 — that address already has an account
{ "error": "email_in_use", "message": "…" }
```

> **This is the one auth route that is not enumeration-safe**, deliberately. The
> alternative — answer identically and mail the existing owner — needs the
> sender M13 still owes. The tradeoff is bounded: signup, not sign-in, at
> 5/minute. Revisit when mail delivery exists.

### `POST /auth/password` ✅

Sign in with email + password. Rate-limited to **10/minute** per IP — tighter
than `/auth/oauth`, because this is the endpoint credential stuffing targets and
each attempt costs a scrypt.

```jsonc
{ "email": "ada@example.com", "password": "…" } // → 200 (same session shape)
// 401 — unknown address, wrong password, or an account with no password set
{ "error": "invalid_credentials" }
```

> **All three failures are the same answer AND the same wall-clock time.** The
> branches with nothing to verify still verify against a dummy hash, because a
> caller who can tell them apart by status _or_ by timing has an
> account-existence oracle. An account created by Apple, Google, or a magic link
> has `password_hash = NULL` and therefore cannot use this route — a normal
> state, not a missing value.

### `POST /auth/password/reset/request` ✅

Ask for a reset code. Answers **202 whether or not the address has an account**.
Rate-limited to **5/minute** per IP.

```jsonc
{ "email": "ada@example.com" }   // → 202 { "ok": true }
// 503 — no email sender is configured on this server
{ "error": "magic_link_unavailable", "message": "…" }
```

> The token is minted without first checking that the account exists: looking
> would make the two cases cost different work for no benefit, since the
> response is identical either way and `/reset/confirm` already refuses a token
> whose address has no account.
>
> **Reset tokens live in their own Redis namespace** (`lilypad:password-reset:`),
> separate from magic-link tokens. Same entropy, same TTL, same `GETDEL` — but
> one key space would make a reset token redeemable at
> `/auth/magic-link/verify`, so an email saying "reset your password" would
> silently be a full sign-in.

### `POST /auth/password/reset/confirm` ✅

Spend a reset code on a new password, and sign in. Single-use. Rate-limited to
**10/minute** per IP.

```jsonc
{ "token": "…", "password": "…" } // → 200 (same session shape)
// 400 — new password too short · 401 — code unknown, expired, already used,
// or its address has no account (which creates nothing)
```

> Signing in here is not a shortcut: redeeming the token has just proved inbox
> possession, which is exactly the proof `/auth/magic-link/verify` accepts on
> its own. Demanding a second sign-in immediately afterwards would prove nothing
> and strand a user who has just changed the credential.

### `POST /auth/magic-link/request` ✅

Ask for a sign-in **code**. Answers **202 whether or not the address has an
account**, deliberately: a response that differed would be an
account-enumeration oracle. Rate-limited to **5/minute** per IP.

```jsonc
{ "email": "ada@example.com" }   // → 202 { "ok": true }
// 503 — no email sender is configured on this server (see below)
{ "error": "magic_link_unavailable", "message": "…" }
```

> **Delivery is dev-only today.** The token flow is complete and tested, but the
> only sender that exists writes the code to the server log. A production sender
> (SES/Resend/SMTP) is chosen with the rest of the hosting in **M13**. Until
> then this endpoint answers 503 outside development rather than accepting
> sign-ins whose email never arrives.
>
> **What is sent is a code, not a clickable link.** The sender used to also
> receive `${PUBLIC_BASE_URL}/auth/magic-link?token=…`, deferring a landing page
> to M14 — but M14 was split into P1/P2/P4 and that page belonged to none of
> them, so the URL was being generated for a route that does not exist
> (following it returns a raw 404). Nothing could have handled it client-side
> either: the app registers no URL scheme and no associated domain. The phone's
> `SignInScreen` asks the user to paste the code, which is what the email
> carries. A clickable link comes back only if a landing page or deep-link
> handler is actually built.

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

**`kind: "desktop"` is refused — 403, before the signature is even checked.** A
computer may never put itself on an account, however well it proves who is
signed in: linking costs a phone approving an enrollment code
([ADR-0010](adr/0010-explicit-device-linking.md)), which is the
physical-possession second factor on the highest-privilege action in the
product. Nothing could reach this branch while the desktop had no way to hold an
account token; [ADR-0012](adr/0012-password-authentication.md) gives it one, so
the rule is enforced here rather than by client convention.

```jsonc
// request
{ "challenge": "…", "publicKey": "…", "signature": "…",
  "kind": "mobile", "fingerprint": "phone-…",
  "name": "Ada’s iPhone", "platform": "ios" }   // name/platform optional
// 200 OK
{ "accessToken": "eyJ…", "expiresInSeconds": 600,
  "deviceId": "uuid",       // devices.id — a real server-side uuid
  "userId": "uuid" }
// 401 — unknown, expired, already-spent, or wrongly-signed challenge
{ "error": "invalid_signature" }
// 403 — kind was "desktop"; use /devices/enrollment-code instead
{ "error": "desktop_enrollment_requires_approval", "message": "…" }
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

### `POST /devices/enrollment-code` ✅

The desktop asks for a single-use code to show as a QR
([ADR-0008](adr/0008-desktop-enrollment-via-phone.md)). The desktop has **no
OAuth client of its own** — it is enrolled by a phone that is already signed in.
Unauthenticated by necessity, since an unenrolled desktop has no token; that is
safe because the code is **bound server-side to the public key proved here**, so
an intercepted code can only ever enroll that one machine. 120-second TTL.
Rate-limited to **20/minute** per IP.

```jsonc
// request — same proof fields as /devices/enroll, minus `kind` (always desktop)
{ "challenge": "…", "publicKey": "…", "signature": "…",
  "fingerprint": "desktop-…", "name": "Work Mac", "platform": "macos" }
// 201 Created
{ "code": "…", "expiresInSeconds": 120,
  "apiBaseUrl": "https://…" }   // the address the PHONE should use
```

`apiBaseUrl` comes from the same `advertisedUrls()` seam `POST /pairing/create`
uses, and the desktop needs it: it puts the value in the QR, and a laptop
configured with `http://localhost:8080` cannot ask a phone to reach that. The
phone has **no default backend address of its own** — the code it scans is what
tells it where Lilypad lives.

### `POST /devices/enrollment-code/approve` ✅ 🔒 device token

An already-enrolled phone adds that desktop to **its own** account. Requires a
**device** token, not merely an account session: approving another machine is
exactly the act that should need a device that was itself enrolled. The account
the desktop joins is the token's subject — the body carries only the code.
Rate-limited to **20/minute** per IP.

```jsonc
{ "code": "…" }
// 200 OK
{
  "ok": true,
  "deviceId": "uuid",
  "name": "Work Mac",       // label the desktop supplied, never an authz input
  "platform": "macos",
  "pairSecret": "…"         // delivered ONCE; never stored in plaintext
}
// 404 — unknown, expired, or already used; all answer identically so a caller
//       cannot probe for live codes
{ "error": "invalid_code", "message": "…" }
// 409 { "error": "device_owned_by_another_account" }   // or "public_key_in_use"
```

The desktop learns it succeeded because its next `POST /devices/token` starts
working. There is no completion endpoint and no push channel.

Approval also establishes the **trust pair** between the approving phone and the
newly linked desktop, and returns that pair's `pairSecret`. Linking has to make
the laptop _reachable_, not merely _owned_: enrollment writes `devices.user_id`,
while [`/connect/request`](#post-connectrequest) authorizes on a
`trusted_devices` row plus this secret and never consults ownership. Without it
a user completed the whole ceremony and still could not connect. The phone must
store the secret — losing it means seeing the computer but being unable to
reach it, recoverable only by linking again.

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
