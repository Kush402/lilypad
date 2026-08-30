---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-29
summary: Canonical map of the system as built.
---

# Lilypad — Architecture Overview

_Current as of 2026-07-19 (post-M5.4). This is the canonical map of the system
as built; per-subsystem rationale lives in the docs it links._

Lilypad is a **phone-first remote laptop control** system with a built-in AI
operator. Pair a phone with a Mac **once**, and from then on the phone connects
— over the local network when both are on it, over the internet when they are
not — straight into a live, controllable screen session. An **Ask** bar lets the
phone hand the Mac a task in plain language, executed on-device by a tiered,
sandboxed agent.

## Design pillars (non-negotiables)

1. **LAN-direct first, internet-capable always.** When phone and laptop share a
   network, the **entire session — including signaling — stays local and works
   with no internet at all**. When they do not, the path is direct P2P via STUN,
   and TURN only as a last resort. The client races these paths; the user never
   picks one. See [NETWORKING.md](NETWORKING.md) and
   [ADR-0006](adr/0006-lan-first-connectivity.md).
2. **The cloud is a control plane, never a data plane.** Screen video, input,
   clipboard, and files never pass through our servers — direct on LAN and P2P,
   and end-to-end encrypted (DTLS-SRTP) when relayed through TURN. This is also
   the constraint that makes a free tier affordable:
   [ADR-0007](adr/0007-cloud-is-control-plane-only.md),
   [INFRASTRUCTURE-COST-MODEL.md](INFRASTRUCTURE-COST-MODEL.md).
3. **No custom video protocol.** Standard WebRTC H.264 + DataChannels.
4. **No silent remote access.** Trust is established by an explicit desktop
   approval; every session shows a visible indicator, writes audit logs, and
   has a tray panic-disconnect. Trusted auto-connect is per-device opt-out,
   revocable in the dashboard.
5. **Connection stability is priority #1.** No user activity (zoom, mode
   switch, network flap, radio handoff) may break a session; recovery
   machinery owns life/death decisions (see "Resilience machinery").
6. **Model-agnostic AI.** The agent engine never names a vendor; providers are
   config behind one adapter seam (enforced by a tripwire test).

## Connectivity: the path hierarchy

Ordered cheapest and fastest first. The client tries them in order and the user
never chooses.

| Path             | When                                | Cloud involvement                                     | Marginal cost                 |
| ---------------- | ----------------------------------- | ----------------------------------------------------- | ----------------------------- |
| **LAN direct**   | Same network                        | **None at all** — the laptop serves its own signaling | **Zero**                      |
| **Internet P2P** | Different networks, NAT traversable | Rendezvous + signaling only                           | Near zero                     |
| **TURN relay**   | Both behind hostile NAT/CGNAT       | Relays encrypted packets it cannot read               | Bandwidth — the dominant cost |

The full algorithm, discovery mechanism, failure modes, and privacy boundary are
in [NETWORKING.md](NETWORKING.md).

> **Status note.** LAN-direct _media_ already works today (host ICE candidates
> win on-LAN). LAN-direct _signaling_ — the embedded server on the laptop that
> removes the internet dependency entirely — is milestone M9.5; the LAN control
> plane (embedded TLS server, mDNS, LAN-first client race) is implemented and
> release-blocked on real-device offline media validation. See
> [NETWORKING.md](NETWORKING.md).
> yet. Until then a session still requires a reachable backend, which in
> development is a process on the laptop itself.

## Components

| Component    | Tech                                              | Responsibility                                                                                                                                                                                              |
| ------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Desktop**  | Rust + Tauri v2 (webrtc-rs), React UI             | Bubble/tray/QR/approve + trusted-devices dashboard, ScreenCaptureKit capture, VideoToolbox H.264 encode, adaptive bitrate, CGEvent input injection, presence channel, Ask agent (tiered executor + sandbox) |
| **Mobile**   | React Native (bare), react-native-webrtc          | My Devices (no-QR connect), QR scanner, live viewer (touch/gesture/keyboard/clipboard), Ask panel + agent step feed, keychain-persisted identity + pairs                                                    |
| **Backend**  | Node + Fastify                                    | REST (pairing, connect, device pairs), WS signaling hub (rooms, presence, approve, session mint), trust service, TURN cred minting, audit log                                                               |
| **Postgres** | 16 (Drizzle)                                      | devices, trusted_devices (pair trust), sessions, audit_logs; users reserved for M5 accounts                                                                                                                 |
| **Redis**    | 7                                                 | 60s single-use pairing tokens, room-auth records, room/session persistence (restart resurrection)                                                                                                           |
| **TURN**     | coturn (LAN dev) / public relay (prod & cellular) | Media relay when P2P fails; per-session time-limited credentials                                                                                                                                            |
| **Admin**    | React + Vite scaffold                             | M6                                                                                                                                                                                                          |

