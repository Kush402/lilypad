---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: M3 production audit — reconnect lifecycle findings.
---

# Lilypad Reconnect & Session-Lifecycle Audit (M3 → M5)

**Scope:** every disruption scenario a live remote-desktop session can hit — phone
network handoff, lock/background, desktop sleep, router restart, signaling-server
restart, transient WS drops, ICE failure, TURN credential expiry — traced against
the actual code in the desktop (Rust/Tauri/webrtc-rs), mobile (React
Native/react-native-webrtc), and backend (Fastify/Redis) tiers.

**Files read in full:** `apps/desktop/src-tauri/src/session.rs`,
`apps/desktop/src-tauri/src/signaling/mod.rs`,
`apps/desktop/src-tauri/src/signaling/messages.rs`,
`apps/desktop/src-tauri/src/rtc/mod.rs`, `apps/desktop/src-tauri/src/state.rs`,
`apps/desktop/src-tauri/src/commands.rs`, `apps/desktop/src-tauri/src/lib.rs`,
`apps/desktop/src-tauri/src/main.rs`, `apps/mobile/src/lib/signaling.ts`,
`apps/mobile/src/lib/webrtc.ts`, `apps/mobile/src/screens/ViewerScreen.tsx`,
`apps/backend/src/signaling/hub.ts`, `apps/backend/src/routes/signaling.ts`,
`apps/backend/src/session/manager.ts`, `apps/backend/src/session/stateMachine.ts`,
`apps/backend/src/turn/credentials.ts`, `apps/backend/src/redis.ts`,
`apps/backend/src/config.ts`, `apps/backend/src/server.ts`,
`apps/backend/src/routes/pairing.ts`, `packages/protocol/src/signaling.ts`.

---

## Executive Summary

The desktop side has real, thoughtfully-engineered reconnect machinery: a
non-blocking signaling-reconnect loop with backoff (`session.rs:105-123`), an
ICE-restart budget (`session.rs:72,313-333`), and a recovery deadline
(`session.rs:79,386-393`). The backend hub has a genuinely good mid-session
grace mechanism for a _single_ dropped seat (`hub.ts:163-192`). Everywhere else,
resilience is either half-built or entirely absent, and the two halves that do
exist don't agree with each other on timing.

Three findings are launch-blocking for a product competing with Parsec/AnyDesk:

1. **The mobile client has no reconnect logic of any kind.** `signaling.ts` never
   attaches a `ws.onclose` handler; the moment the phone's WebSocket dies —
   which happens on nearly every scenario in the brief (lock, background,
   cellular handoff, backend restart) — the app goes silently, permanently
   inert. No error, no state change, no retry.
2. **The backend's own single-seat grace design is defeated by the exact
   scenario named in the brief — a router restart** — because it drops both
   seats' sockets close together, and the _second_ `handleClose` sees the first
   peer's slot already empty and ends the room immediately, skipping the grace
   window entirely (`hub.ts:167-192`).
3. **Room state lives only in a process-local `Map`** (`hub.ts:85-86`). A
   backend restart (deploy, crash, autoscale cycle) erases every session's
   routing state with no resurrection path; Redis is written to only as an
   audit trail, never read back to rebuild a room.

Layered on top: mobile never reacts to its own ICE failure, the app never
sends the `pause`/`resume` messages the protocol already defines for exactly
this purpose, there is no session-resumption token so a torn-down room forces
a full re-pair, TURN credentials have no mid-session refresh path, and the
three tiers' heartbeat/timeout constants were tuned independently and now
race each other. None of this requires new product surface — it requires
finishing the reconnect story that was half-built for M2's demo and treating
it as first-class production infrastructure for M5.

Findings below are ordered by severity; each includes file:line citations for
current behavior, root cause, a concrete redesign, and a plan an engineer can
implement without re-deriving this analysis.

---

## Finding 1: Mobile signaling client has no reconnect path — a dropped WebSocket is a silent, permanent, undetected outage

### Current implementation

`apps/mobile/src/lib/signaling.ts:23-37` (`MobileSignaling.connect`):

```ts
connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('signaling connection failed'));
    ws.onmessage = (e: WebSocketMessageEvent) => { ... };
  });
}
```

There is no `ws.onclose` handler anywhere in the file — not during the initial
connect, and not after. `onerror` only rejects the promise returned by the
_first_ `connect()` call; once that promise has resolved, nothing in
`MobileSignaling` or its caller (`ViewerConnection`, `apps/mobile/src/lib/webrtc.ts:38-91`)
is listening for the socket to close. `ViewerConnection.start()`
(`webrtc.ts:47-53`) calls `connect()` once, registers, sends `pair-request`,
and starts a 10s heartbeat (`webrtc.ts:51`) — that heartbeat calls
`this.sig.heartbeat()` (`signaling.ts:93-101`), which does
`this.ws?.send(...)` (`signaling.ts:39-41`). On a dead socket, `WebSocket.send`
on a closed/closing socket is a silent no-op or throws depending on RN's
polyfill state — either way nothing surfaces to `ViewerCallbacks`.

### Problems

- Every scenario in the brief that kills a TCP/WS connection — phone
  backgrounded, phone locked, WiFi→cellular handoff, cellular tower handoff,
  router restart, backend restart, generic transient drop — silently strands
  the mobile app with no way back in, and the app never tells the user.
- Because the video/input path is peer-to-peer once WebRTC is up, the RTCView
  keeps showing the _last decoded frame_ forever; `ViewerState` never leaves
  `'connected'` (the `connectionstatechange` handler in `webrtc.ts:114-119`
  only fires on the _peer connection_, not on signaling), so the UI badge
  claims "Connected" while the app is completely deaf to the backend and can
  never re-signal (answer a fresh offer, exchange trickled ICE, receive
  `session-end`, or renegotiate). This is a materially worse failure mode than
  a visible disconnect: the user has no signal that anything is wrong.
  Compare to the desktop, which explicitly distinguishes this state via
  `SessionEvent::SignalingReconnecting`/`SignalingReconnected`
  (`session.rs:48-52, 213, 248`).
- Even the backend's generous 15s reregister grace (`hub.ts:71-73`, default
  `DEFAULT_REREGISTER_GRACE_MS = 15_000`) is wasted on the mobile side: the
  grace window exists precisely so a briefly-dropped peer can climb back in,
  but the mobile app never attempts to.

### Root cause

The mobile signaling client was written to mirror the desktop's _happy-path_
API (`register`/`pairRequest`/`answer`/`iceCandidate`/`heartbeat`) but the
desktop's reconnect logic lives entirely in `session.rs`'s hand-rolled state
machine (`recv_next`, the `reconnect_signaling` helper, the `select!` loop) —
none of that was ported to the TypeScript side. `MobileSignaling` is a thin,
stateless wrapper with no lifecycle beyond "open once."

### Redesign

Give `MobileSignaling` an internal reconnect state machine mirroring the
desktop's, and make `ViewerConnection` own a matching `ViewerState` value
(`'connecting' | 'negotiating' | 'connected' | 'reconnecting_signaling' |
'recovering_ice' | 'failed' | 'ended'`) instead of just forwarding the raw
`RTCPeerConnection.connectionState`.

1. **`MobileSignaling`**: add `private reconnectAttempt = 0`, wire
   `ws.onclose = (e) => this.handleClose(e)`. `handleClose`:
   - If the socket close was caused by our own `close()` (a `closing` flag set
     before calling `ws.close()`), do nothing — intentional teardown.
   - Otherwise, if `this.roomEstablished` (set true once we've sent/received
     an `answer`), emit a `'signaling-reconnecting'` synthetic event to the
     `onMessage` handler (or a new dedicated `onConnectionEvent` callback) and
     schedule a reconnect with the **same backoff table as the desktop**
     (500ms, 1s, 2s, 4s, 8s capped, see Finding 6 for why these must match)
     up to the same `MAX_SIGNALING_RECONNECTS = 5`.
   - On reconnect success: re-open the WS, re-send `register(deviceId)` (the
     hub's `vacated` check in `hub.ts:281-292` will let the same `deviceId`
     reclaim the seat within the grace window), then emit
     `'signaling-reconnected'`.
   - On exhausting attempts: emit `'signaling-lost'` and let the caller decide
     to end the session or offer a manual "Reconnect" button.
   - If the socket closes _before_ `roomEstablished` (pairing not yet
     complete), fail immediately — signaling IS the session pre-establishment,
     matching the desktop's own rule at `session.rs:221-225`.
2. **`ViewerConnection`**: subscribe to the new signaling lifecycle events and
   map them into `ViewerState`. Crucially, this state must be tracked
   _independently_ from `RTCPeerConnection.connectionState` — a session can be
   `connected` on the peer connection while `reconnecting_signaling` is true,
   which is the correct "media still flows, don't panic" state the desktop
   already models.
3. **`ViewerScreen`**: add a `'reconnecting_signaling'` entry to
   `STATE_LABEL` (`ViewerScreen.tsx:34-40`) so the badge reads "Reconnecting…"
   instead of silently freezing on "Connected."
4. Add an explicit React Native `NetInfo` listener (see Finding 4) that, on
   regaining connectivity, immediately triggers a signaling reconnect attempt
   rather than waiting for the next backoff tick — this shaves seconds off
   real-world Wi-Fi→cellular handoffs, which is exactly the scenario named in
   the brief.

### Tradeoffs

Mirroring the desktop's backoff table in TypeScript duplicates a constant that
should really live in `@lilypad/protocol` as a shared export (see Finding 6) —
duplicating it now and unifying later is acceptable, but do not let the two
implementations drift; add a protocol-level constant immediately if the
schedule allows, otherwise flag it as immediate follow-up debt.

### Implementation plan

1. Add `RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000]` and
   `MAX_SIGNALING_RECONNECTS = 5` to `@lilypad/protocol` (new export,
   consumed by both the mobile client and, ideally, refactored into the Rust
   side too so there is one source of truth per language boundary).
2. Rewrite `MobileSignaling` (`signaling.ts`) with the state machine above;
   change its constructor to accept an additional `onLifecycle` callback
   (or fold into the existing `Handler` union with synthetic message types
   `{ type: '_signaling_reconnecting' | ... }` kept out of the wire protocol).
3. Update `ViewerConnection` (`webrtc.ts`) to consume the new lifecycle
   events and expand `ViewerState`.
4. Update `ViewerScreen.tsx`'s `STATE_LABEL` map and any other UI reading
   `ViewerState`.
5. Add a unit test suite (RN has no WebSocket in Jest by default — use a
   fake `WebSocket` global, the same pattern the backend's `hub.test.ts`
   already uses for fake `Peer`s) exercising: drop after connect → reconnect
   succeeds; drop before pairing → immediate `ended`; drop, exhaust 5
   attempts → `signaling-lost`.

### Migration strategy

Purely additive on the wire (no protocol schema change); ship behind no flag
— this is a strict bug fix. Roll out mobile-app-only; the backend already
supports reclaiming a vacated seat within `reregisterGraceMs`, so no backend
change is required for this finding alone (though Finding 2's fix should ship
alongside it, since this finding's grace window is worthless without that
fix).

### Testing strategy

- Unit: fake-WebSocket-driven reconnect state machine tests (see above).
- Integration: spin up the real backend + hub, connect a headless mobile
  client (or a small Node WS harness impersonating one), yank the socket
  mid-session, assert the room survives past `reregisterGraceMs` once the
  fix lands and the client reconnects before the deadline.
- Manual device testing checklist (add to the existing manual QA doc): put
  the phone in airplane mode for 5s mid-session, toggle WiFi→cellular
  physically, lock the phone for 30s, background the app for 2 minutes.

### Risk assessment

Low risk to ship — it only adds behavior where none existed. The main risk is
a reconnect storm if a truly dead room is retried needlessly; bounded by
`MAX_SIGNALING_RECONNECTS` and the pre-existing hub-side reap.

### Performance impact

Negligible — one extra WS reconnect + a JSON `register` frame per drop.
Battery: a live heartbeat timer already runs every 10s regardless.

### Future extensibility

This is the foundation Finding 4 (AppState) and Finding 5 (mobile ICE
recovery) build on — both need a live "am I currently trying to get back
online" state that this finding introduces.

---

## Finding 2: Simultaneous/near-simultaneous seat vacate bypasses the reconnection grace window — the exact "router restart" scenario in the brief is _not_ survivable today

### Current implementation

`apps/backend/src/signaling/hub.ts:163-192` (`handleClose`):

