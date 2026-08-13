---
status: In Progress
owner: @kushsharma024
last-verified: 2026-08-12
summary: What we reuse instead of building, and what each option costs at scale.
---

# Lilypad — Reuse Inventory

Before building anything, check whether it already exists — in this repo, in the
standard library, in an already-installed dependency, or as a service with a
genuinely free tier.

Two rules govern the choice:

1. **Prefer generous free tiers, self-hosting options, and low marginal cost**
   over developer convenience.
2. **Engineering time has value.** The cheapest cloud bill is not always the
   cheapest architecture — but recurring costs compound and one-off effort does
   not.

Cost figures are order-of-magnitude list prices as understood at authoring time
and **must be re-verified before committing**. See
[INFRASTRUCTURE-COST-MODEL.md](INFRASTRUCTURE-COST-MODEL.md).

---

## 1. Already in this repo — reuse, do not rebuild

The most common mistake is re-implementing something two files away.

| Need                                                   | Reuse                                                                                                               | Where                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Wire contracts (any process boundary)                  | `@lilypad/protocol` zod schemas + the hand-mirrored Rust serde types, pinned by a drift test                        | `packages/protocol/`                             |
| Signaling routing semantics                            | `MessageRouter` — pure decisions, no I/O; the embedded LAN server reuses these rules                                | `apps/backend/src/signaling/messageRouter.ts`    |
| Session lifecycle, reconnect, ICE-restart budget       | `SessionRunner` + `fsm.rs` + `reconnect.rs` — cellular-hardened, do not reinvent                                    | `apps/desktop/src-tauri/src/session/`            |
| Cross-tier timing constants                            | `packages/protocol/src/constants.ts` — backend grace windows and both clients' backoff derive from the same numbers | same                                             |
| OS clipboard access                                    | `crate::clipboard` — the single owner, process-wide lock (CRASH-1)                                                  | `apps/desktop/src-tauri/src/clipboard.rs`        |
| Input scope enforcement                                | `InputDispatcher` per-event gate — the injection boundary, not the UI                                               | `apps/desktop/src-tauri/src/input/dispatcher.rs` |
| Env validation + production safety guard               | `packages/shared/src/env.ts`                                                                                        | same                                             |
| Any colour, corner radius, or the font stack           | `@lilypad/design` — CSS via `@import`, TS via `import`. Never a hex literal (ADR-0011)                              | `packages/design/src/tokens.ts`                  |
| Trust/pair semantics incl. revoke ending live sessions | `TrustService` + `hub.endRoomsForDevicePair`                                                                        | `apps/backend/src/services/trust.ts`             |
| Testable OS boundaries                                 | The trait + mock pattern (`ClipboardReader`, `InputBackend`, `Brain`, `Executor`)                                   | throughout                                       |

---

## 2. Platform features — prefer over dependencies

| Need                   | Use                                                                                     | Instead of                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| LAN discovery          | Native mDNS: `NWBrowser`/`NetService` (Apple), `NsdManager` (Android), `dns-sd` (macOS) | A custom UDP broadcast protocol — which also needs Apple's multicast entitlement |
| Secret storage         | Keychain / Secure Enclave, Android Keystore, DPAPI+TPM                                  | A bespoke encrypted file                                                         |
| Device keypairs        | Platform crypto + Ed25519                                                               | Rolling our own scheme                                                           |
| Screen capture, encode | ScreenCaptureKit + VideoToolbox                                                         | A userspace encoder                                                              |
| NAT traversal          | WebRTC ICE (already in use)                                                             | A custom hole-punching protocol                                                  |
| Media encryption       | DTLS-SRTP, mandatory in WebRTC                                                          | Application-layer crypto                                                         |

---

## 3. External services — cost-compared

