---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-12
summary: Assets, threats, and mitigations.
---

# Lilypad — Threat Model

Remote laptop control is high-stakes: a session grants view + input over the
public internet. This documents the assets, threats, and mitigations.

## Assets

- The **laptop** (screen contents + input control).
- **Pairing tokens** (grant a phone the right to request a session).
- **User accounts / credentials** (M5).
- **TURN relay** capacity (abuse target).

## Trust model

- The **desktop user** is the ultimate authority: a session only starts after an
  explicit **Approve** on the laptop. There is **no silent remote access**.
- The **backend** is trusted for signaling + pairing brokerage but is **never in
  the media path** (WebRTC is end-to-end DTLS-SRTP encrypted between peers).

## Threats → mitigations

| Threat                           | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen/replayed QR token         | Tokens are **single-use** (Redis GETDEL) with a **60s TTL**, high-entropy, bound to the desktop device + room. **Enforced at the WS layer too**: `SignalingHub`'s room-auth check ([`apps/backend/src/services/roomAuth.ts`](../apps/backend/src/services/roomAuth.ts)) rejects a `register` attempt whose `roomId` was never issued by the pairing flow, or whose `deviceId` doesn't match the device that flow actually issued it to — a leaked/guessed `roomId` alone no longer wins a seat.                                                                                                                                                                                        |
| QR shoulder-surfing / screenshot | Short TTL + single-use; the token alone is useless without the desktop-side Approve.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Silent/unattended takeover       | Mandatory **Approve/Deny** on desktop; **visible session indicator**; **panic disconnect** in tray.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Man-in-the-middle on signaling   | **WSS** (TLS) in production; SDP fingerprints bind the DTLS handshake — media MITM fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Media eavesdropping              | WebRTC **DTLS-SRTP** is mandatory; no unencrypted media.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Over-broad permissions           | **Scopes** (`view` vs `control`), enforced at the desktop's input-injection boundary ([`apps/desktop/src-tauri/src/input/dispatcher.rs`](../apps/desktop/src-tauri/src/input/dispatcher.rs)) — a view-only session's pointer/key/clipboard events are dropped before they ever reach the OS, not just hidden by the mobile UI.                                                                                                                                                                                                                                                                                                                                                         |
| TURN abuse / cred theft          | **Time-limited rotating TURN credentials** (use-auth-secret) in production, issued per session — not the static dev secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Brute force / flooding           | **Rate limits** on pairing + auth (tightened in M6); room seat cap (2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Account compromise (M5)          | Password hashing (argon2/bcrypt), session expiry, device binding, trusted-device revocation — full design in [docs/m5-auth-design.md](m5-auth-design.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Repudiation                      | **Audit logs** ([`apps/backend/src/services/auditLog.ts`](../apps/backend/src/services/auditLog.ts)): `device_paired`, `session_start`, `session_end`, `sessions_revoked`, `pair_denied` are implemented today. `sessions_revoked` was split out of `session_end` on 2026-08-25: withdrawing access and a screen-share ending are the two facts an incident is reconstructed from, and they had been the same row. `login`/`login_failed` have no trigger point pre-M5 (no auth yet); `panic_disconnect` is indistinguishable from an ordinary disconnect at the protocol level today (tracked as a known gap, not fabricated) — both ship once M5/a distinguishing wire signal lands. |
| Persistent unauthorized access   | Session **expiry**; trusted devices are explicit and revocable; every new pair still logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Secure defaults

- Deny by default: no session without Approve; no media before `pair-approved`.
- Least privilege: `view` unless `control` is explicitly granted.
- Ephemeral secrets: pairing tokens in Redis only, never persisted; TURN creds
  short-lived.

## Known gaps / production hardening checklist (pre-launch)

- [x] Enforce **WSS/HTTPS** everywhere — `loadEnv()` refuses to boot with
      `NODE_ENV=production` and a plaintext `PUBLIC_BASE_URL`/`SIGNALING_URL`
      ([`packages/shared/src/env.ts`](../packages/shared/src/env.ts)). HSTS
      itself is a reverse-proxy/TLS-terminator concern (native desktop/mobile
      clients don't consume it) — remains open only for `apps/admin`, if that
      is ever served directly rather than behind a proxy that already sets it.
- [x] **Time-limited TURN credentials** — coturn `use-auth-secret` + per-session
      HMAC creds ([turn/credentials.ts](../apps/backend/src/turn/credentials.ts)).
      Remaining: **rotate the shared secret** itself in production.
- [x] **Redis authentication** — `loadEnv()` refuses to boot in production
      with an unauthenticated `REDIS_URL`
      ([`packages/shared/src/env.ts`](../packages/shared/src/env.ts)).
- [x] **`trustProxy` configuration** — rate limiting and per-IP connection
      caps no longer silently key on a reverse proxy's own IP; configurable
      via `TRUST_PROXY` ([`apps/backend/src/trustProxy.ts`](../apps/backend/src/trustProxy.ts)).
- [x] **Room-auth binding (seat-hijack fix)** — `register()`'s first-seat claim
      is checked against the pairing flow's own record before a `Room` is
      ever created ([`apps/backend/src/services/roomAuth.ts`](../apps/backend/src/services/roomAuth.ts),
      gated at the route layer in
      [`apps/backend/src/routes/signaling.ts`](../apps/backend/src/routes/signaling.ts)
      so `SignalingHub` itself stays synchronous). Residual gap: `deviceId`
      is still a self-asserted string at redemption time — full closure is
      [docs/m5-auth-design.md](m5-auth-design.md).
- [x] **View/control scope enforcement** — a view-only session's input is
      dropped at the desktop's injection boundary
      ([`apps/desktop/src-tauri/src/input/dispatcher.rs`](../apps/desktop/src-tauri/src/input/dispatcher.rs)),
      not just hidden by the mobile UI.
- [x] **Per-route rate limits** — every auth, enrollment, pairing and device
      route carries its own `config.rateLimit` on top of the global 120/min,
      and the per-IP key was verified unspoofable against production:
      `X-Forwarded-For` and `X-Real-IP` changed nothing, and `CF-Connecting-IP`
      is refused at Cloudflare's edge with a 403. **IP reputation remains
      open** — there is none.
- [x] **Signed desktop auto-update** — the updater verifies an Ed25519
      signature over a BLAKE2b-512 prehash before installing, and the published
      v0.1.1 artifact was verified end to end: the minisign key id matches the
      public key compiled into the shipped app, and the signature validates
      against the 21,106,156-byte tarball for both platform entries. This is
      **not** the same as code signing: the app is ad-hoc signed, Gatekeeper
      rejects it with "no usable signature", and that needs an Apple Developer
      ID (see docs/deployment.md).
- [x] **Full device-trust rollout** — delivered by M9/ADR-0010. Every route
      resolves its actor from a signed token rather than the request body;
      verified against production by driving the whole linking ceremony over
      the API and then failing to break it nine different ways.
- [x] **A password reset removes the attacker, not just their session.**
      Resetting the password revokes the account's refresh tokens **and every
      device on the account**, and ends those devices' live rooms
      ([`routes/auth.ts`](../apps/backend/src/routes/auth.ts),
      [`services/accountDevices.ts`](../apps/backend/src/services/accountDevices.ts)).
      Sessions alone were not enough: a device key is a credential in its own
      right (ADR-0002) and never presents the password again, so somebody who
      signed in with a stolen password — which enrols their machine, ADR-0015 —
      kept a working device token, a place on the account, and the ability to
      list, rename and revoke the victim's own Macs, after the victim had done
      the one thing the product tells a compromised user to do. The cost is
      that the owner's own machines are signed out too, which is what "reset my
      password" means everywhere else and what both clients recover from by
      signing in again.
- [ ] Optional: require the desktop to re-confirm for `control` scope escalation.
- [x] **Data retention policy for audit logs; PII minimization** — the policy is
      **2 days**, and it is enforced rather than documented:
      [`services/auditRetention.ts`](../apps/backend/src/services/auditRetention.ts)
      deletes every row past the window on boot and hourly thereafter. Two days
      because of what the rows hold — an IP address, an account, a device and a
      metadata blob per sign-in, pairing and session, which together are a
      movement log of a person's machines. The questions that need them
      ("what just happened?", a live support case) are same-day questions;
      anything longer is a liability that buys nothing.
- [x] **Account deletion** — `DELETE /account` (docs/api.md), reachable from the
      Mac at Your account → Delete account. Removes the account, its devices,
      its pairs and every refresh token; ends every live session for those
      devices; and refuses the caller's own token from that moment on. Audit
      rows survive it _anonymised_ and then expire on the 2-day clock above:
      deleting an account is neither a way to erase what it did nor a way to
      keep the record longer than anyone else's.
- [ ] IP reputation on pairing/auth (split out of the item above).

### Residual: revocation is fast, not instantaneous

Access tokens are verified by signature alone (ADR-0001) so that an unavailable
Postgres cannot break sessions already running. The cost is a ten-minute lag on
any authorization change, revocation included. Three things bound it:

- Revoking a device revokes the account's **refresh tokens**, so no new token
  can be minted (`routes/devices.ts`).
- Every route a revoked device could still reach re-checks the device row
  (`auth/liveDevice.ts`), so the stale token buys nothing on the management
  surface, the pairing surface, or signaling.
- Re-enrolling a revoked device requires a credential **minted after** the
  revocation (`auth/deviceRegistry.ts`), so the window cannot be used to make
  itself permanent.

What remains is any route that authorizes on the token alone and does not touch
the database. There are none today; this is written down so that adding one is a
deliberate act rather than an oversight.

## Explicit non-goals (v1)

No custom crypto/transport (rely on WebRTC/TLS), no LAN-only bypass of approval,
no gaming-grade latency shortcuts that weaken security, no background/headless
access without the on-screen indicator.
