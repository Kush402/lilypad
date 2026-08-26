---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-26
summary: Pro is $2.99/month with one month included, sold through StoreKit, and the entitlement is enforced by the control plane at remote session establishment.
---

# ADR-0016 — What Pro costs, and who takes the money

**Completes [ADR-0013](0013-connectivity-is-the-paid-boundary.md)**, which
decided that remote connectivity is the paid feature and deliberately left the
price as `$XXXX` "until the owner sets them". The owner set them on 2026-08-26.

## Context

Three things were open, and each blocked something concrete: the website could
not describe a plan, the iOS app could not be submitted with a paid feature and
no purchase path, and the backend had no reason to read `users.tier` — a column
that had existed unread since M8.

## Decision

**Pro is $2.99 per month, with one month included, sold as an auto-renewing
subscription through StoreKit.** Free stays exactly as ADR-0013 describes it:
unlimited LAN, forever, never metered. Team remains a mailto and a human reply
until two customers have asked for it.

### Why StoreKit and not Stripe

Stripe was considered and rejected for the iOS purchase path. Guideline 3.1.1:

> "If you want to unlock features or functionality within your app… you must use
> in-app purchase. Apps may not use their own mechanisms to unlock content or
> functionality, such as license keys…"

Remote access is functionality inside the app. Selling it through Stripe from
the iOS app is the case that guideline exists to refuse, and the US storefront's
new latitude is about _linking out to_ an external purchase, not about replacing
in-app purchase with one. A rejection here costs a review cycle at the exact
moment the product is trying to launch.

The cost is Apple's commission: 15% under the Small Business Program, which is
**not automatic and must be applied for**. That is $0.45 of $2.99. Against
infrastructure at roughly $0.004 per user per month
([INFRASTRUCTURE-COST-MODEL.md](../INFRASTRUCTURE-COST-MODEL.md)), the margin
survives it comfortably.

### The trial is Apple's, not ours

**The included month is a StoreKit introductory offer, not a `trial_ends_at`
column.** Apple enforces one introductory offer per Apple ID per subscription
group, at the platform level, for free.

A trial recorded against an email address is farmed with a stream of throwaway
addresses, and reached by accident by anyone who signs up twice. Every month of
engineering that would go into detecting that is a month not spent on the
product, and the platform already solved it.

### Where the entitlement is enforced

**One gate, at remote session establishment, in the control plane.** Not a meter
on traffic, and not a check scattered across clients.

This requires something that does not exist yet: the backend currently cannot
tell a LAN session from a remote one, because
[NETWORKING.md §1](../NETWORKING.md) makes the control plane a hard dependency
for _every_ session. Gating `/connect/request` today would gate LAN as well,
which ADR-0013 forbids in its first non-negotiable. **The LAN control path is
therefore a prerequisite of billing, not a performance optimisation** — see
[ADR-0006](0006-lan-first-connectivity.md), which specified it long before there
was a commercial reason to build it.

Until it exists, the entitlement check is written, tested, and left switched
off. A gate that cannot distinguish free from paid must not be enforcing.

### Nobody loses something they were promised

The website listed "relayed sessions when a network blocks a direct one" under
Free, and said paid tiers would only ever be about larger allowances and managed
AI. That was ADR-0013's predecessor strategy, still live on the page months
after the ADR amended it.

Exactly one account existed when this was found, and it belonged to the owner,
so the page was corrected at zero cost. The promise that replaces it is pinned
by a test: **remote access stays free for everyone who has it until the day Pro
can actually be bought.** The paywall arrives with the purchase button or not at
all.

## Consequences

- `users.tier` becomes load-bearing after eight milestones of being dead.
- Receipt validation and App Store Server Notifications v2 become a
  production dependency: a subscription that lapses has to be observed, and a
  refund has to remove access.
- The desktop cannot sell anything. It reads entitlement from the account, which
  means a customer buys on their phone and their Mac learns about it. That is
  the same direction ownership already flows in
  ([ADR-0015](0015-ownership-follows-sign-in.md)).
- **A price is now a promise.** The site quotes no figure until the purchase
  path exists, because a price with no button is an offer that cannot be
  accepted.
