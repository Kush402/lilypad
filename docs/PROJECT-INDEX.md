---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-12
summary: Repository index, verified status, and known gaps.
---

# Lilypad — Project Index & Status

_Generated 2026-08-12 at `fa1581a` (branch `main`). A complete inventory of every
tracked part of the repo with its verified status._

**Current milestone: M7 — documentation system + CI guardrails.** The product is
mid-transition from a working single-user engineering product to a multi-user
consumer product; see [§7 Roadmap](#7-roadmap-position) for where that stands and
[adr/](adr/) for the decisions driving it.

**Verification method:** every ✅ below was checked by running the thing, not by
reading a doc — `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`,
`pnpm docs:check`, `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets`.
Items marked 🔜 were confirmed absent from the code.

---

## 1. Health at a glance

| Check                           | Result                                           |
| ------------------------------- | ------------------------------------------------ |
| `pnpm typecheck`                | ✅ 8/8 tasks pass                                |
| `pnpm lint` (ESLint)            | ✅ 6/6 tasks pass, 0 warnings                    |
| `pnpm test` (JS/TS)             | ✅ **697 pass, 0 fail** across 55 files/suites   |
| `cargo test` (desktop)          | ✅ **298 pass, 0 fail, 0 ignored**               |
| `cargo clippy --all-targets`    | ✅ clean — no errors, no warnings                |
| `cargo fmt --check`             | ✅ clean                                         |
| `pnpm format:check`             | ✅ clean                                         |
| `pnpm docs:check`               | ✅ clean — 56 markdown files                     |
| `pnpm audit --audit-level high` | ✅ clean — blocking in CI (2 documented ignores) |
| **Total automated tests**       | **996**                                          |

Test breakdown: backend 386 · mobile 250 · desktop Rust 298 · desktop UI 44 ·
shared 18.

A further **11 opt-in end-to-end tests** are skipped by default
(`apps/mobile/src/lib/deviceFlow.e2e.test.ts`). They drive the mobile app's own
`identity.ts` and `auth.ts` against a running backend with real Postgres and
Redis, substituting only the Keychain, and are excluded from the total because
`pnpm test` must stay hermetic. See [oauth-setup.md](oauth-setup.md) for how to
run them.

## 2. Repo scale

| Metric           | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| Tracked files    | 379                                                       |
| Source lines     | ~40,500 (ts/tsx/rs/js/mjs/kt/swift/objc)                  |
| Test files       | 56                                                        |
| Code-graph index | 242 files parsed · 2,471 nodes · 23,905 edges · 110 flows |
| Languages        | Rust, TypeScript, TSX, Kotlin, Objective-C, SQL, JS       |

### Per-package

| Package             | Files | Source lines | Status                                      |
| ------------------- | ----: | -----------: | ------------------------------------------- |
| `apps/desktop`      |   127 |       22,524 | ✅ shipped — the largest subsystem          |
| `apps/backend`      |    67 |        8,064 | ✅ shipped                                  |
| `apps/mobile`       |    95 |        7,856 | ✅ shipped (iOS real; Android builds in CI) |
| `packages/protocol` |    11 |        1,014 | ✅ shipped                                  |
| `packages/shared`   |     8 |          413 | ✅ shipped                                  |
| `packages/design`   |     5 |          259 | ✅ shipped — design tokens (P3)             |
| `apps/admin`        |     8 |           95 | 🚧 **scaffold only** — placeholder cards    |
| `apps/site`         |     3 |          712 | ✅ shipped — static marketing site (P4)     |

### Detected communities (from the code graph)

| Community         | Size | Cohesion | Dominant language |
| ----------------- | ---: | -------: | ----------------- |
| `input-inject`    |  988 |    0.184 | rust              |
| `signaling-room`  |  596 |    0.451 | typescript        |
| `lib-constructor` |  433 |    0.367 | typescript        |
| `components-use`  |  105 |    0.165 | tsx               |
| `src-env`         |   25 |    0.425 | typescript        |
| `scripts-out`     |   22 |    0.239 | javascript        |
| (5 smaller)       |   31 |        — | kotlin/objc/sql   |

Cross-community coupling: **1 edge pair**, 0 architectural warnings — the tiers
are cleanly separated.

---

## 3. Subsystem status

### `apps/desktop` — Tauri v2 + Rust (macOS) ✅

| Area         | Files                                                                                                                                                                     | Status                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `session/`   | mod, fsm, reconnect, media_controller, input_gate, signaling_client, clipboard_watcher                                                                                    | ✅ runner FSM, reconnect grace, ICE-restart budget, panic disconnect                                |
| `media/`     | pipeline, abr, capture/{screencapturekit,synthetic}, encoder/{videotoolbox,software}, convert, frame, metrics, mode                                                       | ✅ real capture + HW H.264 + loss-based ABR; software fallback                                      |
| `input/`     | dispatcher (1,222 lines), macos, windows, worker, protocol, metrics                                                                                                       | ✅ macOS CGEvent real; ⚠️ Windows `SendInput` **compile-complete, unverified** — no Windows machine |
| `rtc/`       | mod                                                                                                                                                                       | ✅ webrtc-rs peer, tracks, DataChannels, RTCP                                                       |
| `agent/`     | runner, controller, security, protocol, executor/{skills,sandbox_exec,ax_exec,vision,verify}, sandbox/{mod,profile}, llm/{anthropic,openai_compat,store}, ax/{macos,tree} | ✅ Ask operator: 4 tiers, Seatbelt sandbox, approvals, model-agnostic                               |
| `signaling/` | messages (712 lines), mod                                                                                                                                                 | ✅ serde mirror of the zod contract, drift-tested                                                   |
| Lifecycle    | lib, main, commands (835), state, presence, permission, power, autostart, single_instance, health, clipboard                                                              | ✅ all shipped                                                                                      |
| Frontend     | `src/components/*` (Bubble, QrOverlay, Control, Setup, Diagnostics, SoftwareUpdate, AgentProviderCard), `src/lib/*`                                                       | ✅ 44 tests pass                                                                                    |
| Tests        | `src-tauri/tests/*` — 12 integration suites + soak                                                                                                                        | ✅ 298 total incl. fault injection + clipboard race                                                 |
| Examples     | 6 benches/harnesses (`bench_encode`, `bench_input`, `bench_pipeline`, `headless_mobile_peer`, …)                                                                          | ✅ compile + run                                                                                    |

### `apps/backend` — Fastify + Postgres + Redis ✅

| Area         | Files                                                                                                | Status                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `signaling/` | hub (612), room, roomRegistry, messageRouter, guards, lifecyclePolicy, registerAuth, peer, hubBundle | ✅ 16 files, heavily unit-tested                                   |
| `services/`  | pairing, roomAuth, trust (338), auditLog, advertisedUrls                                             | ✅                                                                 |
| `routes/`    | pairing, signaling (+`/connect/request`, `/metrics`), devices, health                                | ✅ all documented in `api.md` as of this pass                      |
| `session/`   | manager, roomStore, stateMachine                                                                     | ✅                                                                 |
| `db/`        | schema, client, migrate + 3 Drizzle migrations                                                       | ✅ 5 tables: users, devices, trusted_devices, sessions, audit_logs |
| `turn/`      | credentials                                                                                          | ✅ per-session HMAC creds                                          |
| `tunnel/`    | quickTunnel                                                                                          | ✅ dev-only cloudflared wrapper, self-healing                      |
| Guards       | allowedOrigins, metricsAuth, trustProxy, config, logging                                             | ✅                                                                 |

### `apps/mobile` — bare React Native ✅

| Area       | Files                                                                                                                         | Status                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `lib/`     | webrtc (936), touch (543), signaling, input, api, device, pairs, agentFeed, quality, viewport, lifecycle, errors, pressRepeat | ✅ 28 files, 249 tests                                                   |
| `screens/` | ViewerScreen (1,094), ScannerScreen, DeviceListScreen, AgentPanel                                                             | ✅                                                                       |
| iOS        | Xcode project, Podfile.lock, fastlane, PrivacyInfo                                                                            | ✅ real-device verified                                                  |
| Android    | Gradle, Kotlin `MainActivity`/`MainApplication`, fastlane                                                                     | ✅ builds + ships in CI; ⚠️ not hardware-verified in this repo's records |

### `packages/` ✅

- `protocol/` — zod wire contracts: `qr`, `signaling` (343), `input`, `pairing`,
  `connect`, `agent`, `constants`, plus a JSON fixture pinned against the Rust
  serde mirror by a drift test on both sides.
- `shared/` — `env` (218, boot-time production safety guard), `logger`,
  `constants`.

### `infra/` ✅

`docker-compose.yml` (Postgres 16 · Redis 7 · coturn 4.6) · `postgres/init.sql` ·
`coturn/turnserver.conf` (dev) · `coturn-prod/` (self-hosted relay with
`use-auth-secret`, its own compose + README).

### `.github/workflows/` ✅

| Workflow             | Trigger        | Status                                                        |
| -------------------- | -------------- | ------------------------------------------------------------- |
| `ci.yml`             | push/PR + cron | ✅ TypeScript + Rust jobs, nightly & weekly soak              |
| `release.yml`        | `v*` tag       | ✅ universal macOS build → sign → notarize → staple → publish |
| `mobile-ios.yml`     | push           | ✅ fastlane → TestFlight                                      |
| `mobile-android.yml` | push           | ✅ fastlane → Play internal + APK                             |

### `scripts/` ✅

`bootstrap.mjs` (installs + seeds `.env`) · `doctor.mjs` · `clean.mjs` (5 tiers)
· `release.mjs` (tag cutter) · `run-tauri.mjs`.

---

## 4. Documentation system

Docs are an enforced engineering artifact, not a cleanup task. `pnpm docs:check`
runs in CI and fails on drift — missing frontmatter, a broken relative link, or an
HTTP route that exists in code but not in [api.md](api.md) (or vice versa). See
[CONTRIBUTING.md](../CONTRIBUTING.md#documentation) for the rules and the
what-to-update-when table.

### Source of truth by area

| Area                  | Owning document                                                      |
| --------------------- | -------------------------------------------------------------------- |
| Architecture          | [architecture.md](architecture.md)                                   |
| Design rationale      | [technical-design.md](technical-design.md)                           |
| Significant decisions | [adr/](adr/)                                                         |
| REST + WS API         | [api.md](api.md), [signaling-protocol.md](signaling-protocol.md)     |
| Input protocol        | [input-protocol.md](input-protocol.md)                               |
| Database              | [db-schema.md](db-schema.md)                                         |
| Security              | [threat-model.md](threat-model.md), [../SECURITY.md](../SECURITY.md) |
| Connectivity          | [NETWORKING.md](NETWORKING.md)                                       |
| Infrastructure cost   | [INFRASTRUCTURE-COST-MODEL.md](INFRASTRUCTURE-COST-MODEL.md)         |
| Reuse / build-vs-buy  | [REUSE-INVENTORY.md](REUSE-INVENTORY.md)                             |
| Infrastructure / ops  | [operations.md](operations.md), [RUNBOOK.md](RUNBOOK.md)             |
| Consumer product      | [user-guide.md](user-guide.md)                                       |
| Roadmap               | [milestones.md](milestones.md)                                       |
| Status / index        | this file                                                            |

Historical audit records live in [audit/m3/](audit/m3/) and are cited from code
comments as rationale — they carry `status: Reference` and must not be deleted.

### Prior reconciliation (2026-08-12)

Four docs claimed features were unbuilt that had shipped
(`ask-architecture-audit`, `m5.3-ai-executor-plan`, `m5.4-trusted-devices-audit`,
`milestones` M6), and [api.md](api.md) was missing five live routes
(`POST /connect/request` plus the four trusted-pair routes). All corrected; the
route check now makes that specific failure unmergeable.

---

## 5. Known gaps and risks

### Blocking a multi-user consumer product

These are the reason the product is not yet consumer-ready. Each is verified.

| ID          | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Milestone |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| SEC-1       | No accounts — nothing is owned, so nothing can be authorized — **backend done.** `/auth/oauth`, magic link, and rotating refresh ship. Desktop sign-in is decided and implemented ([ADR-0008](adr/0008-desktop-enrollment-via-phone.md)). The enrollment and device-token flow is verified end to end against a live backend; the provider SDK paths still need a real iOS/Android build ([oauth-setup.md](oauth-setup.md)).                                                                                                                                                                                                                                                                                                                                                                | M8        |
| ~~SEC-2~~   | Device identity is a self-asserted string — **closed in M9.** Ed25519 challenge-response ships in `/devices/{challenge,enroll,token}`, and every route now requires a matching device token for a device an account owns. A device NOBODY owns still authorizes on its self-asserted id, because there is no account behind it to protect; that lane disappears when P1 makes enrolment mandatory in both clients.                                                                                                                                                                                                                                                                                                                                                                          | ✅ done   |
| ~~SEC-3~~   | Every route except `/metrics` is unauthenticated — **closed in M9.** `optionalAuth` + `auth/authorize.ts` gate `/devices/pairs` (GET/PATCH/DELETE), `/devices/unpair`, `/connect/request`, `/pairing/create` and `/pairing/redeem`. Acting AS a device requires that device's own token; managing one requires owning it. Denials answer 404, so "not yours" is indistinguishable from "does not exist". Route wiring is asserted per route in `routes/authorization.test.ts`.                                                                                                                                                                                                                                                                                                              | ✅ done   |
| ~~SEC-4~~   | Presence room is claimable by asserting a device id, and the claim evicts the incumbent socket — **closed in M9.** The claim must now be backed by a device token presented on the WebSocket upgrade, verified against the row it names. Fails closed on a database outage. Session rooms are unaffected: they were already bound to a server-minted room record.                                                                                                                                                                                                                                                                                                                                                                                                                           | ✅ done   |
| ~~SEC-5~~   | Pairs with `connect_secret_hash = NULL` authorize with no secret — **closed in M9.** Migration `0005` revokes every such row and `authorizeConnect` refuses a null hash outright, so knowing two device ids is no longer enough to ring a laptop on a pre-secret pair. Verified against a live Postgres: one seeded legacy row revoked, two secret-bearing pairs untouched. Affected phones re-pair once with a QR, which issues a secret and un-revokes the row.                                                                                                                                                                                                                                                                                                                           | ✅ done   |
| ~~AND-1~~   | ~~Android release builds were signed with the committed `debug.keystore`~~ — **fixed.** `release` now takes credentials from env or Gradle properties (the four names CI already exports) and produces an **unsigned** APK when they are absent, because unsigned fails loudly where debug-signed failed silently and permanently. Partial configuration counts as unconfigured. Resolution logic verified in a real Gradle evaluation across all four cases; the AGP DSL around it is unverified (no Android SDK on this machine).                                                                                                                                                                                                                                                         | ✅ done   |
| SEC-6       | Desktop: `withGlobalTauri` + `csp: null` + 21 unauthenticated Tauri commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | M10       |
| ~~RACE-1~~  | ~~`upsertDevice` select-then-insert could create two device rows for one device and split its trust across them~~ — **fixed** by `UNIQUE (kind, fingerprint)` in migration `0003` plus `ON CONFLICT DO NOTHING` + re-select. Verified against a live Postgres: 8 concurrent upserts, one row, one id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ✅ done   |
| ~~SEC-7~~   | No automated proof that user A cannot reach user B's devices — **closed in M9.** `auth/authorize.test.ts` is a table of every actor Bob can be against every resource Alice owns, on every gated route; `routes/authorization.test.ts` proves each route actually asks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ✅ done   |
| OPS-1       | Backend cannot run more than one instance (in-memory rooms, per-process rate limits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | M11       |
| OPS-2       | No deployment artifact of any kind — no Dockerfile, no IaC, no hosting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | M11/M13   |
| OPS-3       | No production domain, DNS, or TLS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | M13       |
| OPS-4       | TURN relay range sized for ~50 concurrent relayed sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | M13       |
| NET-1       | No `turns:` 443 fallback — UDP-blocked networks cannot connect at all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M13       |
| NET-2       | Google public STUN hardcoded; discloses every user's IP to a third party                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | M13       |
| OBS-1       | No crash reporting on any tier; desktop audit log goes to stderr only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M10/M15   |
| ~~PROD-1~~  | **The account layer is connected on neither end** — **closed in P1.** The desktop now has a **This computer** panel that mints an enrollment QR and renders `Not linked`/`Linked` honestly; the phone's scanner classifies pair codes and link codes and confirms them differently; sign-in is routed and reached from the act that needs it. Remaining: first-run onboarding, and a real-device run of the whole flow.                                                                                                                                                                                                                                                                                                                                                                     | ✅ done   |
| OBS-2       | No observability beyond in-memory counters that reset on restart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M15       |
| ~~DEP-1~~   | ~~19 high/critical dependency advisories~~ — **fixed**: drizzle-orm 0.38→0.45.2, fastify 5.2→5.11.3, vitest 2→3.2.7, vite 6.0→6.4.3, plus `pnpm.overrides` for transitives. CI audit is now **blocking**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ✅ done   |
| ~~CRASH-1~~ | ~~`NSPasteboard` data race → SIGSEGV~~ — **fixed.** The clipboard watcher (session tick, every 750 ms) and the InputWorker's paste write both hit `NSPasteboard` unsynchronized off the main thread; AppKit's pasteboard type cache is not thread-safe, and it killed the process ~1 run in 3 of `session_connect_lifecycle`. All access now funnels through [`clipboard.rs`](../apps/desktop/src-tauri/src/clipboard.rs), which owns a process-wide lock and exposes functions rather than the lock itself. `arboard` appears nowhere else in the crate — that is the invariant. Regression test: [`tests/clipboard_race.rs`](../apps/desktop/src-tauri/tests/clipboard_race.rs), verified to kill the process when the lock is neutered. 12/12 clean runs of the previously-flaky binary. | ✅ done   |

| LAN-1 | **No LAN discovery of any kind.** No mDNS/Bonjour/`NsdManager`/broadcast anywhere, and no local-network entitlements. The phone learns the laptop's address only from a QR or a saved pair's stored `apiBaseUrl`. | M9.5 |
| LAN-2 | **A session cannot start without a reachable backend**, even on a LAN — `/ws/signal` brokers approval and offer/answer. It works offline today only because the backend runs on the laptop (`DEFAULT_BACKEND_URL = http://localhost:8080`), which is a dev artifact, not a designed capability. | M9.5 |
| LAN-3 | **Presence and no-QR reconnect are cloud-only.** `presence.rs` holds a standing WS to the backend and `/connect/request` is an HTTP round-trip; neither has a LAN path. | M9.5 |
| COST-1 | **coturn relay port range allows ~50 concurrent relays** (`min-port`/`max-port` span 100 ports) — far below any real scale. | M13 |
| COST-2 | **Google public STUN is hardcoded**, disclosing every user's IP to a third party and adding gathering latency when offline. Our own coturn can serve STUN. | M9.5/M13 |

### Platform gaps

| Gap                              | State                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android release signing          | ✅ fixed — release yields an **unsigned APK** when no credentials are configured, instead of falling back to the committed `debug.keystore` (`android/app/build.gradle`). CI injects real signing via fastlane. |
| Android field validation         | ⚠️ builds and ships to Play in CI; never validated on hardware                                                                                                                                                  |
| Windows input backend            | ⚠️ compiles, never executed                                                                                                                                                                                     |
| Windows Media Foundation encoder | 🔜 stub                                                                                                                                                                                                         |
| `single_instance.rs`             | ⚠️ Unix-only (`AsRawFd`); will not compile on Windows as wired                                                                                                                                                  |

### Deferred by decision

| Item                 | Rationale                                                            |
| -------------------- | -------------------------------------------------------------------- |
| Stripe billing       | Needed only for ADR-0013's paid remote tier; prices still `$XXXX`    |
| Voice control (M5.5) | Not started                                                          |
| Passkeys             | Post-GA upgrade — see [ADR-0001](adr/0001-account-authentication.md) |
| Audio streaming      | Out of scope; video + input only                                     |

None of the above blocks the **existing** single-user macOS ↔ iOS product, which
works end to end today.

---

## 6. Important commands

```bash
# Full local verification — everything CI runs
pnpm typecheck && pnpm lint && pnpm format:check && pnpm docs:check && pnpm test
cd apps/desktop/src-tauri && cargo test && cargo fmt --check && cargo clippy --all-targets

# Development
pnpm doctor           # check prerequisites with repair steps
pnpm bootstrap        # prepare a clean machine end-to-end
pnpm infra:up         # Postgres + Redis + coturn
pnpm --filter @lilypad/backend dev
pnpm --filter @lilypad/desktop tauri dev

# Release (desktop)
pnpm release <version>   # bumps versions in lockstep; prints the tag commands
```

The code graph (`.code-review-graph/`) rebuilds via the code-review-graph MCP
server's `build_or_update_graph` tool; it is git-ignored and derived, so it never
needs to be committed.

---

## 7. Roadmap position

Two tracks with deliberately separate numbering — see
[milestones.md](milestones.md). **M0–M18** build the platform; **P1–P6** turn it
into a product someone can buy and use. An entry is never both.

**Shipped:** M0–M6 (session layer), M7 (docs system), M8 (accounts + device
identity), M9 (ownership + authorization).

### Platform track — remaining

| Milestone | Objective                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| M9.5      | LAN-direct connectivity — a session with the cloud entirely unreachable ([ADR-0006](adr/0006-lan-first-connectivity.md)) |
| M10       | Desktop security hardening (CSP, command authorization, persisted logs, crash reporting)                                 |
| M11       | Horizontal scaling ([ADR-0004](adr/0004-signaling-horizontal-scaling.md)) + backend deployment artifact                  |
| M12       | Threat-model refresh, agent injection tests, CI rule making a missing isolation case fail                                |
| M13       | Production infrastructure + `takedia.com` DNS/TLS/hosting ([ADR-0005](adr/0005-turn-topology.md))                        |
| M15       | Observability + support                                                                                                  |
| M16/M17   | Android GA · Windows GA                                                                                                  |

M14 (Consumer UX) is superseded by P1/P2/P4, and M18's Ask half by P5; both stay
in `milestones.md` unchanged.

### Product completion track

| Milestone | Objective                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** 🚧 | Account-connected clients — sign-in, enrollment QR, approval screen, first-run wizard. Human tap-through left                                                                         |
| **P2** 🚧 | Device management — list, rename, revoke, active sessions (phone done; desktop view + session history remain)                                                                         |
| **P3** ✅ | Design system — `@lilypad/design`; one palette for all three surfaces ([ADR-0011](adr/0011-design-tokens.md))                                                                         |
| **P4** ✅ | `lilypadhome.takedia.com` — `apps/site`, static, claims-tested. Hosting and DNS remain M13's                                                                                          |
| **P5** ⏹️ | **Closed, no change** — Ask is in-app-only by design and its transcripts are correct as they are                                                                                      |
| **P7** ✅ | Consumer onboarding — email + password sign-in, an auth gate on the phone, a dashboard front door on the Mac ([ADR-0012](adr/0012-password-authentication.md))                        |
| P6        | Entitlements — boundary decided ([ADR-0013](adr/0013-connectivity-is-the-paid-boundary.md): LAN free, remote paid, 1-month trial); blocked on prices + LAN control-plane independence |

**Production readiness: not ready.** The session layer is production-grade and
its authentication and authorization now are too. What remains is the service
around it — multi-instance backend, deployment, observability (M11, M13, M15) —
and the product around that (P1–P6).
