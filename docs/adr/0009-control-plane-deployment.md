---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-13
summary: Why the control plane is one VM behind a Cloudflare tunnel, with TURN deliberately separate.
---

# ADR-0009 — One VM, a tunnel, and TURN kept apart

## Context

Lilypad needs a public control plane so devices can pair and sign in from
anywhere. It must not become a cloud remote-desktop service: screen and input
are peer-to-peer, and on a LAN they never leave the network
([ADR-0006](0006-lan-first-connectivity.md), [networking.md](../NETWORKING.md)).

That shapes the economics completely. A session costs a few KB of signaling to
set up and then **zero** server bandwidth for its entire life. The only traffic
we ever pay for is TURN relay, and only when both peers fail to connect
directly.

Two constraints came from measurement rather than preference:

- **Egress pricing dominates.** Hetzner includes 20 TB with a ~€4.35/mo box;
  Fly charges $0.02/GB and AWS ~$0.09/GB. One terabyte of relay is €0, $20, or
  $90 depending only on where it runs.
- **A sleeping host is disqualifying.** Render's free tier sleeps on idle, which
  drops every WebSocket. Presence and signaling are long-lived sockets, so a
  free tier that sleeps does not merely degrade Lilypad — it breaks it. Fly and
  Railway no longer offer a free tier at all (as of August 2026).

## Decision

**One VM runs the whole control plane — backend, Postgres, Redis — behind a
Cloudflare Tunnel. TURN runs on a separate host.**

1. **Cloudflare Tunnel for ingress.** cloudflared dials outward, so the VM has
   **no inbound ports open at all**: no firewall rule to misconfigure, no
   certificate to expire, free TLS and DDoS absorption. The identical mechanism
   already serves `lilypad.takedia.com`.
2. **Postgres and Redis as containers on that VM**, published to nothing.
   Redis is not optional — eleven modules depend on it for pairing tokens,
   device challenges and room routing — but its data is single-use and
   short-TTL, so persistence stays off and a managed instance would be paying
   for durability we deliberately do not want.
3. **TURN stays separate** ([`infra/coturn-prod`](../../infra/coturn-prod/README.md)).
   A tunnel carries HTTP and WebSockets only; TURN needs UDP on a public IP with
   a wide port range. Separating it also means a relay flood cannot starve the
   API.
4. **Staged cost:** $0 on Oracle Always Free for testers, ~€9/mo on Hetzner for
   real production. Nothing heavier is provisioned before a measurement demands
   it.

## Alternatives

**A managed platform (Fly, Railway, Render).** Rejected on all three counts
above: no free tier, or a free tier that sleeps and breaks WebSockets, plus
per-GB egress on the one workload that has real bandwidth.

**Managed Postgres (Neon/Supabase) from the start.** Reasonable, and kept as a
documented fallback. Rejected as the default because the VM must exist anyway
for Redis and the backend, so a second vendor adds a failure mode and a network
hop for no saving. Neon's 0.5 GB free tier also scales to zero, which adds cold
starts to sign-in.

**Managed TURN (Twilio, Metered).** Rejected as the steady state: per-GB pricing
is precisely the cost curve this architecture exists to avoid. Metered's free
tier is what the project used during development, and its instability under a
sustained 1–3 Mbps stream is documented in `infra/coturn-prod/README.md`.

**Kubernetes.** Rejected outright at this scale. The control plane is one Node
process; orchestrating it would cost more operational surface than it removes.

## Consequences

- **The control plane is a single point of failure, and that is an accepted
  trade.** When it is down, new pairings fail — but **live P2P sessions keep
  running**, reconnects keep working (device tokens verify by signature, not a
  DB read), and LAN sessions are entirely unaffected.
- **Multi-instance is a real change when it comes.** Rooms, rate limits and IP
  caps are per-process `Map`s today, so a second instance requires the Redis
  pub/sub relay. It is contained to `SignalingHub`'s executor methods, and
  nothing before Stage 3 needs it.
- **Signaling shares `api.takedia.com`.** A separate `signal.` host buys
  independent scaling we do not need yet; splitting later is a DNS record.
- **Oracle Always Free carries real risk** — ARM capacity is often unavailable,
  idle resources get reclaimed, and there is no SLA. It is the $0 tester tier,
  never the paid-user tier.

## Status

Accepted (2026-08-13). Artifacts built and verified locally: the multi-arch
image boots under production configuration and reports healthy, the production
guard refuses dev defaults, `/metrics` requires a bearer token, and CORS fails
closed. **Nothing is deployed to a public host.** Route authorization (SEC-3)
landed in M9 ([ADR-0010](0010-explicit-device-linking.md)); the remaining
caveat before opening this to strangers is that unenrolled devices still use
the pre-accounts lane until P1 makes enrolment mandatory in both clients — see
[deployment.md](../deployment.md).
