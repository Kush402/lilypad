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

| Threat                           | Mitigation                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Stolen/replayed QR token         | Tokens are **single-use** (Redis GETDEL) with a **60s TTL**, high-entropy, bound to the desktop device + room. **Enforced at the WS layer too**: `SignalingHub`'s room-auth check ([`apps/backend/src/services/roomAuth.ts`](../apps/backend/src/services/roomAuth.ts)) rejects a `register` attempt whose `roomId` was never issued by the pairing flow, or whose `deviceId` doesn't match the device that flow actually issued it to — a leaked/guessed `roomId` alone no longer wins a seat. |
| QR shoulder-surfing / screenshot | Short TTL + single-use; the token alone is useless without the desktop-side Approve.                                        |
| Silent/unattended takeover       | Mandatory **Approve/Deny** on desktop; **visible session indicator**; **panic disconnect** in tray.                         |
| Man-in-the-middle on signaling   | **WSS** (TLS) in production; SDP fingerprints bind the DTLS handshake — media MITM fails.                                   |
| Media eavesdropping              | WebRTC **DTLS-SRTP** is mandatory; no unencrypted media.                                                                    |
| Over-broad permissions           | **Scopes** (`view` vs `control`), enforced at the desktop's input-injection boundary ([`apps/desktop/src-tauri/src/input/dispatcher.rs`](../apps/desktop/src-tauri/src/input/dispatcher.rs)) — a view-only session's pointer/key/clipboard events are dropped before they ever reach the OS, not just hidden by the mobile UI. |
| TURN abuse / cred theft          | **Time-limited rotating TURN credentials** (use-auth-secret) in production, issued per session — not the static dev secret. |
| Brute force / flooding           | **Rate limits** on pairing + auth (tightened in M6); room seat cap (2).                                                     |
| Account compromise (M5)          | Password hashing (argon2/bcrypt), session expiry, device binding, trusted-device revocation — full design in [docs/m5-auth-design.md](m5-auth-design.md). |
| Repudiation                      | **Audit logs** ([`apps/backend/src/services/auditLog.ts`](../apps/backend/src/services/auditLog.ts)): `device_paired`, `session_start`, `session_end`, `pair_denied` are implemented today. `login`/`login_failed` have no trigger point pre-M5 (no auth yet); `panic_disconnect` is indistinguishable from an ordinary disconnect at the protocol level today (tracked as a known gap, not fabricated) — both ship once M5/a distinguishing wire signal lands. |
| Persistent unauthorized access   | Session **expiry**; trusted devices are explicit and revocable; every new pair still logs.                                  |

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
- [ ] Per-route rate limits + IP reputation on pairing/auth.
- [ ] Signed desktop auto-update (M6) to prevent tampered binaries.
- [ ] Optional: require the desktop to re-confirm for `control` scope escalation.
- [ ] Data retention policy for audit logs; PII minimization.
- [ ] Full M5 auth/device-trust rollout — design complete
      ([docs/m5-auth-design.md](m5-auth-design.md)), implementation is M5 scope.

## Explicit non-goals (v1)

No custom crypto/transport (rely on WebRTC/TLS), no LAN-only bypass of approval,
no gaming-grade latency shortcuts that weaken security, no background/headless
access without the on-screen indicator.
