---
status: Planned
owner: @kushsharma024
last-verified: 2026-08-12
summary: Cost drivers, per-scale estimates, and managed-vs-self-hosted decisions.
---

# Lilypad — Infrastructure Cost Model

> **Status: Planned.** Nothing here is deployed yet. The purpose is to identify
> the **major cost drivers** and pick an architecture that stays cheap, not to
> predict a bill precisely.

> **Pricing caveat.** Every figure below is an order-of-magnitude estimate from
> list prices as understood at authoring time. **Re-verify current pricing before
> committing to any provider** — the _ratios_ between options are the durable
> part of this analysis, not the absolute numbers.

---

## 1. The one number that matters

**A relayed hour of video costs ~1.2 GB of egress.**

720p30 H.264 at a realistic ~2.5 Mbps average (the ABR controller ranges 1–10
Mbps): `2.5 Mbps × 3600 s ≈ 1.1 GB`, plus RTCP and input return traffic. Round to
**1.2 GB per relayed hour**.

Everything else — signaling, presence, API, database — is rounding error by
comparison. Signaling is a few KB per session setup. Presence heartbeats are
~2 MB per device per month. **TURN egress is the entire cost story.**

Which is why the architecture in [NETWORKING.md](NETWORKING.md) exists: every
session served over LAN or direct P2P costs **exactly zero**.

---

## 2. Assumptions

| Assumption                               | Conservative | Optimistic |
| ---------------------------------------- | ------------ | ---------- |
| Sessions per user per month              | 20           | 20         |
| Average session length                   | 15 min       | 15 min     |
| Hours per user per month                 | 5            | 5          |
| Share of sessions on LAN (at home)       | 30%          | 50%        |
| Share of _remote_ sessions needing TURN  | 35%          | 20%        |
| **Effective TURN share of all sessions** | **24.5%**    | **10%**    |
| Egress per relayed hour                  | 1.2 GB       | 1.2 GB     |
| Peak-to-average concurrency ratio        | 5×           | 5×         |

The LAN share is the lever with the most leverage and the least cost: it is
free, it is faster, and it is more private. The TURN share for remote sessions is
higher than typical web-RTC figures because phone-on-cellular to home-NAT is a
comparatively hostile path (CGNAT is common).

---

## 3. TURN egress by scale

`TURN GB/month = users × 5 h × TURN share × 1.2 GB`

|   Users | Total hours | TURN hours (cons.) | TURN egress (cons.) | TURN egress (opt.) |
| ------: | ----------: | -----------------: | ------------------: | -----------------: |
|     100 |         500 |                123 |         **0.15 TB** |            0.06 TB |
|   1,000 |       5,000 |              1,225 |          **1.5 TB** |             0.6 TB |
|  10,000 |      50,000 |             12,250 |         **14.7 TB** |               6 TB |
| 100,000 |     500,000 |            122,500 |          **147 TB** |              60 TB |

### What that egress costs, by provider

| Provider                             | Unit price                   |  1.5 TB | 14.7 TB |   147 TB |
| ------------------------------------ | ---------------------------- | ------: | ------: | -------: |
| **Hetzner VPS (self-hosted coturn)** | ~€4.4/mo, **20 TB included** | **~€4** | **~€9** | **~€36** |
| Contabo VPS (self-hosted)            | ~$6/mo, ~32 TB included      |     ~$6 |     ~$6 |     ~$25 |
| DigitalOcean droplet                 | $6/mo + $0.01/GB over 1 TB   |    ~$11 |   ~$143 |  ~$1,466 |
| Cloudflare TURN                      | ~$0.05/GB                    |    ~$75 |   ~$735 |  ~$7,350 |
| Twilio Network Traversal             | ~$0.40/GB                    |   ~$600 | ~$5,880 | ~$58,800 |
| AWS EC2 egress                       | ~$0.09/GB                    |   ~$135 | ~$1,323 | ~$13,230 |

