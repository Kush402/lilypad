---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: The cloud may carry control traffic only; the data plane stays on the user's devices.
---

# ADR-0007 — The cloud is a control plane, never a data plane

## Context

Remote-control products drift toward routing everything through the vendor. It is
easier to build, easier to debug, and it quietly becomes both the largest
recurring cost and the largest privacy liability.

For Lilypad specifically, the numbers are stark. A relayed hour of 720p video is
~1.2 GB of egress. On managed TURN at ~$0.40/GB, 100,000 users would cost roughly
**$59,000/month** in relay alone; on self-hosted coturn with bandwidth-inclusive
VPS pricing it is roughly **€36/month**. See
[INFRASTRUCTURE-COST-MODEL.md](../INFRASTRUCTURE-COST-MODEL.md).

That difference is not a tuning detail. It determines whether a free consumer
tier can exist at all.

There is also a product argument. "Your screen never passes through our servers"
is a claim worth being able to make truthfully — and it is only true if the
architecture enforces it.

## Decision

**The cloud handles control traffic only. The data plane stays on the user's
devices.** This is a binding architectural constraint, not a preference.

**The cloud may handle:** account identity and authentication; device ownership,
metadata, and public keys; trust grants; authorization; signaling and
rendezvous; presence; connection negotiation; TURN credentials; TURN relay _only_
when direct connectivity fails; entitlement state; minimal aggregate telemetry;
update metadata; explicitly-submitted diagnostics.

**The devices handle:** screen capture; video encode and transport; input; the
clipboard; local files; local OS access; AI execution. Always.

Two rules follow, and both are testable:

1. **When two devices are on the same LAN, the entire session stays off the
   cloud** — including signaling ([ADR-0006](0006-lan-first-connectivity.md)).
2. **When relay is unavoidable, TURN forwards DTLS-SRTP packets it cannot
   read.** Relaying is a transport fallback, never an inspection point.

## Alternatives

**Cloud-relayed media as the default path** (the "just proxy everything"
architecture). Rejected on cost, privacy, and latency simultaneously. It is the
single most expensive design available and it forecloses the free tier.

**Cloud-side video transcoding** (server-side scaling, codec conversion,
recording). Rejected. It requires decrypting user screen content on our
infrastructure — an unacceptable privacy position for this product — and it adds
compute cost on top of bandwidth cost.

**Cloud-hosted AI execution.** Rejected for V1. The agent runs on the laptop
because that is where the screen, the accessibility tree, the sandbox, and the
files are. A managed-inference option may be offered later as a _paid_ tier where
the user opts in and the cost is metered — but the executor stays local.

**Storing session artefacts** (recordings, clipboard history, input logs) to
enable features later. Rejected. It would be the largest table, the largest cost
driver, and the largest breach liability, in exchange for features nobody has
asked for.

## Consequences

- **Cost scales with the rare path, not the common one.** LAN and P2P sessions
  are free to serve; only relayed minutes cost money, which is exactly what a
  paid tier should meter.
- **The privacy claim is architectural**, so it survives contact with a security
  review rather than depending on a policy promise.
- **Some features become harder or impossible**, and that is accepted: no
  server-side session recording, no cloud-side transcoding, no "watch a replay"
  feature without an explicit, consented, opt-in redesign.
- **The database must stay small.** See the cost model's list of what is refused
  storage. Audit logs are the one unbounded table and need a retention policy.
- **Observability must be privacy-preserving by construction** — counters and
  ratios (P2P:TURN, connection success, setup time), never content.
- **A cloud outage degrades rather than disables.** LAN sessions are unaffected;
  established remote sessions continue because media is peer-to-peer.

## Status

Accepted (2026-08-12). Constrains every subsequent milestone; enforced by the
LAN-offline test suite (M9.5) and by review of anything that proposes routing
session data through the backend.