```ts
handleClose(peer: Peer): void {
  const c = this.ctx.get(peer);
  if (!c) return;
  this.ctx.delete(peer);
  const room = this.rooms.get(c.roomId);
  if (!room) return;
  room[c.role] = undefined;
  if (room.established) {
    room.vacatedAt[c.role] = this.now();
    const other = c.role === 'desktop' ? 'mobile' : 'desktop';
    if (room[other] === undefined) {
      this.endRoom(room, `${c.role} disconnected`);
      return;
    }
    log.signaling.info(..., 'mid-session transport drop — holding seat, session continues peer-to-peer');
    return;
  }
  this.endRoom(room, `${c.role} disconnected`);
}
```

### Problems

Walk through a router restart, which drops both the desktop's and the
mobile's WebSocket to the backend within milliseconds of each other (both are
on the same LAN, both lose upstream at once — this is _the_ textbook shape of
this scenario, not an edge case):

1. Desktop's socket dies first. `handleClose(desktopPeer)` runs: sets
   `room.desktop = undefined`, `room.vacatedAt.desktop = now()`. It checks
   `room.mobile` — still present (its close event hasn't landed yet) — so it
   holds the seat and logs "holding seat, session continues." Correct so far.
2. Milliseconds later, mobile's socket dies too. `handleClose(mobilePeer)`
   runs: sets `room.mobile = undefined`, `room.vacatedAt.mobile = now()`. It
   checks `room[other]` where `other = 'desktop'` — and `room.desktop` is
   **already `undefined`** from step 1. The condition
   `room[other] === undefined` is true, so it calls
   `this.endRoom(room, 'mobile disconnected')` **immediately**, tearing down
   the room, sending `session-end` to a socket that's already dead, and
   deleting the room from `this.rooms` — all within the same event-loop tick
   the outage began, with zero grace period.

The 15-second `reregisterGraceMs` this hub was clearly designed to provide
(`hub.ts:70-73`, and the extensive comments at `hub.ts:163-166, 194-201`
explicitly describing exactly this "hold the seat" intent) never gets a
chance to apply, because the check `room[other] === undefined` cannot tell
the difference between "the other seat was _never_ occupied" and "the other
seat _just_ vacated and might reconnect any second." Any disruption that
takes down both peers' transports around the same time — router restart,
shared WiFi AP reboot, brief ISP blip affecting both (rarer but possible if
routed through the same edge), or even a coincidental brief backend blip that
both sockets ride — degrades from "recoverable, 15s grace" to "instant kill,"
silently, with no code path exercising the grace logic at all.

### Root cause

`handleClose`'s "is the room now abandoned" check tests _current_ seat
occupancy (`room[other] === undefined`) instead of testing whether the other
seat is _irrecoverably_ gone (i.e., its own grace window has already
expired). The grace mechanism only works if at least one `handleClose` call
sees the other peer still connected — an assumption that silently fails
whenever both peers drop together, which is common, not rare.

### Redesign

Change the "should we end the room right now" test from "is the other seat
occupied" to "has the other seat's grace window already expired" — i.e.
never end the room synchronously from `handleClose` purely because the
_other_ seat also happens to be empty at this instant; only end it
synchronously if the other seat was vacated _and its grace period has already
elapsed_, otherwise let the periodic `reapStale` sweep (which already
correctly checks `vacated < graceCutoff` at `hub.ts:202-214`) be the single
source of truth for grace-expiry teardown.

Concretely:

```ts
handleClose(peer: Peer): void {
  const c = this.ctx.get(peer);
  if (!c) return;
  this.ctx.delete(peer);
  const room = this.rooms.get(c.roomId);
  if (!room) return;
  room[c.role] = undefined;
  if (room.established) {
    room.vacatedAt[c.role] = this.now();
    const other = c.role === 'desktop' ? 'mobile' : 'desktop';
    const otherVacatedAt = room.vacatedAt[other];
    const otherNeverConnected = room.deviceIds[other] === undefined;
    // Only end synchronously when the other seat was either never part of
    // this room, or its own grace window has already fully elapsed — a seat
    // that JUST vacated (even microseconds ago) still deserves its grace
    // window; reapStale() will reconcile it on the next sweep.
    if (room[other] === undefined && otherNeverConnected) {
      this.endRoom(room, `${c.role} disconnected`);
      return;
    }
    if (
      room[other] === undefined &&
      otherVacatedAt !== undefined &&
      this.now() - otherVacatedAt >= this.reregisterGraceMs
    ) {
      this.endRoom(room, `${c.role} disconnected`);
      return;
    }
    log.signaling.info(..., 'mid-session transport drop — holding seat, session continues peer-to-peer');
    return;
  }
  this.endRoom(room, `${c.role} disconnected`);
}
```

This makes the _only_ way to end a room with both seats vacated-but-within-grace
be the periodic `reapStale()` sweep, which already runs every 10s
(`routes/signaling.ts:50`) and already implements the correct grace-cutoff
check (`hub.ts:202-214`) — that logic already handles the "both eventually
expire" case correctly today; it was simply being pre-empted by the eager
check in `handleClose`.

Reduce the reap interval from 10s to something tighter (e.g. 3-5s) once this
fix lands, so a truly-abandoned dual-vacate room doesn't linger up to
`reregisterGraceMs + 10s` before cleanup — see Finding 6 for the full
cross-tier timeout retuning.

### Tradeoffs

A dual-vacated room now stays allocated in the `rooms` Map for up to
`reregisterGraceMs` even when both peers are actually gone for good (e.g. the
user genuinely walked away and force-quit both apps) — a small, bounded
memory/bookkeeping cost (one `Room` object, already capped globally by
`maxRooms`, `hub.ts:74-76`) in exchange for correctly surviving the router-
restart case. This is the correct tradeoff for a product whose core value
proposition is "the session survives disruption."

### Implementation plan

1. Patch `handleClose` as above in `apps/backend/src/signaling/hub.ts`.
2. Add regression tests to `hub.test.ts` (or wherever `handleClose` is
   exercised) simulating: (a) desktop closes, then mobile closes 5ms later —
   assert the room is _not_ ended synchronously and still exists; (b) same
   scenario, then advance the fake clock past `reregisterGraceMs` with no
   re-register — assert `reapStale()` now ends it; (c) same scenario, but one
   peer re-registers with the same `deviceId` within the grace window —
   assert the room survives and the seat is reclaimed.
3. Tighten `reapStale`'s interval per Finding 6.

### Migration strategy

Backend-only change, no protocol/wire change, no client changes required.
Safe to deploy independently and immediately — it only _relaxes_ an
overly-eager teardown path; it cannot make any currently-surviving scenario
worse.

### Testing strategy

Unit tests as above (fake clock + fake `Peer`, matching the existing patterns
in `hub.test.ts`). Load/chaos test: run a real desktop+mobile pair against a
real backend behind a router the tester can literally power-cycle; assert
the session resumes without a full re-pair.

### Risk assessment

Low. This is a narrow, well-understood fix to a single function with an
existing test harness. The only regression risk is a genuinely-abandoned
room lingering slightly longer before cleanup — bounded and monitored via the
existing `activeRooms` metric (`hub.ts:106-116`).

### Performance impact

None measurable — same data structures, marginally more Map lookups in a
rarely-hit branch (a disconnect path, not the hot signaling-relay path).

### Future extensibility

This fix is a prerequisite for Finding 3's Redis-backed room resurrection:
resurrection needs to already agree that "two vacated seats" isn't
automatically "room over," or restoring a room from Redis after a backend
restart (which necessarily starts with _both_ seats vacated) would
immediately self-destruct under the current logic.

---

## Finding 3: Signaling-hub room state is process-local memory only — a backend restart silently kills every live session with no resurrection path

### Current implementation

`apps/backend/src/signaling/hub.ts:84-90`:

```ts
export class SignalingHub {
  private readonly rooms = new Map<string, Room>();
  private readonly ctx = new Map<Peer, PeerCtx>();
  ...
```

`Room` (`hub.ts:52-68`) holds the live `Peer` handles (actual WebSocket
wrappers), the `SessionStateMachine` instance, `vacatedAt`/`lastSeen`
timestamps, and the `established` flag — none of it serializable or
persisted. `apps/backend/src/routes/signaling.ts:23-47` constructs exactly
one `new SignalingHub(...)` per process at route-registration time, with an
empty `rooms` Map — there is no code path that reads anything back from
Redis to seed it.

The only Redis-touching code is `SessionManager`
(`apps/backend/src/session/manager.ts`), wired in via the hub's
`onSessionStart`/`onSessionEnd` hooks (`routes/signaling.ts:28-44`). It
persists a `SessionRecord` (`manager.ts:15-24`) keyed
`lilypad:session:<id>` with a **fire-and-forget** `void sessions.create(...)`
— the hub never awaits it, never reads it back, and the record exists purely
as an audit/debugging artifact. Confirmed: `create`/`transition`/`end` in
`manager.ts` are the only Redis touchpoints in the whole session-lifecycle
path, and nothing in `hub.ts` calls any of them to _reconstruct_ a `Room`.

### Problems

- A deploy, crash, OOM kill, or horizontal autoscale-down of the backend
  process instantly and silently drops **every** live room: the in-memory
  `Map` is gone, and there is no mechanism for a reconnecting desktop or
  mobile client to find their room again — `register()`
  (`hub.ts:248-301`) on the new process creates a brand-new `Room` with
  `established: false`, `sessionId: undefined`, `vacatedAt: {}` — no memory
  of the prior session at all.
- This directly contradicts the product's core promise ("sessions survive
  whenever technically possible") for what is, in a hosted-signaling
  architecture, one of the _most common_ disruptions in production: rolling
  deploys happen on every release, and horizontally-scaled signaling servers
  (needed for real traffic, not just a single dev box) mean a client's
  reconnect can easily land on a _different_ process instance even without a
  restart, which today is indistinguishable from "the room doesn't exist" —
  worth calling out explicitly: this bug also blocks horizontal scaling of
  the signaling tier entirely, not just restart-survival, since two hub
  instances never share room state.
- Even though the media path is peer-to-peer once ICE is established, an
  in-progress ICE restart, a `renegotiate`, or the periodic trickle of new
  candidates all depend on signaling relay — so a backend restart _during_ an
  active ICE restart (e.g. one triggered by the very network flap that also
  bounced the backend, if colocated/same outage) strands the session with a
  half-completed renegotiation and no way to finish it.
- `SessionManager.get`/`transition` (`manager.ts:61-76`) are dead code paths
  today — nothing calls them outside of tests (`pairing.test.ts` not
  reviewed here beyond scope, but grep confirms no runtime caller in
  `hub.ts`/`routes/signaling.ts`) — meaning the Redis persistence exists but
  provides zero operational value beyond an audit log a human could query
  directly. This is wasted infrastructure sitting one step away from solving
  the actual problem.

### Root cause

The hub was designed as a pure, transport-agnostic, in-memory router
(explicitly stated in its own doc comment: "Room-routed signaling... The hub
relays... and never trusts a client", `hub.ts:78-83`) — a reasonable M2
design for a single-process demo. Session _persistence_ was bolted on
afterward purely as an audit/analytics hook (`onSessionStart`/`onSessionEnd`),
not as the room's source of truth, so the two systems (live routing state,
audit trail) were never unified.

### Redesign

Make Redis the source of truth for room state, and the in-memory `Map` a
per-process **cache** of it, keyed the same way. This is the standard
pattern for horizontally-scalable signaling (same shape as Socket.IO's Redis
adapter, or LiveKit's room service) and is the only way to satisfy both
"survive a backend restart" and "scale the signaling tier past one process."

**Data model** — extend `SessionRecord`
(`manager.ts:15-24`) into a `RoomRecord` that captures everything needed to
resurrect a `Room`, minus the live `Peer` handles (which cannot survive a
process restart — the underlying WebSocket to the _old_ process is gone
regardless):

```ts
interface RoomRecord {
  id: string; // roomId
  fsmState: SessionState;
  sessionId?: string;
  scopes: SessionScope[];
  deviceIds: Partial<Record<DeviceKind, string>>;
  established: boolean;
  resumptionToken: string; // see below
  updatedAt: number;
  version: number; // optimistic-concurrency guard
}
```

Stored at `lilypad:room:<roomId>`, TTL refreshed on every mutating dispatch
(matching the existing `SessionManager` TTL pattern, `manager.ts:41,90-92`).

**Hub changes**:

1. Every state-mutating point in `dispatch`/`register`/`approve`/`endRoom`
   (`hub.ts:248-484`) — after applying the in-memory change — writes the
   `RoomRecord` to Redis (fire-and-forget is _not_ acceptable here anymore
   for the fields that gate reconnection: `established`, `deviceIds`,
   `sessionId`, `scopes` must be durably written before the hub ACKs the
   state-changing message, or a crash between the in-memory change and the
   Redis write reintroduces the bug for a narrow race window — use a small
   in-process write-behind queue with an upper bound of ~1 outstanding write
   per room to keep p99 latency low without an unbounded backlog).
2. On `register()` for a room the in-memory `Map` doesn't have
   (`hub.ts:262-274`, the `if (!room) { room = {...} }` branch): before
   creating a **fresh** room, first `GET lilypad:room:<roomId>` from Redis.
   If found and not expired, reconstruct the `Room` object from the record
   (`fsm` seeded to `fsmState`, `established`, `scopes`, `deviceIds`) with
   both `Peer` slots empty and both `vacatedAt` timestamps set to "now" (they
   were, from this process's point of view, vacated at the moment of the old
   process's death) — then proceed through the _existing_ re-register logic
   (`hub.ts:281-292`, the `vacated` / `deviceIds[role] !== msg.payload.deviceId`
   check) completely unmodified. This is the key insight: **Finding 2's fixed
   grace-window logic already knows how to let a device reclaim a vacated
   seat** — resurrecting the `Room` from Redis just needs to reproduce the
   "both seats currently vacated, both within grace" state that Finding 2
   makes survivable. Backend-restart recovery falls out of the _combination_
   of Finding 2's fix + this finding's resurrection, for free, using logic
   that already exists.
3. Bump `reregisterGraceMs` on resurrected rooms specifically (e.g. to
   30-45s) to give both peers time to notice the backend socket died and
   redial, since a restart-induced drop affects _both_ seats simultaneously
   and clients may be independently backing off (see Finding 6) — a longer
   grace window here is cheap (bounded by `maxRooms`) and directly increases
   the restart-survival rate.
4. `reapStale()` and `endRoom()` must delete the Redis record
   (`DEL lilypad:room:<roomId>`) alongside the in-memory `Map` entry
   (`hub.ts:432-450`), or resurrected-but-actually-dead rooms accumulate in
   Redis until TTL (acceptable as a backstop, but delete eagerly for
   correctness of the `activeRooms` semantics if that metric is ever sourced
   from Redis directly).
5. **Session resumption token** (also closes Finding 7): mint a random
   high-entropy `resumptionToken` per room at `approve()` time
   (`hub.ts:382-413`, alongside `sessionId`), deliver it to both peers in the
   `session-start` payload (extend the `sessionStart` schema in
   `packages/protocol/src/signaling.ts:104-112`), and require it as part of
   `register` when a client is _specifically_ attempting a resume — this
   guards against a different desktop/mobile device that happens to guess or
   replay a `deviceId` from re-attaching to a stale resurrected room record
   after the original devices are long gone. Practically: extend the
   `register` payload with an optional `resumptionToken`; if a room record
   exists in Redis with `established: true`, require the token to match
   before allowing reconstruction; if creating a room fresh (no prior
   record), the token requirement doesn't apply.

### Tradeoffs

This adds a Redis round-trip (or at minimum a queued write) to every
signaling state transition, and turns the hub from "pure in-memory,
trivially testable" into "in-memory cache + external source of truth,"
which is a real increase in operational complexity (Redis becomes a hard
dependency for correctness, not just an audit sink — `redis.ts:14-16`'s
"a Redis blip must degrade... not take the server down" comment will need
revisiting: a signaling hub that can't durably record `established` during a
Redis outage should probably still route messages in-memory-only and log a
degraded-durability warning, rather than blocking, to avoid making Redis a
single point of failure for the live media path it doesn't even carry).
Recommend: writes are best-effort with a bounded retry and a warning log, not
a hard requirement to complete before the hub ACKs — losing resurrection
capability during a Redis outage is an acceptable degradation; losing
signaling entirely is not.

### Implementation plan

1. Add `RoomRecord` type + `RoomStore` (Redis-backed, same `KvStore`
   interface pattern as `manager.ts:9-13`) to
   `apps/backend/src/session/roomStore.ts` (new file).
2. Thread a `RoomStore` instance into `SignalingHubDeps`
   (`hub.ts:22-44`) alongside the existing `buildIceServers`/`onSessionStart`
   hooks.
3. Add the Redis-read-before-create branch to `register()`.
4. Add write-behind persistence calls at each of: `register` (new/resurrected
   room), `approve` (session-start), `dispatch`'s `answer` case (sets
   `established = true` — the single most important field to persist,
   `hub.ts:342-347`), and `endRoom` (delete).
5. Extend `sessionStart` protocol schema with `resumptionToken`
   (`packages/protocol/src/signaling.ts:104-112`) and `register` payload with
   optional `resumptionToken` (`signaling.ts:48-55`).
6. Update both desktop (`messages.rs`) and mobile (`signaling.ts`) clients to
   store and replay the token across a signaling reconnect.
7. Extensive new tests in `hub.test.ts`: kill-and-recreate a `SignalingHub`
   instance mid-session sharing a fake `RoomStore`, assert both peers can
   re-register into the resurrected room and the session continues.

### Migration strategy

Ship the `RoomStore` write path first (dark — write but never read back),
verify records land correctly in a staging Redis and TTLs behave, then ship
the read-and-resurrect path behind a feature flag (env var,
e.g. `LILYPAD_ROOM_RESURRECTION_ENABLED`) so it can be disabled instantly if
Redis-driven resurrection misbehaves in production before the flag is
removed once proven. No wire-protocol break — `resumptionToken` is an
additive optional field both schemas already tolerate via `zod`'s object
shape (new required fields would break old clients; keep it optional with a
clear "no token ⇒ fresh room only" fallback during rollout).

### Testing strategy

- Unit: `RoomStore` round-trip tests (write, read, TTL expiry, version
  conflict).
- Integration: two hub instances sharing one fake/real Redis, simulate a
  restart by discarding one instance's in-memory `Map` and routing the same
  clients' next `register` to the second instance; assert the session
  resumes.
- Chaos: `docker compose restart backend` mid-session in a manual E2E rig;
  assert both desktop and mobile recover without re-pairing.

### Risk assessment

Medium-high — this is the single most architecturally significant change in
this report (introduces a durable source of truth where none existed) and
touches the hottest path in the backend. Mitigate with the feature flag,
extensive fake-Redis unit coverage mirroring the existing `hub.test.ts`
patterns, and a staged rollout starting with write-only (no behavior change,
pure observability) before enabling reads.

### Performance impact

One additional Redis write per state-mutating signaling message (register,
offer, answer, approve, disconnect) — bounded, low-frequency events (not
per-frame, not per-ICE-candidate if candidates are excluded from persistence,
which they should be — trickled candidates are cheap to regenerate via ICE
restart and not worth persisting). Read cost only on `register()` for a room
not already in the local `Map`, i.e. only on cold-start/resurrection, not on
the steady-state relay path.

### Future extensibility

This is the prerequisite for horizontally scaling the signaling tier (running
N backend replicas behind a load balancer) — a hard requirement for any real
production traffic beyond a single box, and something the current
architecture cannot do at all today regardless of restarts. It also gives
the resumption-token mechanism a natural home for future features like
multi-device handoff (approve a session on desktop A, resume viewing from a
different phone) without any further backend redesign.

---

## Finding 4: React Native app never observes `AppState` — background, lock, and foreground transitions are invisible to the session

### Current implementation

Exhaustive search of `apps/mobile/src` (`grep -rn "AppState" apps/mobile/src`,
`grep -rn "NetInfo" apps/mobile/src`) returns **zero matches** in either case.
`ViewerConnection` (`apps/mobile/src/lib/webrtc.ts`) and `ViewerScreen`
(`apps/mobile/src/screens/ViewerScreen.tsx`) have no lifecycle hook beyond the
screen's own `useEffect` cleanup (`ViewerScreen.tsx:50-59`), which only fires
on component unmount (navigating away), not on the app backgrounding while the
screen stays mounted.

### Problems

- iOS and Android both aggressively throttle or suspend background JS
  execution, freeze timers (RN's `setInterval`, used for the 10s heartbeat at
  `webrtc.ts:51`), and — depending on OS version and background-mode
  entitlements the app does not appear to declare — can tear down the
  WebSocket and even the `RTCPeerConnection` outright while backgrounded.
  None of this is anticipated: no code path pauses outbound video decode
  work, pauses the heartbeat intentionally (vs. having it silently starve),
  or sends the protocol's own `pause` message (see Finding 8) before the OS
  does it forcibly.
- On foreground resume, nothing proactively checks whether the signaling
  socket or peer connection is still alive — the app just hopes the frozen
  state was still fine, which combined with Finding 1 (no reconnect) means a
  background/foreground cycle is a coin-flip between "still works" and
  "silently dead forever."
- No `NetInfo` (or equivalent) listener means a WiFi→cellular handoff is
  detected, if at all, only reactively via `RTCPeerConnection`'s own
  `connectionstatechange` firing `'failed'` — by which point the ICE session
  has already fully timed out client-side rather than being proactively
  restarted the instant the OS reports a new active interface, which is
  measurably slower and more visible to the user than a proactive restart.

### Root cause

The mobile viewer was built to the happy path of "screen stays foregrounded,
network stays up" for the M2 demo; RN's `AppState` and `NetInfo` (the latter
requiring `@react-native-community/netinfo`, not currently a dependency —
confirm via `apps/mobile/package.json` before implementation) were never
wired in because the initial milestone didn't need them.

### Redesign

Add an explicit `AppLifecycleController` owned by `ViewerConnection`:

```ts
import { AppState, type AppStateStatus } from 'react-native';
// + NetInfo from @react-native-community/netinfo (new dependency)

class AppLifecycleController {
  private appState: AppStateStatus = AppState.currentState;
  constructor(
    private readonly onBackground: () => void,
    private readonly onForeground: () => void,
    private readonly onNetChange: (connected: boolean) => void,
  ) {
    AppState.addEventListener('change', this.handleAppState);
    NetInfo.addEventListener(this.handleNetInfo);
  }
  private handleAppState = (next: AppStateStatus) => {
    if (this.appState === 'active' && next.match(/inactive|background/)) this.onBackground();
    if (this.appState.match(/inactive|background/) && next === 'active') this.onForeground();
    this.appState = next;
  };
  private handleNetInfo = (state: NetInfoState) => this.onNetChange(!!state.isConnected);
}
```

Wire it into `ViewerConnection.start()`:

- **`onBackground`**: send the protocol's existing `pause` message
  (`packages/protocol/src/signaling.ts:139-143`, currently dead — see
  Finding 8) so the desktop can stop encoding/sending video (saving the
  host's CPU/battery and the mobile's decode work while the screen isn't
  visible) without tearing down ICE or the DataChannel; keep the heartbeat
  alive at a reduced rate if the OS allows any background execution
  (best-effort; if the OS fully suspends the JS thread, `onForeground`'s
  recovery path below has to assume the worst anyway).
- **`onForeground`**: immediately probe socket health — if the WebSocket's
  `readyState !== OPEN`, trigger `MobileSignaling`'s reconnect flow from
  Finding 1 rather than waiting for the next heartbeat's send failure to be
  (not) noticed; then send `resume` to resume the video stream.
- **`onNetChange`**: on a _disconnected → connected_ transition (new network
  path available), proactively call `this.sig.renegotiate()`
  (`signaling.ts:83-91`, itself currently dead — see Finding 5) instead of
  waiting for the peer connection to independently notice and time out.

### Tradeoffs

Requires adding `@react-native-community/netinfo` as a new dependency (small,
well-maintained, already the de-facto standard for this in RN) — a minor
increase in bundle size/native module surface, easily justified by the
correctness gain. `pause`/`resume` on backgrounding trades a small
UX regret (a black frame flash on foreground while the encoder ramps back up)
for a real CPU/battery/bandwidth win on both ends whenever the phone is
locked or backgrounded, which is presumably a very common state for any
session left "open" for reference while the user does something else.

### Implementation plan

1. Add `@react-native-community/netinfo` to `apps/mobile/package.json`.
2. Implement `AppLifecycleController` (new file,
   `apps/mobile/src/lib/lifecycle.ts`).
3. Wire it into `ViewerConnection` (construct in `start()`, tear down in
   `close()` — `webrtc.ts:144-164`).
4. Implement `pause`/`resume` emission (depends on Finding 8's desktop-side
   handling existing first, or this finding's `pause` sends are no-ops on
   arrival — sequence Finding 8 before or alongside this).
5. Manual test matrix: lock phone 10s/60s/10min mid-session; background app
   via home button; toggle airplane mode; physically move between WiFi and
   cellular coverage.

### Migration strategy

Additive, mobile-only for the `AppState`/`NetInfo` wiring; the `pause`/
`resume` emission depends on Finding 8 landing (desktop must already accept
and act on these messages, which today it does not — `session.rs`'s
`handle_inbound` match arm at `session.rs:519-582` has no case for `pause`/
`resume` at all, they fall through the `_ => {}` catch-all). Land Finding 8's
desktop-side handling first or same-release.

### Testing strategy

Automated: mock `AppState`/`NetInfo` modules in Jest, assert
`pause`/`resume`/`renegotiate` are emitted on the right transitions. Manual:
device test matrix above, run on both iOS and Android (background behavior
differs meaningfully between the two OSes).

### Risk assessment

Low-medium. The main risk is over-aggressive pausing causing visible flicker
if the OS reports spurious `AppState` transitions (known to happen briefly
during iOS control-center/notification-center swipes) — debounce `onBackground`
with a short delay (e.g. 2s) before actually sending `pause`, so a quick swipe-down-and-back
doesn't interrupt the stream.

### Performance impact

Net positive: pausing encode while backgrounded saves the desktop's CPU/GPU
encoder cycles and the mobile's battery, for what is likely a common usage
pattern (leave the session open, check back periodically).

### Future extensibility

Establishes the pattern for any future "which capabilities does the OS
currently allow" gating — e.g. iOS background modes, Android battery
optimization exemptions — that a production remote-desktop app will
eventually need for reliable background operation (e.g. audio-only fallback,
push-notification-triggered wake).

---

## Finding 5: Mobile never attempts recovery when its own peer connection reports `failed` — no ICE restart, no renegotiation, no reconnect of any kind

### Current implementation

`apps/mobile/src/lib/webrtc.ts:114-119`:

```ts
p.addEventListener('connectionstatechange', () => {
  const s = p.connectionState;
  if (s === 'connected') this.cb.onState('connected');
  else if (s === 'failed') this.cb.onState('failed');
  else if (s === 'closed' || s === 'disconnected') this.cb.onState('ended');
});
```

That is the entirety of the mobile side's response to a `failed`
`RTCPeerConnection` state — it calls `this.cb.onState('failed')`, which
`ViewerScreen.tsx:34-40` renders as the label `"Connection failed"`, and
nothing else happens. `MobileSignaling.renegotiate()`
(`signaling.ts:83-91`) exists and is fully speced on the wire (relayed by the
hub at `hub.ts:354-358`, and would need to be handled by the desktop — see
below), but it is never called from `webrtc.ts` or `ViewerScreen.tsx`
(confirmed via `grep -rn "renegotiate" apps/mobile/src` returning only its
own definition).

Contrast with the desktop, which has a real, bounded ICE-restart loop keyed
off exactly this same `failed` state (`session.rs:313-333`,
`MAX_ICE_RESTARTS = 2` at `session.rs:72`, calling `WebRtcPeer::restart_ice`
at `rtc/mod.rs:227-240`).

### Problems

- `RTCPeerConnection.connectionState` transitions to `failed` on _either_
  peer's local judgment of its own ICE checks — it is not purely a function
  of the desktop's view of the network. If the mobile's own local network
  path is what broke (very plausible on a phone: WiFi drops, cellular
  handoff, carrier NAT re-mapping), the _mobile_ side may see `failed` before
  or independent of the desktop, and today the mobile side has no way to
  request or perform any recovery — it just displays a dead-end message.
- Because the desktop is the offerer and the one that calls `restart_ice()`
  (`session.rs:316-328`), the _only_ path to an ICE restart today is the
  desktop's own connection-state observer noticing `failed` on its side.
  There is no code path where the mobile can ask for one via `renegotiate`
  (which the hub _would_ relay to the desktop and treat as a trigger for a
  new offer, per `hub.ts:354-358`'s comment "Either peer may ask; the
  desktop (offerer) produces the new offer" — the backend was clearly built
  expecting the mobile to eventually call this, and it never does).
- Net effect: a huge share of the real-world "mobile network changed"
  scenarios in the brief (WiFi→cellular handoff, cellular tower handoff) rely
  entirely on the desktop's side of the same `RTCPeerConnection` also
  independently observing `failed` — asymmetric NAT/firewall behavior means
  this is not guaranteed to happen in lockstep, and until it does, the phone
  shows a dead screen with a "Connection failed" label that isn't even wired
  to any retry button.

### Root cause

The mobile viewer was built purely as the answering side of the handshake
(`setupPeer`/`handleOffer`, `webrtc.ts:92-142`) with no equivalent of the
desktop's `session.rs` recovery loop ever ported over — mirroring the same
gap pattern as Finding 1 (signaling reconnect) and Finding 4 (AppState): the
desktop's `session.rs` accumulated real production-hardening logic that was
never symmetrically implemented on the TypeScript/mobile side.

### Redesign

1. On `connectionstatechange === 'failed'`, instead of only calling
   `this.cb.onState('failed')`, first attempt local recovery:
   - Call `this.sig.renegotiate()` (already implemented, just unused) to ask
     the desktop to produce a fresh ICE-restart offer, **bounded by the same
     `MAX_ICE_RESTARTS = 2`-shaped budget** the desktop enforces
     (`session.rs:72`) — track `iceRestartAttempts` in `ViewerConnection`,
     reset it to 0 on a subsequent `'connected'` transition (mirroring
     `session.rs:302-306`), and stop asking after the budget is exhausted.
   - Surface an intermediate `ViewerState` value (e.g. `'recovering'`)
     distinct from the terminal `'failed'`, so the UI shows "Reconnecting…"
     instead of a dead-end "Connection failed" while a restart is in flight.
   - Add a client-side recovery deadline mirroring the desktop's
     `RECOVERY_TIMEOUT = 20s` (`session.rs:79`) — if `connected` isn't
     reached within that window after requesting `renegotiate`, transition to
     the real terminal `'failed'` state and _then_ offer the user a manual
     "Reconnect" action (which should tear down and redo the full offer/
     answer handshake from scratch, or better, redeem a resumption token per
     Finding 3).
2. **Desktop-side counterpart required**: today `handle_inbound`
   (`session.rs:519-582`) has no match arm for a `renegotiate` message at
   all — it would silently fall through the `_ => {}` catch-all
   (`session.rs:581`) and be ignored entirely. Add a case that, on receiving
   `renegotiate` with `iceRestart: true`, calls the exact same
   `peer.restart_ice()` path the desktop's own `failed`-state handler already
   uses (`session.rs:316-328`), sharing the same `ice_restarts` budget
   counter so a mobile-initiated and desktop-initiated restart can't combine
   to exceed the intended cap.

### Tradeoffs

Two independent triggers for the same bounded resource (ICE restarts) means
the shared counter must be carefully synchronized — since both live in the
same `run_session` loop/state on the desktop side, this is straightforward
(one `ice_restarts: u32` already exists at `session.rs:166`, just needs the
new `renegotiate`-inbound branch to go through the identical increment/budget
check instead of adding a second independent counter).

### Implementation plan

1. Desktop: add a `"renegotiate"` arm to `handle_inbound`'s match
   (`session.rs:519-582`) that, given `peer` is `Some`, performs the same
   bounded restart the `s == "failed"` branch does
   (`session.rs:313-328`) — factor that block into a shared helper function
   both call sites invoke, so the budget/deadline bookkeeping lives in one
   place.
2. Mobile: implement the recovery logic in `webrtc.ts`'s
   `connectionstatechange` handler as described above; add `'recovering'` to
   `ViewerState` (`webrtc.ts:18`) and `STATE_LABEL`
   (`ViewerScreen.tsx:34-40`).
3. Tests: desktop unit test asserting a `renegotiate` inbound message
   triggers `restart_ice` and respects the shared budget (mirror the existing
   `backoff_is_exponential_and_capped` test style at `session.rs:626-636`);
   mobile unit test (mock `RTCPeerConnection`) asserting the bounded retry +
   deadline behavior.

### Migration strategy

No protocol change (the `renegotiate` message type already exists and is
already relayed correctly by the hub — `hub.ts:354-358`). Ship the desktop
handler first (it's inert until something sends `renegotiate`, so it's a
safe no-op deploy), then ship the mobile trigger logic.

### Testing strategy

Integration test: force a mobile-side ICE failure (e.g. by having the test
harness drop the mobile's active candidate pair) while leaving the desktop's
view of the connection nominally fine, and assert the session recovers via
the mobile-initiated `renegotiate` path — this is the scenario existing tests
cannot currently exercise because the trigger doesn't exist.

### Risk assessment

Low-medium. The desktop-side change reuses an already-tested restart path;
the main new risk surface is the shared-budget synchronization between the
two trigger sites, mitigated by factoring them into one function.

### Performance impact

Negligible — ICE restarts are already a rare, bounded operation; this only
adds a second (still bounded) trigger for it.

### Future extensibility

Symmetric recovery capability on both peers is a prerequisite for any future
multi-hop or relay-assisted recovery strategy (e.g. server-assisted ICE
restart hinting, or a "either side may propose a codec/resolution
renegotiation" feature), since both sides will already speak the same
recovery vocabulary.

---

## Finding 6: Heartbeat, timeout, and backoff constants were tuned independently per tier and now race each other

### Current implementation

| Constant                                                       | Value                                 | Location                                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop app-level heartbeat send interval                      | 10s                                   | `session.rs:155` (`tokio::time::interval(Duration::from_secs(10))`)                                                                               |
| Desktop signaling-reconnect backoff                            | 500ms→8s capped, 5 attempts           | `session.rs:97-100, 75`                                                                                                                           |
| Desktop ICE-restart budget                                     | 2 restarts                            | `session.rs:72`                                                                                                                                   |
| Desktop recovery deadline (per restart attempt)                | 20s                                   | `session.rs:79`                                                                                                                                   |
| Desktop pairing-redemption timeout                             | 120s (env-overridable)                | `session.rs:81-94`                                                                                                                                |
| Mobile app-level heartbeat send interval                       | 10s                                   | `webrtc.ts:51` (`setInterval(() => this.sig.heartbeat(), 10_000)`)                                                                                |
| Mobile signaling reconnect                                     | **none**                              | Finding 1                                                                                                                                         |
| Backend heartbeat-timeout (peer reaped if silent this long)    | 30s default                           | `hub.ts:70, 101` (`DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000`)                                                                                        |
| Backend reregister grace (seat held this long after vacate)    | 15s default                           | `hub.ts:71-73, 102` (`DEFAULT_REREGISTER_GRACE_MS = 15_000`)                                                                                      |
| Backend reap-sweep interval                                    | 10s                                   | `routes/signaling.ts:50`                                                                                                                          |
| Backend register timeout (socket must register or gets closed) | 10s                                   | `routes/signaling.ts:15`                                                                                                                          |
| Transport-level (WS ping/pong or TCP keepalive)                | **none configured**                   | `server.ts:31` (`@fastify/websocket` registered with only `maxPayload`, no `pingInterval`); no OS-level keepalive tuning visible in either client |
| TURN credential TTL                                            | 3600s, minted once at `pair-approved` | `turn/credentials.ts:32,36`, delivered once in `session-start`                                                                                    |

### Problems

1. **The desktop's total signaling-reconnect budget can exceed the backend's
   reregister grace window.** Worst case for the desktop's 5-attempt backoff
   schedule is `500+1000+2000+4000+8000 = 15,500ms` of _sleeping_ alone
   (`session.rs:97-100`), **not counting** the time each `signaling::connect`
   attempt itself takes to time out against an unreachable server (TCP
   connect timeouts can easily add multiple seconds per attempt on a lossy
   network) — so the desktop's realistic worst-case reconnect duration can
   comfortably exceed the backend's `reregisterGraceMs = 15,000ms`
   (`hub.ts:73,102`). If the desktop is still inside its backoff/retry loop
   when the backend's `reapStale()` sweep (`hub.ts:194-231`, running every
   10s per `routes/signaling.ts:50`) decides the grace window has elapsed, the
   room is torn down out from under a desktop that was about to successfully
   reconnect — a session that _should_ have survived, doesn't, purely because
   two independently-chosen constants weren't checked against each other.
2. **No transport-level keepalive** means the _only_ signal either tier has
   that a peer's TCP connection is dead is the 10s app-level heartbeat frame
   arriving (or not) within the backend's 30s window — on mobile networks
   where NAT bindings are commonly recycled around 30s of idle
   (well-documented carrier behavior), a 10s heartbeat is _barely_ inside
   that budget with essentially no margin, and any single delayed/lost
   heartbeat frame (easily caused by exactly the disruptions this report is
   about) risks tripping the 30s reap on a connection that's actually fine.
   `@fastify/websocket`'s registration at `server.ts:31` does not set a
   `pingInterval`/`pongTimeout` — genuine transport-level ping/pong (which OS
   networking stacks and NAT devices treat specially, refreshing idle-timeout
   clocks even when application data isn't flowing) would give a faster,
   cheaper, more reliable "is this socket still alive" signal than waiting up
   to 30 application-level seconds.
3. **`RECOVERY_TIMEOUT` is a flat 20s regardless of which ICE-restart attempt
   it's guarding** (`session.rs:79`, applied identically at
   `session.rs:321` for both the 1st and 2nd restart) — real-world ICE
   gathering + connectivity checks against a TURN relay after a network
   handoff can legitimately take close to this long on a first attempt; a
   flat, non-adaptive deadline gives no extra headroom for a second attempt
   that might need to fall back further (e.g. to a relayed-only candidate
   pair) after the first, faster path failed.
4. Mobile has no reconnect timing at all (Finding 1), so there is currently
   no mobile-side constant to even check for consistency — once mobile's
   reconnect logic is added (Finding 1's redesign), its backoff schedule
   _must_ be chosen with this same grace-window math in mind, or it will
   inherit problem #1 above on day one.
5. **TURN credential TTL has no mid-session refresh** — `buildIceServers`
   (`turn/credentials.ts:48-62`) is called exactly once, at `approve()` time
   (`hub.ts:401-411`), with a 3600s (`DEFAULT_TTL_SECONDS`, `turn/credentials.ts:32`)
   expiry baked into the username/credential pair handed to each peer in
   `session-start`. Any session that legitimately runs longer than an hour —
   not a stretch for a remote-desktop product used for actual work — and
   _then_ needs an ICE restart (network handoff, etc.) will present an
   **expired** TURN credential to coturn, and any restart attempt that must
   fall back to a relayed candidate will fail outright, even though the
   whole point of this ICE-restart machinery is to survive exactly that kind
   of disruption. There is no code path anywhere in `session.rs`,
   `hub.ts`, or `routes/signaling.ts` that re-mints and re-delivers fresh ICE
   servers mid-session.

### Root cause

Each of these constants was chosen locally, by the engineer implementing that
one file, evidently without a cross-tier timing budget being written down
anywhere — there's no single document or shared constant module that says
"the mobile/desktop reconnect budget must be strictly less than the backend's
reregister grace, which must be strictly less than its heartbeat-timeout,
which must be comfortably longer than the app heartbeat interval." Each
number in isolation has a reasonable-sounding comment justifying it
(e.g. `session.rs:81-86`'s justification for the 120s pairing timeout is
genuinely well-reasoned) but none of the comments reference the _other_
tiers' constants.

### Redesign

Establish and document one explicit cross-tier timing budget, then make
every constant either derive from it or assert against it at startup/test
time:

```
                     mobile/desktop reconnect budget  <  backend reregister grace  <  backend heartbeat timeout
                              (worst case ~12s)                  (25s)                        (35s)

     app heartbeat interval  <<  backend heartbeat timeout / 3   (so ~2 missed beats, not 1, trip the reaper)
              (8s)                          (25s / 3 ≈ 8.3s)
```

Concrete recommended values (all made explicit, cross-referenced, and — where
they live in different languages — sourced from one shared table so
"changing one changes the doc/tests for all"):

- **App heartbeat interval**: keep at ~10s but tighten to **8s** on both
  desktop (`session.rs:155`) and mobile (`webrtc.ts:51`) for slightly more
  margin.
- **Backend heartbeat timeout**: reduce `DEFAULT_HEARTBEAT_TIMEOUT_MS` from
  30s to **25s** (`hub.ts:70`) — still ~3 missed 8s heartbeats before reaping,
  which is plenty of tolerance for jitter while cutting dead-peer detection
  time by a fifth.
- **Backend reregister grace**: reduce `DEFAULT_REREGISTER_GRACE_MS` from 15s
  to a value _explicitly derived from_ the client reconnect budget below —
  set to **max(client reconnect budget) + 3s margin**. With the retuned
  client backoff below (worst case ~9.5s of sleep + connect-attempt time,
  bounded to ~12s realistic worst case), set grace to **15s** (keep as-is,
  but now _documented_ as derived rather than coincidentally close) — or, to
  give more headroom for the "backend restart, both peers reconnecting
  independently" case from Finding 3, use the **resurrected-room-specific
  30-45s** grace already recommended there, while keeping the _normal_
  single-seat-drop grace at 15s.
- **Client (desktop + mobile) reconnect backoff**: keep the exponential
  schedule but reduce `MAX_SIGNALING_RECONNECTS` from 5 to **4** attempts
  (500ms, 1s, 2s, 4s = 7.5s worst-case sleep), keeping total worst-case
  reconnect time safely under the 15s grace window even accounting for
  per-attempt connect timeouts, and — critically — **export this schedule
  from `@lilypad/protocol`** as a shared constant (Finding 1's
  implementation plan already calls for this) so Rust and TypeScript can't
  drift independently again; add a small Rust build-time or test-time check
  (a unit test hardcoding the expected values with a comment pointing at the
  protocol package) since Rust can't literally import the TS constant.
- **Reap-sweep interval**: reduce from 10s to **5s**
  (`routes/signaling.ts:50`) so grace-window and heartbeat-timeout expiries
  are noticed roughly twice as fast, tightening the worst-case "how long can
  a truly-dead room linger" bound without materially increasing CPU (a Map
  iteration over active rooms every 5s is cheap at any realistic scale below
  `maxRooms = 10,000`).
- **ICE recovery deadline**: make `RECOVERY_TIMEOUT` scale with attempt
  number rather than being flat — e.g. `12s` for the first restart, `20s`
  for the second (real second attempts often need to fall back to
  relay-only paths, which take longer to converge) — small change to
  `session.rs:313-328`'s restart branch to look up a per-attempt deadline
  table instead of the single flat constant at `session.rs:79`.
- **TURN credential refresh**: add a mid-session refresh path — either (a)
  the backend proactively pushes a fresh `session-start`-shaped
  `ice-servers-refresh` message to both peers at, say, 45-minute intervals
  for any session still `connected`/`negotiating` (simplest, backend-driven,
  no client polling), or (b) the client requests fresh servers as part of
  invoking `renegotiate` if enough of the original TTL has elapsed. Recommend
  (a): it requires no new client-initiated logic, and pairs naturally with
  the periodic `reapStale()` sweep the hub already runs — add a companion
  sweep that finds `connected` sessions nearing TURN-credential expiry and
  proactively re-issues.

### Tradeoffs

Tighter timeouts modestly increase false-positive reap risk under genuine
network jitter (mitigated by keeping heartbeat-timeout comfortably above 2-3
missed intervals) in exchange for faster detection of genuinely dead peers
and a coherent, provably-non-racing set of cross-tier budgets. The TURN
refresh adds a small periodic background task and a new server→client
message type, a modest complexity increase for closing a real correctness
gap in long-running sessions.

### Implementation plan

1. Write down the cross-tier timing budget as a comment block (or a small
   shared markdown doc referenced from both `hub.ts` and `session.rs`) so
   future changes to any one constant are made with the others in view.
2. Apply the retuned constants listed above across
   `session.rs`/`webrtc.ts`/`hub.ts`/`routes/signaling.ts`.
3. Export the reconnect-backoff schedule from `@lilypad/protocol`
   (shared with Finding 1's implementation).
4. Implement the per-attempt `RECOVERY_TIMEOUT` table in `session.rs`.
5. Implement the TURN-credential-refresh background sweep + new
   `ice-servers-refresh` protocol message (extend
   `packages/protocol/src/signaling.ts`) and client handling on both desktop
   (`WebRtcPeer` needs a method to swap ICE server config on the live
   `RTCPeerConnection` mid-session — `webrtc-rs`'s `set_configuration`-style
   API, verify availability) and mobile (`RTCPeerConnection.setConfiguration`
   if `react-native-webrtc` exposes it, or fall back to only applying the
   refreshed servers on the _next_ ICE restart if live reconfiguration isn't
   supported by the underlying native bridge).

### Migration strategy

Constants-only changes are simple config bumps deployable independently per
tier with no coordination risk beyond the grace-window math (deploy the
backend's grace/timeout changes before or alongside the client backoff
changes, never after — a backend with a _shorter_ grace than clients expect
recreates problem #1). The TURN-refresh feature needs the new protocol
message shipped to both clients before the backend starts sending it
(standard additive-protocol rollout: backend waits for a version/capability
flag or simply degrades gracefully if a client doesn't recognize the message
type — the existing `_ => {}` catch-all patterns in both `session.rs:581`
and the mobile `onSignal`'s `default: break;` at `webrtc.ts:87-89` already
provide this safety net for an unrecognized new message type).

### Testing strategy

Add an explicit unit test (in the backend, since it's the tier that owns
both constants) asserting `DEFAULT_REREGISTER_GRACE_MS >
maxPossibleClientReconnectTimeMs` symbolically, so a future change to either
constant that violates the invariant fails CI rather than silently
regressing. TURN refresh: integration test asserting a session held open past
the (test-shortened) TTL still successfully completes an ICE restart.

### Risk assessment

Low for the constant retuning (config-only, well-tested existing paths).
Medium for the TURN-refresh feature (new message type, new mid-session
mutation of a live `RTCPeerConnection`'s ICE server list, which is a less
commonly-exercised code path in most WebRTC stacks and should be tested
carefully against both webrtc-rs and react-native-webrtc's actual behavior
before relying on it).

### Performance impact

Negligible for constant changes. TURN refresh adds one Redis-independent
periodic sweep and, at most, one small JSON message per session per ~45
minutes — immaterial.

### Future extensibility

A documented, explicit cross-tier timing budget is exactly the kind of thing
that prevents this category of bug from recurring as new tiers or new retry
paths are added (e.g. a future TURN-server-side health check, or a future
third client platform) — make it a living doc, not just a one-time fix.

---

## Finding 7: No session-resumption token — a torn-down room forces a full re-pair from scratch, discarding granted scopes and forcing a new QR scan

### Current implementation

The only "resumption" concept in the codebase is the hub's same-`deviceId`
seat-reclaim within `reregisterGraceMs` (`hub.ts:281-292`) — which only works
while the _room itself_ (the in-memory `Room` object) still exists. There is
no separate, portable token a client can hold onto and present to _rejoin or
recreate_ a specific session after the room object is gone (e.g. after
Finding 2/3's fixes still fail to save it — the grace window is always
finite) or after any hard disconnect. `apps/backend/src/routes/pairing.ts`
exposes exactly two endpoints, `/pairing/create` and `/pairing/redeem`, both
scoped to the _initial_ QR-based pairing flow (`PairingCreateRequestSchema`/
`PairingRedeemRequestSchema`, not shown here beyond scope but confirmed via
grep that no `resume`-shaped request schema exists anywhere in
`packages/protocol/src/pairing.ts`).

### Problems

- Any disruption that outlives the reconnection grace window — a longer
  network outage, a user closing the mobile app fully (not just
  backgrounding) and reopening it minutes later, a desktop reboot — has
  exactly one recovery path today: the desktop shows a fresh QR code
  (`create_pairing`, `commands.rs:80-128`) and the mobile user has to
  re-scan it and go through the full approve/deny handshake again, even
  though both devices, both users, and the intent to reconnect are all
  unchanged. This is a materially worse UX than any competing product
  (Parsec/AnyDesk/Jump Desktop all support quiet reconnection to a
  previously-paired endpoint without re-scanning anything).
- There's also no way to distinguish, from the backend's point of view, "the
  same device is trying to get back into the same conversation" from "a
  brand new pairing attempt" beyond the coincidental fact that `deviceId` is
  stable per install (`load_or_create_device_id`, `commands.rs:31-46`,
  `getDeviceId()` referenced in `webrtc.ts:49-50`) — `deviceId` alone is not
  a security boundary (it's client-supplied and unauthenticated beyond the
  seat-reclaim check), so it cannot safely be widened into a general resume
  credential without an accompanying secret.

### Root cause

Resumption was never designed as a first-class concept — the pairing flow
(QR + single-use token, `pairing.ts`, `services/pairing.ts` not read in full
here but referenced) and the mid-session seat-reclaim (`hub.ts`) were each
built to solve a narrower problem, and nothing bridges "I had a session, it's
now fully gone, let me get back into _that specific_ session (not a fresh
pairing) without the desktop user having to re-approve."

### Redesign

Introduce a `resumptionToken`, minted once per approved session (at
`approve()`, `hub.ts:382-413`, alongside the existing `sessionId`) — a
high-entropy random value (not derived from anything guessable), delivered
to _both_ peers in the `session-start` payload (protocol change, additive
field on `sessionStart`, `packages/protocol/src/signaling.ts:104-112`).

- Both clients persist this token locally, scoped to `roomId` (desktop:
  alongside the existing `device_id` file in the app-config dir,
  `commands.rs:31-46`'s pattern; mobile: `AsyncStorage`, mirroring
  `getDeviceId()`'s own persistence, `device.ts` not read in full here but
  referenced from `webrtc.ts:16`).
- On any reconnect attempt (signaling-reconnect per Finding 1, or a fresh
  socket after the _room itself_ is gone per Finding 3), the client includes
  the token in `register`'s payload (extend the `register` schema,
  `packages/protocol/src/signaling.ts:48-55`) if it has one for this
  `roomId`.
- The hub, on `register()`, checks Redis (via Finding 3's `RoomStore`) for a
  room record — live, vacated-but-in-grace, or resurrectable — whose stored
  `resumptionToken` matches. If it matches: **skip the approve/deny
  handshake entirely** and go straight back to `connected`/`negotiating`
  (whichever the persisted `fsmState` says), re-delivering fresh ICE servers
  (this also naturally satisfies Finding 6's TURN-refresh need on every
  resume). If it doesn't match (or the room record has fully expired,
  matching the same TTL as the underlying `RoomRecord`): fall back to the
  normal fresh-pairing flow — the resume attempt fails closed, safely, into
  the existing QR-pairing UX.
- Give the _desktop user_ a lightweight, explicit consent gate for silent
  resumption the first time it's exercised in a given app session (e.g. a
  brief toast "phone reconnected" rather than a full re-approve dialog) —
  resumption should feel invisible for transient disruptions but the desktop
  owner should still always be able to see, and revoke (via the existing
  Disconnect/Panic buttons, `commands.rs:240-255`), an active resumed
  session.

### Tradeoffs

A long-lived resumption token is a bearer credential — if leaked (e.g. from
an insecurely-stored local file), it lets someone silently rejoin a prior
session without a fresh approve. Mitigate with: token TTL bounded to a
sensible window (e.g. 24h — long enough to survive "left it overnight,"
short enough to bound leak exposure), single active token per room (minting
a new one invalidates the old on next full pairing), and storing it with the
platform's secure-storage primitive where available (Keychain on iOS/macOS,
Keystore on Android) rather than plain files/AsyncStorage — flag this
explicitly as a security-review item before shipping, not merely an
implementation detail.

### Implementation plan

1. Extend `sessionStart` and `register` protocol schemas with the optional
   `resumptionToken` field (`packages/protocol/src/signaling.ts`).
2. Mint + persist the token as part of Finding 3's `RoomRecord`/`approve()`
   changes (`hub.ts:382-413`).
3. Add the token-match short-circuit branch to `register()`
   (`hub.ts:248-301`).
4. Desktop: persist/read the token via secure local storage; present it on
   `register` (`signaling/messages.rs:40-46`'s `Envelope::register` needs a
   new optional field).
5. Mobile: same, via `MobileSignaling.register()`
   (`signaling.ts:43-51`).
6. Desktop UI: lightweight resumption toast instead of the full
   `AwaitingApproval` control window (`commands.rs:169-198`'s
   `apply_session_event` needs a new branch distinguishing "fresh pair
   request" from "resumed session").

### Migration strategy

Fully additive on the wire (optional field, ignored by old clients/servers
via the existing safe-catch-all patterns). Ship backend support first
(inert without a client sending the field), then update both clients in a
subsequent release. No forced simultaneous upgrade required.

### Testing strategy

Unit: token mint/match/expiry logic in the hub. Integration: full
disconnect-and-resume flow (kill the room entirely, reconnect with a stored
token, assert no re-approval prompt appears and media resumes). Security
review: token entropy, storage-at-rest, and revocation paths, before
shipping (flag explicitly to whoever runs `security-review` on this repo).

### Risk assessment

Medium — introduces a new bearer-credential surface, which is inherently
more sensitive than the rest of this report's changes. Justify the
complexity by how much it improves the product's core promise, but do not
skip the dedicated security review this specific finding calls for.

### Performance impact

Negligible — one extra field on already-small JSON messages, one Redis
lookup keyed by token (or by `roomId` with a token-equality check) on the
already-existing `register()` path.

### Future extensibility

This is the natural foundation for future multi-device / handoff features
(resuming a session from a different phone, or a companion desktop app) and
for any future "recently connected devices" UI on the desktop side.

---

## Finding 8: `pause`/`resume` are fully specified protocol messages, correctly relayed by the hub, and never sent by either client — a dead protocol path exactly where it's needed most

### Current implementation

`packages/protocol/src/signaling.ts:138-149` defines both messages with
clear intent in their own doc comments ("Temporarily stop the stream (phone
backgrounded, user paused) without tearing down ICE"). The hub fully
implements routing for both, including state-machine transitions
(`hub.ts:360-368`):

```ts
case 'pause':
  room.fsm.tryTransition('paused');
  this.relay(room, from === 'desktop' ? 'mobile' : 'desktop', msg);
  return;
case 'resume':
  room.fsm.tryTransition('connected');
  this.relay(room, from === 'desktop' ? 'mobile' : 'desktop', msg);
  return;
```

The state machine itself models `paused` as a real, first-class state with
defined transitions back to `connected` (`stateMachine.ts:9-20,35-36`).
Despite all of this backend readiness, `grep -rn "'pause'\|'resume'"
apps/desktop/src-tauri/src apps/mobile/src` (beyond the schema/hub files
already cited) finds **no sender or handler on either client** —
`session.rs`'s `handle_inbound` match (`session.rs:519-582`) has no `"pause"`/
`"resume"` arm (falls through `_ => {}`), and neither `webrtc.ts` nor
`ViewerScreen.tsx` ever constructs or sends one.

### Problems

- This is precisely the mechanism Finding 4's "phone backgrounded" recovery
  design depends on, and it does not exist on either end today — meaning
  Finding 4's redesign has a real, unbuilt dependency, not just a
  nice-to-have. Today, backgrounding the phone does nothing intentional:
  the desktop keeps encoding and sending full-rate video into a peer
  connection whose remote end may be fully suspended, burning CPU/GPU/
  battery/bandwidth on frames nobody is decoding.
  Media pipeline start/stop as a _reaction_ to backgrounding cannot happen
  without a signal from the phone that it _is_ backgrounded — this exists on
  the wire, is routed, and is simply never triggered.
- The state machine's `paused` state (`stateMachine.ts:16,35-36`) is
  similarly unreachable in practice today outside of direct unit tests of
  the FSM itself, since no runtime path ever sends the message that drives
  the hub into calling `room.fsm.tryTransition('paused')`.

### Root cause

The message pair was speced and wired through the hub ahead of the client
work that would use it (a reasonable "build the plumbing first" sequencing
choice for M2), but the client-side work — desktop reacting to an inbound
`pause` by stopping its encoder, and mobile emitting `pause`/`resume` off
lifecycle events — was never scheduled before this audit.

### Redesign

1. **Desktop**: add `"pause"`/`"resume"` arms to `handle_inbound`
   (`session.rs:519-582`). On `pause`: call `pipeline.control().pause()` (or
   equivalent — check `MediaPipeline`'s existing control surface in
   `apps/desktop/src-tauri/src/media/pipeline.rs`, not read in full for this
   audit but referenced from `session.rs:352-368`'s existing
   `pl.control().set_target_bitrate/request_keyframe` calls, which confirm a
   `control()` handle already exists to extend) to stop feeding the
   `TrackLocalStaticSample` without tearing down the `RTCPeerConnection`,
   DataChannel, or ICE — matching the protocol doc comment's explicit intent.
   Keep input injection (keyboard/mouse) gated off regardless (it already is,
   correctly, whenever the connection isn't fully healthy — but explicitly
   also gate it off on `paused`, since a backgrounded phone obviously
   shouldn't be driving input). On `resume`: restart the encoder feed and
   force an immediate keyframe (reusing the existing
   `pl.control().request_keyframe()` call already used for RTCP-triggered
   keyframes, `session.rs:366-370`) so the phone doesn't wait for the next
   periodic IDR to get a clean picture back.
2. **Mobile**: wire `sig.pause()`/`sig.resume()` calls (add these two thin
   wrapper methods to `MobileSignaling`, mirroring the existing
   `renegotiate()`/`heartbeat()` pattern at `signaling.ts:83-101`) into
   Finding 4's `AppLifecycleController` `onBackground`/`onForeground`
   callbacks.

### Tradeoffs

None significant — this closes a gap between fully-built infrastructure and
its (currently nonexistent) consumers; the only design decision is exactly
how the desktop's media pipeline should "pause" (stop encoding entirely vs.
drop to a minimal keep-alive rate) — recommend fully stopping encode work to
maximize the battery/CPU win, since the doc comment's own stated intent
("without tearing down ICE") already implies the connection itself stays
warm and ready for an instant resume.

### Implementation plan

1. Add `pause()`/`request_keyframe`-triggering `resume()` to
   `MediaPipeline`'s control surface if not already sufficient (check
   `media/pipeline.rs`).
2. Add the `handle_inbound` arms in `session.rs`.
3. Add `pause()`/`resume()` methods to `MobileSignaling`.
4. Wire into `AppLifecycleController` (Finding 4).
5. Test: unit test the desktop's pause/resume handling (pipeline stops/
   restarts on the message, connection state untouched); manual test the
   full background→pause→foreground→resume→keyframe cycle end to end.

### Migration strategy

No protocol change needed at all (messages already exist and are already
correctly routed) — purely a client-side implementation of an existing
contract. Ship desktop-side handling first (safe no-op until a client sends
it), then mobile-side emission.

### Testing strategy

Desktop unit test asserting `pause` stops the sample-feed task without
closing the peer connection, and `resume` restarts it and requests a
keyframe. Manual E2E: background the phone for 60s, confirm (via desktop
logs/metrics) encoding actually stopped, foreground it, confirm the picture
resumes promptly.

### Risk assessment

Low — additive handling of an already-specified, already-tested (at the
schema/hub level) message pair.

### Performance impact

Positive — measurable CPU/battery savings on both ends whenever a session is
backgrounded, which given the product's use case (leave a remote session up
for reference) may be a very large fraction of total connected time.

