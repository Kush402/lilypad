---
status: Planned
owner: @kushsharma024
last-verified: 2026-08-12
summary: Connectivity architecture — LAN-direct first, internet P2P second, TURN last.
---

# Lilypad — Networking Architecture

> **Status: Planned.** This is the target design. §1 records what the code does
> **today** (verified), §2 onward is the design being built. See
> [ADR-0006](adr/0006-lan-first-connectivity.md) and
> [ADR-0007](adr/0007-cloud-is-control-plane-only.md).

Two hard requirements govern everything here:

1. **A LAN session must work with no internet at all.**
2. **The cloud must never carry the data plane, and cloud spend must be
   minimized aggressively without hurting security or reliability.**

---

## 1. What the code does today (verified 2026-08-12)

| Property                   | Reality                                                                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LAN discovery              | **None.** No mDNS, Bonjour, `NSNetService`, `NsdManager`, or UDP broadcast anywhere. No `NSLocalNetworkUsageDescription` / `NSBonjourServices`. The phone learns the laptop's address **only** from the QR payload, or from `apiBaseUrl` stored on a saved pair.        |
| Media path on LAN          | **Already direct.** `iceTransportPolicy` defaults to `'all'`, candidates trickle as gathered, and nothing requires a srflx or relay candidate — host candidates win on-LAN. The data plane requirement is already met.                                                  |
| Control plane              | **Hard dependency.** A session cannot start without `/pairing/create` + `/pairing/redeem` (or `/connect/request`) **and** the `/ws/signal` socket, which brokers register → pair-request → approve → `session-start` (carrying ICE servers) → offer/answer/ICE relay.   |
| Internet needed on LAN?    | **No — but only by accident.** `DEFAULT_BACKEND_URL` is `http://localhost:8080` and `config.ts` advertises the laptop's own LAN IP in the QR, so the "cloud" is currently a process running _on the laptop_. That is a development artifact, not a designed capability. |
| Post-establishment         | **Already correct.** A dropped signaling socket does not end an established session: media flows peer-to-peer and the seat is held for a grace window.                                                                                                                  |
| Presence / no-QR reconnect | **Cloud-only.** `presence.rs` holds a standing WebSocket to `backend_base_url`; `/connect/request` is an HTTP round-trip. Neither has a LAN path.                                                                                                                       |
| STUN                       | Google's public STUN is hardcoded (`stun.l.google.com`). With no internet it simply yields no srflx candidates — host candidates still work — but it adds gathering latency, and when the internet _is_ up it discloses every user's IP to a third party.               |

### The consequence that reshaped the plan

Moving the backend to `signal.takedia.com` — which is exactly what the previous
roadmap's M13 proposed — **would have regressed LAN capability**, making every
same-room session depend on the public internet for signaling. The fix is not to
keep the backend on localhost; it is to recognise that **the laptop must be able
to act as its own control plane**, with the cloud as a rendezvous service used
only when the devices cannot find each other directly.

---

## 2. Target architecture

```
                   ┌────────────────────────────┐
                   │       TAKEDIA CLOUD        │   ← control plane ONLY
                   │  identity · ownership ·    │
                   │  presence · rendezvous ·   │
                   │  TURN creds · TURN relay   │
                   └─────────────┬──────────────┘
                                 │  only when devices
                                 │  cannot reach each other
              ┌──────────────────┴──────────────────┐
          PHONE                                  LAPTOP
        ┌──────────┐                          ┌──────────┐
        │ viewer   │                          │ capture  │
        │ input    │                          │ input    │
        │          │                          │ AI       │
        └────┬─────┘                          └────┬─────┘
             └────────────── DIRECT ───────────────┘
                    LAN · then P2P · then TURN
```

**The data plane never touches the cloud** except as a TURN relay of last
resort. On a LAN, nothing touches the cloud at all.

### Two control planes, one protocol

The wire protocol in `@lilypad/protocol` is unchanged. What varies is **who
serves it**:

| Mode           | Signaling served by                                                      | Internet required |
| -------------- | ------------------------------------------------------------------------ | ----------------- |
| **A — LAN**    | An embedded server on the **laptop** (`https://<laptop>:PORT/ws/signal`) | **No**            |
| **B — Remote** | The cloud (`wss://signal.takedia.com/ws/signal`)                         | Yes               |

A LAN room has exactly two known peers, so the embedded server is far simpler
than the cloud hub: no room registry, no capacity policy, no Redis, no
multi-tenancy. It reuses the existing `MessageRouter` semantics.

### Local channel security

The local endpoint is TLS with a **self-signed certificate bound to the
device's Ed25519 identity** ([ADR-0002](adr/0002-device-identity.md)), pinned by
the phone at pairing time. No CA, no internet, no name resolution required — and
the same identity authenticates the device both locally and remotely. Media is
DTLS-SRTP regardless; this protects the signaling channel from a hostile peer on
the same LAN.

---

## 3. Connection algorithm

The user never chooses a mode. They tap a laptop; the client races paths.

```
User taps "MacBook Pro"
        │
        ├─ 1. Last-known LAN address (cached from the previous session)
        │      one TCP connect, ~50ms, no multicast, works offline
        │      hit ──────────────────────────────► LAN WebRTC (host candidates)
        │
        ├─ 2. mDNS browse  _lilypad._tcp.local
        │      ~200–500ms, works offline, needs multicast on the network
        │      hit ──────────────────────────────► LAN WebRTC
        │
        ├─ 3. Cloud presence: "is this laptop online?"
        │      requires internet
        │      no ───────────────────────────────► "MacBook Pro is offline"
        │      yes
        │        ├─ 4. Internet P2P via STUN (host + srflx)
        │        │      success ──────────────────► Direct WebRTC, no relay
        │        └─ 5. TURN relay
        │               success ──────────────────► Relayed WebRTC
        │               fail ─────────────────────► "Couldn't connect"
```

**Ordering rationale.** Step 1 before step 2 is deliberate: a cached address is
one TCP connect with no multicast dependency, so it is both faster _and_ works on
the many networks that block mDNS. Step 2 recovers the case where DHCP moved the
laptop. Steps 1–2 are attempted **before any cloud call**, so a LAN session never
pays a cloud round-trip and never reveals to the cloud that a session happened.

Steps 1 and 2 run concurrently with a short timeout budget (~1.5s total) before
falling through to the cloud, so a laptop that is genuinely remote does not feel
slow.

---

## 4. LAN discovery decision

Evaluated against: works offline · no new wire protocol · no special platform
entitlement · survives hostile networks.

| Option                                                 | Verdict                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Last-known-address cache**                           | **Chosen (primary).** Zero protocol, zero dependencies, instant, works offline, and works where multicast is blocked. Fails only when the laptop's IP changed — which mDNS then covers.                                                                                                                                                                                       |
| **mDNS/Bonjour `_lilypad._tcp`**                       | **Chosen (secondary).** Uses each platform's _native_ API — `NWBrowser`/`NetService` (Apple), `NsdManager` (Android), `dns-sd` (macOS host), a Rust mDNS crate on Windows. Critically, browsing via the system API needs only the **Local Network** permission, **not** the `com.apple.developer.networking.multicast` entitlement, which requires an Apple approval process. |
| Raw UDP broadcast / custom multicast                   | **Rejected.** Requires the multicast entitlement on iOS (Apple approval), invents a protocol, and is blocked on the same networks mDNS is.                                                                                                                                                                                                                                    |
| Cloud-assisted LAN hint (laptop reports its local IPs) | **Rejected as primary** — it needs the internet, so it cannot satisfy requirement 1. Retained as a _remote-mode_ optimisation only.                                                                                                                                                                                                                                           |
| Bluetooth / BLE                                        | **Rejected.** Extra permissions, extra battery, poor range, and no throughput benefit — it would only carry an address we can get more cheaply.                                                                                                                                                                                                                               |
| QR-assisted                                            | **Already exists.** Remains the provisioning path, not the reconnect path.                                                                                                                                                                                                                                                                                                    |