## System diagram

```
                    ┌── one-time trust ──────────────────────────┐
                    │  QR (60s single-use token) → scan → redeem │
                    │  → ring → Approve ("Trust this device")    │
                    └────────────────────────────────────────────┘
  ┌───────────────┐                                   ┌───────────────┐
  │    DESKTOP    │◀── connect-request (ring) ────┐   │    MOBILE     │
  │  Tauri + Rust │                               │   │ RN + WebRTC   │
  │  ┌─────────┐  │                               │   │  My Devices ──┼── POST /connect/request
  │  │presence │──┼── standing WS, presence:<id> ─┤   │  (no QR ever  │
  │  └─────────┘  │                               │   │   again)      │
  └──────┬────────┘                               │   └──────┬────────┘
         │        WS signaling /ws/signal (rooms: register/offer/answer/ICE/approve)
         ▼                                        │          ▼
              ┌───────────────────────────────────┴──────────────┐
              │  BACKEND (Fastify)                               │
              │  REST: /pairing/* /connect/request /devices/pairs│
              │  WS hub: session rooms + presence rooms          │
              │  Redis: tokens · room-auth · room records        │
              │  Postgres: devices · trusted_devices · audit     │
              └──────────────────────────────────────────────────┘
                              │ (public URL: pinned tunnel in dev,
                              │  stable domain in prod)
                       ┌──────┴───────┐
                       ▼              ▼
                  ┌────────┐    ┌──────────┐
                  │  TURN  │    │   STUN   │  ← DTLS-SRTP media, P2P when
                  └────────┘    └──────────┘    possible, relayed when not
```

## The two connection flows

**First time (the only QR):** bubble → `POST /pairing/create` (single-use 60s
token + fresh room, room-auth bound to the desktop) → phone scans → `redeem`
(atomic GETDEL burn; room-auth gains the phone) → phone joins the room, sends
`pair-request` → desktop rings → **Approve + "Trust this device"** →
trust row (`trusted_devices`, auto-approve on by default) + session mint +
per-peer time-limited TURN creds → offer/answer/ICE → live session. The phone
persists the pair (keychain) and shows it in **My Devices**.

**Every time after (no QR):** My Devices → Connect → `POST /connect/request`
→ backend verifies the pair (fails closed: not_trusted / revoked / offline),
mints a room with room-auth for both devices, and delivers a
`connect-request` over the desktop's **presence channel** (a standing
registration in the reserved `presence:<deviceId>` room — same hub, same
heartbeat/reaping/guards as sessions). The desktop spawns its normal session
runner on that room; auto-approve skips the ring; everything downstream is
byte-for-byte the pairing flow. A trusted ring **supersedes** any stale
session state — it can never be silently ignored. Cloud and LAN hubs buffer a
`pair-request` that arrives before the desktop has seated (takeover teardown
gap). Reopening the phone while the Mac is still Active uses
`resume: true` + `register.rejoin` to rejoin **that** room instead of minting
another. Force-kill with no JS callback ends the session from the hub
heartbeat / `peer-status` + 15s counterpart-gone window, not from an on-kill
hook.

## Resilience machinery (the product's spine)

- **Traffic-liveness outvotes state machines**: inbound REMB/loss/input frames
  are ground truth; a `failed` ICE verdict or a phone-requested restart is
  declined while traffic is live (12s window).
- **Bounded ICE restarts** (2 per unhealthy period, 12s/30s recovery budgets)
  with deadlines lifted the moment peer traffic proves recovery.
- **Offer resend watchdog**: the initial offer re-sends at ~8s/~16s until the
  answer arrives (socket flaps during the handshake self-heal).
- **Hub session-start replay**: a phone rejoining an approved-but-not-yet-
  established room gets its missed `session-start` again (zombie-flap heal).
- **Seat grace + zombie eviction**: mid-session socket drops hold the seat for
  the same device; a reconnect evicts its own dead socket.
- **Room/room-auth lifetimes match the session** (6h + sliding refresh),
  deleted together at room end; rooms resurrect across backend restarts.
