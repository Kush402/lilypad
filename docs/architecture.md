# Lilypad — Architecture Overview

Lilypad is an **internet-first, phone-first remote laptop control** system. A
lightweight desktop app shows a floating "Lilypad" bubble; clicking it displays a
short-lived QR code. The user scans it from the mobile app, **approves on the
laptop**, and the laptop screen streams live to the phone with touch, keyboard,
and developer shortcuts.

## Design pillars (non-negotiables)

1. **Works over the public internet.** Phone on cellular, laptop behind NAT/
   firewall. Transport is **WebRTC + STUN + TURN (coturn)**. Same-Wi-Fi is only a
   dev convenience — never the design target. No LAN-only assumptions.
2. **No custom video protocol.** Standard WebRTC media (H.264) + DataChannel.
3. **No silent remote access.** Every session requires an explicit **Approve** on
   the desktop, a visible session indicator, and a panic disconnect.
4. **Phone-first UX + developer controls.** Low latency, readable text, dev
   keyboard toolbar, trackpad/touch modes.

## Components

| Component    | Tech                      | Responsibility                                                                                               |
| ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Desktop**  | Rust + Tauri v2, React UI | Floating bubble, tray, QR overlay, approve/deny, capture/encode/input backends, capture/encode/input (M3/M4), WebRTC peer (M2) |
| **Mobile**   | React Native (bare)       | Login, device list, QR scanner, low-latency viewer, input toolbar                                            |
| **Backend**  | Node + Fastify            | REST (health, pairing, later auth/devices/sessions), WebSocket signaling, Redis pairing, Postgres data       |
| **Admin**    | React + Vite              | Users, devices, sessions, TURN usage, billing (M6)                                                           |
| **coturn**   | STUN + TURN               | NAT traversal for the WebRTC media path                                                                      |
| **Postgres** | 16                        | Users, devices, trusted devices, sessions, audit logs                                                        |
| **Redis**    | 7                         | Single-use 60s pairing tokens, signaling room state                                                          |

## System diagram

```
  ┌─────────────┐   QR (60s single-use token)   ┌─────────────┐
  │  DESKTOP    │ ────────────────────────────▶ │   MOBILE    │
  │ Tauri+Rust  │                                │ RN + WebRTC │
  └──────┬──────┘                                └──────┬──────┘
         │      WS signaling (register/offer/answer/ICE/approve)
         │                                              │
         ▼                                              ▼
              ┌──────────────────────────────────┐
              │   BACKEND (Fastify)              │
              │   REST: /health /pairing/*       │
              │   WS  : /ws/signal (rooms)       │
              │   Redis: tokens + rooms          │
              │   Postgres: users/devices/...    │
              └──────────────────────────────────┘
                         │
                  ┌──────┴───────┐
                  ▼              ▼
             ┌────────┐    ┌──────────┐
             │ coturn │    │  STUN    │   ← encrypted WebRTC media (DTLS-SRTP)
             │ (TURN) │    │          │      P2P when possible, relayed when not
             └────────┘    └──────────┘
```

## End-to-end flow

1. **Pairing.** Desktop → `POST /pairing/create` → backend mints a single-use
   token (Redis, 60s TTL) bound to the desktop device + a fresh signaling room.
   Desktop renders the QR.
2. **Redeem.** Mobile scans → `POST /pairing/redeem` → backend atomically burns
   the token (GETDEL) and returns room join info.
3. **Approve.** Backend pushes a `pair-request` to the desktop over signaling;
   desktop shows **Approve/Deny** (M2).
4. **Connect.** Both peers join the signaling room, exchange SDP offer/answer +
   ICE candidates; ICE uses STUN then TURN. WebRTC connects.
5. **Session.** Desktop sends a video track; mobile opens the input DataChannel.
   Pointer/keyboard/shortcut events flow phone → desktop.

## Repository layout

See the root [README](../README.md). Monorepo via pnpm workspaces + Turborepo:
`apps/{desktop,mobile,backend,admin}`, `packages/{protocol,shared}`, `infra/`,
`docs/`.

## Where things are implemented across milestones

- **M1 (done):** repo, infra, backend `/health` + pairing service, desktop shell +
  capture/encode/input backends, mobile scanner. See [milestones.md](./milestones.md).
- **M2:** WS signaling room routing + WebRTC with a fake video track.
- **M3:** real capture + hardware H.264 encode.
- **M4:** input injection.
- **M5:** auth, trusted devices, audit logs, scopes.
- **M6:** TURN hardening, deploy, billing, admin, observability.
