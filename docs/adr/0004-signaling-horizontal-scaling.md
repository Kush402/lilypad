---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: Why rooms stay in memory and instances relay through Redis pub/sub.
---

# ADR-0004 — Signaling scale-out: in-memory rooms + Redis pub/sub relay

## Context

The backend cannot run more than one instance. `RoomRegistry.rooms`,
`SignalingHub.ctx`, the metrics counters, the per-IP connection limiter, and the
`@fastify/rate-limit` counters are all per-process. The code is explicit about
this; `session/roomStore.ts` states that Redis persistence is scoped to
boot-time resurrection and "does not (yet) help a client whose reconnect lands on
a different, still-running replica".

This blocks production: a single instance is a single point of failure and cannot
be deployed with zero downtime.

The instinct is "move room state into Redis". That instinct is wrong here, and
the reason is specific to Lilypad's shape:

- A room has exactly **two** peers, never more.
- Signaling carries only SDP, ICE candidates, and control frames — a few KB over
  a session's entire lifetime. **Media never touches the backend.**
- Most of a session's wall-clock life is idle: after negotiation completes,
  signaling is nearly silent.

So the hot path is not hot, and the state is tiny. What is actually missing is a
way for two instances to reach each other.

## Decision

**Keep rooms in memory. Add Redis for routing only.**

- Redis holds a `device → owning_instance` map with a short TTL, refreshed by the
  existing heartbeat.
- Each instance subscribes to its own pub/sub channel.
- When a room's two peers are connected to different instances, `relay`/`send`
  publish through Redis instead of calling `Peer.send` directly.
- Per-IP caps and rate limits move to a Redis-backed store in the same change,
  because in-process limits silently multiply by the replica count.

`Room`, `MessageRouter`, and `LifecyclePolicy` are **not modified**. The change is
confined to the executor methods on `SignalingHub` — which is possible precisely
because the M3 architecture pass already separated pure routing decisions from
the code that performs I/O.

## Alternatives

**Move all room state into Redis.** Rejected. Adds a network round-trip to every
relayed frame and a serialization boundary to the FSM, in exchange for solving a
state-size problem that does not exist. It would also make `handleMessage`
async, which the codebase deliberately avoided so a client's `register` can never
race an in-flight Redis read for its own next message.

**Sticky sessions / connection affinity at the load balancer.** Rejected. Mobile
clients reconnect constantly and from different source IPs — cellular NAT rebinds
are the normal case, not the exception. Affinity cannot be guaranteed for the
exact client population that reconnects most.

**Redirect the mobile peer to the desktop's instance via a per-instance
hostname.** Rejected for now. It is the cleanest topology and avoids the relay
hop entirely, but it requires per-instance DNS and public addressability, which is
a large infrastructure commitment for a hop that costs microseconds on a channel
carrying kilobytes.

## Consequences

- Horizontal scaling becomes a deployment concern rather than a code change.
- An instance dying kills its rooms — but both clients already survive this:
  desktop presence reconnects forever with capped backoff, and sessions continue
  because media is peer-to-peer and seats are held for a re-register grace
  window. This is the payoff of the existing resilience work.
- Redis becomes required for new sessions and for cross-instance relay. It is
  **not** required for sessions already established, which keep running
  peer-to-peer through a Redis outage.
- Redis pub/sub is at-most-once. Acceptable: every message it carries is either
  idempotent or already covered by client-side retry (ICE trickle, renegotiate).
  A dropped frame degrades to the same case as a transient socket blip, which the
  clients are extensively hardened against.
- The 10k-concurrent target needs roughly 3–4 instances. The bottleneck at higher
  scale is TURN bandwidth, not signaling CPU — see [ADR-0005](0005-turn-topology.md).

## Status

Accepted (2026-08-12). Implemented in milestone M11.
