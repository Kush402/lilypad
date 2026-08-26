---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-15
summary: Free is LAN connectivity forever; remote connectivity is the paid feature, after a one-month trial.
---

# ADR-0013 — Connectivity is the paid boundary

**Amends the free-tier strategy in
[INFRASTRUCTURE-COST-MODEL.md §9](../INFRASTRUCTURE-COST-MODEL.md#9-free-tier-strategy).**

## Context

The product is one sentence: **use your laptop from your phone.** Two ways to
reach the laptop exist, and they have completely different economics
([NETWORKING.md](../NETWORKING.md), [ADR-0006](0006-lan-first-connectivity.md)):

- **On the same network.** Media goes host-to-host. Nothing we run carries a
  byte of it, ever.
- **From anywhere else.** Direct P2P when the NATs allow it, TURN relay when
  they do not. Relay is the only path that spends our money, at roughly
  **1.2 GB per relayed hour**.

The previous strategy metered **only what costs money**: free included unlimited
LAN _and_ unlimited direct P2P remote sessions, plus an allowance of relayed
minutes. That principle is coherent, but it prices the product by our cost
rather than by the value a user receives, and it makes the free tier and the paid
tier differ only in a number the user cannot see or predict.

## Decision

**Free is LAN, forever. Remote connectivity is the paid feature, and every
account gets one month of it free before paying.**

|                                   | Free                  | Paid (`pro` / `team` — `$XXXX`)                 |
| --------------------------------- | --------------------- | ----------------------------------------------- |
| Same network as the laptop        | ✅ unlimited, forever | ✅                                              |
| Remote (cellular, other networks) | —                     | ✅ **P2P first, TURN only when needed**         |
| Trial                             | —                     | **1 month of remote, then payment is required** |

Four things this decision explicitly keeps:

1. **LAN is never paywalled, never metered, never counted.** Unchanged from the
   previous strategy and non-negotiable.
2. **LAN traffic is never routed through the cloud.** The boundary is about who
   may _establish_ a remote session, never about inserting ourselves into a
   local one.
3. **P2P before TURN, always.** Paying for remote does not mean being relayed —
   it means being allowed to connect remotely at all. A paid session that goes
   direct costs us nothing, and the client must still prefer it.
4. **Prices stay `$XXXX`** until the owner sets them. Tiers remain `free`,
   `pro`, `team` (`users.tier`); this ADR decides _what_ is paid, not _how much_.
   Answered on 2026-08-26 by [ADR-0016](0016-storekit-and-the-price.md): $2.99 a
   month, one month included, through StoreKit.

## The honest tension

**Direct P2P costs us nothing, and this decision charges for it anyway.** That
breaks the old "meter only what costs money" rule, and it should be recorded as
a deliberate choice rather than smoothed over.

The reason it is defensible: the value a user buys is _reaching their laptop from
the train_, and they neither know nor care whether that particular session
happened to traverse a relay. Pricing on our transport luck would make the same
product cost different amounts on different networks. The cost rule still governs
the **architecture** — P2P first, TURN last, because that is what keeps the paid
tier's margin — it simply no longer governs the **price list**.

The consequence for cost modelling is favourable: relay is now only ever bought
by trial and paying users, so free users cannot generate relay spend at all.

## What makes this enforceable, and what does not

**Free is free by construction, not by policy.** A LAN session's media never
touches us, so there is nothing to meter and no bill to avoid. We do not gate it
because we could not observe it even if we wanted to.

**Remote is enforceable because remote is ours.** Reaching a laptop across the
internet requires our control plane: presence, `/connect/request`, and the
signaling room. That is exactly where an entitlement check belongs — one gate on
remote session establishment, not a meter on traffic.

**This is not implemented, and one prerequisite is missing.**

- `users.tier` is still read nowhere (P6).
- **A LAN session today still depends on the control plane.** Media on LAN is
  already direct — verified — but establishment goes through `/pairing/*` and
  `/ws/signal`, so "LAN works with no internet" is currently true only in
  development, where the backend happens to run on the laptop
  ([NETWORKING.md §1](../NETWORKING.md#1-what-the-code-does-today-verified-2026-08-12)).
  There is also no LAN discovery: the phone learns the laptop's address only
  from a QR or a saved pair.

  **A free tier defined as "LAN only" therefore cannot ship until the laptop can
  act as its own control plane** — which is already the target design in
  NETWORKING §2, not new work invented here. Until then, cutting free users off
  from the cloud would cut them off from LAN as well.

## Alternatives

**Meter relayed minutes, free tier included (the previous strategy).** Rejected
by the owner in favour of a boundary a user can understand without knowing what
a NAT is. Its cost logic survives in the architecture.

**Free tier includes remote P2P but not TURN.** Rejected: it makes the product's
availability depend on the user's network topology, so the same purchase behaves
differently for different people, and support cannot explain why.

**Time-limited trial of everything, then LAN-only.** This is what was chosen,
stated the other way round — one month of remote, then remote stops and LAN
continues forever. Recorded here so the equivalence is not re-litigated.

## Consequences

- **P6 (entitlements) gains a concrete definition** and loses one of its two
  blockers: _what_ is gated is now decided. It still needs prices.
- **The trial is a new piece of state** — per account, one month, starting at a
  moment that has to be defined (first sign-in, or first remote attempt). Not
  decided here; it is a product question with no code depending on it yet.
- **Billing becomes real work** — Stripe, a webhook, and a tier column that is
  actually read. None of it exists today.
- **The cost model's free-tier section is superseded**; relay demand at every
  scale should now be modelled against trial + paying users, not all users.
- **LAN independence moves onto the critical path for launch**, because it is
  what makes the free tier a real product rather than a disabled one.