### Future extensibility

Once wired, `paused` becomes a real, observable state the desktop's tray
UI and any future "sessions" list can surface honestly (today it's a purely
theoretical FSM state), and is a natural hook for a future explicit
user-facing "Pause streaming" control independent of backgrounding.

---

## Finding 9: `MAX_ICE_RESTARTS = 2` is a blunt, desktop-only budget that resets fully on any transient recovery

### Current implementation

`session.rs:70-72`:

```rust
/// Bounded ICE-restart budget per unhealthy period (reset when the peer
/// reports `connected` again).
const MAX_ICE_RESTARTS: u32 = 2;
```

Applied at `session.rs:313-333`; reset at `session.rs:302-306`
(`if peer_connected { ice_restarts = 0; recovery_deadline = None; }`).

### Problems

- A budget of 2 is thin for the scenarios explicitly named in the brief:
  WiFi↔cellular handoffs on a moving/transitioning device can legitimately
  flap `connecting`→`failed`→`connecting` more than twice in quick succession
  as the OS's network stack settles on a stable interface (common on both
  iOS and Android during a handoff), and today the 3rd `failed` within one
  "unhealthy period" ends the session outright (`session.rs:329-332`,
  `"connection failed (ICE restarts exhausted)"`) even though the underlying
  network is actually about to stabilize.