**This is the decisive finding.** Self-hosted coturn on a bandwidth-inclusive VPS
is roughly **1,000× cheaper** than managed TURN at scale. A managed TURN provider
would make a free consumer tier financially impossible; self-hosting makes it a
rounding error.

Sizing note: cost is bounded by _bandwidth_, but capacity is bounded by
_concurrency_. At 100k users, peak concurrent relays ≈ 840 × 2.5 Mbps ≈ **2.1
Gbps**, so ~3–4 boxes are needed for throughput regardless of the traffic
allowance. Budget ~8 boxes at 100k for headroom and regional spread.

---

## 4. Total monthly cost by scale

Phase numbering matches [§6](#6-scaling-path).

| Component                      |       100 users |          1,000 |           10,000 |          100,000 |
| ------------------------------ | --------------: | -------------: | ---------------: | ---------------: |
| Domain (`takedia.com`)         |             ~$1 |            ~$1 |              ~$1 |              ~$1 |
| API + signaling compute        | €4 (shared box) |             €4 |    €12 (2 boxes) |   €60 (~6 boxes) |
| PostgreSQL                     |   €0 (same box) |          €0–19 | €19–50 (managed) |         €100–200 |
| Redis                          | €0 (not needed) |             €0 |              €10 |              €30 |
| **TURN (self-hosted)**         |          **€4** |         **€4** |           **€9** |          **€36** |
| Monitoring / errors            | €0 (free tiers) |             €0 |            €0–20 |          €50–100 |
| Email (magic links)            |  €0 (free tier) |             €0 |             ~$15 |             ~$50 |
| **Total (order of magnitude)** |     **~€10/mo** | **~€15–30/mo** |  **~€60–120/mo** | **~€350–500/mo** |

At 100,000 users that is roughly **$0.004 per user per month**. A generous free
tier is not merely affordable — it is close to free to serve.

For contrast, the same product on managed TURN plus managed everything would run
into **tens of thousands of dollars per month** at 100k users, and the free tier
would have to be cut.

---

## 5. Managed vs self-hosted, per component

Engineering time has real value; the cheapest cloud bill is not always the
cheapest architecture.

| Component                       | Decision                                          | Why                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **coturn (TURN/STUN)**          | **Self-host**                                     | The 1,000× cost difference dominates everything else. coturn is stable, well-understood, and configured once. Also removes the hardcoded Google STUN dependency and its IP disclosure.            |
| **API + signaling**             | **Self-host on a VPS** (Phase 1–2)                | It is one Node process. A PaaS costs more and adds little at this size. Revisit if on-call burden becomes real.                                                                                   |
| **PostgreSQL**                  | **Self-host early → managed later**               | Trivial at Phase 1. Move to managed (Neon/Supabase have usable free tiers) once backups and point-in-time recovery matter more than the ~$20.                                                     |
| **Redis**                       | **Defer entirely**                                | Only needed for multi-instance signaling ([ADR-0004](adr/0004-signaling-horizontal-scaling.md)). At Phase 1 there is one instance; adding Redis now would be paying for Phase 2 at Phase 1 scale. |
| **Crash reporting**             | **Managed free tier** (Sentry ~5k errors/mo free) | Self-hosting Sentry costs far more in ops than the subscription.                                                                                                                                  |
| **Email (magic links)**         | **Managed** (Resend/SES ~$0–15)                   | Deliverability is a reputation problem that cannot be self-hosted cheaply.                                                                                                                        |
| **Analytics / product metrics** | **Build minimal, in Postgres**                    | We need ~10 counters, not a product-analytics platform. See [§7](#7-what-we-deliberately-do-not-buy).                                                                                             |
| **Payments**                    | **Not yet**                                       | No billing in V1. Stripe when there is something to sell.                                                                                                                                         |
| **Object storage**              | **Not needed**                                    | Lilypad stores no screen data, ever.                                                                                                                                                              |
| **Kubernetes**                  | **No**                                            | See [ADR-0005](adr/0005-turn-topology.md) — TURN needs host networking and a huge UDP port range, and the rest is one API process.                                                                |

---

## 6. Scaling path

Do not pay for Phase 4 while at Phase 1.

| Phase | Trigger                                               | Architecture                                                                                                                                    |
| ----- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | 0 → ~1k users                                         | One VPS: API + signaling + Postgres. One coturn VPS. No Redis.                                                                                  |
| **2** | Signaling CPU or WS count saturates                   | Horizontal API/signaling behind a load balancer + Redis pub/sub relay ([ADR-0004](adr/0004-signaling-horizontal-scaling.md)). Managed Postgres. |
| **3** | TURN latency poor for distant users, or >20 TB egress | Regional coturn (EU/US/APAC), latency-routed DNS.                                                                                               |
| **4** | Only if genuinely global                              | Regional control plane. Probably never needed at this product's scale.                                                                          |

**Upgrade paths are designed in from the start** (the signaling hub is already
decomposed so Phase 2 is a contained change), but none of them are paid for early.

---

## 7. What we deliberately do not buy

Each of these is a recurring cost avoided by not having the feature, or by
building the 5% of it we need:

- **A product-analytics platform.** We need connection-success rate, P2P:TURN
  ratio, setup time, reconnect frequency, crash rate. That is a handful of
  counters in Postgres, not Amplitude.
- **A managed feature-flag service.** A column and an env var.
- **A log aggregation platform.** Structured stdout logs plus retention on the
  box until volume justifies otherwise.
- **A support desk.** An email address.
- **Managed TURN.** See §3.
- **Anything storing session content.** Not a cost decision — a product one. See
  [§8](#8-database-cost-and-what-we-refuse-to-store).

---

## 8. Database cost, and what we refuse to store

The database must stay small and boring. Cost follows directly from that.

**Stored:** users; devices (including public keys and ownership); trust grants;
minimal session records (start/end/duration, for support and quotas); entitlement
state; security-relevant audit events.

**Never stored:** screen recordings or frames; keystroke or input history;
clipboard contents; file contents; AI prompts or conversations (by default);
per-heartbeat presence history; high-frequency telemetry.

At 100k users with minimal session records this is comfortably in the low
gigabytes — a rounding error against TURN. **Audit logs need a retention policy**
(they are the only table with unbounded growth today, and it has no index on
`created_at`); without one they become the largest table and eventually the
largest cost.

---

## 9. Free-tier strategy

The architecture makes a generous free tier sustainable because **the expensive
path is the rare path**.

| Tier             | Includes                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Free**         | Unlimited **LAN** sessions. Unlimited **direct P2P** remote sessions. A generous monthly allowance of **relayed** (TURN) minutes. Core remote control, input, clipboard, multiple devices, BYO-key AI. |
| **Paid (later)** | Higher or unmetered relay allowance; managed AI (we hold the key and pay inference); premium models; team/business features; extended history; priority support.                                       |

Two rules:

1. **LAN is never paywalled.** It costs us nothing, it is the best experience,
   and restricting it would be user-hostile for no gain.
2. **Meter only what actually costs money** — relayed minutes and managed AI
   inference. Everything else is free because it is genuinely free to serve.

---

## 10. Metrics that predict the bill

Track these from day one; they are the leading indicators of cost:

- **P2P : TURN ratio** — the single most important number.
- **LAN : remote ratio** — every point moved to LAN is pure margin.
- Relayed minutes per user (identifies abuse and the paid-tier boundary).
- TURN egress per region.
- Failed connection attempts by stage (LAN → P2P → TURN).
- Concurrent relays at peak (capacity planning, distinct from bandwidth).

None of these require collecting session content — they are counters and
ratios. See [NETWORKING.md §7](NETWORKING.md#7-privacy-what-leaves-the-device).
