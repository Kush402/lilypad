---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: Why the laptop runs its own control plane so LAN sessions need no internet.
---

# ADR-0006 — LAN-first connectivity: the laptop is its own control plane

## Context

Two devices on the same network should not need the public internet to talk to
each other. That is a correctness argument, a privacy argument, a latency
argument, and — because relayed bandwidth is the dominant infrastructure cost —
a cost argument.

Verified state of the code (2026-08-12):

- **The media path is already LAN-direct.** `iceTransportPolicy` defaults to
  `'all'`, candidates trickle as gathered, and nothing requires a srflx or relay
  candidate, so host candidates win on-LAN.
- **The control path is not.** A session cannot start without `/pairing/*` (or
  `/connect/request`) _and_ the `/ws/signal` socket that brokers approval and
  carries offer/answer.
- **It currently works offline only by accident.** `DEFAULT_BACKEND_URL` is
  `http://localhost:8080` and the backend advertises its own LAN IP in the QR, so
  the "cloud" is a process on the laptop. That is a development artifact.
- **There is no LAN discovery of any kind** — no mDNS, Bonjour, `NSNetService`,
  `NsdManager`, or UDP broadcast, and no local-network entitlements.

The previous roadmap proposed moving signaling to `signal.takedia.com`. That
would have **regressed** LAN capability: every same-room session would have
started depending on the public internet. This ADR exists because that plan was
wrong.

## Decision

**The desktop app embeds a signaling server. The cloud is a rendezvous service
used only when the devices cannot reach each other directly.**

1. The laptop serves the existing `@lilypad/protocol` signaling contract at
   `https://<laptop>:PORT/ws/signal`. A LAN room has exactly two known peers, so
   this is dramatically simpler than the cloud hub: no room registry, no capacity
   policy, no Redis, no multi-tenancy.
2. The local channel is **TLS with a self-signed certificate bound to the
   device's Ed25519 identity** ([ADR-0002](0002-device-identity.md)), pinned by
   the phone at pairing. No CA and no name resolution required.
3. **Discovery is a cached last-known address first, mDNS second.** A cached
   address is one TCP connect — faster than multicast _and_ functional on the
   many networks that block it. mDNS (`_lilypad._tcp.local`) recovers the case
   where DHCP moved the laptop.
4. **Both are attempted before any cloud call**, so a LAN session never pays a
   cloud round-trip and never tells the cloud it happened.

## Alternatives

**Keep signaling cloud-only; rely on the media path being direct.** Rejected —
it fails the hard requirement outright. Media being direct is worth little if the
session cannot be _established_ without the internet.

**Cloud-assisted LAN hint** (laptop reports its local IPs; phone tries them).
Rejected as the primary mechanism: it still needs the internet, so it cannot
deliver an offline LAN session. Retained as a remote-mode optimisation.

**Raw UDP broadcast or custom multicast discovery.** Rejected. On iOS it requires
the `com.apple.developer.networking.multicast` entitlement, which needs an Apple
approval process, and it invents a wire protocol where a standard one exists.
Browsing via the _system_ mDNS API needs only the Local Network permission.

**Bluetooth/BLE discovery.** Rejected — extra permissions, extra battery, short
range, and it would only carry an address obtainable far more cheaply.

**Ship the Node backend inside the desktop app.** Rejected: a large binary, a
second runtime, and a second update surface, to serve two peers.

## Consequences

- **A LAN session works with the cloud entirely offline.** This is the headline
  capability and becomes a release-blocking automated test.
- **New surface on the desktop:** an embedded TLS server, certificate generation
  and pinning, and an mDNS responder. This is real work and real attack surface —
  it must be bound to the loopback/LAN interfaces, authenticated, and covered by
  the same authorization model as the cloud path.
- **The protocol stays single-source.** Both control planes speak the contract in
  `@lilypad/protocol`, so the phone's session code is identical either way; only
  the endpoint differs.
- **Presence needs a local answer too.** Cloud presence is unavailable offline,
  so "is my laptop here?" on a LAN is answered by discovery, not by the cloud.
- **Networks that block peer-to-peer traffic** (client isolation, guest and many
  corporate networks) cannot be fixed by any discovery mechanism. Lilypad falls
  through to remote mode and says so honestly.
- **Cost:** every LAN session is zero marginal cost. Combined with
  [ADR-0007](0007-cloud-is-control-plane-only.md), this is what makes a generous
  free tier sustainable.

## Status

Accepted (2026-08-12). Implemented in milestone M9.5, before the cloud
deployment milestone — so the cloud is added _beside_ a working local path rather
than in front of it.
