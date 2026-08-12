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
| `pnpm docs:check`               | ✅ clean — 54 markdown files                     |
| `pnpm audit --audit-level high` | ✅ clean — blocking in CI (2 documented ignores) |
| **Total automated tests**       | **995**                                          |

Test breakdown: backend 386 · mobile 249 · desktop Rust 298 · desktop UI 44 ·
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
| `apps/admin`        |     8 |           95 | 🚧 **scaffold only** — placeholder cards    |

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
| SEC-2       | Device identity is a self-asserted string — **backend + clients done, not yet enforced.** Ed25519 challenge-response ships in `/devices/{challenge,enroll,token}`; both clients generate, store, and sign. The self-asserted id is still ACCEPTED because no route requires a token yet (see SEC-3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | M8        |
| SEC-3       | Every route except `/metrics` is unauthenticated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M8        |
| SEC-4       | Presence room is claimable by asserting a device id, and the claim evicts the incumbent socket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | M9        |
| SEC-5       | Pairs with `connect_secret_hash = NULL` authorize with no secret                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M8        |
| ~~AND-1~~   | ~~Android release builds were signed with the committed `debug.keystore`~~ — **fixed.** `release` now takes credentials from env or Gradle properties (the four names CI already exports) and produces an **unsigned** APK when they are absent, because unsigned fails loudly where debug-signed failed silently and permanently. Partial configuration counts as unconfigured. Resolution logic verified in a real Gradle evaluation across all four cases; the AGP DSL around it is unverified (no Android SDK on this machine).                                                                                                                                                                                                                                                         | ✅ done   |
| SEC-6       | Desktop: `withGlobalTauri` + `csp: null` + 21 unauthenticated Tauri commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | M10       |
| ~~RACE-1~~  | ~~`upsertDevice` select-then-insert could create two device rows for one device and split its trust across them~~ — **fixed** by `UNIQUE (kind, fingerprint)` in migration `0003` plus `ON CONFLICT DO NOTHING` + re-select. Verified against a live Postgres: 8 concurrent upserts, one row, one id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ✅ done   |
| SEC-7       | No automated proof that user A cannot reach user B's devices                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | M12       |
| OPS-1       | Backend cannot run more than one instance (in-memory rooms, per-process rate limits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | M11       |
| OPS-2       | No deployment artifact of any kind — no Dockerfile, no IaC, no hosting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | M11/M13   |
| OPS-3       | No production domain, DNS, or TLS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | M13       |
| OPS-4       | TURN relay range sized for ~50 concurrent relayed sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | M13       |
| NET-1       | No `turns:` 443 fallback — UDP-blocked networks cannot connect at all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M13       |
| NET-2       | Google public STUN hardcoded; discloses every user's IP to a third party                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | M13       |
| OBS-1       | No crash reporting on any tier; desktop audit log goes to stderr only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M10/M15   |
| OBS-2       | No observability beyond in-memory counters that reset on restart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M15       |
| ~~DEP-1~~   | ~~19 high/critical dependency advisories~~ — **fixed**: drizzle-orm 0.38→0.45.2, fastify 5.2→5.11.3, vitest 2→3.2.7, vite 6.0→6.4.3, plus `pnpm.overrides` for transitives. CI audit is now **blocking**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ✅ done   |
| ~~CRASH-1~~ | ~~`NSPasteboard` data race → SIGSEGV~~ — **fixed.** The clipboard watcher (session tick, every 750 ms) and the InputWorker's paste write both hit `NSPasteboard` unsynchronized off the main thread; AppKit's pasteboard type cache is not thread-safe, and it killed the process ~1 run in 3 of `session_connect_lifecycle`. All access now funnels through [`clipboard.rs`](../apps/desktop/src-tauri/src/clipboard.rs), which owns a process-wide lock and exposes functions rather than the lock itself. `arboard` appears nowhere else in the crate — that is the invariant. Regression test: [`tests/clipboard_race.rs`](../apps/desktop/src-tauri/tests/clipboard_race.rs), verified to kill the process when the lock is neutered. 12/12 clean runs of the previously-flaky binary. | ✅ done   |

| LAN-1 | **No LAN discovery of any kind.** No mDNS/Bonjour/`NsdManager`/broadcast anywhere, and no local-network entitlements. The phone learns the laptop's address only from a QR or a saved pair's stored `apiBaseUrl`. | M9.5 |
| LAN-2 | **A session cannot start without a reachable backend**, even on a LAN — `/ws/signal` brokers approval and offer/answer. It works offline today only because the backend runs on the laptop (`DEFAULT_BACKEND_URL = http://localhost:8080`), which is a dev artifact, not a designed capability. | M9.5 |
| LAN-3 | **Presence and no-QR reconnect are cloud-only.** `presence.rs` holds a standing WS to the backend and `/connect/request` is an HTTP round-trip; neither has a LAN path. | M9.5 |
| COST-1 | **coturn relay port range allows ~50 concurrent relays** (`min-port`/`max-port` span 100 ports) — far below any real scale. | M13 |
| COST-2 | **Google public STUN is hardcoded**, disclosing every user's IP to a third party and adding gathering latency when offline. Our own coturn can serve STUN. | M9.5/M13 |

### Platform gaps

| Gap                              | State                                                            |
| -------------------------------- | ---------------------------------------------------------------- |
| Android release signing          | ⚠️ signed with the **committed `debug.keystore`** — ship-blocker |
| Android field validation         | ⚠️ builds and ships to Play in CI; never validated on hardware   |
| Windows input backend            | ⚠️ compiles, never executed                                      |
| Windows Media Foundation encoder | 🔜 stub                                                          |
| `single_instance.rs`             | ⚠️ Unix-only (`AsRawFd`); will not compile on Windows as wired   |

### Deferred by decision

| Item                 | Rationale                                                            |
| -------------------- | -------------------------------------------------------------------- |
| Stripe billing       | Entitlement tables only in V1; no pricing signal yet                 |
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

**Shipped:** M0–M6 — see [milestones.md](milestones.md).

**Current:** **M7 — documentation system + CI guardrails.** Frontmatter and status
on every doc, `pnpm docs:check` in CI, ADRs, CodeQL + dependency audit.

**Next, in dependency order:**

| Milestone | Objective                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| M8        | Accounts + Ed25519 device identity; every route behind authorization                                        |
| M9        | Same-account device visibility replaces QR pairing ([ADR-0003](adr/0003-same-account-device-visibility.md)) |
| M10       | Desktop security hardening (CSP, command authorization, persisted logs, crash reporting)                    |
| M11       | Horizontal scaling ([ADR-0004](adr/0004-signaling-horizontal-scaling.md)) + backend deployment artifact     |
| M12       | Security hardening + release-blocking multi-user isolation suite                                            |
| M13       | Production infrastructure + `takedia.com` ([ADR-0005](adr/0005-turn-topology.md))                           |
| M14       | Consumer UX across desktop, mobile, and web                                                                 |
| M15       | Observability + support                                                                                     |
| M16       | Android GA · M17 Windows GA · M18 Ask productisation                                                        |

**Production readiness: not ready.** The session layer is production-grade; the
service around it (authentication, authorization, multi-instance backend,
deployment, observability) is what M8–M15 build.
