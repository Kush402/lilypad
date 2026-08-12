---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: M3 production audit — backend security findings.
---

# Lilypad Backend Security Audit — M3 Hardening Pass

**Scope:** `apps/backend` (Fastify + Redis + Postgres signaling/pairing service), the shared `packages/protocol` and `packages/shared` contracts it depends on, `infra/` deployment config, and the desktop-side (`apps/desktop/src-tauri`) enforcement points that the backend's authorization model depends on for its guarantees to actually hold end-to-end.

**Method:** every file listed in the audit brief was read in full; every claim below cites `file:line`. Where a claim depends on a file outside the initial list (e.g. `apps/desktop/src-tauri/src/commands.rs`, `session.rs`, `input/worker.rs`, `docker-compose.yml`), that file was read in full before the claim was made. No source file was modified as part of this audit.

**Overall verdict:** the signaling/pairing surface is well-engineered _as a protocol relay_ — schema validation is strict (`packages/protocol/src/signaling.ts`), the state machine is exhaustive (`apps/backend/src/session/stateMachine.ts`), abuse guards exist for the cheap vectors (`apps/backend/src/signaling/guards.ts`), and the team has clearly already reasoned about GETDEL atomicity, TURN secret exposure, and dev-secret leakage into production. But the system currently has **no identity layer**. Every actor — desktop, mobile, room, device — is a string the client asserts about itself, and the one high-entropy secret that stands in for identity (`roomId`) is never checked against the pairing system that mints it. Combined with plaintext transport being the shipped default and scope enforcement not existing anywhere in the data path, the product today provides _authorization theater_: the UI shows an Approve/Deny dialog and a view/control toggle, but neither is backed by a check that would stop a technically capable attacker or a modified client. None of this is a knock on code quality — the gaps are exactly the ones the codebase's own comments and `docs/threat-model.md` checklist already flag as open. This report turns those checklist items into concrete, implementable designs and adds several the checklist does not yet mention (Redis auth, audit log implementation, rate-limiter key correctness behind a proxy, scope enforcement's complete absence on the desktop).

**Controls verified as sound (not re-litigated below):**

- Pairing token entropy and single-use semantics: `randomBytes(24)` (192 bits) plus atomic `GETDEL` (`apps/backend/src/services/pairing.ts:39`, `:83`) — no TOCTOU window; a replayed token cannot succeed twice regardless of concurrency.
- WS frame size cap preventing single-frame event-loop stalls (`apps/backend/src/server.ts:31`).
- Signaling envelope/payload validation via `zod` discriminated unions rejecting anything malformed before it reaches business logic (`packages/protocol/src/signaling.ts:168-186`).
- The TURN shared secret is never serialized to a client; only derived per-session HMAC credentials are (`apps/backend/src/config.ts:19-24`, `apps/backend/src/turn/credentials.ts:34-42`).
- Production boot refuses to start with the two literal, publicly-known dev secrets (`packages/shared/src/env.ts:50-61`) — a good pattern, though narrower than it should be (Finding 11).
- Re-registration into an _already-occupied_ seat is correctly rejected (`apps/backend/src/signaling/hub.ts:276-280`), and role spoofing on an established connection is caught (`hub.ts:145-148`). The gap is specifically the _first_ registration into a virgin seat (Finding 1).

---

## Finding 1 — `roomId` is a bearer capability with no proof of possession; WS registration is fully decoupled from the pairing system (seat hijack)

**Severity: Critical**

### Current implementation