- **Media send failures are network events, not pipeline death**: frames drop
  until the path recovers, then a forced IDR resnaps the picture.
- **Capture auto-restart** (3 attempts, budget re-armed after 60s healthy)
  rides out macOS stopping the stream on display reconfiguration.
- **ABR with a REMB probe ladder** (climbs out of the estimate deadlock) plus
  a **sender-congestion signal**: sample-queue overflow — invisible to RTCP —
  backs the bitrate off and holds probing 20s, killing stutter cycles.
- **Presence reconnects forever** (capped backoff): availability, not a
  session — there is no budget after which giving up is correct.

## Ask — the on-device AI operator (M5.3)

Phone types a task → `agent_command` over the input DataChannel → desktop
`AgentController` spawns a run (control scope required). The loop
(observe → decide → act) is pure and unit-tested; every action passes a
security **gate**: Safe/Sensitive run, Consequential holds for phone approval,
Forbidden never runs. Human input = instant takeover. Tiered executor, cheap
first: **P1** allowlisted skills (open app/url/file, new folder) with
postcondition verification → **P2** codegen in a deny-default macOS Seatbelt
sandbox (scratch-jailed writes, no network, secrets unreadable, always
approval-held) → **P3** accessibility tree read/press → **P4** vision
(screenshot to a vision-capable model). Providers: Anthropic + any
OpenAI-compatible endpoint (Gemini/OpenAI/Ollama/…) behind `ProviderChoice`;
keys live in the macOS keychain; capability flags (vision, …) shape the
toolset; transient provider errors retry with backoff; a tripwire test fails
the build if a vendor name leaks into engine code.

## Trust & identity (M5.4 → M5)

Today: deviceIds are stable self-asserted strings (desktop: config-dir file;
phone: keychain). Trust rows bind desktop↔mobile pairs with per-pair
auto-approve and revocation (dashboard on desktop, Forget on phone; revoked
pairs fail closed; re-running the QR ceremony un-revokes). The register gate
authorizes every seat claim against pairing-flow records; presence rooms by
suffix match. **Next** (`m5-auth-design.md`): Ed25519 device keys +
challenge-response make the same strings cryptographically provable through
the same seams — no call-site redesign.

## Subsystem map

```
apps/desktop/src-tauri/src/
  session/     runner FSM, recovery, media controller, reconnect policy
  media/       capture (ScreenCaptureKit) · encode (VideoToolbox) · pipeline · ABR
  rtc/         webrtc-rs peer, tracks, DataChannels, RTCP feedback
  input/       validated injection (CGEvent), scope gating, dispatcher
  signaling/   WS client + serde message mirror (defense-in-depth bounds)
  presence.rs  standing presence connection + ring/supersede
  agent/       Ask: runner, security gate, tiered executor, sandbox, llm/, ax/
apps/desktop/src/
  components/  Bubble · QrOverlay · Control (dashboard) · Setup · Diagnostics
  lib/         tauri bridge, useAppState, useLiveResource, useUpdater (auto-update FSM)
apps/mobile/src/
  lib/         webrtc client, signaling, touch/gesture, identity, pairs, agent feed
  screens/     DeviceList (My Devices) · Scanner · Viewer (+AgentPanel)
apps/backend/src/
  signaling/   hub, room, registry, router, lifecycle, register gate
  services/    pairing, roomAuth, trust, TURN creds, audit, advertised URLs
  routes/      pairing, signaling(+/connect/request,/metrics), devices, health
packages/protocol/  zod wire contracts shared by all tiers (+Rust mirrors by hand)
packages/shared/    env, logger, redis keys, cross-tier timing constants
packages/design/    colour tokens (both schemes), radii, font stack — CSS + TS
apps/site/          static marketing site, no framework (P4)
```

## Documentation index

**Living reference:** this file · `technical-design.md` · `api.md` ·
`signaling-protocol.md` · `input-protocol.md` · `db-schema.md` ·
`threat-model.md` · `operations.md` · `RUNBOOK.md` (build/release/auto-update) ·
`user-guide.md` · `milestones.md`.

**Design/audit records (rationale, cited from code):**
`m5.4-trusted-devices-audit.md` (pairing audit + trusted-device design) ·
`ask-architecture-audit.md` + `m5.3-ai-executor-plan.md` (Ask agent) ·
`m5-ai-remote-controller.md` (M5 survey) · `m5-auth-design.md` (device
identity forward spec) · `audit/m3/*` (the M3 production audit — findings are
referenced as rationale throughout the codebase; do not delete).
