---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: Why TURN runs on dedicated regional VMs rather than in Kubernetes.
---

# ADR-0005 — TURN topology: dedicated regional VMs, not Kubernetes

## Context

TURN is what makes Lilypad work on the networks it was built for. A direct
peer-to-peer path succeeds often, but not on symmetric NAT, not on many cellular
carriers, and not on restrictive corporate or hotel Wi-Fi. When it fails, the
relay is the product.

The current state is not production-viable:

- `infra/coturn-prod/turnserver.conf` sets `min-port=49160`, `max-port=49260` —
  **100 ports, roughly 50 concurrent relayed sessions.** Far below the launch
  target.
- The static auth secret is passed on the container command line, so it is
  visible in `docker inspect` and the host process list.
- The backend advertises **Google's public STUN servers**
  (`stun.l.google.com`), disclosing every user's IP to a third party on every
  connection, despite coturn being perfectly capable of serving STUN itself.
- No `turns:` (TLS over 443) candidate is advertised, so a user on a network that
  blocks UDP outright has no working path at all.

## Decision

**Run coturn on dedicated VMs in three regions, latency-routed by DNS. Not
Kubernetes, not serverless.**

- Relay port range sized to the concurrency target with substantial headroom.
- `turns:` on TCP/443 advertised as the last-resort candidate.
- Self-hosted STUN via the same coturn instances; drop the Google dependency.
- The auth secret moves to an environment file or secret store, off the command
  line. HMAC per-session credentials stay as they are — that part is already
  correct — plus secret rotation and credential refresh on `renegotiate`.

## Alternatives

**coturn in Kubernetes.** Rejected. TURN needs a very large contiguous UDP port
range and host networking to allocate relay ports. Expressing that in Kubernetes
means `hostNetwork: true` with a hostPort range, which discards most of what the
orchestrator provides while inheriting all of its operational complexity. The
pods would be pinned to nodes and effectively become VMs with extra steps.

**Managed TURN (Twilio, Metered, Cloudflare Calls).** Not rejected outright —
this is the right fallback if self-hosting proves burdensome, and the code
already supports a static-credential public relay for exactly this. Rejected as
the primary because relay bandwidth is the dominant cost at scale and per-GB
managed pricing is where the economics break first. The `PUBLIC_TURN_URL` seam
means switching is configuration, not code.

**Serverless / edge.** Rejected. TURN requires long-lived raw UDP associations.
There is no serverless product that fits, and any attempt becomes a hybrid where
the real relay is a VM anyway.

**Anycast.** Rejected for now. It is genuinely attractive for TURN and worth
revisiting, but it requires BGP and address-space commitments that do not make
sense at hundreds-to-low-thousands of users. Latency-routed DNS reaches ~90% of
the benefit for ~5% of the effort.

## Consequences

- Relay bandwidth becomes the primary infrastructure cost, and it scales with the
  fraction of sessions that cannot go peer-to-peer. Measuring the P2P-vs-TURN
  ratio is therefore a first-class metric, not a nice-to-have (milestone M15).
- Three VMs need patching, monitoring, and certificate renewal — real ongoing ops
  that Kubernetes would not have removed anyway.
- Adding a region is a VM plus a DNS record, not a cluster.
- TLS certificates for `turns:` must be renewed on the TURN hosts; coturn must be
  reloaded when they rotate. This is a scheduled operational task and belongs in
  the runbook.
- Users on UDP-blocked networks get a working, if slower, path for the first time.

## Status

Accepted (2026-08-12). Implemented in milestone M13.