### Networks where LAN discovery fails

Documented honestly rather than pretended away. On **WiFi client isolation**,
**guest networks**, and many **corporate networks**, peer-to-peer LAN traffic is
blocked outright — no discovery mechanism can fix that, because the network is
deliberately preventing it. On those networks Lilypad falls through to Mode B and
behaves exactly as a remote session. Some **VPNs** capture all traffic and break
LAN reachability; the client detects the failure and falls through the same way.
IPv6-only and dual-stack networks are handled because mDNS advertises both A and
AAAA records and ICE gathers both families.

---

## 5. When TURN is actually necessary

TURN is needed only when **both** peers are behind NATs that defeat hole
punching — most commonly symmetric NAT or carrier-grade NAT on mobile networks.
It is never needed on a LAN, and not needed for most home-router-to-cellular
paths where STUN succeeds.

This matters financially: TURN is the single largest potential cost driver, and
every session pushed to LAN or P2P costs **exactly zero**. See
[INFRASTRUCTURE-COST-MODEL.md](INFRASTRUCTURE-COST-MODEL.md).

Cost-control measures, in order of impact:

1. **LAN-first** — a session at home never reaches the internet, let alone TURN.
2. **Never force relay.** `FORCE_RELAY` stays off; `iceTransportPolicy: 'all'`.
3. **Self-hosted coturn on bandwidth-inclusive VPS**, not per-GB managed TURN —
   a ~1000× cost difference at scale (see the cost model).
4. **Short-lived credentials** (already implemented: 5-minute HMAC) so a leaked
   credential cannot be used to relay third-party traffic.
5. **Per-user quotas** on relayed minutes, enforced at credential-issue time.
6. **Measure the P2P:TURN ratio continuously** — it is the metric that predicts
   the infrastructure bill.

---

## 6. Failure modes

| Condition                  | LAN session                                                               | Remote session                                                                                        |
| -------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Cloud completely down      | **Works.** Discovery, pairing-on-file, signaling, media, input all local. | Cannot establish. Already-established sessions continue (media is P2P).                               |
| Internet down, LAN up      | **Works.** This is the headline capability.                               | N/A                                                                                                   |
| TURN down                  | Unaffected — never used.                                                  | Works when P2P succeeds; fails only for the subset that needs relay.                                  |
| Database down              | Unaffected.                                                               | New sign-ins fail; existing sessions and reconnects survive (tokens verify by signature, not lookup). |
| Signaling down mid-session | Session continues — media is peer-to-peer and the seat is held.           | Same.                                                                                                 |
| Laptop asleep              | Not reachable. Wake-on-LAN is a possible future addition.                 | Not reachable.                                                                                        |

---

## 7. Privacy: what leaves the device

| Data                                            | Leaves the device?                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Screen video, input, clipboard, files           | **Never to the cloud** — direct, or DTLS-SRTP through TURN which relays _encrypted_ packets it cannot read. |
| AI prompts and results                          | Stay on the laptop; go only to the model provider the user configured with their own key.                   |
| Account identity, device public keys, ownership | Cloud (control plane).                                                                                      |
| Presence ("laptop is online")                   | Cloud, **remote mode only**. A LAN session tells the cloud nothing.                                         |
| Session metadata (start/end/duration)           | Cloud, remote mode only, minimal.                                                                           |

**A LAN session is invisible to the cloud.** That is a genuine privacy property,
not a marketing line, and it follows directly from the architecture.

---

## 8. Consumer messaging

Accurate claims only:

- **"Your computer. Anywhere."**
- **"At home, Lilypad connects directly over your own network — no internet
  required."**
- **"Away, Lilypad connects securely over the internet, peer-to-peer whenever
  possible."**
- **"Your screen never passes through our servers."** — true: direct on LAN and
  P2P, and end-to-end encrypted through TURN when relayed.

Do **not** describe Lilypad as a "cloud remote desktop". It would misrepresent
the architecture and undersell the privacy property.