- The reset-on-`connected` rule (`session.rs:302-306`) means a connection
  that briefly reaches `connected` between two restart attempts (plausible —
  ICE can reach `connected` transiently before renegotiating further, or a
  flaky path can connect just long enough to reset the counter and then fail
  again) gets an effectively unbounded number of restarts over a long enough
  flaky session, which is the opposite failure mode: too generous in the
  flapping case, too stingy in the "several restarts needed to find a stable
  path" case. Neither behavior is actually what you want; the current design
  optimizes for neither.
- This budget lives _only_ on the desktop, and (before Finding 5's fix) is
  the _only_ trigger for a restart at all — mobile has no independent budget
  or triggering capability today.

### Root cause

`MAX_ICE_RESTARTS = 2` reads as a reasonable-sounding round number chosen
without modeling the actual distribution of restart attempts needed across
real network-handoff scenarios, and the "reset fully on connected" rule is a
simple implementation choice that doesn't distinguish "genuinely healthy
again" from "transiently reached connected once."

### Redesign

Replace the flat, fully-resetting counter with a **token-bucket-style
budget**: e.g. start with a budget of 5 restart tokens; each restart attempt
consumes one; tokens regenerate slowly over time (e.g. 1 token per 60s of
sustained `connected` time, capped at 5) rather than jumping back to full on
the very first `connected` observation. This tolerates a burst of rapid
flapping during a genuine handoff (consuming several tokens quickly, as
intended) while still bounding a persistently-unstable connection from
restarting forever (since tokens only regenerate slowly, sustained flapping
exhausts the bucket and correctly ends the session).

```rust
struct IceRestartBudget {
    tokens: f64,          // current budget, fractional for smooth regen
    max_tokens: f64,      // 5.0
    regen_per_sec: f64,   // 1.0 / 60.0  (1 token per 60s connected)
    last_regen: Instant,
}
impl IceRestartBudget {
    fn try_consume(&mut self) -> bool { /* ... */ }
    fn regen(&mut self, connected: bool, now: Instant) { /* only regen while connected */ }
}
```

Apply the same structure symmetrically once Finding 5 gives mobile its own
trigger — but keep the _token bucket itself_ on the desktop (the offerer,
the side that actually performs `restart_ice()`), with mobile's
`renegotiate` requests simply attempting to consume from that same shared
bucket rather than mobile maintaining an independent one, avoiding the
"two independent budgets can combine to exceed the intended total" problem
flagged in Finding 5's tradeoffs section.

### Tradeoffs

A token-bucket is marginally more complex than a flat counter, but it's a
well-understood, easily-unit-tested pattern (the codebase already uses one
for signaling-abuse rate limiting on the backend, `TokenBucket` referenced at
`routes/signaling.ts:4,76` — reuse that existing implementation's shape/API
if it's generic enough, or port the concept).

### Implementation plan

1. Implement `IceRestartBudget` in `session.rs` (or a small new module),
   replacing the flat `ice_restarts: u32` counter.
2. Update the `s == "failed"` branch (`session.rs:313-333`) and the new
   `renegotiate`-inbound branch (Finding 5) to both call
   `budget.try_consume()` instead of the current increment-and-compare.
3. Call `budget.regen(peer_connected, Instant::now())` on every heartbeat
   tick (`session.rs:384-394` already runs every 10s — reuse that tick
   rather than adding a new timer).
4. Unit tests: rapid-flap scenario consumes tokens correctly and eventually
   exhausts; sustained-connected scenario regenerates tokens over time;
   mixed scenario matches hand-computed expected token counts.

### Migration strategy

Desktop-only, no protocol/wire change. Safe to ship independently; tune the
constants (5 max, 60s regen) based on real-world telemertry once available,
ideally exposed as env-overridable knobs the way `PAIRING_TIMEOUT` already is
(`session.rs:88-94`) for easy field tuning without a full rebuild.

### Testing strategy

Deterministic unit tests using a fake/injectable clock (the existing
`backoff_is_exponential_and_capped` test at `session.rs:626-636` shows the
codebase's existing testing style for this kind of pure-function timing
logic — mirror it).

### Risk assessment

Low — isolated to the desktop's own recovery bookkeeping, well-testable in
isolation, no external protocol dependency.

### Performance impact

Negligible.

### Future extensibility

A token-bucket budget generalizes naturally to any future bounded-retry
resource in the reconnect system (e.g. Finding 1's mobile signaling
reconnect attempts could use the identical structure instead of a flat
attempt counter, for the same flapping-tolerance benefit).

---

## Finding 10: No OS-level sleep/wake detection on desktop — recovery is purely reactive through the media pipeline's own failure detection, which tears down the whole session

### Current implementation

`grep -rn "sleep\|wake\|suspend\|resume\|power"
apps/desktop/src-tauri/src --include="*.rs"` finds matches only in
`session.rs` (protocol-level `resume`/`pause`/`recovery` naming, already
covered by Findings 8/9) and the media-capture files — no OS power-event
listener exists anywhere (confirmed by reading `lib.rs`, `main.rs`, and
`commands.rs` in full: `lib.rs`'s `tauri::Builder` setup registers only
`tauri_plugin_shell` and the app's own commands, `lib.rs:120-145`; no
power-management plugin, no `NSWorkspace` sleep/wake notification
subscription referenced anywhere).

When macOS suspends the process for system sleep, on wake: the underlying
TCP socket to the signaling server is very likely dead (extended suspension
almost always invalidates TCP connections due to peer timeouts on the far
side, or the OS itself may tear down sockets across sleep depending on
version/settings) and ScreenCaptureKit's capture stream is well-documented to
not survive a system sleep cycle cleanly. Today, the _only_ code path that
would notice any of this is:

- The signaling reconnect logic (`session.rs:204-226`), which only fires once
  the _socket read_ returns `None` — which will eventually happen, but only
  reactively, with no proactive trigger the instant the OS reports a wake
  event.
- The media pipeline's own unexpected-death detection
  (`session.rs:490-505`): if the capture/encode thread dies (which sleep is
  likely to cause), the sample channel closes, and — since `stop_flag` wasn't
  set intentionally — `media_fail_tx` fires
  `"media pipeline stopped unexpectedly (capture or encoder failure)"`, which
  `run_session`'s main loop treats as **fatal**: it disables input
  immediately and sends `SessionEvent::Ended` (`session.rs:230-239`),
  **ending the entire session** rather than attempting to restart just the
  capture pipeline.

### Problems

- Desktop sleep/wake — explicitly named in the brief as a scenario to trace
  — today most likely results in the _whole session ending_ (media pipeline
  death → fatal `Ended` event) rather than a graceful, fast recovery,
  even though the underlying network path and paired mobile device may both
  still be perfectly fine and ready to resume the instant capture is
  restarted.
- There's no proactive signal at all: the app finds out about a sleep/wake
  cycle only by consequence (a dead socket, a dead pipeline), which is slower
  and less precise than subscribing to the OS's own power-event
  notifications and reacting immediately and deliberately.

### Root cause

Sleep/wake handling was never built; the existing "unexpected pipeline death
= fatal" logic (`session.rs:490-505`) was reasonably designed for genuine
encoder/capture _failures_ (a real bug or hardware issue you want to
surface loudly), but sleep/wake is a _known, recoverable, expected_ event
that is currently indistinguishable from that same fatal case.

### Redesign

1. Subscribe to OS sleep/wake notifications — on macOS, `NSWorkspace`'s
   `willSleepNotification`/`didWakeNotification` (available via a small
   native Tauri plugin or a `cocoa`/`objc` crate call from within the Rust
   process; several existing Tauri community plugins already wrap this).
   Wire the wake event into a new `Control` variant (extend the enum at
   `session.rs:24-30`, e.g. `Control::SystemWoke`) sent into the running
   session's `control_rx`.
2. On `SystemWoke`: proactively force a signaling reconnect (don't wait for
   the socket to report closed — start the reconnect flow immediately,
   since a stale-but-not-yet-errored socket after a long sleep can sit in a
   deceptive half-open state for a while before the OS notices) and
   proactively restart the media pipeline (stop the old one if still
   "running" per its stop flag, start fresh) rather than waiting for its
   death to be detected as a fatal error.
3. Distinguish "pipeline died because of a detected sleep/wake cycle" (
   recoverable — restart the pipeline, keep the session alive, matching the
   spirit of the `RECOVERY_TIMEOUT`/ICE-restart machinery already present for
   network disruptions) from "pipeline died with no known cause" (still
   fatal, as today) by checking a `system_asleep` flag the wake handler sets/
   clears, consulted in the `media_fail_rx` branch (`session.rs:230-239`)
   before deciding to end the session outright.

### Tradeoffs

Native OS power-event subscription is platform-specific glue code (separate
implementations needed per OS, and Windows/Linux equivalents are out of
scope for the currently macOS-only capture backend per
`session_capture_kind()`'s own comments, `session.rs:424-438`) — accept this
as necessary platform-integration debt, scoped initially to macOS to match
where the real capture backend already lives.

### Implementation plan

1. Add a small platform module (`apps/desktop/src-tauri/src/os/power.rs` or
   extend the existing `os` module) wrapping `NSWorkspace` sleep/wake
   notifications on macOS, emitting into a channel the session runner reads.
2. Add `Control::SystemWoke` (and optionally `Control::SystemSleeping` for
   proactively pausing before the OS forces it) to `session.rs`'s `Control`
   enum.
3. Handle both in `run_session`'s `control_rx.recv()` arm
   (`session.rs:259-281`): on wake, trigger the signaling-reconnect path
   (reuse the existing `reconnect_signaling` helper,
   `session.rs:105-123`) and a pipeline restart; on sleeping (if
   implemented), proactively send `pause` (Finding 8) to the phone before the
   OS suspends the process, so the phone shows an intentional "Host is
   asleep" state instead of a mystery stall.
4. Track a `system_asleep`-derived flag consulted by the `media_fail_rx`
   handling (`session.rs:230-239`) to avoid the fatal path on an
   expected/recoverable pipeline death.

### Migration strategy

Desktop-only, additive `Control` variant, no protocol change unless the
`pause`-on-sleep enhancement is included (which depends on Finding 8).
Ship the macOS wake-detection + pipeline-restart behavior first; treat
`pause`-on-sleep as a fast-follow once Finding 8 lands.

### Testing strategy

Manual: put the test Mac to sleep via `pmset sleepnow` (or the lid) mid-
session for varying durations (10s, 5min, overnight), wake it, and time how
long the session takes to resume video vs. today's baseline (session ends
outright). Unit test the `system_asleep`-gates-fatal-path logic with a fake
control-channel-driven test.

### Risk assessment

Medium — native platform API integration always carries some risk of
platform-version-specific quirks; scope tightly to macOS first (matching the
existing capture backend's own OS scoping) and keep the fallback (today's
reactive-only behavior) intact for any platform without the new hook wired.

### Performance impact

None during normal operation; strictly improves recovery latency after a
sleep/wake cycle.

### Future extensibility

The same `os/power.rs` module is the natural home for any future
power-state-aware behavior (e.g. throttling encode quality on battery,
pausing when the lid closes even without full sleep).

---

## Finding 11: UI state model conflates all recoverable states into a single "Active"/"Connected" label with no distinct in-progress-recovery indicator surfaced to either user

### Current implementation

Desktop: `apply_session_event` (`commands.rs:169-198`) explicitly documents
its own reasoning for _not_ distinguishing recovery states from the
comment at `commands.rs:174-181`: `"failed"`/`"disconnected"`/`"closed"` are
deliberately treated as non-terminal from the UI's perspective, and only the
runner's own definitive `SessionEvent::Ended` resets UI state — meanwhile
`SessionEvent::ConnectionState` only _sets_ `Active` on `"connected"` and
otherwise does nothing (`commands.rs:182-186`), meaning a session mid-ICE-
restart, mid-signaling-reconnect, or approaching its recovery deadline shows
exactly the same UI as a fully healthy `Active` session — the desktop tray/
control UI has no visual distinction for "reconnecting."

Mobile: `STATE_LABEL` (`ViewerScreen.tsx:34-40`) maps
`ViewerState` 1:1 to a short label, but `ViewerState` itself
(`webrtc.ts:18`) has no `reconnecting`-shaped value at all — it's
`'connecting' | 'negotiating' | 'connected' | 'failed' | 'ended'` — so even
once Findings 1/4/5's reconnect logic exists, there's no state value ready to
represent "was connected, currently trying to get back."

### Problems

Users of a production remote-desktop tool actively want to know "is this
temporarily degraded and recovering, or is everything actually fine" — both
Parsec and AnyDesk show an explicit "Reconnecting…" indicator during exactly
this kind of transient recovery. Today's Lilypad UI can only say "Active" or
"gone," which either under-communicates a real, user-relevant degraded state
(desktop side) or has no data model slot to hold it at all (mobile side,
before this report's other findings are implemented).

### Root cause

The desktop's UI-state simplification (`commands.rs:174-181`) was a
deliberate, reasonable fix for a _worse_ prior bug (clearing `control_tx`
too eagerly, per the same comment) but over-corrected into "never show
anything but Active or Idle," losing the useful middle state in the process.
The mobile `ViewerState` type was simply never designed with a recovery
state in mind, consistent with mobile having no recovery logic at all before
this audit (Findings 1/5).

### Redesign

Add a distinct, additive UI-only state that does **not** change any of the
control-channel-availability logic `commands.rs:174-181` was protecting
(`control_tx` must remain live/available through this state, exactly as
today):

- Desktop: add `SessionStatus::Recovering` (extend the enum at
  `state.rs:12-23`) alongside the existing `Idle`/`Pairing`/
  `AwaitingApproval`/`Active`. In `apply_session_event`
  (`commands.rs:169-198`), set `Recovering` when
  `SessionEvent::SignalingReconnecting` fires (`session.rs:213`) or when a
  `ConnectionState` transitions to `"failed"`/`"disconnected"` while an ICE
  restart is in flight (i.e., `recovery_deadline.is_some()`, which would need
  to be surfaced as a new field on the `ConnectionState` event or a
  dedicated new `SessionEvent::Recovering` variant — simplest: add
  `SessionEvent::Recovering` alongside the existing
  `SignalingReconnecting`/`SignalingReconnected` pair, emitted from
  `session.rs`'s `s == "failed"` branch right where it starts an ICE
  restart, `session.rs:313-328`). Set back to `Active` on
  `SignalingReconnected`/`ConnectionState{"connected"}`.
- Mobile: add `'reconnecting'` to `ViewerState` (needed by Findings 1 and 5
  regardless — this finding just calls out that it must be _surfaced_, not
  only internally tracked) and a corresponding `STATE_LABEL` entry
  (`ViewerScreen.tsx:34-40`), e.g. `"Reconnecting…"`.

### Tradeoffs

None of substance — this is a pure additive UI-state improvement riding on
top of the other findings' recovery-event plumbing; the only real work is
making sure the new state doesn't get treated as terminal anywhere
(mirroring the careful non-terminal handling the desktop already models for
`failed`/`disconnected`/`closed`).

### Implementation plan

1. Add `SessionStatus::Recovering` to `state.rs:12-23`.
2. Add `SessionEvent::Recovering`/(reuse existing `SignalingReconnecting`/
   `SignalingReconnected`) plumbing in `session.rs` and `commands.rs`.
3. Add `'reconnecting'` to mobile's `ViewerState`/`STATE_LABEL`.
4. Add a small visual treatment (e.g. a pulsing badge / distinct color) in
   both the desktop tray icon state and the mobile viewer badge
   (`ViewerScreen.tsx:157-166`'s existing badge styling is a natural place to
   add a `reconnecting`-specific background color).

### Migration strategy

Pure UI/state-model addition, no wire-protocol change, ships independently
per platform.

### Testing strategy

Manual visual QA of the new state during an induced signaling drop / ICE
restart (can be forced today by killing the backend process or blackholing
the desktop's route to it via a firewall rule during a live test session).

### Risk assessment

Low.

### Performance impact

None.

### Future extensibility

A named `Recovering` state is a natural place to eventually attach
richer diagnostics (e.g. "reconnecting, attempt 2 of 4" or a countdown to
the recovery deadline) once the underlying events carry that data — see
Finding 12.

---

## Finding 12: Recovery progress (restart budget remaining, deadline countdown) is tracked internally but never surfaced to either UI

### Current implementation

`ice_restarts`, `recovery_deadline`, and the reconnect `attempt` counter all
live as purely-internal `run_session` locals in `session.rs`
(`ice_restarts: u32` at `session.rs:166`, `recovery_deadline: Option<Instant>`
at `session.rs:171`, the reconnect loop's `attempt` at
`session.rs:110`) — none of this is included in any `SessionEvent` payload
sent to the UI (`SessionEvent`'s variants, `session.rs:33-58`, carry only
coarse state strings/reasons, no attempt/budget/deadline data).

### Problems

Even once Finding 11 adds a "Reconnecting…" indicator, the user has no way
to see _how much longer_ to expect it to take or _how many attempts remain_
before the session gives up — a static "Reconnecting…" label with no
progress signal reads, after a few seconds, indistinguishably from a hang,
which is a worse experience than showing "Reconnecting (attempt 2/4,
~8s)" the way a polished product would.

### Root cause

`SessionEvent`'s variants were designed around coarse lifecycle transitions
(registered, pairing, connected, ended) rather than as a general telemetry
channel — reasonable for M2's scope, insufficient for M5's polish bar.

### Redesign

Extend `SessionEvent::SignalingReconnecting` and add a new
`SessionEvent::Recovering { attempt: u32, max_attempts: u32, deadline_secs: u32 }`
variant (or add fields directly to the existing variants) populated from the
same locals already tracked in `run_session`'s loop — this is a pure
plumbing change, no new logic, since every value needed already exists in
scope at the point each event is emitted (`session.rs:213`, `session.rs:321`).
Mirror on mobile once Finding 5's recovery logic exists: track and expose
`iceRestartAttempts`/budget on `ViewerConnection` for the UI to read.

### Tradeoffs

None meaningful — purely additive data on existing events.

### Implementation plan

1. Add fields to `SessionEvent::SignalingReconnecting`/introduce
   `SessionEvent::Recovering` in `session.rs:33-58`.
2. Populate them at the existing emission sites
   (`session.rs:213, 321`).
3. Surface in the desktop UI (tray tooltip or control window) and the
   mobile badge (`ViewerScreen.tsx`).

### Migration strategy

Additive Rust enum fields (Tauri serializes via `serde`, so the frontend
simply reads new optional fields) — no coordination needed beyond the
frontend TypeScript types picking them up.

### Testing strategy

Manual visual QA identical to Finding 11's.

### Risk assessment

Low.

### Performance impact

None.

### Future extensibility

Feeds naturally into any future in-app diagnostics/telemetry panel.

---

## Finding 13 (polish): Exponential backoff has no jitter

### Current implementation

`session.rs:96-100`:

```rust
fn backoff_delay(attempt: u32) -> Duration {
    let ms = 500u64.saturating_mul(1u64 << attempt.min(6));
    Duration::from_millis(ms.min(8_000))
}
```

Purely deterministic — the same attempt number always produces exactly the
same delay.

### Problems

For a single desktop reconnecting to a single backend, this is harmless
today. But once Finding 3 ships (horizontally scaled signaling, backend
restarts affecting many concurrently-connected sessions at once) and Finding
1 ships (mobile gets its own reconnect loop), a backend restart or brief
regional network event could cause a meaningful fraction of all currently-
connected clients (both desktop and mobile) to begin reconnecting on
_exactly_ the same deterministic schedule, creating synchronized retry
bursts against the recovering backend at t=500ms, t=1.5s, t=3.5s, etc.
across the whole fleet — a classic thundering-herd risk that costs nothing
to avoid now, before it can bite at scale.

### Root cause

The backoff was designed and tested (`session.rs:626-636`) purely for
correctness of a single client's schedule, with no consideration yet of
fleet-wide synchronized retries, since multi-instance/fleet-scale operation
wasn't yet part of the picture when it was written.

### Redesign

Add ±20% random jitter to each computed delay:

```rust
fn backoff_delay(attempt: u32) -> Duration {
    let base_ms = 500u64.saturating_mul(1u64 << attempt.min(6)).min(8_000);
    let jitter_range = (base_ms as f64 * 0.2) as i64;
    let jitter = rand::thread_rng().gen_range(-jitter_range..=jitter_range);
    Duration::from_millis((base_ms as i64 + jitter).max(0) as u64)
}
```

Port the same jitter into the mobile reconnect schedule (Finding 1) and the
shared `@lilypad/protocol` constant table (Finding 6), so all three tiers'
retry schedules avoid synchronization.

### Tradeoffs

Makes the existing deterministic unit test
(`backoff_is_exponential_and_capped`, `session.rs:626-636`) need updating to
assert a _range_ rather than an exact value — trivial, but a real test
change, not purely additive.

### Implementation plan

1. Add jitter to `backoff_delay` in `session.rs`.
2. Update its unit test to assert bounds instead of exact values.
3. Mirror in the mobile reconnect implementation (Finding 1) and the shared
   protocol constant if/when centralized (Finding 6).

### Migration strategy

Trivial, no coordination needed, ship anytime.

### Testing strategy

Updated unit test asserting each delay falls within its expected jittered
range across many samples (seeded RNG for determinism in CI).

### Risk assessment

Very low.

### Performance impact

None meaningful; strictly reduces worst-case synchronized load on a
recovering backend.

### Future extensibility

Standard practice for any future retry logic added to the system going
forward — worth calling out in whatever engineering-conventions doc governs
this codebase.

---

## Finding 14 (polish): Signaling-reconnect failure is a single generic error with no cause classification

### Current implementation

`session.rs:105-123` (`reconnect_signaling`): on exhausting all attempts,
returns a single generic `anyhow::bail!("gave up after {MAX_SIGNALING_RECONNECTS} attempts")`
regardless of _why_ every attempt failed — DNS failure, TCP refused,
TLS handshake failure (once `wss://` is added per the `NOTE` at
`signaling/mod.rs:32`), or an application-level rejection are all
indistinguishable from the caller's point of view; `run_session`'s handling
of this error (`session.rs:251-254`) just formats it into
`SessionEvent::Ended { reason: format!("signaling lost: {e}") }`.

### Problems

Operationally and for user-facing error messaging, "your network is gone"
vs. "the backend is refusing your connection" (e.g. a room that's already
been torn down, or a version-mismatch rejection once one exists) call for
different user guidance ("check your connection" vs. "try re-scanning the
QR code") — today both produce the same generic message.

### Root cause

`connect()` in `signaling/mod.rs:33-36` already collapses the underlying
`tokio_tungstenite` error into a single `anyhow!("signaling connect failed: {e}")`
string, so no structured classification survives past the first layer either.

### Redesign

Introduce a small error enum (`SignalingConnectError::{Network, Rejected,
Timeout}`) at the `signaling::connect` layer, propagate it through
`reconnect_signaling`, and let `SessionEvent::Ended`'s `reason` (or a new
structured field) carry enough information for the UI to show a more
specific, actionable message.

### Tradeoffs

Small increase in error-handling verbosity for a real (if modest) UX
improvement; low cost, low urgency — genuinely a polish-tier item, listed
here for completeness per the "exhaustive, not just critical" instruction.

### Implementation plan

1. Add the error enum to `signaling/mod.rs`.
2. Thread it through `reconnect_signaling` (`session.rs:105-123`).
3. Extend `SessionEvent::Ended`/`Error` with an optional classified reason
   the frontend can branch on for messaging.

### Migration strategy

Additive, no protocol change, no urgency — bundle with any other
`session.rs` change for efficiency rather than shipping standalone.

### Testing strategy

Unit tests asserting each underlying failure mode maps to the expected
enum variant.

### Risk assessment

Very low.

### Performance impact

None.

### Future extensibility

A structured error taxonomy here is a natural foundation for any future
telemetry/analytics on _why_ sessions fail to reconnect, which will matter
for prioritizing future reliability work.

---

## Appendix: Target Reconnect State Machines (Summary)

The individual findings above each specify their piece; this appendix
collects the end-state shape for reference.

**Desktop session runner** (`session.rs`, largely already close to this
shape — findings 5/8/9/10/12 extend it):

```
Idle → Pairing (QR shown) → AwaitingApproval → Active
                                                  │
                    ┌─────────────────────────────┼───────────────────────────┐
                    │                              │                           │
         SignalingReconnecting              Recovering (ICE restart,     SystemWoke
        (backend socket dropped,             token-bucket budget)     (proactive reconnect
         backoff+jitter, resurrect                                    + pipeline restart)
         room via resumption token)                │
                    │                              │
                    └──────────► Active ◄───────────┘
                                    │
                                  Ended (explicit disconnect, budget
                                  exhausted, deadline exceeded, denied)
```

**Mobile viewer connection** (`webrtc.ts`, does not exist today — Findings
1/4/5/11 together construct it):

```
connecting → negotiating → connected
                              │
        ┌─────────────────────┼─────────────────────┬───────────────────┐
        │                     │                      │                   │
 reconnecting_signaling   recovering (ICE       backgrounded (pause    NetInfo regained
 (WS dropped, backoff+    renegotiate request,   sent, encoder idle    (proactive
 jitter, resurrect via     bounded budget)         upstream)            renegotiate)
 resumption token)              │                      │                   │
        │                     │                      │                   │
        └─────────► connected ◄──────────────────────┴───────────────────┘
                        │
                      ended (explicit disconnect, budget exhausted,
                      deadline exceeded, session-end from server)
```

**Backend room** (`hub.ts`/`stateMachine.ts` FSM, extended by Findings 2/3/6/7):

```
idle → pairing → waiting_approval → connecting → negotiating → connected ⇄ paused
                                                                    │
                                    (either seat vacates, established=true)
                                                                    │
                                                       held-with-grace (Redis-backed
                                                       RoomRecord persists across a
                                                       backend restart; grace applies
                                                       per-seat independently, never
                                                       shortcut by the other seat's
                                                       simultaneous vacate — Finding 2)
                                                                    │
                                        ┌───────────────────────────┼───────────────────┐
                                        │                                                │
                          same-deviceId or resumption-token                    grace expired on
                          register reclaims the seat → connected                both seats (or
                                                                                 explicit disconnect)
                                                                                        │
                                                                                    disconnected
```

This is the concrete target shape referenced throughout the findings above;
no single finding needs to re-derive it.
