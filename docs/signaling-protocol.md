# Lilypad — Signaling Protocol

JSON over WebSocket at `/ws/signal`. Room-routed by `roomId`; the backend relays
between the two peers in a room and brokers approve/deny. It never touches media.
Schemas: [`packages/protocol/src/signaling.ts`](../packages/protocol/src/signaling.ts).

## Envelope

Every message shares:

```ts
{
  (type, roomId, from, ts, payload);
}
// from: "desktop" | "mobile"    ts: ms since epoch
```

## Message types

| type               | direction                 | payload                                                |
| ------------------ | ------------------------- | ------------------------------------------------------ |
| `register`         | peer → server             | `{ role, deviceId }` — join the room as desktop/mobile |
| `pair-request`     | mobile → server → desktop | `{ deviceId, deviceName, requestedScopes }`            |
| `pair-approved`    | desktop → server          | `{ grantedScopes }` — server mints session id + ICE    |
| `pair-denied`      | desktop → server → mobile | `{ reason }`                                           |
| `session-start`    | server → both             | `{ sessionId, grantedScopes, iceServers }`             |
| `offer`            | desktop → mobile          | `{ type:"offer", sdp }`                                |
| `answer`           | mobile → desktop          | `{ type:"answer", sdp }`                               |
| `ice-candidate`    | both                      | `{ candidate, sdpMid, sdpMLineIndex }`                 |
| `renegotiate`      | either → desktop          | `{ reason?, iceRestart? }` — desktop re-offers         |
| `pause` / `resume` | either                    | `{ reason? }` / `{}` — stop/restart stream, keep ICE   |
| `disconnect`       | either                    | `{ reason? }` — graceful teardown                      |
| `heartbeat`        | peer → server             | `{ seq? }` — liveness; stale peers are reaped          |
| `session-end`      | server → both             | `{ reason }`                                           |
| `frame-size`       | desktop → mobile          | `{ width, height, mode }` — capture size for touch mapping |
| `set-capture-mode` | mobile → desktop          | `{ mode: "motion" \| "text" }` — switch capture/encode mode |
| `clipboard-update` | desktop → mobile          | `{ text }` — desktop clipboard changed                 |
| `error`            | server → peer             | `{ code, message }`                                    |
| `ping` / `pong`    | keepalive                 | `{}`                                                   |

## Connection lifecycle

```
mobile redeems token (REST) ─┐
desktop  ── register ──▶ server
mobile   ── register ──▶ server
server   ── pair-request ──▶ desktop
desktop  ── pair-approved(iceServers) ──▶ server ──▶ mobile
desktop  ── offer ──▶ mobile
mobile   ── answer ──▶ desktop
both     ── ice-candidate ⇄  (trickle ICE)
server   ── session-start ──▶ both
   … WebRTC media + input DataChannel flow directly, peer-to-peer …
either   ── session-end ──▶ other   (disconnect / panic)
```

## ICE servers

`pair-approved.iceServers` carries STUN first, then TURN (with time-limited
credentials in production). Clients build `RTCPeerConnection({ iceServers })`.
Trickle ICE: candidates are sent as they are gathered via `ice-candidate`.

## Rooms & security

- A room has exactly two seats (desktop + mobile). Extra `register`s are rejected.
- Messages are only relayed to the **other** seat in the same room.
- The desktop's explicit `pair-approved` is the gate — no media flows before it.

## Status

**Implemented (M2):** full room routing (2 seats), offer/answer/ICE relay,
approve/deny broker, session state machine, `heartbeat` reaping, and
`pause`/`resume`/`renegotiate`/`disconnect` — all Zod-validated with sender
identity enforced (anti-spoof, seat-taken, role checks). Session ICE servers use
**time-limited TURN credentials** ([turn/credentials.ts](../apps/backend/src/turn/credentials.ts)).

The routing lives in a transport-agnostic
[`SignalingHub`](../apps/backend/src/signaling/hub.ts) (unit-tested with fake
peers + smoke-tested over live WebSockets); the Fastify route is a thin adapter.

**Also implemented (M3–M4):** the desktop (webrtc-rs) and mobile
(react-native-webrtc) peers consuming this signaling, the full media path
(capture → encode → RTP), `frame-size`/`set-capture-mode` mode switching, and
`clipboard-update` sync — verified end-to-end on real hardware.