| Service                                    | Purpose                  | Free tier                          |           ~1K users |        ~10K |     ~100K | Self-host?             | Decision                                                                 |
| ------------------------------------------ | ------------------------ | ---------------------------------- | ------------------: | ----------: | --------: | ---------------------- | ------------------------------------------------------------------------ |
| **coturn on Hetzner/Contabo**              | TURN + STUN              | n/a                                |             **~€4** |     **~€9** |  **~€36** | **Yes — chosen**       | **Self-host.** 20–32 TB traffic included per box.                        |
| Twilio Network Traversal                   | TURN                     | no                                 |               ~$600 |     ~$5,880 |  ~$58,800 | no                     | **Rejected** — ~1000× the self-hosted cost.                              |
| Cloudflare TURN                            | TURN                     | limited                            |                ~$75 |       ~$735 |   ~$7,350 | no                     | Rejected as primary; possible emergency overflow.                        |
| Metered / Xirsys                           | TURN                     | small                              |              ~$500+ |    ~$5,000+ |         — | no                     | Rejected — per-GB pricing.                                               |
| **Hetzner VPS**                            | API + signaling          | no                                 |                 ~€4 |        ~€12 |      ~€60 | n/a                    | **Chosen** for Phase 1–2.                                                |
| Fly.io / Render                            | API + signaling          | small                              |             ~$10–25 |    ~$50–100 |    ~$300+ | n/a                    | Revisit if on-call burden grows.                                         |
| **PostgreSQL (self-host → Neon/Supabase)** | Database                 | Neon/Supabase have real free tiers |               €0–19 |     ~$19–50 | ~$100–200 | Yes early              | **Self-host at Phase 1**, managed once PITR matters.                     |
| Redis / Valkey                             | Multi-instance signaling | n/a                                | **€0 — not needed** |        ~€10 |      ~€30 | Yes                    | **Defer to Phase 2.**                                                    |
| **Sentry**                                 | Crash reporting          | ~5k errors/mo                      |                  €0 |       €0–26 |      ~$80 | Possible, not worth it | **Managed free tier.** Self-hosting costs more in ops than the plan.     |
| **Resend / SES**                           | Magic-link email         | 3k/mo (Resend), SES ~$0.10/1k      |                  €0 |        ~$15 |      ~$50 | No                     | **Managed.** Deliverability is a reputation problem.                     |
| Amplitude / PostHog / Mixpanel             | Product analytics        | varies                             |               $0–50 |       $100s |    $1000s | PostHog yes            | **None.** We need ~10 counters in Postgres, not a platform.              |
| LaunchDarkly etc.                          | Feature flags            | small                              |                 $$$ |        $$$$ |      $$$$ | n/a                    | **None.** A column and an env var.                                       |
| Datadog / New Relic                        | Observability            | small                              |                 $$$ |        $$$$ |      $$$$ | no                     | **None yet.** Structured stdout + Postgres counters; revisit at Phase 3. |
| Auth0 / Clerk / WorkOS                     | Authentication           | small                              |            ~$25–100 | ~$250–1,000 |  $1,000s+ | Keycloak (heavy)       | **Build on OAuth directly** — see below.                                 |
| Stripe                                     | Payments                 | n/a (per-txn)                      |                   — |           — |         — | no                     | **Not in V1.** No billing until there is something to sell.              |
| Object storage (S3/R2)                     | —                        | —                                  |                   — |           — |         — | —                      | **Not needed.** Lilypad stores no session content.                       |

### On authentication specifically

Auth0/Clerk are convenient and become expensive precisely as the product
succeeds. [ADR-0001](adr/0001-account-authentication.md) chooses Apple + Google
OAuth plus email magic links, implemented directly. OAuth authorization-code flow
plus signed tokens is well-trodden, the libraries are mature and free, and it
avoids a per-MAU bill on the single most load-bearing dependency in the system.
This is the one place where "build it" wins clearly on cost **and** on avoiding
vendor lock-in for user identity.

---

## 4. Things we chose not to have yet

Each avoids recurring cost, operational surface, or both:

- Billing (nothing to sell yet).
- A product-analytics platform.
- A log aggregation platform.
- A support desk (an email address).
- Session recording or history (also an [ADR-0007](adr/0007-cloud-is-control-plane-only.md) violation).
- Managed AI inference (BYO key in V1; metered paid tier later).
- Kubernetes, service mesh, message queues, multi-region active-active.

---

## 5. How to use this document

When a task needs a capability:

1. Search this repo. Section 1 is the most commonly missed.
2. Check the platform (section 2).
3. Check an already-installed dependency.
4. Only then evaluate a new dependency or service — and **fill in a row in
   section 3 with real costs at 1K / 10K / 100K users** before choosing.
5. Ask whether the feature needs to exist at all right now.

Record anything non-obvious here so the next person does not redo the analysis.