`SignalingHub.register()` (`apps/backend/src/signaling/hub.ts:248-301`) accepts a `register` message from any WebSocket client carrying an arbitrary `roomId` string (bounded only by the protocol's `1..128` char length check, `packages/protocol/src/signaling.ts:41`) and an arbitrary, self-asserted `deviceId` (`min(8).max(128)`, `signaling.ts:53`). If no `Room` exists yet for that `roomId`, one is created on the spot (`hub.ts:262-275`); if the requested seat (`desktop`/`mobile`) is empty, the caller claims it unconditionally (`hub.ts:276-296`). At no point does `register()` consult Redis, the pairing service, or any other record of which `roomId`s were actually issued by `POST /pairing/create` (`apps/backend/src/services/pairing.ts:35-65`) or redeemed by `POST /pairing/redeem` (`pairing.ts:79-97`). The two systems share a `roomId` value purely by convention — the hub trusts it on sight.

The only protection against a second party claiming a seat is the `seat_taken` check (`hub.ts:276-280`), which fires _after_ a seat is occupied, and the `vacated`/re-register grace check (`hub.ts:283-288`), which only applies to a seat that previously held a peer and dropped mid-session. **Neither applies to the very first registration into an empty seat.** Whoever's `register` frame lands first, wins the seat — there is no cross-check against the pairing record's `desktopDeviceId` (`pairing.ts:45`) or any device credential at all.

### Problems

1. **Race-to-register hijack.** If a third party learns a `roomId` before the legitimate mobile device registers (see Finding 3 for how plaintext transport makes this trivial), it can send `register {role: "mobile", deviceId: "<anything>"}` first and permanently occupy the mobile seat for that room. The real phone's subsequent `register` gets `seat_taken` (`hub.ts:277`) and is locked out — a denial-of-service at minimum, session takeover at worst if the desktop user approves the attacker's `pair-request` (the desktop UI has no way to distinguish the attacker's `deviceName`, which is also self-asserted and unauthenticated, from the real device's — `packages/protocol/src/pairing.ts:46`, `signaling.ts:62`).
2. **Room-exhaustion DoS bypasses pairing entirely.** Because `register()` never checks Redis, an attacker does not need to call `/pairing/create` at all to consume the global room budget. It can open WebSocket connections and send `register` with freshly generated `roomId` strings directly, each one instantiating a `Room` object (`hub.ts:262-275`) that counts against `maxRooms` (`hub.ts:74-76`, default `10_000`). Combined with the per-IP connection cap of 20 (`apps/backend/src/routes/signaling.ts:12`), an attacker needs roughly 500 distinct source IPs (trivial with cloud/IPv6 pools) to exhaust the room table and start rejecting real pairing attempts with `capacity` errors (`hub.ts:256-260`).
3. **The pairing token secures nothing at the WS layer.** The entire security narrative in `docs/threat-model.md:24` ("Stolen/replayed QR token ... bound to the desktop device + room") is true only for the REST redemption step. Once `roomId` is known by _any_ means (leak, guess, brute force of the 128-char-bounded but otherwise unvalidated string space, or — more realistically — network observation per Finding 3), the pairing token adds no further gate to entering the room.

### Root cause

Two independently-designed subsystems (Redis-backed single-use pairing tokens, and an in-memory WS room table) were bridged only by sharing a string value, with an implicit assumption that the string is secret and only reaches legitimate parties. That assumption is not enforced by anything — no signature, no server-side lookup, no expiry tied to the pairing record's TTL.

### Redesign

Make the signaling hub verify room legitimacy and device identity against the same source of truth the pairing service already writes to:

1. **Add a Redis-backed room-authorization record.** When `createPairing()` runs, also write `lilypad:room-auth:<roomId> → { desktopDeviceId, ttl }` with a TTL equal to a new, generous "room claim window" (e.g. 10 minutes — long enough to cover pairing + QR display + scan + redeem, short enough to bound exposure). `redeemPairing()` extends/rewrites this record with `mobileDeviceId` once redemption succeeds.
2. **`SignalingHub.register()` must look up this record before creating a `Room`.** Inject a `RoomAuthStore` dependency (mirroring how `buildIceServers` is injected today, `hub.ts:23-24`) with a method `verify(roomId, role, deviceId): Promise<boolean>`. For `role: 'desktop'`, the record's `desktopDeviceId` must match; for `role: 'mobile'`, it must match `mobileDeviceId` (only present after `/pairing/redeem`). Reject with a new `unauthorized_room` error code (extending the existing `sendError` pattern, `hub.ts:469-478`) and close the socket (mirroring `capacity`'s `peer.close(4429, ...)` pattern, `hub.ts:258-260`) if the check fails.
3. Because `register()` is currently synchronous and the rest of the hub is designed to be pure/testable (`hub.ts:78-84`), thread the async lookup through as already done for persistence hooks (`onSessionStart`, etc. are fire-and-forget; this one is NOT — it's a gate, so it must be awaited before seat assignment). This requires converting `handleMessage`'s `register` branch to async plus buffering/rejecting frames that arrive before the async check resolves (a few-ms Redis round trip) — use a short in-flight guard per peer to avoid a double-register race during the await.
4. This closes Finding 1 without requiring the full M5 auth system: it is enforceable today because the pairing service already has an authoritative `desktopDeviceId` and, post-redemption, `mobileDeviceId`. It does not yet cryptographically prove device identity (that's Finding 15 / M5) but it does prove _possession of the specific pairing flow's token_, which is the property the threat model already claims to provide.

### Tradeoffs

- Adds one Redis round-trip to every `register` (a few ms) — negligible against WS connection setup cost, but it does mean `register()` can no longer be handled fully synchronously/in-process, which is a real architectural change to the hub's current design (everything else in `hub.ts` is deliberately pure and synchronous, `hub.ts:78-84`).
- Requires the pairing service and the hub to share a Redis client/namespace, which they already do (`redisKeys`, `packages/shared/src/constants.ts:4-9`) — low integration cost.
- Does not fully solve device impersonation (a stolen/leaked _token_ still lets an attacker redeem as "the mobile device," because `deviceId` in `/pairing/redeem`'s body is still self-asserted, `pairing.ts` request schema, `packages/protocol/src/pairing.ts:44-48`). Full resolution requires Finding 15's device-identity design.

### Implementation plan

1. Extend `PairingRecord` (`services/pairing.ts:14-20`) and add `RoomAuthRecord` type with `desktopDeviceId`, `mobileDeviceId | null`, `expiresAt`.
2. Write the record in `createPairing()` alongside the existing `client.set(...)` call (`pairing.ts:51-56`); update it in `redeemPairing()` after the `GETDEL` succeeds (`pairing.ts:83-88`).
3. Add `RoomAuthStore` interface + Redis-backed implementation; inject into `SignalingHub` via `SignalingHubDeps` (`hub.ts:22-44`).
4. Convert `register()` to `async register()`, await the store lookup before the `seat_taken`/`vacated` checks; add a small `Set<Peer>` of "register in flight" peers to reject a concurrent second `register` frame from the same peer with a `duplicate_register` error while the first is pending.
5. Add a TTL cleanup job or rely on Redis TTL alone (simplest — no cron needed).
6. Update `docs/threat-model.md:24` to describe the new, actually-enforced binding.

### Migration strategy

Ship behind a feature flag (`ROOM_AUTH_ENFORCED=false` default in staging) for one release so existing mobile/desktop builds that might be mid-flight during a rollout aren't locked out; flip to `true`-only (remove the flag) once client versions are confirmed compatible. No data migration needed — this is additive Redis state with TTLs, nothing to backfill.

### Testing strategy

- Unit: extend `apps/backend/src/signaling/hub.test.ts` — add a case "rejects register for a roomId with no pairing record," "rejects register when deviceId doesn't match the pairing record's desktopDeviceId," "accepts mobile register only after redemption recorded mobileDeviceId."
- Unit: extend `apps/backend/src/services/pairing.test.ts` for the new record shape.
- Integration: end-to-end test that spins up Redis (already used per `vitest.config.ts`/existing patterns) and drives create → (attacker registers first with wrong deviceId) → rejected → real device registers → accepted.
- Load test: confirm the added Redis round-trip doesn't regress `register` latency past an agreed SLO (e.g. p99 < 50ms) under the existing room-cap stress scenario already covered by `hub.test.ts:287-306`.

### Risk assessment

High confidence, high value fix — this is the single highest-leverage change in this report because it converts the pairing token from "informational" to "actually authorizing" at the only layer (the WS hub) that grants access to a live session. Residual risk: still relies on `deviceId` self-assertion at redemption time; full closure needs Finding 15.

### Performance impact

One additional Redis GET (or reuse of the existing pairing-record read pattern) per `register` frame — sub-millisecond to a few ms depending on Redis locality; negligible relative to WebRTC negotiation timescales (hundreds of ms to seconds).

### Future extensibility

This `RoomAuthStore` is the natural seam where M5's device-trust system plugs in later: instead of a bare `deviceId` string match, `verify()` can be upgraded to check a signed challenge (Finding 15) without touching the hub's call site.

---

## Finding 2 — View/control scope is asserted in the protocol but enforced nowhere in the data path

**Severity: Critical**

### Current implementation

The protocol defines `SessionScope = 'view' | 'control'` (`packages/protocol/src/pairing.ts:18-19`) and threads it through: the mobile sends `requestedScopes` in `pair-request` (`packages/protocol/src/signaling.ts:57-65`), the desktop is supposed to grant `grantedScopes` in `pair-approved` (`signaling.ts:70-76`), and the hub forwards `grantedScopes` to both peers in `session-start` (`hub.ts:382-413`, `signaling.ts:104-112`). Following the actual desktop implementation, however:

- `create_pairing()` sets `AppState.offered_scopes` once, at pairing-creation time, defaulting to `["view", "control"]` and never varying it (`apps/desktop/src-tauri/src/state.rs:31-32,45`, `apps/desktop/src-tauri/src/commands.rs:86-89,147`).
- When the mobile's `pair-request` arrives, the desktop only _displays_ `requested_scopes` to the UI via `SessionEvent::PairRequested` (`apps/desktop/src-tauri/src/session.rs:520-526`, `session.rs:37-40`) — the value is never read back into the approval path.
- `approve_session()` — the Tauri command the Approve button actually invokes — always sends `Control::Approve(s.offered_scopes.clone())`, i.e. the fixed desktop-side default, completely ignoring whatever the phone requested (`apps/desktop/src-tauri/src/commands.rs:216-223`).
- Once a session is live, `InputWorker` is enabled purely on `peer_connected && input_channel_open` (`apps/desktop/src-tauri/src/session.rs:157-163, 233-235, 307, 339-347, 400`) — there is no third condition checking `grantedScopes` contains `"control"`.
- `InputWorker::handle_message()` (`apps/desktop/src-tauri/src/input/worker.rs:88-98`) and the `InputDispatcher` it feeds simply decode and execute every batch of `InputEvent`s (`worker.rs:64-73`) with no scope parameter anywhere in the call chain. `grep` across `apps/desktop/src-tauri/src/input/*.rs` confirms zero references to "scope" in the entire input subsystem.

### Problems

The net effect: **there is no code path, anywhere in this repository, that can produce a session where `control` input is rejected while `view` is allowed.** The scope selector is fully cosmetic today:

1. A mobile client cannot even request view-only in a way the desktop will honor — the desktop always grants its fixed offered set on Approve.
2. Even if it could, the desktop's `InputWorker` would still execute every keyboard/mouse/clipboard event once the DataChannel is open, because scope is never consulted at the point where input is actually injected into the OS.
3. This means a modified/malicious mobile client (or a legitimate client with a bug) that was ostensibly granted `view` only can send full `key_down`/`click`/`clipboard` events and have them executed on the desktop with no server or client-side rejection. Given this is a remote-desktop product whose entire value proposition includes screen-share-only mode, this is a materially false security/privacy guarantee to end users.

### Root cause

Scope was designed as a protocol-level field and plumbed through message schemas, but the two places that need to _act_ on it — the desktop's approve handler (should narrow to the intersection of offered ∩ requested, or at minimum respect a user-facing choice) and the input-injection worker (should gate `key_*`/`pointer_*`/`clipboard`/`shortcut` events on `"control" ∈ grantedScopes`) — were never wired to it. This reads as a feature that was scaffolded (types, schema, UI event) but never load-bearing wired end-to-end — exactly the kind of gap an M2→M3 hardening pass should catch before it ships as a trust boundary.

### Redesign

1. **Desktop: thread `grantedScopes` from `session-start` into `InputWorker`.** Add `InputWorker::set_scopes(&self, scopes: HashSet<Scope>)` (mirroring the existing `set_enabled` message pattern, `worker.rs:74,100-104`), called from `session.rs` wherever `SessionEvent`/session-start handling currently lives (near the existing `input.set_enabled(...)` call sites, `session.rs:307,339-347`). Store the granted scope set in the `InputDispatcher` and have `process_batch` (`worker.rs:67`) filter: `pointer_*`, `click`, `scroll`, `key_*`, `text_input`, `shortcut`, and `clipboard` events all require `Scope::Control`; nothing currently defined requires only `Scope::View` for input (view-only sessions send **no** input events at all, by design — the gate should simply be "drop the entire batch, log once, bump a metric" if `control` isn't granted).
2. **Desktop: make Approve actually reflect what's requested.** `approve_session()` should either (a) present the user a scope-selection UI backed by `requested_scopes` from the last `PairRequested` event (store it in `AppState` alongside `offered_scopes` when the event arrives, `commands.rs:169-198`), and send `grantedScopes = intersection(offered_scopes, requested_scopes, user_selection)`, or, as a minimal fix, (b) send `grantedScopes = intersection(offered_scopes, requested_scopes)` automatically with no new UI, closing the gap without a design change. Either way, `Control::Approve` must stop hardcoding `offered_scopes` verbatim (`commands.rs:223`).
3. **Backend: defense in depth.** Although the hub is explicitly out of the media/data path (`docs/threat-model.md:18`), it _does_ own the `pair-approved`→`session-start` transition (`hub.ts:382-413`) and could reject a `grantedScopes` that is not a subset of the room's `scopes` set from the original `pair-request` (`hub.ts:317-322`), catching a compromised desktop client that tries to grant more than was ever requested. This is a cheap, purely-server-side check worth adding regardless of the desktop fix.

### Tradeoffs

Filtering in the input worker is a small, low-risk change (a `HashSet` check before dispatch). The bigger cost is UX: deciding what a user sees when scopes are requested vs. offered (a full scope-negotiation UI is a product decision, not purely engineering) — the minimal auto-intersection fix (2b) avoids that cost and should ship first; a richer picker can follow later without changing the enforcement point.

### Implementation plan

1. Add `Scope` enum + `HashSet<Scope>` field to `InputDispatcher` (`apps/desktop/src-tauri/src/input/dispatcher.rs`) with a `set_scopes`/`allows(kind)` method.
2. Wire `InputWorker::set_scopes` (new) → called from `session.rs` at the same point `input.set_enabled(...)` is called after `session-start` is received, using `p.granted_scopes` from `messages::SessionStartPayload` (already parsed, `session.rs:528-538` region).
3. Fix `commands.rs:216-223` to intersect stored `requested_scopes` (persist it from `PairRequested`, `session.rs:522-526`) with `offered_scopes` before sending `Control::Approve`.
4. Add the backend-side subset check in `hub.ts`'s `pair-approved` handler (`hub.ts:324-326` → `approve()` at `hub.ts:382`).
5. Add a user-visible indicator when a batch is dropped for scope reasons (log + metric at minimum; UI toast ideally) so a legitimate control-granted session that silently loses control (bug) is debuggable.

### Migration strategy

Pure logic fix, no data migration. Ship desktop + backend changes together (backend defense-in-depth check is a no-op until desktop starts sending a real intersection, but should land first so a stale desktop build can't over-grant against a patched backend).

### Testing strategy

- Rust unit tests in `apps/desktop/src-tauri/src/input/dispatcher.rs`'s existing test module: assert a `control`-less scope set drops `key_down`/`click`/`clipboard` batches and increments a "dropped: scope" counter, while an empty/`view`-only session still allows... nothing (view sessions send no input; this is a negative test to ensure grant absence truly blocks execution).
- `commands.rs` unit/integration test (or a session.rs integration test) asserting `Control::Approve` payload equals the intersection of offered and requested scopes, not the raw offered set.
- Backend: `hub.test.ts` case "rejects pair-approved granting a scope never requested."
- Manual verification step (per the mandated `verify` skill for any behavior change): pair with a scope of `view` only requested, confirm mouse/keyboard input from the phone is provably dropped (log line / metric), not just "the mobile app didn't send it."

### Risk assessment

Critical — this is the gap between the marketed feature ("screen mirroring only, no control") and reality. Any customer relying on view-only mode for compliance/privacy reasons (e.g. sharing a screen with an untrusted party) is currently unprotected against a modified client.

### Performance impact

Negligible — one `HashSet` membership check per input batch, already on a dedicated OS thread (`worker.rs:35-37`) well off any latency-critical path.

### Future extensibility

The `Scope`-gated dispatcher is also the natural hook for finer-grained scopes later (e.g. `clipboard`, `file-transfer`) without re-touching the transport layer — each new capability becomes one more enum variant checked in the same place.

---

## Finding 3 — No enforced transport encryption; plaintext is the shipped default across HTTP, WebSocket, and TURN control channel

**Severity: Critical**

### Current implementation

`packages/shared/src/env.ts:11-25` defaults `PUBLIC_BASE_URL` to `http://localhost:8080` and `SIGNALING_URL` to `ws://localhost:8080/ws/signal`; `STUN_URL`/`TURN_URL` default to `stun:`/`turn:` (no `s` variants). `QrPayloadSchema.signalingUrl` explicitly accepts either a URL _or_ a bare `ws`-prefixed string (`packages/protocol/src/qr.ts:21`: `z.string().url().or(z.string().startsWith('ws'))`), i.e. the schema does not require `wss://`. `infra/coturn/turnserver.conf:29-30` sets `no-tls` / `no-dtls` for the TURN control channel, with a comment acknowledging it's dev-only (`turnserver.conf:29`). `packages/shared/src/env.ts`'s production-boot refusal (`env.ts:50-61`) only checks two variables (`TURN_SECRET`, `DATABASE_URL`) against known literal dev-default _strings_ — it has no logic at all that inspects `PUBLIC_BASE_URL`/`SIGNALING_URL`'s scheme, so a production deploy that simply forgets to put a TLS-terminating reverse proxy in front (there is no reverse-proxy config anywhere in the repo — confirmed by an exhaustive search for nginx/Caddy/Traefik config, none exist) boots successfully serving plaintext HTTP and WS to the internet, with no warning.

### Problems

1. `docs/threat-model.md:27` claims "Man-in-the-middle on signaling | **WSS** (TLS) in production" as a mitigation, and lists "Enforce WSS/HTTPS everywhere; HSTS" as an unchecked (`[ ]`) pre-launch item (`threat-model.md:45`). Nothing in code enforces or even nudges toward this — it is entirely an operational/deployment-runbook responsibility with zero fail-safe.
2. Plaintext signaling directly enables Finding 1's hijack scenario: `roomId`, `deviceId`, `deviceName`, SDP offers/answers, and (embedded in `session-start`) the TURN `username`/`credential` all traverse the wire unencrypted if an operator ships the defaults. An on-path attacker (shared Wi-Fi, compromised router, transparent proxy) can read the `roomId` the moment the desktop's QR-encoded payload is fetched or the WS handshake happens, then race to register (Finding 1) or simply harvest the TURN credential for relay abuse (Finding 7).
3. Plaintext REST also means `/pairing/create`'s response — containing the single-use `token` itself — is interceptable over the wire before the phone even scans the QR, if `PUBLIC_BASE_URL` communication happens over the network rather than being purely local (the QR flow, by design, sends the token to the phone out-of-band via the QR image, not over the network — so this specific leg is fine — but `/pairing/redeem`'s request, which contains the raw token, absolutely does cross the network from phone to backend, and would be observable in plaintext).

### Root cause

TLS termination was treated as a pure ops concern (mentioned in `.env.example` comments: "On real internet use https://api.yourdomain.com") with no corresponding code-level guardrail, unlike the (partial) guardrail that already exists for secret values (`env.ts:50-61`). The team clearly knows this is required (the threat model documents it) but the enforcement pattern that worked for secrets was never extended to schemes/transport.

### Redesign

1. Extend the existing production fail-fast check (`env.ts:50-61`) with a scheme check: in production, refuse to boot if `PUBLIC_BASE_URL` does not start with `https://`, or if `SIGNALING_URL` does not start with `wss://`, or if `STUN_URL`/`TURN_URL` allow plaintext without an explicit escape hatch (TURN over UDP/TCP without TLS is normal — DTLS-SRTP still protects the actual media; the concern is the _signaling_ and _REST_ legs, not TURN media relay itself, so scope the check to `PUBLIC_BASE_URL`/`SIGNALING_URL`).
2. Add an explicit `ALLOW_INSECURE_TRANSPORT` escape hatch (default `false`) for legitimate cases (LAN-only deployments, internal testing) so the check is a deliberate override, not a silent bypass.
3. Tighten `QrPayloadSchema.signalingUrl` (`qr.ts:21`) to require `wss://` (or `ws://` only when a corresponding "insecure" flag is also present in the payload, so a scanner can visibly warn the user) rather than silently accepting either.
4. Document (and ideally provide, e.g. a Caddy/Compose profile) a reference TLS-terminating reverse-proxy config in `infra/`, since none currently exists — this turns "the operator must know to add TLS" into "the reference deployment ships with it on by default and turning it off requires an explicit choice."

### Tradeoffs

This will break purely-local/dev/LAN setups that intentionally run without TLS (the whole current dev experience, per `.env.example`) unless `NODE_ENV=development`/`test` is exempted (it already is, implicitly, since the check in `env.ts:51` only applies `if (parsed.data.NODE_ENV === 'production')`) or the explicit `ALLOW_INSECURE_TRANSPORT` flag is set for controlled LAN deployments the product may still want to support.

### Implementation plan

1. Add scheme-validation logic to `loadEnv()` in `packages/shared/src/env.ts`, symmetric with the existing `INSECURE_DEV_DEFAULTS` block (`env.ts:35-38,50-61`).
2. Add `ALLOW_INSECURE_TRANSPORT: z.coerce.boolean().default(false)` to `EnvSchema` (`env.ts:8-26`).
3. Update `qr.ts:21`'s schema and the desktop's `QrPayloadDto`/`decode_qr_payload` equivalents to reject plaintext unless the insecure flag is echoed in the payload.
4. Add an `infra/Caddyfile` (or nginx equivalent) reference config terminating TLS in front of the Fastify app and coturn's TLS listener, referenced from `docker-compose.yml`.
5. Update `turnserver.conf` production guidance to enable `cert`/`pkey`/remove `no-tls`/`no-dtls` for internet-facing deployments, with the dev file kept plaintext for local Docker Compose use.

### Migration strategy

Additive env var with a safe default (`false` = strict in production, i.e. no behavior change needed for anyone already deploying correctly with HTTPS/WSS); anyone currently running plaintext-in-production (if any) will need to set the escape hatch temporarily while they stand up TLS termination — surfacing this loudly is the point.

### Testing strategy

- Unit test in `packages/shared` (mirroring existing env tests) asserting `loadEnv()` throws in production with a plaintext `PUBLIC_BASE_URL`/`SIGNALING_URL` and no escape hatch, and succeeds with the hatch set or with `https/wss` schemes.
- Integration/manual: boot the backend with `NODE_ENV=production` and default `.env` values, confirm it refuses to start with a clear error (matching the existing pattern's UX, `env.ts:47`).

### Risk assessment

High value, low implementation risk — this is primarily a validation/config change, not a runtime redesign. It converts a silent, easy-to-miss operational requirement into a loud boot-time failure, which is the same pattern already proven out for secrets.

### Performance impact

None — validation runs once at boot.

### Future extensibility

The same "fail loud on insecure production config" pattern should be the template for any future secret/transport requirement (e.g. when M5 adds JWT signing keys, apply the identical treatment).

---

## Finding 4 — Redis has no authentication and is the sole store for pairing-token bearer state

**Severity: High**

### Current implementation

`infra/docker-compose.yml:29-39` runs `redis:7-alpine` with `command: ['redis-server', '--save', '', '--appendonly', 'no']` — no `--requirepass`, no ACL config. `.env.example` defines `REDIS_URL=redis://localhost:6379` with no credential component and no companion `REDIS_PASSWORD` variable. `packages/shared/src/env.ts:17` accepts any `REDIS_URL` string with no production-time check (unlike `TURN_SECRET`/`DATABASE_URL`, `env.ts:35-38`). `apps/backend/src/redis.ts:5-8` constructs the `ioredis` client directly from `env.REDIS_URL` with no additional auth options.

### Problems

Redis is not an incidental cache here — it is the **sole store of the single-use pairing token's bearer secret** (`services/pairing.ts:51-56`) and (per Finding 1's proposed fix) will also hold the room-authorization record. Anyone who can reach the Redis port — a misconfigured security group, a compromised container on the same Docker network, a cloud provider default that exposes the port, or an internal actor with lateral network access — can:

1. `KEYS lilypad:pairing:*` / read any live pairing token directly, bypassing `/pairing/create` and `/pairing/redeem` entirely.
2. Write their own `lilypad:pairing:<token>` record with an attacker-chosen `roomId`/`desktopDeviceId`, minting a token that will pass `redeemPairing()`'s validation (`services/pairing.ts:83-88`) with no interaction from a real desktop at all.
3. Read/manipulate `lilypad:session:*` records (`session/manager.ts:36-42, 90-91`).

Given Redis is explicitly called out in the docker-compose file as sitting on a published port (`docker-compose.yml:34`, `'${REDIS_PORT:-6379}:6379'`) rather than only on the internal Compose network, the exposure surface in a naive lift-and-shift deployment is direct.

### Root cause

Redis was treated purely as ephemeral session-local infrastructure ("ephemeral pairing/rooms," `docker-compose.yml:1`) without threat-modeling it as holding bearer credentials equivalent in sensitivity to a signed token.

### Redesign

1. Add `requirepass` (or better, ACL-based auth restricting the app user to only the `lilypad:*` keyspace) to the Redis service, sourced from a new `REDIS_PASSWORD` env var, mirroring the `POSTGRES_PASSWORD` pattern already used for Postgres (`docker-compose.yml:15-16`).
2. Update `REDIS_URL` construction to embed the credential (`redis://:${REDIS_PASSWORD}@host:port`) and add `REDIS_PASSWORD` (or require it be embedded in `REDIS_URL`) to the `INSECURE_DEV_DEFAULTS`-style production check in `env.ts` — refuse to boot in production if `REDIS_URL` has no credential component.
3. Stop publishing Redis's port to the host at all in any deployment profile beyond local dev (remove/parameterize the `ports:` mapping, `docker-compose.yml:34`, so it's reachable only on the internal Docker/K8s network in staging/production compose profiles).
4. Enable TLS for Redis connections in production (`ioredis` supports `tls: {}` options) if Redis is ever reached over an untrusted network segment.

### Tradeoffs

Adds one more secret to manage/rotate; negligible operational cost given Postgres already follows this pattern. No functional behavior change for legitimate traffic.

### Implementation plan

1. `docker-compose.yml`: add `REDIS_PASSWORD` env, `command: ['redis-server', '--requirepass', '${REDIS_PASSWORD}', ...]`.
2. `.env.example`: add `REDIS_PASSWORD=` with a generation hint; update `REDIS_URL` example to include it.
3. `packages/shared/src/env.ts`: add a production check that `REDIS_URL` contains credentials (e.g. regex `redis(s)?:\/\/[^:]+:[^@]+@`) or that a separate `REDIS_PASSWORD` is set and non-default.
4. Restrict the published port mapping to a `dev`-only compose override file; production compose/K8s manifests should not publish 6379 externally.

### Migration strategy

Existing dev environments keep working unauthenticated (dev-only check exemption via `NODE_ENV !== 'production'`); anyone with an existing production deployment following the current defaults must set `REDIS_PASSWORD` before their next deploy — call this out prominently in the release notes / runbook, same treatment as the existing `TURN_SECRET`/`DATABASE_URL` boot check.

### Testing strategy

- `env.ts` unit test: production boot with unauthenticated `REDIS_URL` throws.
- Integration: `docker compose up` with `REDIS_PASSWORD` set, confirm backend connects successfully and an unauthenticated `redis-cli -h ... ping` from outside the Compose network fails/is refused.

### Risk assessment

High — Redis compromise today is equivalent to full pairing-system compromise (mint arbitrary tokens, read live ones, forge session records). The fix is standard infrastructure hardening with well-understood tradeoffs.

### Performance impact

Negligible — Redis AUTH adds a single round-trip at connection time (already amortized by `ioredis`'s persistent connection, `redis.ts:5-8`).

### Future extensibility

Once Redis is credentialed, migrating to a managed Redis (ElastiCache/Upstash/etc.) for production — which will require auth regardless — becomes a drop-in swap rather than a new hardening project.

---

## Finding 5 — Rate limiting and per-IP connection caps key on `req.ip` with no `trustProxy` configuration

**Severity: High**

### Current implementation

`@fastify/rate-limit` is registered globally with `{ max: 120, timeWindow: '1 minute' }` (`apps/backend/src/server.ts:26`) and applies uniformly to every route including `/pairing/create`, `/pairing/redeem`, and the WS upgrade request. `Fastify(...)` is constructed with no `trustProxy` option (`server.ts:11-20`). Separately, `IpConnectionLimiter` (`apps/backend/src/signaling/guards.ts:10-35`) caps concurrent WS connections using `req.ip` directly (`apps/backend/src/routes/signaling.ts:65-66`).

### Problems

Fastify's default `req.ip` is the immediate TCP peer address unless `trustProxy` is configured to parse `X-Forwarded-For`/similar headers from a specifically trusted hop. Any production deployment sitting behind a load balancer, CDN, or reverse proxy (the overwhelmingly likely production topology for an internet-facing service, and the exact topology Finding 3's TLS-termination recommendation would introduce) will see **every client's `req.ip` resolve to the proxy's address**, not the real client's. This has two failure modes simultaneously:

1. **The abuse guards become a shared pool.** `IpConnectionLimiter`'s cap of 20 concurrent connections "per IP" (`routes/signaling.ts:12`) becomes a cap of 20 concurrent connections _for the entire service_, since every client looks like the same IP. A single legitimate burst of users (or one hostile client intentionally opening many sockets) locks out everyone else — the guard flips from "abuse mitigation" to "single-client DoS amplifier."
2. **The 120/min REST rate limit is similarly pooled** across all users of `/pairing/create`/`/pairing/redeem`, meaning a modest, unremarkable amount of traffic from many real users could trip a limit meant to bound one bad actor, or conversely a bad actor spraying requests behind the same proxy consumes the shared budget and starves everyone else.

### Root cause

Both guards were written and tested (correctly, per `guards.ts`'s own unit-testable design) assuming `req.ip` reflects the true client address, without accounting for the reverse-proxy topology that TLS termination and horizontal scaling both require in production.

### Redesign

1. Set `trustProxy` explicitly on the Fastify instance (`server.ts:11`), driven by an env var (`TRUSTED_PROXY_HOPS` or `TRUSTED_PROXY_CIDRS`) rather than a blanket `true` (blanket trust of `X-Forwarded-For` from _any_ client is itself spoofable — a client can simply set the header — so `trustProxy` must be configured to trust only the known number of hops / known proxy IP ranges in front of the app, per Fastify's documented `trustProxy` semantics).
2. Once configured correctly, `req.ip` will resolve to the real client address as long as the proxy in front sanitizes/overwrites (not appends to) incoming `X-Forwarded-For` from the public internet — call this out explicitly as an infra requirement alongside the TLS-termination reference config from Finding 3.
3. Add a per-route override for `/pairing/redeem` specifically (currently sharing the generic 120/min, `server.ts:26`) tightening it to something like 10/min per IP — token guessing is already infeasible given entropy (Finding-adjacent, not itself a vulnerability), but a tighter limit here reduces log noise and provides an earlier signal for credential-stuffing-style probing.

### Tradeoffs

Requires operational discipline: the `TRUSTED_PROXY_HOPS`/CIDR config must match the actual deployment topology, and getting it wrong (e.g. trusting an untrusted hop) reintroduces IP spoofing via a forged header. This is a standard, well-documented tradeoff for any proxied Node service and not unique to this codebase.

### Implementation plan

1. Add `TRUSTED_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0)` (or a CIDR-list variant) to `EnvSchema` (`packages/shared/src/env.ts`).
2. Pass `trustProxy: env.TRUSTED_PROXY_HOPS || false` into `Fastify({...})` (`server.ts:11`).
3. Add a per-route rate-limit config object to the `/pairing/redeem` route registration (`fastify/rate-limit` supports route-level overrides via `config.rateLimit`).
4. Document the required proxy configuration (append vs. overwrite `X-Forwarded-For`) in the deployment runbook.

### Migration strategy

No data migration. Purely additive config; default (`0` trusted hops) preserves today's exact behavior for anyone not yet behind a proxy, so this is safe to ship immediately and tune per-environment.

### Testing strategy

- Unit test constructing the Fastify instance with `trustProxy: 1` and asserting `req.ip` reflects `X-Forwarded-For` when the request originates from a simulated trusted hop, and does _not_ when it doesn't (Fastify/`@fastify/http-proxy` test utilities or a manual `light-my-request` injection test).
- Manual verification in the staging environment's real proxy topology: confirm two different real client IPs behind the LB are rate-limited independently.

### Risk assessment

High — this silently defeats the two abuse guards the team already built, in exactly the deployment topology the product will ship in. It's a classic "worked in dev, silently broken in prod" class of bug.

### Performance impact

None material — `trustProxy` parsing is a cheap header read already built into Fastify core.

### Future extensibility

Once `trustProxy` is correctly configured, any future per-IP feature (geo-based abuse scoring, IP reputation lists mentioned as a checklist item in `docs/threat-model.md:49`) becomes viable; today it would be building on a broken foundation.

---

## Finding 6 — Audit logging is entirely unimplemented despite being documented as a shipped mitigation

**Severity: High**

### Current implementation

`apps/backend/src/db/schema.ts:86-100` defines a complete `audit_logs` table (`userId`, `deviceId`, `eventType`, `metadata` jsonb, `ip`, `createdAt`, indexed on `eventType`). `docs/threat-model.md:33` lists, as a present-tense mitigation: "Repudiation | **Audit logs**: login, login_failed, device_paired, session_start/stop, pair_denied, panic_disconnect (with ip + metadata)." An exhaustive search of `apps/backend/src/` for any reference to `auditLogs`/`audit_log` outside the schema definition itself returns nothing — **no code path in the backend ever inserts a row into this table.** The closest analog, `SessionManager` (`apps/backend/src/session/manager.ts`), persists session state to _Redis_ with a 3600s TTL (`manager.ts:41,90-91`), shortened to 60s once a session ends (`manager.ts:78-88`) — an ephemeral operational cache, not a durable, queryable audit trail, and it carries no `ip` field, no `userId`, and is deliberately discarded within a minute of session end (`manager.ts:87`, comment: "Keep the terminal record briefly for audit/debug, then let it expire").

Separately, the desktop _does_ emit local log lines tagged `lilypad::audit` for user-initiated actions (`apps/desktop/src-tauri/src/commands.rs:124,211,221,235,243,251`) — but these are local `log::info!`/`log::warn!` calls, not sent to or persisted by the backend, and are only as durable as the desktop's local log file/rotation policy.

### Problems

1. There is no server-side, durable, queryable record of who paired with whom, when a session started/ended, who denied a pairing, or when a panic-disconnect occurred — precisely the events the threat model claims are logged "with ip + metadata."
2. If a user disputes an unauthorized access ("I never approved that session"), there is currently no backend evidence to investigate the claim — the only artifact is a desktop-local log file that the _user's own machine_ controls (and could plausibly be tampered with or simply rotated away before an investigation happens).
3. This is a direct, verifiable gap between documentation and implementation that would fail any compliance-oriented review (SOC2-style controls commonly require exactly this kind of access log).

### Root cause

The `audit_logs` table was scaffolded during initial schema design (comment: "most columns are populated across later milestones," `schema.ts:15-16`) anticipating M5 auth work, but no interim write path was built for the events that are _already_ happening pre-auth (pairing, session start/end, denial) — these don't actually require the M5 user/auth system to log; they only need `deviceId`/`roomId`/`ip`, all of which are already available at the exact call sites that would need to log them (`services/pairing.ts:35-65,79-97`; `signaling/hub.ts:382-413,432-450`).

### Redesign

1. Add a small `AuditLog` write helper (`apps/backend/src/audit/log.ts`, new) wrapping `db.insert(schema.auditLogs).values({...})`, non-blocking/fire-and-forget (matching the existing pattern for `onSessionStart`/`onSessionEnd` hooks, `hub.ts:26-44`, which are explicitly "the hub never awaits them").
2. Instrument the following call sites, all of which already have the needed data in scope:
   - `createPairing()` (`services/pairing.ts:35-65`): `pairing_created` with `deviceId`, `roomId`, requester IP (needs to be threaded in from the route handler, `routes/pairing.ts:7-14`, via `req.ip`).
   - `redeemPairing()` (`services/pairing.ts:79-97`) success and `PairingTokenError` failure paths (`routes/pairing.ts:17-31`): `token_redeemed` / `token_redeem_failed`.
   - `SignalingHub.approve()` (`hub.ts:382-413`): `session_start` with `sessionId`, `roomId`, both `deviceId`s, `grantedScopes`.
   - `dispatch()`'s `pair-denied` branch (`hub.ts:328-333`): `pair_denied`.
   - `endRoom()` (`hub.ts:432-450`): `session_end` with `reason`.
   - Add a corresponding `panic_disconnect` distinction — currently `disconnect` is a single generic reason string (`hub.ts:370-373`); consider a dedicated payload flag so panic-originated disconnects are distinguishable in the audit log, matching the threat model's explicit mention of `panic_disconnect` as its own event type (`threat-model.md:33`).
3. IP capture requires threading `req.ip` from the Fastify route handler down into the pairing service (currently the service functions take only the parsed body, `services/pairing.ts:35-38,79-82`) and from the WS route handler into the hub (currently the hub's `Peer` interface, `hub.ts:16-19`, has no IP field — add one, populated at socket accept time in `routes/signaling.ts:65-84`).

### Tradeoffs

Adds a Postgres write on the hot path of session start/end and pairing create/redeem. Should be fire-and-forget (matching the existing `void sessions.create(...).catch(...)` pattern, `routes/signaling.ts:29-38`) so a transient Postgres blip degrades audit completeness, not session availability — consistent with the product's existing "Redis blip must degrade, not take the server down" philosophy (`redis.ts:10-13`).

### Implementation plan

1. Create `apps/backend/src/audit/log.ts` with a typed `logAudit(event: {eventType, userId?, deviceId?, ip?, metadata?})` function.
2. Add `ip: string` to the `Peer` context (`hub.ts:16-19,46-50`) populated in `routes/signaling.ts`'s socket handler.
3. Thread `req.ip` into `createPairing`/`redeemPairing` call sites in `routes/pairing.ts:7-31` (pass as an extra function argument, keeping the pure-function signature testable per the existing `client: PairingRedis = redis` injection pattern, `services/pairing.ts:37,81`).
4. Instrument the six call sites listed above.
5. Add a lightweight retention/cleanup job (or Postgres partitioning) per the threat model's still-open "Data retention policy for audit logs; PII minimization" item (`threat-model.md:52`).

### Migration strategy

No schema migration needed — the table already exists (`drizzle/0000_parched_colossus.sql` presumably already includes it per the schema file; verify before shipping). Purely additive write paths; safe to deploy incrementally, one event type at a time if desired, since nothing currently reads this table (no regression risk from partial rollout).

### Testing strategy

- Unit tests for `logAudit()` (mockable DB client, following the existing `KvStore`/`PairingRedis` dependency-injection pattern used throughout this codebase, `session/manager.ts:9-13`, `services/pairing.ts:25-28`).
- Integration test: drive a full pair→approve→disconnect flow against a real Postgres (matching existing test infra) and assert the expected sequence of `audit_logs` rows exists with correct `eventType`/`metadata`.
- Add a dashboard/query smoke test (even a manual `SELECT count(*) FROM audit_logs WHERE event_type = 'session_start'` sanity check) as part of the release checklist.

### Risk assessment

High from a compliance/incident-response standpoint even though it has zero impact on runtime security controls — it affects the organization's ability to detect and respond to incidents _after_ one of the other findings in this report is exploited, which is precisely why repudiation controls matter for a remote-access product.

### Performance impact

One async Postgres insert per lifecycle event (pairing create/redeem, session start/end, denial) — a handful of writes per session, not per-message; negligible relative to WebRTC/media costs.

### Future extensibility

This is also the natural landing spot for M5's `login`/`login_failed` events already anticipated in the threat model's event list (`threat-model.md:33`) and in the `users`/`devices` schema (`schema.ts:25-48`) — the write helper built here is reused as-is.

---

## Finding 7 — TURN credentials are hour-long bearer tokens for the relay, unbound to the session beyond expiry

**Severity: Medium**

### Current implementation

`generateTurnCredential()` (`apps/backend/src/turn/credentials.ts:34-42`) mints a coturn `use-auth-secret`-scheme credential with `DEFAULT_TTL_SECONDS = 3600` (`credentials.ts:32`), embedding only an expiry timestamp and an optional `label` (`${sessionId}:${role}`, `hub.ts:408`) into the `username`. coturn's `use-auth-secret` mechanism (`infra/coturn/turnserver.conf:13-18`) verifies only the HMAC and the expiry — it has no concept of the `label` beyond what's embedded in the username string; coturn does not restrict _which_ peer or session may use a given credential, only _until when_ it's valid.

### Problems

A credential minted for `${sessionId}:desktop` is a bearer secret good for relay allocation on the TURN server for a full hour from issuance, usable by anyone who possesses the `username`/`credential` pair — not cryptographically bound to the session, IP, or peer it was issued for. If leaked (most plausibly via Finding 3's plaintext-signaling gap, since `session-start`'s payload carries `iceServers` including these credentials in cleartext over an unencrypted WS by default), an attacker gets up to an hour of anonymous TURN relay bandwidth/allocation — a resource-abuse vector (bandwidth cost, potential for using the relay to obscure the attacker's own traffic origin) entirely disconnected from the actual remote-desktop session it was minted for. There is also no revocation path: if a session ends after 2 minutes, the minted credential remains valid for the remaining ~58 minutes with no way to invalidate it early (coturn's `use-auth-secret` scheme has no revocation list; only nonce/short expiry limits exposure).

### Root cause

1 hour was chosen as "comfortably longer than a session's setup" (`credentials.ts:32` comment) — a reasonable choice to avoid mid-session ICE-restart credential expiry, but it wasn't re-examined for the _leak exposure window_ it creates, which is a different and larger concern than setup latency.

### Redesign

1. Shorten the default TTL substantially (e.g. 300s / 5 minutes) — comfortably longer than ICE gathering/negotiation (typically seconds) while shrinking the leak-exposure window by 12x.
2. For sessions that legitimately run long (hours), issue a _fresh_ credential on `renegotiate` (`hub.ts:354-358`) rather than relying on one credential's long TTL to cover the whole session lifetime — the hub already has a natural extension point here since `renegotiate` already triggers a state transition and relay.
3. Combine with Finding 3 (encrypt the transport that carries these credentials) as the primary mitigation — a short TTL reduces blast radius but doesn't replace not leaking the credential in the first place.

### Tradeoffs

More frequent credential minting means more `createHmac` calls (cheap, `credentials.ts:40`) and slightly more signaling chatter if proactively refreshed before expiry for long sessions; negligible cost either way. Shortening TTL below actual ICE-gathering time in poor network conditions could cause spurious re-negotiation — 300s is a safe floor based on typical WebRTC gathering times (seconds, not minutes), but should be validated against the product's real-world worst-case network conditions (e.g. behind restrictive corporate NATs) before finalizing.

### Implementation plan

1. Lower `DEFAULT_TTL_SECONDS` in `credentials.ts:32` (e.g. to `300`).
2. Add a proactive refresh: on `renegotiate` dispatch (`hub.ts:354-358`), call `buildIceServers` again and include fresh credentials in the relayed message (currently `renegotiate` just relays the client's own message verbatim, `hub.ts:357`; the _response_ offer/answer cycle already goes through the hub, so fresh ICE servers can be attached to the next `session-start`-equivalent event or a small new `ice-servers-refresh` message type).
3. Track outstanding credential expiry per session (optional enhancement) to log if a session runs past its last-issued credential's TTL without a refresh, as an early-warning signal.

### Migration strategy

Purely a constant change plus one new relay path; no client-breaking change since ICE server lists are already a dynamic array the client consumes generically (`packages/protocol/src/signaling.ts:12-18,110`).

### Testing strategy

- Extend `apps/backend/src/turn/credentials.test.ts` to assert the new default TTL and that `expiresAt` matches `now + newTtl`.
- Integration test: verify a `renegotiate` cycle produces a _different_ `credential` value than the original `session-start` (proves rotation, not just presence).

### Risk assessment

Medium — real but bounded impact (relay abuse, not remote-desktop compromise), and one of two independent mitigating layers already exists (short-lived by design, just not short enough given the transport-leak risk in Finding 3).

### Performance impact

Negligible — HMAC-SHA1 over a short string is microseconds.

### Future extensibility

A per-session credential-refresh mechanism is also useful groundwork for eventually supporting TURN credential revocation via a shorter coturn `stale-nonce` window (`turnserver.conf:34`) tuned in lockstep with the backend's issuance TTL.

---

## Finding 8 — No Origin validation on the WebSocket signaling upgrade

**Severity: Medium**

### Current implementation

`@fastify/cors` is registered with `{ origin: config.isDev ? true : false }` (`apps/backend/src/server.ts:22-23`), which governs CORS headers for REST responses but has no bearing on WebSocket upgrade requests (CORS is a browser-enforced, `fetch`/`XHR`-specific mechanism; browsers do not apply the CORS-preflight model to WebSocket connections, and Fastify's `@fastify/websocket` plugin registration (`server.ts:31`) performs no `Origin` header check of its own — confirmed by an exhaustive search of the backend source for `origin`/`Origin`/`verifyClient`/`checkOrigin`, none found outside the CORS registration line).

### Problems

Any web page loaded in a victim's browser (from any origin) can open a WebSocket connection directly to `SIGNALING_URL` — there is no allowlist restricting which web origins may do so. On its own this is low-severity because a connecting page still needs a valid `roomId` (currently unauthenticated per Finding 1, but at least requiring _some_ knowledge) to do anything useful; it is not, today, a CSRF-equivalent "silently ride the victim's cookies/session" vector since there is no cookie-based session at all yet. However, it removes a free, standard defense-in-depth layer, and it becomes materially more important once M5 (Finding 15) introduces cookie- or header-based session auth for the WS handshake — at that point, missing Origin validation would allow a malicious page to piggyback a logged-in user's browser session.

### Root cause

Origin validation was likely considered "covered" by the CORS config without accounting for the fact that WS upgrades aren't subject to CORS in the first place.

### Redesign

Add an explicit Origin allowlist check in the WS route handler (`apps/backend/src/routes/signaling.ts:64-74`), reusing the same allowlist source of truth as the CORS config (a new `ALLOWED_ORIGINS` env var, or, for the current no-web-client architecture, simply reject any request carrying a browser-style `Origin` header at all, since neither the Tauri desktop app nor the React Native mobile app send one, and legitimate traffic should not have it — a `Origin` header present on a WS upgrade to this endpoint is itself a signal of unexpected browser-originated traffic).

### Tradeoffs

If a future web-based viewer client is added (a legitimate product direction for remote desktop tools), this would need to become a real allowlist rather than a blanket reject — track this as a follow-up decision point rather than a one-way door.

### Implementation plan

1. In the `app.get(SIGNALING_PATH, { websocket: true }, (socket, req) => {...})` handler (`routes/signaling.ts:64`), check `req.headers.origin`; if present and not in an allowlist (or, per the minimal version, if present at all), close with `4403`/reject the upgrade before `ipLimiter.acquire` even runs.
2. Log rejected-origin attempts distinctly from other guard rejections for observability.

### Migration strategy

No migration; purely additive rejection logic. Verify neither the desktop (Rust `tokio-tungstenite`-style client, `apps/desktop/src-tauri/src/signaling/`) nor the mobile RN WebRTC client send an `Origin` header by default before enabling a strict reject in production.

### Testing strategy

Add a `hub`/route-level test (or a `signaling.ts` route test using Fastify's `inject` for WS, if the test harness supports it) asserting a WS upgrade carrying `Origin: http://evil.example` is rejected before reaching `hub.handleMessage`.

### Risk assessment

Medium today, will become higher-priority alongside any future browser-based auth (M5 session cookies) — cheap to add now while the fix is simple, expensive to retrofit correctly later under time pressure.

### Performance impact

Negligible — one header check per connection attempt.

### Future extensibility

The allowlist mechanism doubles as the config surface for a future web viewer client, if the product adds one.

---

## Finding 9 — Clipboard payloads have no size cap, and clipboard/paste input has the same unenforced-scope exposure as Finding 2

**Severity: Medium**

### Current implementation

`InputEventSchema`'s `clipboard` variant (`packages/protocol/src/input.ts:105-109`) is `{ ts, kind: 'clipboard', text: z.string() }` — note the complete absence of a `.max(...)` bound, in contrast to every other string field in the same file (`code: z.string().min(1)` on key events has no explicit max either, but is a short key-code string in practice; `textInput`'s `text: z.string()`, `input.ts:78-82`, is similarly unbounded). The `shortcut` action enum includes `'copy'`/`'paste'` (`input.ts:87-88`), which trigger OS-level clipboard operations on the desktop with no size limit at the OS layer either.

### Problems

1. **Unbounded clipboard writes.** A malicious or buggy mobile client can send an arbitrarily large `clipboard`/`text_input` payload — bounded only by the outer WebRTC DataChannel message-size limits (which are peer-to-peer, not policed by this backend at all, since the backend is explicitly out of the media/data path, `docs/threat-model.md:18`) and by whatever the desktop's JSON deserialization (`decode_input_batch`, referenced in `apps/desktop/src-tauri/src/input/worker.rs:66`) is willing to allocate. This is a resource-exhaustion / clipboard-overwrite nuisance vector distinct from, but adjacent to, Finding 2.
2. **Same unenforced-scope exposure as Finding 2, called out specifically because clipboard is unusually sensitive.** A clipboard write from the phone silently overwrites whatever is currently on the desktop's system clipboard — a privacy-relevant action (it can clobber a password a user just copied, or be used as a primitive for a follow-up social-engineering "paste this" attack) that today requires no `control` scope grant to execute, per Finding 2's root cause (the input worker enforces no scope at all). This deserves to be called out separately from Finding 2 because product/policy teams may reasonably want clipboard write specifically gated behind an even narrower scope than general `control` (e.g., some remote-desktop competitors offer a "no clipboard sync" mode independent of general input control).

### Root cause

Length bounds were applied thoughtfully to signaling-protocol fields (`packages/protocol/src/signaling.ts:20-26`: `MAX_SDP_LEN`, `MAX_CANDIDATE_LEN`, etc. — clearly a deliberate pattern the team already follows) but the same discipline was not carried into the input protocol's `clipboard`/`text_input` fields.

### Redesign

1. Add `.max(N)` to `clipboard.text` and `textInput.text` in `packages/protocol/src/input.ts:78-82,105-109` — a reasonable ceiling (e.g. 1 MiB is generous for clipboard text; even 64 KiB comfortably covers real-world paste use cases while bounding abuse) consistent with the existing `MAX_SDP_LEN`-style constants pattern already established in the sibling `signaling.ts` file.
2. Fold `clipboard` (and optionally the `copy`/`paste` shortcut actions) into the scope-gating fix from Finding 2, and consider introducing a dedicated `clipboard` scope in the `SessionScopeSchema` enum (`packages/protocol/src/pairing.ts:18`) if product wants finer granularity than the blanket `control` scope — flagged here as a design option, not a requirement, since Finding 2's fix (gating all input including clipboard on `control`) already closes the acute security gap.

### Tradeoffs

A hard cap could reject a legitimately large clipboard paste (e.g. a user copying a long document) — choose the ceiling generously and return a clear rejection reason rather than silently truncating, so the mobile UI can surface "clipboard content too large to sync" rather than corrupting data.

### Implementation plan

1. Add `MAX_CLIPBOARD_LEN`/`MAX_TEXT_INPUT_LEN` constants alongside the existing `MAX_SDP_LEN` etc. (`input.ts`, mirroring `signaling.ts:22-26`'s pattern) and apply via `.max(...)`.
2. Cover clipboard under the Finding 2 scope-gate in the desktop's `InputDispatcher`.

### Migration strategy

Schema tightening is backward compatible for any real-world clipboard content under the chosen ceiling; bump the input protocol's implicit version only if you want old clients to receive an explicit rejection reason rather than a generic validation error.

### Testing strategy

- `zod` schema unit test asserting an oversized `clipboard.text`/`textInput.text` payload is rejected by `InputEventSchema`.
- Rust dispatcher test asserting a `clipboard` event is dropped (not applied to the OS clipboard) when `control` scope is absent, following Finding 2's test pattern.

### Risk assessment

Medium — bounded impact (clipboard/memory nuisance, not remote-desktop compromise), but clipboard content very often contains sensitive data (passwords, tokens), making its unscoped-write property worth fixing promptly.

### Performance impact

Negligible.

### Future extensibility

A dedicated `clipboard` scope (if added) sets a precedent for further scope granularity (`file-transfer`, `audio`, etc.) as the product grows beyond the current `view`/`control` binary.

---

## Finding 10 — `/pairing/create` is fully unauthenticated with no per-identity issuance limit

**Severity: Medium**

### Current implementation

`app.post('/pairing/create', ...)` (`apps/backend/src/routes/pairing.ts:7-14`) validates only the request body shape via `PairingCreateRequestSchema` (`packages/protocol/src/pairing.ts:22-29`) — `deviceId` is any client-supplied string ≥8 chars, with no check that it corresponds to a previously-seen or registered device. `createPairing()` (`services/pairing.ts:35-65`) then unconditionally mints a token + room and writes a 60s-TTL Redis record, with no rate limit beyond the blanket global 120/min (`server.ts:26`, and see Finding 5 for why that limit may be pooled/ineffective behind a proxy).

### Problems

Anyone — not just a legitimate desktop app — can call this endpoint repeatedly with arbitrary `deviceId`/`deviceName` values, minting valid tokens and rooms tied to nothing real. While each record is small and TTL-bound (60s, `config.ts:16`, `.env.example`'s `PAIRING_TOKEN_TTL_SECONDS`), sustained abuse (especially if Finding 5's proxy issue means the rate limit doesn't actually bound a single real-world attacker) generates continuous Redis write load and — combined with Finding 1's current lack of room-auth enforcement — pointless `Room` churn in the signaling hub if an attacker also opens matching WS registrations.

### Root cause

This endpoint predates any device-identity concept (the whole system is pre-M5/pre-auth by design, `schema.ts:15-16`), so "any caller can request a pairing" was an acceptable simplification for the prototype phase, but was never revisited with an eye toward abuse once the product moved toward "internet-first" exposure.

### Redesign

Short of full M5 auth (Finding 15), add a lightweight per-source-IP issuance cap specific to `/pairing/create` (e.g. 5/minute, tighter than the generic 120/min), and consider requiring a simple app-instance identifier (not security-grade, but raises the bar above "totally anonymous") once Finding 5's `trustProxy` fix makes per-IP limits meaningful again. Full resolution is Finding 15's device-identity system, which would require the caller to prove possession of a registered device key before `/pairing/create` succeeds.

### Tradeoffs

A per-route limit tight enough to meaningfully bound abuse could inconvenience a legitimate user who rapidly retries pairing (e.g. after a failed scan) — pick a value generous enough for normal retry behavior (5-10/min is standard for this class of endpoint) and pair it with clear client-side error messaging.

### Implementation plan

1. Add a route-level `config: { rateLimit: { max: 5, timeWindow: '1 minute' } }` to the `/pairing/create` registration (`fastify/rate-limit` route-level override, same mechanism recommended for `/pairing/redeem` in Finding 5).
2. Track as a placeholder for Finding 15's stronger, identity-bound replacement.

### Migration strategy

Purely additive; verify the chosen limit doesn't regress the existing test suite's pairing flow expectations (`apps/backend/src/services/pairing.test.ts`).

### Testing strategy

Route-level integration test asserting the 6th `/pairing/create` call within a minute from one source returns `429`.

### Risk assessment

Medium — bounded nuisance/DoS-contributor today; becomes low-priority once Finding 15 ships real device authentication ahead of pairing issuance.

### Performance impact

Negligible — one more rate-limit bucket, same mechanism already in use.

### Future extensibility

This per-route limiter registration pattern should be replicated for every new endpoint added pre-M5 rather than relying solely on the generic global limiter, per the code's own comment acknowledging this is temporary ("tightened per-route + real limits in M6," `server.ts:25`).

---

## Finding 11 — Production secret validation checks for known literal defaults, not weak/short secrets in general

**Severity: Low / Polish**

### Current implementation

`INSECURE_DEV_DEFAULTS` (`packages/shared/src/env.ts:35-38`) lists exact string values for `TURN_SECRET` and `DATABASE_URL`; `loadEnv()`'s production check (`env.ts:50-61`) only fails if the configured value is _identical_ to one of these two literals. `EnvSchema` (`env.ts:8-26`) applies no `.min(...)` length constraint to `TURN_SECRET` (or any other secret-shaped field) — `z.string().default('lilypad_dev_turn_secret')` accepts a 1-character string in production just as happily as a 64-character random one.

### Problems

An operator who sets `TURN_SECRET=changeme` or `TURN_SECRET=x` in production sails past the existing check (it's not an exact match to the known default) while still shipping a trivially weak secret. The same applies to any future secret-shaped env var added without remembering to also add it to `INSECURE_DEV_DEFAULTS` and to give it a length floor.

### Root cause

The check was designed to catch the specific, known failure mode (forgetting to change the _committed_ default) rather than the general failure mode (setting _any_ weak value).

### Redesign

Add a minimum-length constraint to `TURN_SECRET` in the schema itself (e.g. `.min(32)`), which is a much stronger and more general guarantee than literal-matching a blocklist, and apply the same discipline to any future secret field (a signing key for M5's JWTs, per Finding 15, being the next obvious one).

### Tradeoffs

None meaningful — a 32+ character requirement is trivially satisfiable by any real secret-generation practice (`openssl rand -hex 32`, etc.) and only inconveniences someone deliberately using a weak value.

### Implementation plan

Add `.min(32, 'TURN_SECRET must be at least 32 characters — generate with e.g. `openssl rand -hex 32`')` to the `TURN_SECRET` field in `EnvSchema` (`env.ts:24`). Keep the existing exact-match `INSECURE_DEV_DEFAULTS` check as well (defense in depth against the specific known-bad value even if someone constructs a 32+ character string that happens to still be the literal default — belt and suspenders).

### Migration strategy

Backward compatible for anyone who already generated a real secret; anyone still on the literal dev default was already blocked by the existing check, so no new breakage — this only tightens what "not the exact dev default" is allowed to be.

### Testing strategy

Unit test: `loadEnv()` in production with a 10-character `TURN_SECRET` throws a clear, actionable error message.

### Risk assessment

Low — this is closing a gap in an already-existing, already-good control, not introducing new coverage from zero.

### Performance impact

None.

### Future extensibility

Establishes the length-floor pattern for every secret field M5's auth system will add (JWT signing keys, refresh-token hashing pepper, etc.).

---

## Finding 12 — Pairing token TTL has no upper bound, silently undermining the documented "60s single-use" guarantee

**Severity: Low / Polish**

### Current implementation

`PAIRING_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60)` (`packages/shared/src/env.ts:19`) accepts any positive integer with no ceiling. `docs/threat-model.md:24` documents the mitigation specifically as "a **60s TTL**."

### Problems

An operator (or a misconfigured deployment script) could set `PAIRING_TOKEN_TTL_SECONDS=86400`, and the system would boot and run fine — silently turning a "narrow, 60-second exposure window" security property into a day-long one, with nothing in the codebase surfacing that this diverges from the documented/intended posture.

### Root cause

The env var was made configurable for legitimate flexibility (testing, different UX pacing) without a corresponding sanity ceiling.

### Redesign

Add `.max(300)` (5 minutes — generous upper bound for any real QR-scan UX) to the schema, and/or log a prominent warning at boot if the configured value differs meaningfully from the documented default.

### Tradeoffs

None significant — no legitimate product flow needs a pairing token to remain redeemable for more than a few minutes.

### Implementation plan

Add the `.max(300)` constraint to `env.ts:19`.

### Migration strategy

Purely additive validation; no existing legitimate config should be near this ceiling.

### Testing strategy

Unit test asserting `loadEnv()` rejects `PAIRING_TOKEN_TTL_SECONDS=3600`.

### Risk assessment

Low.

### Performance impact

None.

### Future extensibility

Same pattern applies to any other TTL/expiry config added later (session TTL, refresh-token lifetime in M5).

---

## Finding 13 — `/metrics` is unauthenticated and publicly exposed

**Severity: Low / Polish**

### Current implementation

`app.get('/metrics', async () => hub.metricsSnapshot())` (`apps/backend/src/routes/signaling.ts:59`) is registered on the same public app instance as every other route, with no auth guard, IP allowlist, or separate internal-only binding. It returns `activeRooms`, `sessionsStarted`, `sessionsEnded`, `roomsRejectedAtCapacity`, `peersReaped` (`hub.ts:108-116`).

### Problems

Any internet caller can poll this endpoint to gauge current load (useful recon for timing a room-exhaustion attack per Finding 1) and to infer rough usage volume (a minor business-confidentiality concern — e.g. a competitor could estimate the service's active-session count over time).

### Root cause

Operational metrics endpoints are commonly left open in early-stage services since "it's just numbers," without considering they also inform an attacker's timing/targeting decisions.

### Redesign

Bind `/metrics` to a separate internal listener (a second Fastify instance/port not exposed publicly), or gate it behind a static bearer token / mTLS if a separate port isn't operationally convenient, consistent with standard Prometheus-style deployment practice (scrape over an internal network only).

### Tradeoffs

Slightly more deployment complexity (a second listening port or a token to distribute to the scraper) — standard and low-cost for any production observability setup.

### Implementation plan

Add a `METRICS_PORT`/`METRICS_BEARER_TOKEN` config option; either stand up a second `Fastify` instance bound to a loopback/internal-only interface, or add a simple `onRequest` hook checking a bearer token specifically on this route.

### Migration strategy

Coordinate with whatever scraper (Prometheus, Datadog agent, etc.) already polls this endpoint, if any, to update its target before removing public access.

### Testing strategy

Integration test asserting `/metrics` returns 401/403 without the token (or is unreachable on the public port once moved).

### Risk assessment

Low — information disclosure only, no direct compromise path, but a free and standard hardening step.

### Performance impact

None.

### Future extensibility

Establishes the "internal-only surface" pattern for any future admin/debug endpoint.

---

## Finding 14 — Production CORS is a binary on/off toggle with no origin allowlist mechanism

**Severity: Low / Polish**

### Current implementation

`await app.register(cors, { origin: config.isDev ? true : false })` (`apps/backend/src/server.ts:22-23`) — in production, `origin: false` disables CORS entirely, meaning any legitimate browser-based cross-origin client (e.g. the `apps/admin` React SPA, if deployed on a different origin than the API) will have its cross-origin requests blocked by the browser.

### Problems

This isn't a vulnerability today (it fails closed, which is safe), but it's a foreseeable operational trap: when the admin app is deployed to production and someone discovers CORS is blocking it, the fastest fix under deployment pressure is very likely to be flipping the flag to `origin: true` (matching the dev config) — which reopens unrestricted cross-origin access to every authenticated-in-the-future endpoint. Flagging this now, before that pressure exists, is cheaper than fixing it during an incident.

### Root cause

The boolean toggle was a reasonable placeholder for a prototype with no real production cross-origin client yet, but has no built-in upgrade path to a proper allowlist.

### Redesign

Replace the boolean with an `ALLOWED_ORIGINS` env var (comma-separated list or JSON array) parsed into `@fastify/cors`'s `origin` option as a function/array, so production can explicitly allowlist e.g. `https://admin.lilypad.example` without ever falling back to `true`.

### Tradeoffs

None significant — this is strictly more precise than the current binary choice.

### Implementation plan

Add `ALLOWED_ORIGINS: z.string().default('')` to `EnvSchema`, parse to a string array, pass as `origin: config.isDev ? true : allowedOrigins` (`server.ts:22-23`).

### Migration strategy

Additive; production behavior is unchanged (`false`/no origins) until `ALLOWED_ORIGINS` is explicitly populated for the admin app's real deployment origin.

### Testing strategy

Integration test asserting a request with `Origin: https://admin.lilypad.example` gets CORS headers when that origin is in the allowlist, and not otherwise.

### Risk assessment

Low today; the value is in preventing a rushed, insecure fix later.

### Performance impact

None.

### Future extensibility

Standard pattern for any additional first-party web client added later.

---

## Finding 15 — M5 auth replacement design: JWT + refresh + device trust + revocation

**Severity: N/A (forward design, explicitly requested by audit scope)**

### Current implementation

Today there is no authentication layer at all. `users`, `devices`, and `trusted_devices` tables exist in the schema (`apps/backend/src/db/schema.ts:25-63`) but are unused by any route — `devices.fingerprint` is documented in its own comment as "Stable client-generated id (dev mode) / device fingerprint" (`schema.ts:43`), i.e. explicitly acknowledged as a placeholder. Every identity in the system today (`deviceId` in pairing and signaling messages) is a bare, self-asserted, unauthenticated string (`packages/protocol/src/pairing.ts:23-24,44-45`; `packages/protocol/src/signaling.ts:52-54`). This is the root enabler behind Findings 1 and 2's severity: there is no cryptographic proof binding a WS connection, a pairing redemption, or an input event to a specific, previously-trusted device.

### Problems

Without device identity, Finding 1's fix (Redis-backed room-auth check) can only verify "the same string the pairing flow saw," not "the same physical device the user paired with previously" — it closes the _acute_ seat-hijack race but not device _impersonation_ (an attacker who somehow learns a valid `deviceId` string, e.g. via Finding 3's plaintext leak, can still redeem/register as if it were that device, because the string alone is the entire credential). A production remote-desktop product competing with Parsec/AnyDesk needs persistent, revocable device trust (pair once, reconnect without re-scanning a QR every time) and user accounts to tie sessions/audit logs to a person, not just a device string.

### Root cause

Auth was explicitly deferred to M5 (`schema.ts:16,24,50`) and the current pairing flow was designed as a self-contained, device-agnostic bootstrap — reasonable for an M1/M2 prototype, but the mandate for this audit is specifically to specify what M5 needs to be to close the gaps the earlier findings identify.

### Redesign

**Identity & session tokens.**

- **User accounts**: `users.passwordHash` (`schema.ts:28`) should use Argon2id (not bcrypt) with per-install pepper stored outside the DB (env-configured, following the `TURN_SECRET`-style pattern from Finding 11, with the same `.min(32)` length floor).
- **Access tokens**: short-lived (10-15 min) JWTs, signed with an asymmetric key (Ed25519/EdDSA preferred over HMAC — allows the signaling hub and any future horizontally-scaled service to _verify_ tokens without holding the _signing_ secret, which only the auth-issuing service needs). Claims: `sub` (user id), `deviceId` (the _verified_, DB-backed device id — see below), `tokenVersion` (see revocation), `exp`.
- **Refresh tokens**: opaque, high-entropy (matching the existing `randomBytes(24)` pattern already used for pairing tokens, `services/pairing.ts:39`), stored **hashed** (SHA-256 is sufficient for a high-entropy random token, unlike passwords) in Postgres with `deviceId`, `expiresAt`, `revokedAt`, and a `familyId` for **rotation with reuse detection**: each refresh exchanges the old token for a new one and immediately invalidates the old value; if a _revoked_ refresh token is ever presented again (a device double-using an old token, or a stolen-and-already-used token being replayed by an attacker), revoke the entire `familyId` immediately — a standard, well-understood pattern (used by e.g. Auth0, Google's OAuth refresh flow) that turns "refresh token was stolen at some point" into a detectable, containable event rather than a silent, permanent compromise.

**Device trust (cryptographic, not string-based) — this is the fix `trusted_devices` (`schema.ts:51-63`) was scaffolded for.**

- On first install, each device (desktop and mobile) generates an Ed25519 keypair locally; the private key never leaves the device (OS keychain/Secure Enclave/Android Keystore where available).
- `devices.fingerprint` (`schema.ts:43`) becomes the device's **public key** (base64), not a client-chosen opaque string.
- Device registration requires a signed challenge-response: server issues a random nonce, device signs it with its private key, server verifies the signature against the claimed public key before creating the `devices` row. This is the mechanism that makes `deviceId` in Finding 1's `register`/`pair-request` messages _provable_ rather than merely _asserted_ — the signaling hub's `register()` (`hub.ts:248-301`) can require a signature over `(roomId, ts)` using the device's registered key, closing the impersonation gap Finding 1's Redis-only fix leaves open.
- `trusted_devices` (`schema.ts:51-63`) rows are created only after an explicit user approval of a _new_ device pairing (reusing the existing Approve/Deny UX, `apps/desktop/src-tauri/src/commands.rs:216-238`) — once trusted, subsequent connections from that device's verified key can skip the QR/pairing-token bootstrap entirely (a legitimate UX improvement this schema was clearly designed to enable, though implementing the "skip re-pairing" UX itself is a product decision outside this audit's "no new features" mandate — the point here is only that the _identity verification primitive_ is what M5 must deliver; whether/when to use it to streamline reconnects is a separate product call).

**Revocation.**

- Per-user `tokenVersion` counter (new column on `users`): bump it on "log out everywhere" / password change / suspected compromise; every JWT embeds the `tokenVersion` it was issued under, and verification checks it against the current DB value — this is the standard way to get real-time revocation out of otherwise-stateless JWTs without a distributed blacklist.
- Per-device revocation: deleting a `trusted_devices` row (explicit user action, "remove this device") must also revoke any outstanding refresh tokens tied to that `deviceId` (cascade via the `familyId`/`deviceId` foreign key already modeled, `schema.ts:56-61`) and should be audit-logged (Finding 6) as a `device_revoked` event.

**Signaling integration.** The WS `register` message (`packages/protocol/src/signaling.ts:48-55`) gains an optional `authToken` (short-lived JWT) field; `SignalingHub.register()` (`hub.ts:248-301`) verifies it (signature + `tokenVersion` + `deviceId` matches the room-auth record from Finding 1) before granting a seat — at which point Finding 1's Redis-lookup fix and this JWT verification become complementary, not redundant: the room-auth record proves "this room's pairing flow expects this device," and the JWT proves "this connection really is that device."

### Tradeoffs

This is a substantial scope of work (full auth stack, key management, rotation/reuse-detection logic, revocation plumbing) — appropriately scoped as its own milestone (M5), not a drop-in patch. Asymmetric signing keys add key-management operational overhead (rotation procedure, secure storage for the private signing key) beyond the current single-shared-secret model. Client-side keypair generation and secure storage require platform-specific work (Keychain/Keystore/Secure Enclave APIs) on both the Tauri desktop and React Native mobile apps — nontrivial but well-trodden ground for both platforms.

### Implementation plan

1. Postgres: add `tokenVersion` to `users`, `revokedAt`/`familyId` to a new `refresh_tokens` table, migrate `devices.fingerprint` semantics to "public key" (additive column `publicKey`, deprecate/repurpose `fingerprint` rather than breaking existing rows if any dev data exists).
2. Auth service: `/auth/register`, `/auth/login` (Argon2id verify, issue access+refresh), `/auth/refresh` (rotate + reuse detection), `/auth/logout` (revoke family), `/auth/logout-all` (bump `tokenVersion`).
3. Device registration: `/devices/register` (challenge-response, Ed25519 verify), `/devices/:id` DELETE (revoke).
4. Desktop/mobile: keypair generation + secure storage; sign the registration challenge; attach `authToken` to WS `register`.
5. Signaling hub: verify `authToken` in `register()`, wire to Finding 1's `RoomAuthStore`.
6. Audit log (Finding 6) integration for every auth/device lifecycle event.

### Migration strategy

This is additive alongside the existing anonymous pairing flow, not a replacement on day one — ship auth as opt-in/parallel (existing QR pairing keeps working for unauthenticated "quick share" use cases if the product wants to keep that tier), then gate `control` scope or persistent trusted-device reconnect behind an authenticated account, migrating power users incrementally. Full cutover timing is a product decision.

### Testing strategy

Standard auth-system test suite: login/refresh/rotation/reuse-detection unit tests; device-registration signature-verification tests (valid signature accepted, tampered/wrong-key signature rejected); revocation propagation tests (bump `tokenVersion`, confirm previously-issued JWTs are rejected mid-lifetime); end-to-end pairing test using a trusted device's signed `register` message.

### Risk assessment

This is the highest-leverage long-term investment in the entire report — it is the only fix that closes Finding 1's residual device-impersonation gap and gives the product a real identity model competitive with Parsec/AnyDesk's account systems. Risk is primarily execution risk (scope, timeline) rather than security-design risk, provided the well-established patterns above (Argon2id, refresh rotation with reuse detection, asymmetric JWT signing, tokenVersion-based revocation) are followed rather than reinvented.

### Performance impact

JWT verification is fast (asymmetric signature check, sub-millisecond); the added Postgres round-trips for login/refresh are on infrequent, non-hot-path operations (not per-message, not even per-session — only at login/refresh-token-expiry cadence).

### Future extensibility

This design is intentionally the foundation for: SSO/enterprise identity federation, per-organization device management dashboards (the `apps/admin` app is presumably headed here), and fine-grained per-device scope policies layered on top of the `trusted_devices` relationship already modeled in the schema.

---

## Summary Table

| #   | Finding                                                                               | Severity       |
| --- | ------------------------------------------------------------------------------------- | -------------- |
| 1   | `roomId` is a bearer capability; WS registration decoupled from pairing (seat hijack) | Critical       |
| 2   | View/control scope unenforced end-to-end                                              | Critical       |
| 3   | No enforced transport encryption (plaintext default)                                  | Critical       |
| 4   | Redis has no authentication                                                           | High           |
| 5   | Rate limits/IP caps keyed on `req.ip` with no `trustProxy`                            | High           |
| 6   | Audit logging unimplemented despite being documented as shipped                       | High           |
| 7   | TURN credential TTL too long relative to leak-exposure risk                           | Medium         |
| 8   | No WS Origin validation                                                               | Medium         |
| 9   | Clipboard payload unbounded + same scope gap as #2                                    | Medium         |
| 10  | `/pairing/create` unauthenticated, no per-identity issuance cap                       | Medium         |
| 11  | Secret-strength check is exact-match only, no length floor                            | Low/Polish     |
| 12  | Pairing token TTL has no upper bound                                                  | Low/Polish     |
| 13  | `/metrics` unauthenticated and public                                                 | Low/Polish     |
| 14  | Production CORS is a brittle boolean toggle                                           | Low/Polish     |
| 15  | M5 auth design: JWT + refresh + device trust + revocation                             | Forward design |
