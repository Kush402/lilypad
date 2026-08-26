---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-12
summary: Design decisions behind the architecture.
---

# Lilypad — Technical Design

Detailed design decisions behind the [architecture](./architecture.md).

## Transport (internet-first)

- **Signaling:** JSON over WebSocket at `/ws/signal`, room-routed by `roomId`.
  The backend relays SDP + ICE and brokers approve/deny; it never sees media.
- **Media:** WebRTC. Desktop is the **offerer**, sends one **H.264 video track**
  (phone-first: 720p@30 default, 1080p "text mode"). Encryption is DTLS-SRTP,
  mandatory in WebRTC — no extra work to secure the media path.
- **Input:** a reliable, ordered **DataChannel** (`lilypad-input`), phone →
  desktop. See [input-protocol.md](./input-protocol.md).
- **NAT traversal:** ICE with **STUN** (host/srflx candidates) then **TURN**
  (relay) as fallback when both peers are behind symmetric NATs. coturn provides
  both. The backend advertises ICE servers in the `pair-approved` message.

### Why not a custom protocol / LAN discovery

The target user is on cellular with the laptop behind a corporate/home NAT. Only
ICE+TURN reliably connects that pair. mDNS/LAN discovery is explicitly out; it
would optimize the one case (same Wi-Fi) that is merely a dev convenience.

## Encoding (M3)

- Hardware H.264 via **VideoToolbox** (macOS) / **Media Foundation** (Windows).
- Low-latency knobs: **no B-frames**, **short GOP**, **adaptive bitrate** driven
  by WebRTC bandwidth estimation, real-time rate control.
- Modes: `720p@30` default; `1080p` "text mode" for readability; AV1 evaluated
  later only if latency/CPU allow.

## Capture (M3)

- **macOS:** ScreenCaptureKit (12.3+, real). **Windows:** Windows Graphics
  Capture (Win10 1803+, not yet wired). Both are wrapped behind the
  `CaptureBackend` trait (`apps/desktop/src-tauri/src/media/capture/`).

## Input injection (M4)

- **macOS:** CGEvent (requires Accessibility permission). **Windows:** SendInput.
- Normalized 0..1 coordinates from the phone are mapped to the captured display's
  pixel space, so DPR/resolution differences don't matter.

## Desktop app structure

- **Tauri v2**, Rust core + React UI. Windows are **label-based**: one bundle,
  rendered as bubble / qr-overlay / control by window label.
- Capture/encode/input each have their own dedicated trait + per-OS backend
  (`crate::media::capture`, `crate::media::encoder`, `crate::input`) — no
  generic plugin-lifecycle wrapper on top; the debug health overlay
  (`crate::health`) queries the two OS permissions that actually gate
  functionality directly. See [plugin-interface.md](./plugin-interface.md)
  for the full history of why the earlier `PluginHost` design was removed.
- **Bubble:** frameless, transparent, always-on-top, skip-taskbar window.
- **Menu bar:** Open Dashboard, Pair a phone…, Approve, Deny, Disconnect, Panic, Settings…, Diagnostics…, Quit.

## Backend structure

- **Fastify v5**, `@fastify/websocket`, `@fastify/rate-limit`, `@fastify/cors`.
- **Drizzle ORM** + `postgres.js` for Postgres; **ioredis** for Redis.
- Requests validated with **zod** schemas from `@lilypad/protocol` (shared with
  mobile), so client and server never drift.
- Pairing tokens are opaque, high-entropy (`randomBytes(24).base64url`), stored
  only in Redis with a 60s TTL, redeemed atomically via **GETDEL** (single-use).
- Every identity today (`deviceId` in pairing/signaling) is a bare,
  unauthenticated string — no accounts, no cryptographic device trust. The
  full JWT + refresh + Ed25519 device-trust + revocation design for M5 is
  spec'd in [docs/m5-auth-design.md](m5-auth-design.md).

## Shared packages

- **`@lilypad/protocol`** — the single source of truth for every wire format
  (QR payload, signaling messages, input events, pairing REST bodies) as zod
  schemas + inferred TS types. Imported by backend, mobile, and (conceptually)
  desktop.
- **`@lilypad/shared`** — server env parsing (zod), pino logger, Redis key
  helpers, health report type.

## Observability (M6)

Debug overlay + metrics: capture time, encode time, RTT, input round-trip, ICE
candidate type (host/srflx/relay). The desktop control window already shows a
plugin-health panel as the seed of this.

## Latency budget (target)

`capture → encode → send → network → decode → paint`. Goals: < 60ms glass-to-
glass on same-region cellular when P2P; < 120ms when TURN-relayed. Pointer moves
are coalesced (~120Hz cap); key/click/shortcut events bypass coalescing.
