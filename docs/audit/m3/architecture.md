# Lilypad Architecture Audit — M2→M5 Readiness

**Scope:** desktop session runtime (`apps/desktop/src-tauri`), backend signaling
(`apps/backend/src`), shared protocol (`packages/protocol/src`), mobile viewer
(`apps/mobile/src/lib/webrtc.ts`), and the architecture/design docs.
**Method:** every file in the mandate was read in full; referenced modules
(`media/pipeline.rs`, `media/abr.rs`, `input/{mod,worker,dispatcher,protocol}.rs`,
`rtc/mod.rs`, `os/{mod,windows}.rs`, backend `server.ts`/`index.ts`/`routes/signaling.ts`,
mobile `types.ts`/protocol imports, desktop frontend `App.tsx`/`Bubble.tsx`/`Control.tsx`/`lib/tauri.ts`)
were read to ground every claim in an actual file:line. No claim below describes
code that was not read.
**Non-goal:** no source file was modified. This document is the only artifact
this audit produced.

---

## Executive summary

Lilypad just proved the hard part — H.264 mirrors over a real WebRTC path with
live input — and the code that got it there is honest about its own shortcuts:
comments like "DEV-ONLY (M1) … Removed once M2 lands" (`commands.rs:200`) and
"stub, real implementation lands in M3" (`os/windows.rs:1`) are everywhere,
which is exactly what you want from a team that ships fast without lying to
itself. The debt is concentrated, not diffuse, which is good news for a
production push: two files (`session.rs`, `hub.ts`) own most of the two
programs' actual behavior, and both are shaped as "one function/class that
knows everything" rather than "a small set of collaborating types." Everything
else — the plugin host, the protocol duplication, the polling UI, the Mutex
state, the scattered timeouts — is a second-order symptom of the same root
cause: **the session/room lifecycle has no explicit, typed, testable state
machine on the desktop side, and the one that exists on the backend
(`SessionStateMachine`) is bypassed by half the code that mutates room state.**

Ten findings follow, ranked by production-user impact. The two god-object
findings (F1, F2) are the ones that block everything else in the mandate:
multi-monitor, audio, multi-user sessions, and a browser viewer all need to
add a _dimension_ to session/room state (which display, which peer, which
codec), and today that dimension has nowhere to attach without growing the
already-290-line `select!` loop or the already-401-line `SignalingHub` class
further. Fix F1/F2 first; every future-readiness seam in F10 becomes a small,
local change instead of a rewrite once they're in place.

| #   | Finding                                                                                                                                           | Severity    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| F1  | `run_session` god function conflates transport, WebRTC lifecycle, media, input gating, and reconnect policy                                       | Critical    |
| F2  | `SignalingHub` god class conflates room registry, message routing, FSM, relay, and reaping                                                        | Critical    |
| F3  | Plugin system is ceremonial: 5/8 plugins have no logic; the 3 with logic duplicate objects owned elsewhere                                        | High        |
| F4  | Protocol duplicated by hand between zod (TS) and serde (Rust) with no drift detection                                                             | High        |
| F5  | Desktop UI polls `get_state` on two independent timers instead of consuming the event stream that already exists                                  | Medium-High |
| F6  | `AppState` is a single coarse Mutex mixing immutable config with hot session state; poisoning is silently absorbed                                | Medium      |
| F7  | Timeouts/budgets/window sizes are scattered magic numbers with no central config surface                                                          | Medium      |
| F8  | Error handling is inconsistent across every boundary — anyhow strings crossing into UI, ad hoc string error codes crossing the wire               | Medium-High |
| F9  | Dead/quasi-dead code is still reachable in production builds (`simulate_pair_request`, `WinEncoder::is_supported`)                                | Medium      |
| F10 | No seam exists yet for multi-monitor, audio, clipboard-to-phone, file transfer, Windows/Linux host parity, browser viewer, or multi-user sessions | High        |

---

## F1 — `run_session` god function (`session.rs`)

### Current implementation (cite file:line)

`run_session` (`apps/desktop/src-tauri/src/session.rs:126-415`, 290 lines) is a
single `async fn` that:

- owns the signaling transport handle and its reconnect state machine inline
  (`inbound: Option<UnboundedReceiver<Envelope>>`, `reconnecting: bool`,
  `recon_tx`/`recon_rx` — lines 143-146, reconnect kickoff at 205-226, recon
  arm at 242-257);
- owns WebRTC peer lifecycle (`peer: Option<Arc<WebRtcPeer>>` at 151, mutated
  from `handle_inbound` on `session-start`/`answer`/`ice-candidate` at
  528-565, and from the `pev` arm on `ConnectionState`/ICE-restart at
  283-338);
- owns the media pipeline and ABR controller (`pipeline`, `abr` at 152-154,
  started inline inside the `pev` arm at 286-301, fed RTCP feedback inline at
  350-372);
- owns the input gate (`input.set_enabled(...)` called from four different
  branches: 235, 307, 341, 345, 400);
- owns three independent timeout/budget policies: ICE-restart budget
  (`MAX_ICE_RESTARTS`, 72; consumed 313-333), signaling reconnect budget
  (`MAX_SIGNALING_RECONNECTS`, 75; consumed in `reconnect_signaling`,
  105-123), and pairing-abandonment timeout (`pairing_timeout()`, 86-94;
  consumed 182-186);
- runs all of the above through one seven-armed `tokio::select!` (180-395)
  where the `pev` arm alone (283-382, 100 lines) contains connection-state
  transition logic, media-pipeline bring-up, ICE-restart policy, and ABR
  wiring, all as sequential `if`/`match` inside one match arm.

Two free functions, `handle_inbound` (511-584) and `handle_peer_event`
(586-620), are extracted, but they take 5-6 parameters each (`env`, `room_id`,
`sig`, `events`, `peer_ev_tx`, `peer` for the first) and still return control
flow (`Ok(true)` means "terminate the session") back into the `select!`
body — they are not independent units, they are the same function split at
the file level for readability, not decomposed by responsibility.

### Problems

1. **Untestable end-to-end behavior.** There is exactly one test in this file
   (`backoff_is_exponential_and_capped`, 626-636) and it tests a pure
   function, not the loop. None of the actual product-critical behavior —
   "ICE restart budget exhausted → session ends", "media pipeline dies →
   input is disabled before the Ended event fires", "signaling drops after
   peer connects → reconnect happens in the background without stalling
   Disconnect" — has a test, because none of it is reachable except by
   driving a real `tokio::select!` loop with a real WebRTC peer and a real
   TCP socket. The header comment even says the crate is "transport-and-UI-
   agnostic" (line 5), but nothing about the current shape lets you assert
   that in a unit test.
2. **Every future feature must edit this function.** Multi-monitor needs a
   second pipeline; audio needs a second track; multi-user needs a
   collection of peers instead of `Option<Arc<WebRtcPeer>>`. Each of these
   touches the `pev` arm, the teardown block (398-414), and `handle_inbound`
   simultaneously, because none of those concerns has a boundary.
3. **Silent coupling between unrelated concerns via shared mutable locals.**
   `peer_connected` and `input_channel_open` (162-163) are two booleans that
   gate `input.set_enabled(...)`, updated from four different call sites
   scattered across two match arms (302-307, 339-346). It is only correct
   today because every call site was updated in lock-step by the same person
   in the same PR; a future contributor adding, say, a "paused" media state
   has no compiler-enforced way to know they must also touch this gate.
4. **Reconnect-in-flight bookkeeping is manual and easy to get wrong.** The
   `inbound = None` / `reconnecting` / `recon_tx` triad (143-146, 205-226,
   242-257) exists purely so the `select!` doesn't poll a dead receiver and
   doesn't fire the background-reconnect task twice — this is exactly what a
   dedicated type with an internal state enum would give you for free.

### Root cause

There is no explicit `SessionFsm`. Desktop-side session state is implicit in
the _combination_ of five separate mutable locals (`peer`, `pipeline`, `abr`,
`peer_connected`, `input_channel_open`, `ice_restarts`, `recovery_deadline`,
`paired`, `reconnecting`) rather than a single typed value with declared valid
transitions — exactly the shape the backend already got right with
`SessionStateMachine` (`apps/backend/src/session/stateMachine.ts`). The
desktop reimplements the same lifecycle (idle → pairing → awaiting-approval →
negotiating → connected → recovering → ended) but does it as boolean soup
instead of a state machine, so nothing enforces that transitions are legal or
observable independent of the transport that drives them.

### Redesign

Decompose into five collaborating units, each in its own module, communicating
by message-passing (channels/events) rather than shared mutable locals. The
orchestrator (`run_session`, kept but shrunk to ~60 lines) owns instances of
each and merges their events in one `select!` with one arm per unit instead of
one arm per raw transport:

```rust
// session/fsm.rs — pure, no I/O, fully unit-testable like stateMachine.ts
pub enum SessionState {
    Registered, Pairing, AwaitingApproval, Negotiating,
    Connected, Recovering { ice_restarts: u32, deadline: Instant },
    Ended(String),
}
pub enum FsmEvent {
    PairRequested { device_name: Option<String>, scopes: Vec<String> },
    Approved(Vec<String>), Denied,
    PeerConnectionState(String), IceRestartFailed(String),
    RecoveryTimedOut, MediaFailed(String), SignalingLost(String),
    Disconnect,
}
pub struct SessionFsm { state: SessionState }
impl SessionFsm {
    /// Pure transition: returns the SessionEvents to emit + the side effects
    /// the orchestrator must perform (SendOffer, StartMedia, CloseAll, ...).
    /// No IO, no locks — this is the thing that gets a stateMachine.test.ts-
    /// style unit test suite.
    pub fn apply(&mut self, ev: FsmEvent) -> (Vec<SessionEvent>, Vec<Effect>) { ... }
}

// signaling/client.rs — owns the transport + reconnect policy as ONE unit
pub struct SignalingClient { /* handle, inbound-or-reconnecting, ReconnectPolicy */ }
pub enum SignalingClientEvent { Message(Envelope), Reconnecting, Reconnected, Lost(anyhow::Error) }
impl SignalingClient {
    pub async fn connect(url: &str, room_id: &str, device_id: &str) -> Result<Self>;
    pub fn send(&self, env: Envelope) -> Result<()>;
    /// Single async fn the orchestrator selects on — absorbs the
    /// inbound/recon_rx/reconnecting bookkeeping entirely internally.
    pub async fn next_event(&mut self) -> SignalingClientEvent;
}

// session/reconnect.rs — the policy SignalingClient composes
pub struct ReconnectPolicy { max_attempts: u32 }
impl ReconnectPolicy {
    pub fn backoff(&self, attempt: u32) -> Duration; // = today's backoff_delay
    pub async fn reconnect(&self, url: &str, room_id: &str, device_id: &str)
        -> Result<(SignalingHandle, UnboundedReceiver<Envelope>)>;
}

// session/media_controller.rs
pub struct MediaController { pipeline: Option<MediaPipeline>, abr: Option<BitrateController> }
impl MediaController {
    pub async fn start(&mut self, peer: Arc<WebRtcPeer>) -> Result<()>; // = start_media_pipeline
    pub fn on_loss_report(&mut self, fraction_lost: f64);
    pub fn on_remb(&mut self, bitrate_bps: u64);
    pub fn request_keyframe(&self);
    pub async fn poll_failure(&mut self) -> Option<String>; // one select! arm
    pub async fn stop(self);
}

// input/gate.rs (thin wrapper the orchestrator owns instead of raw booleans)
pub struct InputGate { worker: InputWorker, connected: bool, channel_open: bool }
impl InputGate {
    pub fn set_peer_connected(&mut self, v: bool) { self.connected = v; self.recompute(); }
    pub fn set_channel_open(&mut self, v: bool) { self.channel_open = v; self.recompute(); }
    fn recompute(&mut self) { self.worker.set_enabled(self.connected && self.channel_open); }
    pub fn handle_message(&self, bytes: Vec<u8>) { self.worker.handle_message(bytes); }
    pub fn disable(&mut self) { self.connected = false; self.channel_open = false; self.recompute(); }
}
```

`run_session` becomes:

```rust
pub async fn run_session(...) -> Result<()> {
    let mut fsm = SessionFsm::new();
    let mut sig = SignalingClient::connect(&signaling_url, &room_id, &device_id).await?;
    let mut media = MediaController::new();
    let mut gate = InputGate::new();
    let mut peer: Option<Arc<WebRtcPeer>> = None;
    loop {
        tokio::select! {
            ev = sig.next_event() => dispatch(&mut fsm, &mut peer, &sig, ev),
            fail = media.poll_failure() => apply(&mut fsm, FsmEvent::MediaFailed(fail)),
            ctrl = control_rx.recv() => apply(&mut fsm, ctrl.into()),
            pev = peer_ev_rx.recv() => handle_peer_event(&mut fsm, &mut media, &mut gate, pev),
            _ = heartbeat.tick() => sig.send(Envelope::heartbeat(&room_id))?,
        }
        if fsm.is_ended() { break; }
    }
    media.stop().await;
    if let Some(p) = peer { p.close().await?; }
    Ok(())
}
```

Every `Effect` the FSM returns (SendOffer, StartMedia(peer), CloseGate,
EmitEvent) is executed by tiny 3-5 line handler functions, not inlined into
the `select!` arm.

### Tradeoffs

More files and more indirection for a single-session, single-peer today.
`Arc<WebRtcPeer>` passing between `MediaController` and the orchestrator adds
a small amount of ceremony (an extra clone) versus the current directly-owned
`Option<Arc<WebRtcPeer>>`. The FSM's `Effect` return type needs care to avoid
becoming its own kind of untyped grab-bag — keep it a closed enum, not a
`Box<dyn Fn>`.

### Implementation plan

1. Extract `session/fsm.rs` first, in isolation, with the state enum listed
   above and a full unit test suite mirroring `stateMachine.test.ts`'s style
   (transitions table + illegal-transition rejection). This has zero runtime
   risk since it's not wired to anything yet.
2. Extract `SignalingClient` (wraps `signaling::connect` + `reconnect_signaling`
   - the `inbound`/`recon_rx`/`reconnecting` triad) with unit tests using a
     fake WebSocket (the existing `signaling::connect` already isolates the
     transport, so this is mostly relocation).
3. Extract `MediaController` (wraps `start_media_pipeline` verbatim plus the
   two RTCP-feedback match arms).
4. Extract `InputGate` (thin, low-risk).
5. Rewire `run_session` to use all four, delegating to `SessionFsm::apply`
   for every decision that currently lives inline in the `select!` arms.
6. Delete the now-dead `handle_inbound`/`handle_peer_event` free functions
   once their logic has moved into FSM effects + the four units above.

### Migration strategy

Land steps 1-4 as additive modules with no behavior change (they're extracted
1:1 from existing code, tested against the SAME expected behavior via the
existing integration path: `apps/desktop/src-tauri/examples/headless_offer.rs`
and `apps/desktop/src-tauri/tests/`). Land step 5 behind the existing
`run_session` public signature so `commands.rs` needs zero changes. Land step
6 only after a full pairing→approve→stream→disconnect manual run confirms
parity (this repo already has a working manual E2E path per the mandate's own
description — use it as the acceptance gate, not just `cargo test`).

### Testing strategy

- `SessionFsm`: table-driven unit tests, one per legal/illegal transition,
  exactly like `stateMachine.test.ts` does for the backend today (that file
  is a template to copy).
- `SignalingClient`: unit tests against a fake `Peer`/socket verifying the
  `inbound = None` → background reconnect → `Some` cycle without a real
  network socket.
- `MediaController`: the existing pipeline tests already isolate this; add
  one test that a `TrySendError::Closed`-style failure produces exactly one
  `MediaFailed` event, not zero and not two.
- `InputGate`: a pure struct test — assert `recompute()` matches the boolean
  table (connected×open → enabled) with no real `InputWorker`.
- Integration: keep (or add, if absent) one end-to-end test that drives the
  full `run_session` through pair→approve→connect→ICE-restart→disconnect
  using the existing `MockPeer`/synthetic-capture dev hooks
  (`LILYPAD_CAPTURE_KIND=synthetic`, session.rs:425) so regressions in the
  decomposition are caught before merge.

### Risk assessment

Medium. The function currently works and has shipped a real session; a bad
extraction that changes ordering (e.g., disabling input before vs. after
sending the `Ended` event) could reintroduce the exact safety bug the H5
comment at line 141 warns about. Mitigate by doing the extraction in the
order above (pure logic first, IO-touching pieces last) and gating each step
on the manual E2E smoke test, not just `cargo test`.

### Performance impact

Neutral to slightly positive. The extra layer of indirection (a few more
`Arc`/channel sends) is negligible next to WebRTC/media I/O latency budgets
(the docs target <60ms glass-to-glass, `technical-design.md:81`). The real
win is fewer `Instant::now()`/timeout comparisons duplicated across call
sites once `Recovering { deadline }` lives in one place instead of the
separate `ice_restarts`/`recovery_deadline` locals (166-171).

### Future extensibility

This is the prerequisite for F10's multi-monitor/audio/multi-user seams:
`MediaController` becomes `Vec<MediaController>` keyed by display id without
touching the FSM; `peer: Option<Arc<WebRtcPeer>>` becomes `PeerPool` without
touching `MediaController`; a browser viewer or a second simultaneous mobile
viewer becomes "another `SignalingClient` + FSM instance" the orchestrator
manages, instead of a rewrite of a 290-line function.

---

## F2 — `SignalingHub` god class (`hub.ts`)

### Current implementation (cite file:line)

`SignalingHub` (`apps/backend/src/signaling/hub.ts:84-484`, ~400 lines) is one
class that owns:

- the room registry itself (`rooms: Map<string, Room>`, 85; `ctx: Map<Peer,
PeerCtx>`, 86) including capacity enforcement (`maxRooms`, 90, 103,
  255-261);
- per-peer message validation and anti-spoof checks (`handleMessage`,
  125-161: zod parse, then `msg.from !== existing.role` at 145, then
  `msg.roomId !== existing.roomId` at 149);
- the entire message-type routing table as one 16-case `switch` (`dispatch`,
  303-380) that inline-mixes FSM transitions (`room.fsm.tryTransition(...)`
  at 319, 337, 344, 356, 361, 366), relay (`this.relay(...)`), and business
  rules (`requireRole`, 415-421) in the same case bodies;
- session-approval side effects (`approve`, 382-413: mints a session id,
  calls the persistence hook, builds per-peer ICE credentials, sends
  `session-start`);
- seat lifecycle / reconnection-grace policy (`handleClose`, 167-192;
  `register`'s `vacated`/`seat_reserved` handling, 281-296);
- staleness reaping for both peers and rooms (`reapStale`, 196-231) — two
  independent sweep loops (grace-cutoff sweep 202-214, heartbeat-cutoff sweep
  217-230) that both mutate the same `rooms` map inside the same method;
- graceful shutdown (`shutdownAll`, 236-240);
- operational metrics counters (`counters`, 92-97; `metricsSnapshot`,
  108-116), incremented from inside `register`, `approve`, `endRoom`,
  `reapStale` — i.e. from five different unrelated methods.

`Room` itself (52-68) is not a class with invariants — it's a plain object
literal built inline in `register` (263-273) and mutated directly from six
different methods (`register`, `dispatch`, `approve`, `handleClose`,
`reapStale`, `endRoom`) with no accessor enforcing e.g. "you can't set
`established = true` without a mobile peer present."

### Problems

1. **One class change-set touches every session concern.** Adding a new
   message type (e.g. a future `file-transfer-offer`) requires editing
   `dispatch`'s switch, possibly `Room`'s shape, and possibly the FSM's
   transition table — all inside the same 400-line file, with no compiler
   boundary stopping an unrelated change from breaking reaping or metrics.
2. **The FSM is invoked as a side effect buried in routing, not as the
   authority.** `room.fsm.tryTransition('negotiating')` (337) is a bare
   statement inside a switch case that also does relay — the _return value_
   of `tryTransition` (a bool) is discarded in every call site inside
   `dispatch` (319, 337, 344, 356, 361, 366), meaning an illegal transition
   (e.g. an `answer` arriving in a state where `negotiating→connected` isn't
   legal) is silently ignored rather than surfaced as a protocol error. The
   FSM exists (`stateMachine.ts`) specifically to reject illegal moves
   (`InvalidTransitionError`, stateMachine.ts:42-50), but the hub throws that
   safety away by calling `tryTransition` instead of `transition` and never
   checking the result.
3. **`Room` has no encapsulation**, so `vacatedAt`/`lastSeen`/`established`
   invariants (e.g. "a role can't be both vacated and currently seated") are
   enforced only by every call site being careful, the same failure mode as
   F1's shared-locals problem, just in TypeScript instead of Rust.
4. **Testing requires standing up the whole class.** `pairing.test.ts` and
   the hub's own tests (not read in full here but implied by the file
   structure) must exercise `handleMessage` end-to-end to test what should be
   a pure routing decision — "given room state X and message Y, what's the
   relay target and FSM transition" is a pure function buried inside a class
   that also does socket-adjacent I/O (`peer.send`, `peer.close`).

### Root cause

No aggregate boundary between "data about a room" (`Room`), "what a message
means for a room" (routing/FSM), and "when a room should die" (lifecycle
policy). All three live as methods on one class that also happens to be the
thing Fastify's route handler talks to (`routes/signaling.ts:26`
`new SignalingHub({...})`), so the class had to grow an API surface for
transport wiring _and_ stayed the place where the actual domain logic lives.

### Redesign

Split into four collaborators plus a thin orchestrator, following the DDD
shape the mandate asks for (aggregate + registry + router + policy):

```typescript
// signaling/room.ts — the aggregate; owns its own invariants
export class Room {
  private constructor(
    public readonly id: string,
    private readonly fsm: SessionStateMachine,
    private peers: Partial<Record<DeviceKind, Peer>> = {},
    private deviceIds: Partial<Record<DeviceKind, string>> = {},
    private lastSeen: Partial<Record<DeviceKind, number>> = {},
    private vacatedAt: Partial<Record<DeviceKind, number>> = {},
    public scopes: SessionScope[] = ['view'],
    public sessionId?: string,
    private establishedFlag = false,
  ) {}
  static create(id: string, onStateChange: TransitionListener): Room { ... }

  seat(role: DeviceKind): Peer | undefined { return this.peers[role]; }
  isEstablished(): boolean { return this.establishedFlag; }
  markEstablished(): void { this.establishedFlag = true; }
  register(role: DeviceKind, peer: Peer, deviceId: string, now: number):
    { ok: true } | { ok: false; reason: 'seat_taken' | 'seat_reserved' } { ... }
  vacate(role: DeviceKind, now: number): void { ... }
  reclaim(role: DeviceKind): void { ... }
  bumpLastSeen(role: DeviceKind, now: number): void { ... }
  isVacatedPastGrace(role: DeviceKind, cutoff: number): boolean { ... }
  isHeartbeatStale(role: DeviceKind, cutoff: number): boolean { ... }
  otherRole(role: DeviceKind): DeviceKind { return role === 'desktop' ? 'mobile' : 'desktop'; }
  /** Transition or return the rejection — callers MUST handle both. */
  tryFsm(to: SessionState): boolean { return this.fsm.tryTransition(to); }
  fsmState(): SessionState { return this.fsm.state; }
}

// signaling/roomRegistry.ts — owns the Map + capacity policy only
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  constructor(private readonly maxRooms: number) {}
  getOrCreate(id: string, onStateChange: TransitionListener):
    { room: Room } | { rejected: 'capacity' } { ... }
  get(id: string): Room | undefined { return this.rooms.get(id); }
  remove(id: string): void { this.rooms.delete(id); }
  all(): Room[] { return [...this.rooms.values()]; }
  get size(): number { return this.rooms.size; }
}

// signaling/messageRouter.ts — PURE decision logic, no I/O
export type RouteAction =
  | { kind: 'relay'; to: DeviceKind; msg: SignalingMessage }
  | { kind: 'approve'; grantedScopes: SessionScope[] }
  | { kind: 'end'; reason: string }
  | { kind: 'reject'; code: string; message: string }
  | { kind: 'noop' };
export class MessageRouter {
  route(room: Room, from: DeviceKind, msg: SignalingMessage): RouteAction { ... }
  // Every branch that today calls room.fsm.tryTransition and discards the
  // bool instead returns { kind: 'reject', code: 'invalid_transition', ... }
  // when tryFsm() returns false — the safety the FSM already provides stops
  // being silently thrown away.
}

// signaling/lifecyclePolicy.ts — reaping + shutdown only
export class LifecyclePolicy {
  constructor(
    private readonly registry: RoomRegistry,
    private readonly heartbeatTimeoutMs: number,
    private readonly reregisterGraceMs: number,
    private readonly now: () => number,
  ) {}
  reapStale(onReap: (room: Room, role: DeviceKind) => void): void { ... }
  shutdownAll(onEnd: (room: Room) => void): void { ... }
}

// signaling/hub.ts — thin orchestrator wiring the four above to Peer I/O + counters
export class SignalingHub {
  constructor(
    private readonly registry: RoomRegistry,
    private readonly router: MessageRouter,
    private readonly lifecycle: LifecyclePolicy,
    private readonly deps: SignalingHubDeps,
  ) {}
  handleMessage(peer: Peer, raw: unknown): void {
    // parse, look up room via registry, get RouteAction from router,
    // execute it (peer.send / this.approve / this.endRoom) — ~40 lines.
  }
  // handleClose/reapStale/shutdownAll delegate straight to lifecycle+registry.
}
```

### Tradeoffs

More files/indirection for a domain that today is genuinely small (two
seats, one FSM). The `RouteAction` pattern adds an allocation per message
(a small object instead of direct calls) — irrelevant at signaling-message
volumes (a handful of messages per session, not per frame). The main real
cost is discipline: `MessageRouter` must stay pure (no `Peer.send` calls
inside it) or the whole point of testing it as pure logic is lost.

### Implementation plan

1. Extract `Room` as a class with the exact same field shape, add unit tests
   for `register`/`vacate`/`reclaim`/`isVacatedPastGrace` in isolation
   (currently only reachable through the hub).
2. Extract `RoomRegistry`, moving `maxRooms`/capacity-rejection logic
   verbatim from `register` (255-261).
3. Extract `MessageRouter.route`, one branch per existing `switch` case in
   `dispatch` (303-380), changing every `tryTransition` call site to check
   the returned bool and emit `{ kind: 'reject', code: 'invalid_transition' }`
   on failure instead of silently continuing.
4. Extract `LifecyclePolicy`, moving `reapStale`'s two sweeps (196-231) and
   `shutdownAll` (236-240) verbatim.
5. Rewrite `SignalingHub` as the thin orchestrator above; `routes/signaling.ts`
   needs zero changes (same public API: `handleMessage`, `handleClose`,
   `reapStale`, `shutdownAll`, `metricsSnapshot`, `isRegistered`, `roomCount`).

### Migration strategy

This is the highest-value, lowest-risk refactor in the whole audit: the
class's public API (used by `routes/signaling.ts:26-59`) doesn't need to
change at all, so it can land as an internal-only PR verified by the existing
hub test suite plus the new unit tests from steps 1-4, with zero risk to the
route layer or the wire protocol. Land steps 1-2 together (pure data +
registry), then step 3 (the highest-value one — it turns a silent-failure bug
into a visible `error` frame to the client), then step 4, then step 5.

### Testing strategy

- `Room`: unit tests for every state transition of seat lifecycle
  (`register` → `vacate` → `reclaim` with wrong device id rejected, etc.) —
  currently these paths are only exercised indirectly.
- `MessageRouter`: table-driven tests, one per message type × room-state
  combination, asserting the exact `RouteAction` returned — this is where
  "an `answer` arrives while the room is still `idle`" gets a first-class
  regression test instead of silently no-op'ing.
- `LifecyclePolicy`: fake clock (`now: () => number`, already injectable per
  `SignalingHubDeps.now?`, hub.ts:35) driving grace/heartbeat cutoffs without
  real timers.
- Regression: keep the existing hub-level integration tests running
  unmodified against the new orchestrator to prove the public behavior is
  bit-identical before deleting the old implementation.

### Risk assessment

Low, specifically because the public API is unchanged and the domain is
small and already well-covered by `SignalingHubDeps`' dependency-injection
seams (`now`, `heartbeatTimeoutMs`, etc., hub.ts:22-44). The one behavior
change worth calling out explicitly to reviewers: turning discarded
`tryTransition` failures into rejected messages is a **protocol-visible
change** (a peer that used to have its illegal message silently ignored will
now receive an `error` frame) — flag this in the PR description and check
whether any client code currently relies on the silent-ignore behavior
(a grep of `apps/mobile` and `apps/desktop` for handling of unexpected
`error` frames is a 10-minute check before merging step 3).

### Performance impact

Neutral. Same number of Map lookups; the `RouteAction` object is a small
short-lived allocation per message at a rate of single-digit messages per
session lifecycle, not per video frame.

### Future extensibility

`Room.peers` and `Room.deviceIds` are currently `Partial<Record<DeviceKind,
X>>` — i.e. hard-coded to exactly one desktop + one mobile. Multi-user
sessions (F10) need `mobile` to become a collection; doing that inside the
new `Room` class is a contained, testable change. Doing it inside today's
`SignalingHub` means touching `dispatch`'s 16-case switch, `handleClose`,
`reapStale`, and `endRoom` simultaneously.

---

## F3 — Ceremonial plugin system

### Current implementation (cite file:line)

The `Plugin` trait (`plugins/mod.rs:72-80`) and `PluginHost` (83-143) define
a uniform `initialize`/`start`/`stop`/`health_check` lifecycle. Of the eight
registered plugins (`with_default_plugins`, 94-104):

- **Five have zero real logic.** `AuditLogPlugin` (`audit_log.rs`),
  `ClipboardPlugin` (`clipboard.rs`), `DevShortcutsPlugin`
  (`dev_shortcuts.rs`), `QrPairingPlugin` (`qr_pairing.rs`), and
  `WebRtcTransportPlugin` (`webrtc_transport.rs`) each follow the identical
  pattern: `initialize` sets `self.ready = true` and returns `Ok(())`
  (e.g. `dev_shortcuts.rs:21-24`), `start`/`stop` are no-ops, and
  `health_check` returns `HealthStatus::Ok` iff `ready` — which is always
  true after `initialize_all` runs once at boot (`lib.rs:118`). These five
  can never report anything but "ok" for the lifetime of the process; they
  exist purely to appear in the `plugin_health` debug map
  (`state.rs:61-62`, rendered in `Control.tsx:73-86`).
- **Two duplicate a real backend just to poll its permission status.**
  `ScreenCapturePlugin` (`screen_capture.rs:11-21`) constructs its own
  `Box<dyn CaptureBackend>` via `create_capture(CaptureKind::ScreenCaptureKit,
...)` (line 19) solely so `health_check` (44-51) can call
  `self.backend.permission_status()` — a second, entirely separate
  `CaptureBackend` instance from the one `MediaPipeline::start` builds per
  session (`media/pipeline.rs:72`). Same pattern in
  `InputInjectionPlugin` (`input_injection.rs:11-17`,
  `create_input_backend()`) versus the real one `InputWorker::spawn`
  builds (`input/worker.rs:38`).
- **One eagerly builds and discards a real hardware object at every app
  launch.** `EncoderPlugin::new()` (`encoder.rs:15-31`) calls
  `create_encoder(kind, EncoderSettings::default())` (line 22) — on macOS
  this is a real VideoToolbox compression session (per the pipeline's own
  comment describing VideoToolbox session build as a "100ms+ blocking XPC
  round-trip", `session.rs:483-484`) — purely to check "did it build", then
  the `enc` value is discarded (line 23, only `enc.name()` is kept) and the
  session presumably torn down on drop. This runs unconditionally at every
  app boot (`lib.rs:112-118`, before any pairing or session exists), adding
  real startup latency and hardware churn for a health check nothing acts on
  automatically.
- **`EncoderPlugin`'s health never updates after boot.** Unlike the two
  "live" plugins above, `EncoderPlugin::health_check` (52-54) just returns
  `self.health.clone()` — a value frozen at construction (line 26). If the
  real session pipeline's encoder later fails mid-stream (the exact failure
  path `MediaPipeline`'s encode-error branch handles at
  `media/pipeline.rs:175-182` by resetting the encoder), the debug overlay
  the user is looking at (polled every 800ms, `Control.tsx:29`) still says
  "ok" — the one plugin whose job is arguably most safety-relevant is the
  one whose health is a lie after the first frame.

### Problems

1. Five of eight plugins are dead weight: they cannot fail, so their
   presence in the debug overlay is misleading (a user or on-call engineer
   scanning `plugin_health` sees 8 "ok" rows and has no way to tell which 3
   are meaningful).
2. Two plugins double the number of live OS-permission-querying backend
   objects for no functional reason, adding memory/object churn and — more
   importantly — a second place a permission-check bug could diverge from
   the real one the session actually uses.
3. One plugin (`EncoderPlugin`) does real, non-trivial, possibly
   user-visible-latency work (spin up hardware encoder) at every app launch,
   for a value that is then thrown away and never refreshed — the worst
   combination of "costs something" and "tells you nothing after boot."
4. The trait shape (`initialize`/`start`/`stop`/`health_check`) is a good
   idea for the _actual_ per-OS backends (`CaptureBackend`, `InputBackend`,
   `EncoderBackend` already have their own, better, per-capability traits —
   `media/capture/mod.rs`, `input/mod.rs:66-83`, `os/mod.rs:18-24`) but the
   `Plugin` layer on top is a second, parallel lifecycle abstraction that
   doesn't compose with those — it wraps them, badly, instead of being them.

### Root cause

The plugin host was designed before the real capture/encode/input
abstractions existed (`plugins/mod.rs:7-9`: "Capture / Encoder /
InputInjection delegate to per-OS backends... Real backends land in
M3/M4; today they are stubs that report Down" — a comment that is now stale,
since M3/M4 shipped real backends that live in `crate::media` and
`crate::input`, not in `plugins/`). Nobody went back and either deleted the
now-redundant plugin wrappers or made them the actual owners.

### Redesign

Two moves, not one:

1. **Delete the five ceremonial plugins outright.** `AuditLogPlugin`'s one
   real method (`record`, `audit_log.rs:14-16`) is a pure logging helper —
   turn it into a free function `crate::audit::record(event, detail)` used
   directly from `commands.rs`'s existing `log::info!(target:
"lilypad::audit", ...)` call sites (which already do the same thing
   inline, e.g. `commands.rs:124,211,221,235,243,251`), removing a redundant
   struct entirely. `ClipboardPlugin`/`DevShortcutsPlugin`/
   `QrPairingPlugin`/`WebRtcTransportPlugin` have no state or behavior worth
   keeping at all — their "capability advertised" role is better served by a
   static `capabilities()` list (see below) than a runtime object.
2. **Replace `ScreenCapturePlugin`/`InputInjectionPlugin`/`EncoderPlugin`
   with pure, stateless health queries against a shared, already-live
   status source** — not a second owned backend instance:

```rust
// permission.rs — extend with free functions, no owned backend needed
pub fn screen_capture_status() -> PermissionStatus { /* query OS directly, cheap */ }
pub fn accessibility_status() -> PermissionStatus { /* query OS directly, cheap */ }

// A capability descriptor replaces "Plugin" for the 5 ceremonial ones —
// no lifecycle, no instance, just metadata for the debug UI:
pub struct Capability { pub name: &'static str, pub permissions: &'static [Permission] }
pub const CAPABILITIES: &[Capability] = &[
    Capability { name: "Clipboard", permissions: &[Permission::Clipboard] },
    Capability { name: "DevShortcuts", permissions: &[Permission::InputInjection] },
    // ...
];

// health.rs — the ONLY place that reports live health, backed by the
// SAME status calls the real session pipeline/input worker use, not a
// second owned instance:
pub fn plugin_health() -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    m.insert("ScreenCapture".into(), screen_capture_status().label());
    m.insert("Accessibility".into(), accessibility_status().label());
    // Encoder: report the LIVE pipeline's status if a session is active,
    // "not yet tested this run" otherwise — never a frozen boot-time value.
    m.insert("Encoder".into(), current_session_encoder_health());
    m
}
```

If a uniform trait is still wanted for M5+ (e.g. a future audio or
clipboard-sync capability that really does need init/start/stop, like a
background clipboard-watcher thread), keep `Plugin` for _those_ — capabilities
that have genuine state and lifecycle — and stop using it as a facade for
things that don't.

### Tradeoffs

Losing the uniform `PluginHost::health()` aggregation model means the debug
overlay's data source becomes a hand-assembled map instead of "iterate all
registered plugins" — slightly less "framework," but the framework wasn't
buying anything since 5/8 members never varied. If M5+ genuinely needs
several independent, stateful, restartable background capabilities (e.g.
clipboard watcher + audio capture + a future telemetry uploader), reintroduce
`Plugin` at that point for those specific three, sized to what actually needs
a lifecycle.

### Implementation plan

1. Delete `AuditLogPlugin`, `ClipboardPlugin`, `DevShortcutsPlugin`,
   `QrPairingPlugin`, `WebRtcTransportPlugin` and their registrations
   (`plugins/mod.rs:96,101-103`).
2. Add `permission::screen_capture_status()` /
   `permission::accessibility_status()` as thin wrappers over what
   `create_capture(...).permission_status()` /
   `create_input_backend().permission_status()` do today, but callable
   without constructing a full backend (may require pushing the OS-query
   logic down one level in `media/capture/screencapturekit.rs` /
   `input/macos.rs` if it's currently only reachable through a constructed
   instance — verify during implementation).
3. Replace `ScreenCapturePlugin`/`InputInjectionPlugin`/`EncoderPlugin` with
   the `health.rs` free-function module above; wire `AppState::host` field
   (`state.rs:35`) to call it instead of `PluginHost::health()`.
4. Delete `PluginHost`/`Plugin`/`PluginContext` if nothing else needs the
   generic lifecycle after step 3 (re-evaluate — `EncoderPlugin`-equivalent
   _may_ still want a live per-session query hook once `MediaController`
   from F1 exists, which is a natural place to expose "current encoder
   health" without polling).

### Migration strategy

Land behind the same `AppStateDto.plugin_health` field shape
(`state.rs:56-63`) so `Control.tsx:73-86` needs no changes. This is a
pure internal refactor with a stable external contract (the debug map);
verify by comparing the map's keys/values before and after on a real run.

### Testing strategy

Unit test the new free functions against the same permission-status enum
(`PermissionStatus`, `permission.rs:7-12`) the old plugins used — behavior
should be identical, just without the redundant owned instance. No existing
test suite appears to cover the plugin host directly (none of the plugin
files above `#[cfg(test)]` blocks), so this is a net testing improvement, not
a regression risk.

### Risk assessment

Low. Nothing in the session runner (`session.rs`) or WebRTC path depends on
`PluginHost`; it is purely a debug-overlay data source (`commands.rs:75`,
`state.rs:61-62`). Worst case of a mistake here is a wrong label in the
Control window's debug panel, not a functional regression.

### Performance impact

Positive: removes one full `VideoToolbox` (or software encoder) session
build-and-discard at every app launch (`encoder.rs:22`), and removes two
redundant `CaptureBackend`/`InputBackend` instances that exist only to be
polled, each of which may hold OS handles.

### Future extensibility

This directly clears the way for F10's Windows/Linux parity work: today,
each per-OS stub (`os/windows.rs`) reports fake health data ("is_supported:
true" while `start()` always errors, see F9) through a plugin wrapper that
adds a layer of indirection between "is this OS capability real" and "what
does the UI show." A flat `health.rs` free-function module makes it obvious,
per platform, exactly which capability queries are real today and which
return `NotApplicable`/stub values — the honest inventory a porting effort
needs.

---

## F4 — Protocol duplicated by hand across languages

### Current implementation (cite file:line)

`@lilypad/protocol` (`packages/protocol/src/{signaling,pairing,input,qr,constants}.ts`)
is the canonical, zod-validated definition of every wire shape, and it is
genuinely shared correctly by the backend and the mobile app — mobile's
`package.json` depends on `@lilypad/protocol: workspace:*` and imports it
directly (`apps/mobile/src/lib/webrtc.ts:8-13`, `signaling.ts`, `input.ts`,
`types.ts:1`). That half of the "single source of truth" story is real and
working.

The desktop, being Rust, cannot import the zod package, so it re-implements
the same shapes by hand:

- `apps/desktop/src-tauri/src/signaling/messages.rs` mirrors
  `packages/protocol/src/signaling.ts`'s `SignalingMessageSchema`
  (`signaling.ts:168-186`) but as a loose `Envelope { msg_type: String, ...,
payload: serde_json::Value }` (`messages.rs:17-26`) plus separately-typed
  inbound payload structs (`PairRequestPayload`, `SessionStartPayload`,
  `SdpPayload`, `IceCandidatePayload`, 90-148) and hand-built outbound JSON
  via `serde_json::json!{...}` macros (`register`, 40-46; `offer`, 57-63;
  `ice_candidate`, 64-79). Nothing ties the `json!` shape at `messages.rs:61`
  (`{"type": "offer", "sdp": sdp}`) to the `SdpSchema` it must match
  (`signaling.ts:28-31`) except the module-doc comment "mirroring
  `@lilypad/protocol` signaling" (`messages.rs:1`) and the six hand-written
  shape-assertion tests at the bottom of the file (150-225).
- `apps/desktop/src-tauri/src/input/protocol.rs` mirrors
  `packages/protocol/src/input.ts`'s `InputEventSchema`
  (`input.ts:111-123`) as a hand-written `#[serde(tag = "kind")]` enum
  (`protocol.rs:53-117`), whose own doc comment admits the coupling is
  informal: "Field names and defaults match exactly so the wire format never
  drifts between the mobile sender and this decoder" (`protocol.rs:1-4`) —
  a comment, not a compiler check.

### Problems

1. **A schema change in TypeScript is invisible to Rust until runtime.**
   Adding a required field to, say, `IceCandidateSchema`
   (`signaling.ts:33-37`) breaks `messages.rs`'s `ice_candidate` builder
   (`messages.rs:64-79`) or `IceCandidatePayload` (`messages.rs:141-148`)
   silently — `cargo build` still succeeds, and the failure only surfaces
   when the backend's zod validation rejects the frame (`hub.ts:126-129`,
   `sendError(peer, 'bad_message', ...)`) or, worse, when it doesn't reject
   it but the two sides disagree on optional-field semantics.
2. **The failure surfaces to the end user as an opaque string.** A protocol
   drift ultimately becomes a `SessionEvent::Error { message }`
   (`session.rs:572-580`, `session.rs:200`) rendered as free text in the UI
   — nothing distinguishes "protocol drift" from "network blip" for
   debugging or telemetry.
3. **The six unit tests in `messages.rs` (150-225) test that Rust produces
   what Rust expects, not that it matches the zod schema** — they're
   regression tests against a second hand-maintained copy of the truth, not
   a cross-check against the actual source of truth.
4. **Widening scope:** the mandate's "three languages" framing is slightly
   inaccurate as read — mobile TS _does_ share the canonical package
   correctly, so the real duplication is exactly two independent
   implementations (zod canonical vs. hand-rolled serde), but that's still
   one implementation more than there should be, and it's the one growing
   fastest (every new message type needs to be added twice, in two syntaxes,
   by whoever's shipping the feature).

### Root cause

There is no Rust code generation from the zod schemas, and no CI check that
would fail a PR that changes `signaling.ts`/`input.ts` without a
corresponding change to `messages.rs`/`protocol.rs`.

### Redesign

Two complementary changes, in order of value-per-effort:

1. **Add a schema-conformance test that runs both sides against golden
   fixtures.** Add a small fixture set (`packages/protocol/fixtures/*.json`,
   one file per message type, generated once from real captured envelopes)
   validated by _both_ the zod schema (in a TS test) and the Rust serde
   types (in a Rust test reading the same JSON file via `include_str!`).
   This doesn't eliminate the duplication but makes drift a **loud CI
   failure** instead of a silent runtime surprise — the highest
   value-to-effort ratio available without a codegen investment.
2. **Longer-term: generate the Rust types from the zod schemas** (or from a
   third neutral IDL both generate from) so there is exactly one
   hand-written source. Options, cheapest first: (a) hand-maintain a
   `protocol.schema.json` (JSON Schema) exported once from the zod schemas
   via `zod-to-json-schema`, then generate Rust structs from it with
   `typify` or `schemars`' inverse — a build-time step
   (`apps/desktop/src-tauri/build.rs` already exists, per the file listing,
   as a natural place to hook this); (b) adopt a shared IDL (protobuf/
   Cap'n Proto) — larger migration, not justified yet given the JSON-over-
   WebSocket design is an explicit pillar (`architecture.md:14`).

### Tradeoffs

Fixture-based conformance testing (option 1) is cheap and immediately
valuable but does not stop someone from writing a Rust struct that happens
to satisfy the fixture while diverging on an untested edge case (e.g. a
new optional field). Full codegen (option 2) removes the duplication
permanently but is a real engineering investment and constrains schema
evolution to what the generator supports (e.g. zod's `.default()` semantics
translating cleanly to serde's `#[serde(default)]` needs verification per
field type).

### Implementation plan

1. Add `packages/protocol/fixtures/` with one canonical JSON example per
   `SignalingMessage` variant and per `InputEvent` variant.
2. Add a TS test (`packages/protocol/src/signaling.test.ts` if absent)
   asserting every fixture parses under `SignalingMessageSchema`.
3. Add a Rust test in `messages.rs`/`protocol.rs` reading the _same_ fixture
   files (relative path from the crate, or copied into
   `apps/desktop/src-tauri/tests/fixtures/` via a `build.rs` copy step) and
   asserting they deserialize into the Rust types with the expected field
   values — this becomes the actual cross-language conformance check.
4. Wire both into CI so a fixture addition/change forces both sides to be
   touched in the same PR.
5. Evaluate codegen (option 2) as a separate, scheduled M5/M6 task once the
   fixture harness proves out which fields are hardest to keep in sync.

### Migration strategy

Purely additive — no existing code changes required for step 1-4. Start with
the highest-churn message types (`session-start`, `offer`, `ice-candidate`,
`InputEvent::PointerMove`/`Click`) since those are the ones most likely to
gain fields as F10's capabilities land.

### Testing strategy

The fixtures _are_ the test strategy — each one is both a TS and a Rust test
input. Add a CI lint that fails if `packages/protocol/src/*.ts` changes in a
PR that doesn't also touch `packages/protocol/fixtures/` (a cheap
path-based guard, not full semantic diffing) as a tripwire against silent
drift.

### Risk assessment

Low. This is pure test/tooling addition with no production code path change.

### Performance impact

None (build/test time only; negligible fixture count).

### Future extensibility

Every capability in F10 (multi-monitor display selection, audio codec
negotiation, file-transfer offer/accept, browser-viewer joining as a third
role) adds new message types or new optional fields to existing ones. Locking
in a fixture-conformance habit now means each of those additions gets the
cross-language safety net automatically, instead of the Rust side silently
falling behind as it did for the current protocol.

---

## F5 — Desktop UI polls `get_state` instead of consuming events

### Current implementation (cite file:line)

`Control.tsx` polls `api.getState()` on an 800ms `setInterval`
(`Control.tsx:18-34`, interval at line 29) and `Bubble.tsx` polls the _same_
command on an independent 1000ms `setInterval` (`Bubble.tsx:19-35`, interval
at line 30) — two separate windows, two separate timers, both taking the
same global Mutex (`lock_state`, `commands.rs:19-21`) roughly twice a second
combined, for the app's entire lifetime, regardless of whether anything
changed.

This is despite the fact that a real push channel already exists and is
already used for exactly this data: `spawn_session_runner`
(`commands.rs:132-166`) forwards every `SessionEvent` to
`app_ev.emit("lilypad://session", ev)` (line 156) _and_ calls
`apply_session_event` (155, defined 169-198) which is the function that
actually mutates the coarse `SessionStatus` the polling loop is fetching.
The push event and the state mutation happen in the same callback, so the
`get_state` polling loop is racing to observe a value that was just pushed
one line above, over a channel the frontend never listens to.

### Problems

1. **Up to ~1.8s of state going stale twice a second, forever, on two
   independent timers**, for state that in practice only changes on
   discrete events (approve tapped, session ends, connection state
   changes) — a push model would deliver the same information with zero
   polling latency and near-zero idle cost.
2. **Two independent polling loops against the same coarse Mutex** means the
   lock is taken by: the Bubble window (1/sec), the Control window (1.25/sec)
   whenever it's open, the tray menu handlers, and the session event forwarder
   — none of which currently contends meaningfully (small critical sections),
   but it's needless churn that will matter more once `AppState` holds more
   (F6) or once multiple windows exist for multi-monitor (F10).
3. **Battery/CPU cost that scales with idle time, not with activity** — a
   remote-desktop app that's supposed to sit in the tray for hours between
   sessions is waking the process twice a second indefinitely just to ask
   "did anything change," which is the opposite of what you want from a
   product competing with Parsec/AnyDesk on resource footprint.
4. The comment at `commands.rs:168` ("Map a runner event onto the coarse
   `SessionStatus` the polling UI reads") shows the author already knows the
   UI is polling — this is a known shortcut, not an oversight, and one that's
   easy to close given the push infrastructure already exists.

### Root cause

The event bus (`app.emit("lilypad://session", ...)`) was added for the
session lifecycle but the frontend components were never updated to listen
to it; `get_state` was kept as the (correct) one-shot "give me a snapshot on
mount" mechanism and never removed as the (incorrect) ongoing sync
mechanism.

### Redesign

Keep `get_state` for exactly one call per window (initial snapshot on
mount), and make the Tauri event the ongoing sync mechanism the frontend
already has plumbing for:

```typescript
// apps/desktop/src/lib/tauri.ts — add
import { listen } from '@tauri-apps/api/event';
export function onSessionEvent(cb: (ev: SessionEventDto) => void) {
  return listen<SessionEventDto>('lilypad://session', (e) => cb(e.payload));
}
```

```tsx
// Control.tsx / Bubble.tsx — replace the setInterval poll with:
useEffect(() => {
  let alive = true;
  void api.getState().then((s) => alive && setState(s)); // ONE snapshot fetch
  const unlisten = onSessionEvent((ev) => {
    if (!alive) return;
    setState((prev) => applyEventLocally(prev, ev)); // mirrors apply_session_event
  });
  return () => {
    alive = false;
    void unlisten.then((f) => f());
  };
}, []);
```

`plugin_health` (the debug-panel data, `Control.tsx:73-86`) is the one field
that genuinely has no event source today (nothing pushes a health-changed
event) — keep a slow poll (e.g. 5s) for _that field only_, decoupled from
session status, or better, emit a `lilypad://health` event whenever
`health_check()`'s result changes (cheap to detect: compare against the last
snapshot before emitting).

### Tradeoffs

Requires the frontend to reconstruct `AppStateDto` incrementally from
discrete events (`applyEventLocally`) rather than always trusting a fresh
full snapshot — a small risk of frontend/backend drift if the event-applying
logic in TS and the `apply_session_event` logic in Rust
(`commands.rs:169-198`) disagree. Mitigate by keeping both derived from the
same enumerated `SessionEvent`/`SessionEventDto` shape (already shared via
serde `#[serde(tag = "kind", ...)]`, `session.rs:33-58`) and unit-testing the
TS reducer against the same fixtures F4 proposes for the protocol.

### Implementation plan

1. Add `onSessionEvent` helper to `lib/tauri.ts`.
2. Add a small pure reducer `applySessionEvent(prev, ev): AppStateDto`
   in TS mirroring `commands.rs:169-198` field-for-field.
3. Update `Bubble.tsx` and `Control.tsx` to fetch once + subscribe once,
   removing both `setInterval` calls.
4. Add a `lilypad://health` event (or fold health into the existing
   `lilypad://session` payload as an optional field) so the debug panel
   stops polling too.

### Migration strategy

Ship behind a feature-equivalent path: keep `get_state` callable exactly as
today (no backend change needed for step 1-3), so this is a frontend-only
change with no Rust-side risk. Land steps 1-3 first (session status), verify
with a manual pair→approve→stream→disconnect run that the badge/state
updates instantly instead of within ~1s, then land step 4.

### Testing strategy

Unit test `applySessionEvent` against every `SessionEvent` variant
(mirrors `apply_session_event`'s Rust match arms 172-192) to guarantee
parity. Manual verification: watch the Control window's status badge
transition immediately on Approve instead of on the next poll tick.

### Risk assessment

Low. Frontend-only change; the Rust event-emission path is unchanged and
already proven working (it drives `apply_session_event` today).

### Performance impact

Positive: removes two indefinite timers, one Mutex-lock, and one IPC
round-trip per second per open window, for the entire idle lifetime of the
app — directly relevant to the "competes with Parsec/AnyDesk" mandate, since
idle resource footprint is a real differentiator users notice on laptops.

### Future extensibility

Multi-monitor (F10) will likely add a second control surface (per-display
overlay or a display picker); an event-driven state model scales to N
windows without N times the polling load. A future browser viewer or
multi-user session (F10) will want server-pushed state changes anyway
(WebSocket-driven, not polled) — getting the desktop UI off polling now
establishes the pattern the whole product needs.

---

## F6 — Coarse `Mutex<AppState>` mixing config with hot session state

### Current implementation (cite file:line)

`SharedState = Mutex<AppState>` (`state.rs:52`) guards one struct
(`state.rs:25-36`) holding: two fields that never change after startup
(`device_id`, `backend_base_url`), three fields that mutate on every session
lifecycle event (`session`, `current_room_id`, `control_tx`), one that
mutates rarely (`offered_scopes`), and the entire plugin host
(`host: PluginHost`). Every command — including the tray's Panic handler
(`lib.rs:92-93` → `commands::panic_disconnect` → `send_control_or_reset` →
`lock_state`, `commands.rs:271-272`) and the 800ms/1000ms polling loops from
F5 — takes the _same_ lock regardless of which of these it actually needs.

`lock_state` (`commands.rs:19-21`) recovers from poisoning by taking the
guarded value back out unconditionally: `state.lock().unwrap_or_else(|poisoned|
poisoned.into_inner())`. The justification given in the doc comment
("the guarded data is still structurally valid… take it back", lines 17-18)
is an assumption, not a guarantee: Rust's mutex poisoning exists precisely
because a panic _while holding the lock_ may have left the data mid-mutation.

### Problems

1. **A panic mid-mutation is silently absorbed and the corrupted state is
   handed to the very next caller with no signal anything went wrong.**
   Consider `apply_session_event` (`commands.rs:169-198`): if a future change
   makes this function panic between `s.session = SessionStatus::Idle`
   (188) and `s.control_tx = None` (189) — e.g. an added line that indexes
   into a `Vec` out of bounds — the poisoned lock is recovered by the _next_
   command (say, the user clicking Disconnect in the tray) with `session ==
Idle` but `control_tx` still `Some(...)`, meaning `send_control_or_reset`
   (`commands.rs:271-279`) would send `Control::Disconnect` down a channel
   whose receiving `run_session` may already believe it's uninvolved, or
   worse, silently succeed at looking idle while a session is still
   technically live. No log line, no user-visible signal, no crash — it just
   quietly proceeds.
2. **Coarse locking is a latent contention/priority-inversion risk as more
   state gets added.** Today's critical sections are all small (field
   reads/writes, no I/O under the lock — confirmed by reading every
   `lock_state` call site in `commands.rs`), so this isn't a live bug, but
   F10's multi-monitor (per-display state), clipboard history, or file-
   transfer progress will naturally want to live somewhere, and the path of
   least resistance is "add a field to `AppState`" — which is exactly how
   coarse Mutexes become bottlenecks over time.
3. **Immutable config (`device_id`, `backend_base_url`) pays lock overhead
   for values that never change after `AppState::new`** (`state.rs:39-49`)
   — every `get_state`/`create_pairing` call takes a lock partly just to
   read two `String`s that were fixed at process start.

### Root cause

`AppState` was designed as "the one place all desktop state lives," a
reasonable M1 starting point, but the mandate's own framing ("god objects")
applies here in miniature: one struct, one lock, for concerns (identity,
config, live session, plugin health) that have no reason to share a
critical section.

### Redesign

Split by mutability/ownership, not by "everything the app needs":

```rust
// Immutable after startup — no lock needed at all.
pub struct DesktopIdentity {
    pub device_id: String,
    pub backend_base_url: String,
}
// app.manage(Arc::new(DesktopIdentity { ... })) instead of inside the Mutex.

// Hot, session-scoped, mutated by the FSM/orchestrator from F1.
pub struct SessionRuntime {
    pub session: SessionStatus,
    pub current_room_id: Option<String>,
    pub offered_scopes: Vec<String>,
    pub control_tx: Option<UnboundedSender<Control>>,
}
pub type SharedSessionRuntime = Mutex<SessionRuntime>;

// Health surface from F3 — read-mostly, cheap, its own lock (or lock-free
// via atomics/ArcSwap since it's just string labels).
pub type SharedHealth = Mutex<BTreeMap<String, String>>; // or ArcSwap<...>
```

Additionally, replace poison-recovery-by-swallowing with a recovery that logs
and marks the runtime state explicitly suspect:

```rust
fn lock_session(state: &SharedSessionRuntime) -> MutexGuard<'_, SessionRuntime> {
    state.lock().unwrap_or_else(|poisoned| {
        log::error!(target: "lilypad::state", "session state mutex poisoned — a prior handler panicked while mutating session state; recovering, but treat this session as suspect");
        let mut guard = poisoned.into_inner();
        // Fail safe rather than fail silent: force to a known-safe state
        // rather than trusting whatever partial mutation caused the panic.
        guard.session = SessionStatus::Idle;
        guard.control_tx = None;
        guard.current_room_id = None;
        guard
    })
}
```

### Tradeoffs

More `app.manage(...)` types for Tauri commands to take as `State<'_, T>`
parameters (mild boilerplate increase per command). Forcing poisoned state
to `Idle` is a safety-over-availability choice: if the panic was actually
harmless, this needlessly ends a session — acceptable for a remote-_control_
product where "fail closed" (drop the session, force the user to re-pair) is
strictly safer than "fail open" (silently continue with unknown state).

### Implementation plan

1. Extract `DesktopIdentity` as an `Arc<DesktopIdentity>` managed
   separately; update the ~3 read sites (`commands.rs:87-88`, `lib.rs:121`)
   to take it as its own `State`.
2. Rename `AppState` to `SessionRuntime`, drop the `host: PluginHost` field
   (superseded by F3's `health.rs` free functions, which need no shared
   mutable state at all).
3. Replace `lock_state`'s swallow-and-continue with the log-and-reset
   version above.
4. Update every `commands.rs` call site (`get_state`, `create_pairing`,
   `spawn_session_runner`, `approve_session`, `deny_session`, `disconnect`,
   `panic_disconnect`, `send_control_or_reset`, `reset_to_idle`) to lock the
   narrower `SharedSessionRuntime` instead of the old combined `AppState`.

### Migration strategy

Land as one PR (the fields are small enough that splitting incrementally
adds more risk than doing it atomically) but keep `AppStateDto`'s wire shape
unchanged (`state.rs:55-63`) so the frontend needs zero changes — `get_state`
internally reads from two managed states instead of one Mutex, but returns
the identical DTO.

### Testing strategy

Add a test that deliberately panics while holding `SharedSessionRuntime`
(spawn a thread, panic mid-lock) and asserts the _next_ lock acquisition logs
the poison and yields `SessionStatus::Idle`/`control_tx: None` — turning the
"is this actually safe" assumption in the current doc comment into an
executable guarantee.

### Risk assessment

Low-medium. The main risk is missing a call site during the split (Tauri's
`State<'_, T>` extraction is compile-checked per command, so a missed site
fails to compile rather than silently misbehaving — a good safety net for
this specific refactor).

### Performance impact

Slightly positive (fewer fields under contention, no lock at all for
identity reads) but not measurable at current scale — this is a robustness
fix, not a perf fix.

### Future extensibility

Per-display state (F10 multi-monitor) and per-peer state (F10 multi-user)
both want to live in something scoped to "current session," not to "the
whole app" — `SessionRuntime` is the natural place to grow a
`Vec<DisplaySelection>` or `Vec<PeerHandle>` without dragging
`DesktopIdentity` or `Health` into the same critical section.

---

## F7 — Scattered magic numbers, no central config surface

### Current implementation (cite file:line)

Timeouts, budgets, and buffer sizes are declared as module-local `const`s or
inline literals across at least six files, with no shared config module and
inconsistent override mechanisms:

- `session.rs`: `MAX_ICE_RESTARTS = 2` (72), `MAX_SIGNALING_RECONNECTS = 5`
  (75), `RECOVERY_TIMEOUT = 20s` (79), `PAIRING_TIMEOUT = 120s` (86, with an
  env-var override `LILYPAD_PAIRING_TIMEOUT_SECS` at 88-94 that **no other
  constant in the file has** — an inconsistent override story), backoff base
  `500ms`/cap `8000ms` inlined in `backoff_delay` (98-99), heartbeat interval
  `10s` inlined at 155, sample-queue depth `4` inlined at 480 with only a
  comment explaining the "133ms at 30fps" derivation (478-479).
- `hub.ts`: `DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000` (70),
  `DEFAULT_REREGISTER_GRACE_MS = 15_000` (73), `DEFAULT_MAX_ROOMS = 10_000`
  (76) — these at least flow through `SignalingHubDeps` for injection
  (22-44), the best-practice example in the codebase.
- `routes/signaling.ts`: `MAX_CONNECTIONS_PER_IP = 20` (12), `MSG_BURST = 60`
  (13), `MSG_REFILL_PER_SEC = 20` (14), `REGISTER_TIMEOUT_MS = 10_000` (15),
  plus a hardcoded reaper interval `10_000` inlined at line 50 — none of
  these are injectable/overridable at all, unlike `hub.ts`'s constants one
  file over.
- `server.ts`: WS max payload `64 * 1024` inlined at line 31.
- `commands.rs`: window dimensions `360.0/500.0` (qr-overlay) and
  `400.0/560.0` (control) are literal `f64` pairs duplicated verbatim at four
  call sites — `create_pairing` (126), `simulate_pair_request` (212),
  `show_qr_overlay` (260), `show_control` (264) — with no shared constant at
  all, the one place in this list where the _same_ two numbers are typed out
  four separate times.
- By contrast, `media/abr.rs`'s `AbrConfig` (17-47) is the one place in the
  codebase that does this right: every tunable lives in one `Default`-
  derived struct, cited by name in the docstring's explanation of the
  algorithm (5-11), and unit-tested against its own defaults (123-199).

### Problems

1. **No single place to look up "what are Lilypad's operational limits"** —
   an on-call engineer tuning TURN fallback behavior or connection limits
   under load has to grep six files across two languages.
2. **Inconsistent overridability**: `PAIRING_TIMEOUT` is env-overridable
   (session.rs:88-94) but `MAX_ICE_RESTARTS`/`RECOVERY_TIMEOUT` in the same
   file are not; `hub.ts`'s constants are constructor-injectable but
   `routes/signaling.ts`'s are hardcoded module constants one file away in
   the same request path.
3. **Duplicated literals invite drift**: the four window-size call sites
   (commands.rs:126,212,260,264) will silently diverge the next time someone
   changes one dialog's size and forgets the other three — there is no
   compiler or test to catch it.

### Root cause

No project convention exists yet for "where do tunables live and how are
they overridden" — each file's author made a locally reasonable choice
(const, env var, DI parameter) without a shared pattern to follow, because
`AbrConfig` (the one good example) hadn't been generalized into a project-
wide convention.

### Redesign

Adopt `AbrConfig`'s shape as the house style and apply it in two places:

```rust
// desktop: config/session.rs
#[derive(Debug, Clone, Copy)]
pub struct SessionLimits {
    pub max_ice_restarts: u32,
    pub max_signaling_reconnects: u32,
    pub recovery_timeout: Duration,
    pub pairing_timeout: Duration,
    pub heartbeat_interval: Duration,
    pub sample_queue_depth: usize,
}
impl Default for SessionLimits {
    fn default() -> Self {
        Self {
            max_ice_restarts: 2, max_signaling_reconnects: 5,
            recovery_timeout: Duration::from_secs(20),
            pairing_timeout: Duration::from_secs(120),
            heartbeat_interval: Duration::from_secs(10),
            sample_queue_depth: 4,
        }
    }
}
impl SessionLimits {
    /// One consistent override story for every field, not just pairing_timeout.
    pub fn from_env() -> Self { /* LILYPAD_MAX_ICE_RESTARTS, LILYPAD_PAIRING_TIMEOUT_SECS, ... */ }
}

// desktop: config/windows.rs
pub struct WindowSpec { pub label: &'static str, pub title: &'static str, pub w: f64, pub h: f64 }
pub const QR_OVERLAY: WindowSpec = WindowSpec { label: "qr-overlay", title: "Lilypad — Pair", w: 360.0, h: 500.0 };
pub const CONTROL: WindowSpec = WindowSpec { label: "control", title: "Lilypad — Session", w: 400.0, h: 560.0 };
```

```typescript
// backend: config/limits.ts — same DI pattern hub.ts already uses, applied
// consistently to routes/signaling.ts's constants too
export interface SignalingLimits {
  maxConnectionsPerIp: number; msgBurst: number; msgRefillPerSec: number;
  registerTimeoutMs: number; reaperIntervalMs: number; maxPayloadBytes: number;
}
export const DEFAULT_SIGNALING_LIMITS: SignalingLimits = { ... };
```

### Tradeoffs

Centralizing adds one more file to open when tuning a single value, and for
truly file-local constants (e.g. a value used in exactly one function with
no override need) a dedicated config struct can be overkill — reserve this
pattern for values that are either (a) duplicated across call sites, (b)
plausibly need runtime/env override, or (c) are operationally significant
enough that "where do I find this" matters during an incident.

### Implementation plan

1. Introduce `SessionLimits` (desktop) and `SignalingLimits` (backend) with
   the values above, threaded through via the existing DI seams
   (`SignalingHubDeps` already supports this pattern for `hub.ts`; extend
   `routes/signaling.ts` to build its `IpConnectionLimiter`/`TokenBucket`
   from a `SignalingLimits` param instead of module constants).
2. Introduce `WindowSpec` constants and replace the four duplicated literal
   pairs in `commands.rs`.
3. Add `SessionLimits::from_env()` mirroring today's `pairing_timeout()`
   function (`session.rs:88-94`) for every field, not just pairing timeout.

### Migration strategy

Additive, mechanical, low-risk — replace literals with named constants field
by field; no behavior change if the default values are copied verbatim
(they are, above). Land as a single "no functional change" PR, verified by a
smoke run plus existing tests (`backoff_is_exponential_and_capped`,
session.rs:626-636, should still pass unmodified once wired to
`SessionLimits`).

### Testing strategy

No new test categories needed beyond what exists; the existing
`AbrConfig`/`BitrateController` and `backoff_delay` tests already prove this
pattern is testable. Add one test asserting `WindowSpec` constants are used
(not re-typed) at all four `commands.rs` call sites — a cheap regression
guard against the exact duplication this finding describes creeping back in.

### Risk assessment

Low. Pure refactor of constant values into named, centralized structs.

### Performance impact

None.

### Future extensibility

F10's per-capability tuning (audio jitter buffer size, file-transfer chunk
size, multi-monitor per-display bitrate caps) all want the same
"defaults + env override + DI-injectable for tests" shape `AbrConfig`
already models — having `SessionLimits`/`SignalingLimits` established as the
house pattern means each new capability's tunables have an obvious home from
day one instead of spawning a seventh scattered-constants file.

---

## F8 — Inconsistent error handling across boundaries

### Current implementation (cite file:line)

Three distinct, uncoordinated error idioms exist, each losing structure at
the boundary it crosses:

1. **Tauri commands → frontend: `Result<T, String>` everywhere.** Every
   `#[tauri::command]` in `commands.rs` returns `Result<T, String>`
   (`create_pairing`, 81-128; `simulate_pair_request`, 203-213;
   `approve_session`, 216-230; `deny_session`, 232-238; `disconnect`,
   240-245; `panic_disconnect`, 248-255), constructed via `.map_err(|e|
e.to_string())` or `format!(...)` at each call site (e.g. 103, 106, 110).
   The frontend (`lib/tauri.ts:24-33`) types every `invoke<T>(...)` call with
   no error type at all — a caught error in `Bubble.tsx:41` (`catch (err) {
console.error('createPairing failed', err); }`) can only log the string,
   never branch on "network unreachable" vs. "backend returned non-2xx" vs.
   "malformed response" even though `create_pairing` actually distinguishes
   these three cases internally (103, 106, 110) before throwing the
   distinction away by stringifying it.
2. **Session runner → UI: `anyhow` strings inside a typed event.**
   `SessionEvent::Error { message: String }` (`session.rs:56-57`) is the
   _only_ typed event field carrying error information, and every producer
   feeds it a fully-formatted human string: `format!("{}: {e}",
env.msg_type)` (200), `format!("pipeline start: {e}")` (297),
   `format!("ICE restart failed: {e}")` (324), `"connection did not recover
in time".into()` (389), etc. There is no `ErrorKind` enum distinguishing
   "transient, will retry" from "fatal, session is ending" even though the
   surrounding code _knows_ the difference (some of these fire alongside
   `SessionEvent::Ended`, some don't) — the frontend has no way to tell them
   apart except by string content.
3. **Backend → clients: ad hoc string error codes.** `hub.ts`'s `sendError`
   (469-478) and every call site (128, 137, 146, 150, 156, 258, 277, 285,
   378, 384, 417) pass a free-form `code: string` — `'bad_message'`,
   `'not_registered'`, `'role_mismatch'`, `'wrong_room'`, `'no_room'`,
   `'capacity'`, `'seat_taken'`, `'seat_reserved'`, `'forbidden'`,
   `'unexpected_type'`, `'peer_missing'` — chosen ad hoc at each call site.
   The wire schema only constrains this to `z.string()`
   (`signaling.ts:125`, the `errorMsg` payload), so nothing stops a typo
   (`'seat_taken'` vs. a hypothetical future `'seatTaken'`) from silently
   producing an uncategorized error client-side, and no client code (mobile
   or desktop) appears to branch on these codes at all today — they exist
   only for logs.

### Problems

1. A production remote-desktop competing with Parsec/AnyDesk needs the UI to
   distinguish, at minimum: "your network dropped, we're retrying" (show a
   spinner) vs. "the other side denied/ended the session" (show a clear
   message) vs. "something is broken, contact support" (surface a
   diagnosable code). Today all three collapse into the same
   free-text `message: String`/`Result<T, String>` shape everywhere, so this
   distinction has to be re-derived by the UI parsing human sentences — the
   worst possible contract for a UI that needs to make decisions, not just
   display text.
2. Debugging a field report ("it disconnected and I don't know why") means
   grepping log strings for substrings, because no error carries a stable
   machine-readable code end-to-end from `hub.ts`'s `sendError` through
   `session.rs`'s `SessionEvent::Error` through `commands.rs`'s event
   forwarding to the frontend.
3. The three idioms don't compose: a backend `error` frame's `code` string
   gets absorbed into `handle_inbound`'s generic `"error"` arm
   (`session.rs:572-579`), which extracts only `message` (576) and **drops
   `code` entirely** — the one place in the whole chain that already has a
   structured code throws it away before it even reaches the Rust side's own
   error type.

### Root cause

No shared error taxonomy was ever designed across the stack — each boundary
(Tauri IPC, session-event bus, WebSocket protocol) independently reached for
"just stringify it," which is the correct quick M1/M2 choice and the wrong
M5 one.

### Redesign

Introduce one small, shared taxonomy and thread it through all three
boundaries without a large rewrite:

```typescript
// packages/protocol/src/errors.ts — NEW, becomes part of the F4 single
// source of truth, shared by backend AND (via the F4 fixture/codegen work)
// mirrored in Rust as an enum instead of a bare String.
export const ErrorCodeSchema = z.enum([
  'bad_message',
  'not_registered',
  'role_mismatch',
  'wrong_room',
  'no_room',
  'capacity',
  'seat_taken',
  'seat_reserved',
  'forbidden',
  'unexpected_type',
  'peer_missing',
  'bad_json',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
```

```rust
// desktop: session/error.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionErrorKind {
    Transient,  // retrying automatically (reconnect in flight, ICE restart)
    ProtocolRejected(/* the backend's ErrorCode, once F4 mirrors it */),
    Fatal,      // session is ending, no automatic recovery
}
#[derive(Debug, Clone, Serialize)]
pub struct SessionError { pub kind: SessionErrorKind, pub message: String }
```

`SessionEvent::Error` becomes `SessionEvent::Error(SessionError)`; every
producer picks the right `kind` instead of just a string (e.g. the ICE-
restart-in-progress path — 297 — is `Transient`, exhausted-restarts — 330 —
is `Fatal`). For Tauri commands, replace `Result<T, String>` with
`Result<T, CommandError>` where `CommandError` is a small serializable enum
(`NetworkUnreachable`, `BackendRejected(u16)`, `MalformedResponse`,
`NoActiveSession`) — Tauri serializes command errors to the frontend as JSON
automatically when the error type implements `Serialize`, so this is a
low-cost change for a real capability gain (the frontend can finally branch
on error kind, e.g. show a distinct "backend unreachable" state vs. a
generic toast).

### Tradeoffs

More boilerplate per error site (constructing an enum variant instead of a
`format!` string) — mitigate by keeping a `message: String` field on every
error type for the human-readable detail, so nothing about today's log
output/UI text needs to disappear, it just gains a `kind`/`code` alongside
it. This is additive, not a rewrite of every error message.

### Implementation plan

1. Add `packages/protocol/src/errors.ts`'s `ErrorCodeSchema`; update
   `signaling.ts`'s `errorMsg.payload.code` (125) to use it instead of bare
   `z.string()`.
2. Add `SessionErrorKind`/`SessionError` in Rust; update every
   `SessionEvent::Error` producer in `session.rs` (200, 297, 324, 330, 389, 579) to pick a `kind`.
3. Update `handle_inbound`'s `"error"` arm (572-580) to parse `code` (not
   just `message`) from the inbound payload and map it into
   `SessionErrorKind::ProtocolRejected`.
4. Add `CommandError` enum for Tauri commands; update `create_pairing`'s
   three failure sites (103, 106, 110) to return typed variants instead of
   `format!` strings.
5. Update `lib/tauri.ts` to type `invoke<T>` calls' rejected value as the new
   `CommandError` shape (Tauri passes the `Serialize` error through as JSON)
   and update `Bubble.tsx:41`'s catch to branch on `err.kind` for at least
   the "backend unreachable" case (the most actionable one for a user to see
   distinctly from a generic failure).

### Migration strategy

Land backend (`errors.ts`) first since it's purely additive to the schema
(a `z.enum` is a strict superset check against existing string values — no
existing valid message becomes invalid). Land desktop session-side second
(internal to `session.rs`, no wire format change since `SessionEvent` is
Tauri-internal, not network-facing). Land Tauri command errors last since it
does change the frontend's error-handling call sites, all of which are
small and enumerable (`Bubble.tsx:41`, and any other `.catch`/`try` around
`api.*` calls).

### Testing strategy

For each producer site changed, assert the correct `kind` is chosen (e.g. a
test that an exhausted ICE-restart budget produces `Fatal`, not
`Transient`). For the Tauri command errors, an integration test isn't
practical without a running Tauri context, but a unit test on the mapping
function (`reqwest` error → `CommandError` variant) is straightforward.

### Risk assessment

Medium (only because of the volume of call sites touched, not because any
individual change is risky) — mitigate by doing it as a mechanical,
reviewable, one-boundary-at-a-time rollout per the migration strategy above,
not one giant PR.

### Performance impact

None.

### Future extensibility

A stable `ErrorCode`/`SessionErrorKind` taxonomy is the foundation the M6
"Observability" debug overlay (`technical-design.md:72-76`, "capture time,
encode time, RTT... ICE candidate type") needs to categorize failures for
telemetry — without it, M6 has nothing to bucket by except parsing free-text
strings, which is a worse foundation to build a metrics dashboard on than
what exists in most of the rest of the codebase already (e.g. `hub.ts`'s
`counters`, 92-97, which _are_ properly typed and aggregable).

---

## F9 — Dead code and M1/M2 leftovers still reachable in production

### Current implementation (cite file:line)

- `commands.rs:200-213`: `simulate_pair_request` is documented as
  "DEV-ONLY (M1): stand in for a phone redeeming the token... Removed once
  M2 lands" (lines 200-202) — but M2 has landed per the mandate's own
  description of the current milestone, and the command is still registered
  in the production `invoke_handler!` list (`lib.rs:129`), meaning it is
  callable from any window's webview content today, in whatever build
  configuration ships. It mutates `SessionStatus` directly
  (`s.session = SessionStatus::AwaitingApproval`, 207-209) and opens the
  control window (212), **entirely bypassing the real pairing handshake**
  (no token redemption, no `pair-request` frame, no device identity check)
  that `session.rs`'s FSM-equivalent logic otherwise enforces.
- `os/windows.rs:9-27`: `WinEncoder::is_supported()` unconditionally returns
  `true` (line 19) while `start()` unconditionally returns
  `Err(PluginError::Unsupported("Media Foundation H.264 encode arrives in
M3"))` (line 22) — a trait contract violation (`is_supported` lying about
  `start`'s real behavior) that will silently mislead any future code that
  branches on `is_supported()` before calling `start()` (there is none today,
  per what was read, but the trait is designed for exactly that use).
- `lib.rs:7`: `#![allow(dead_code)]` is a **crate-wide** blanket, justified
  in the same comment as covering the plugin trait's not-yet-called methods
  (lines 4-7). This suppresses the dead-code lint for the _entire_ crate, not
  just the plugin module — meaning genuinely unused code introduced anywhere
  else in future PRs (a real bug class: an accidentally-orphaned function,
  a typo'd field that should have been read but wasn't) will not be caught
  by the compiler either, for the lifetime of this attribute.
- `plugins/mod.rs:1-9`'s module doc is itself stale: "Real backends land in
  M3/M4; today they are stubs that report `Down`" — untrue today per F3's
  findings (the real backends exist in `crate::media`/`crate::input`; the
  _plugin wrappers_ are stale, not the backends).

### Problems

1. `simulate_pair_request` is the most concerning of these: it is a
   **security-relevant bypass of the approval flow** left wired into the
   production command surface. Nothing in `lib.rs:126-134`'s
   `invoke_handler!` gates it behind a debug/dev build flag
   (`#[cfg(debug_assertions)]` or similar) — it is reachable via
   `window.__TAURI__.core.invoke('simulate_pair_request')` from any content
   that runs in one of the app's webviews in a release build, unless
   Tauri's IPC allowlist (`capabilities/default.json`, not read in full
   here but worth verifying as part of remediation) happens to restrict it,
   which the code itself gives no indication of.
2. The blanket `#![allow(dead_code)]` (`lib.rs:7`) trades a real, ongoing
   safety net (the compiler telling you about genuinely orphaned code) for
   convenience on a narrow, already-shrinking set of call sites (the plugin
   trait methods F3 recommends deleting anyway).
3. `WinEncoder::is_supported() == true` is a small but real footgun for
   whoever picks up Windows encoder work in M3/M4 parity efforts — it is the
   kind of stale flag that causes a future "why does `is_supported` say yes
   but `start` always fails" debugging session.

### Root cause

Milestone-scoped comments ("DEV-ONLY (M1)... removed once M2 lands") were
written as intentions, not enforced as gates (no `#[cfg(...)]`, no CI check
that a "removed once X lands" comment actually gets acted on once X lands).

### Redesign

1. **Delete `simulate_pair_request` entirely** now that a real pairing flow
   exists end-to-end (per the mandate's own description of the current
   state) — or, if a dev-only stand-in is still valuable for UI development
   without a phone, gate it behind `#[cfg(debug_assertions)]` on both the
   command definition _and_ its `invoke_handler!` registration, so a
   `--release` build cannot expose it regardless of the webview's IPC
   allowlist configuration:

```rust
#[cfg(debug_assertions)]
#[tauri::command]
pub fn simulate_pair_request(...) -> Result<(), String> { ... }

// lib.rs
.invoke_handler(tauri::generate_handler![
    commands::get_state,
    commands::create_pairing,
    #[cfg(debug_assertions)]
    commands::simulate_pair_request,
    ...
])
```

2. Fix `WinEncoder::is_supported()` to return `false` until `start()` is
   real, restoring the trait contract (`os/mod.rs:18-24`'s doc says
   "STUB today" already — make the flag match the doc).
3. Narrow `#![allow(dead_code)]` from crate-wide to the specific module(s)
   still carrying genuinely-not-yet-called methods, ideally down to zero
   once F3's plugin deletions land (`Plugin::stop`/`permissions_required`
   may be the only remaining unused trait methods, and those disappear with
   the plugins that declare them).

### Tradeoffs

Removing `simulate_pair_request` entirely means UI development without a
physical phone needs another stand-in (e.g. a small standalone dev harness
script that speaks the signaling protocol directly, or the existing
`examples/headless_offer.rs` extended to also redeem a pairing token) —
worth the one-time cost given the security exposure of leaving a live
approval-bypass command in the release binary.

### Implementation plan

1. Grep the frontend (`apps/desktop/src`) for any remaining call to
   `api.simulatePairRequest` (`lib/tauri.ts:28`) — remove the frontend call
   site too if found, since it currently exists as dead UI-side plumbing
   for a command that per the milestone comment should already be gone.
2. Gate or delete `simulate_pair_request` per the redesign above.
3. Fix `WinEncoder::is_supported`.
4. Narrow the `#![allow(dead_code)]` attribute; run `cargo build` and address
   whatever the compiler now flags (expected to be small, given F3's
   deletions remove most of the justification).

### Migration strategy

Ship the `#[cfg(debug_assertions)]` gate first (zero risk — release builds
lose a command that shouldn't have been there; debug builds are unaffected)
before deciding whether to delete it outright, so there's a safety net if
some dev workflow still depends on it.

### Testing strategy

Add a `#[cfg(not(debug_assertions))]` test (or a build-matrix CI check) that
attempting to invoke `simulate_pair_request` in a release-profile build
fails at the Tauri IPC layer (command not found) — turning "is this
reachable in prod" from a manual code-read into an automated check.

### Risk assessment

Low for the `is_supported`/`allow(dead_code)` fixes. Low-medium for removing
`simulate_pair_request` — verify no shipped mobile/desktop UI flow
(including any hidden dev-menu toggle) depends on it before deleting outright;
the `#[cfg(debug_assertions)]` gate is the safe intermediate step regardless.

### Performance impact

None.

### Future extensibility

A clean invoke-handler surface (only real, production commands registered)
matters more once M5's auth/trusted-devices work adds real security boundaries
around the pairing flow — auditing "what can the webview actually call" is a
much shorter, more confident review once dev-only shims are compile-time
excluded rather than living permanently in the release binary.

---

## F10 — Missing seams for planned capabilities

This finding walks each capability named in the mandate, states exactly what
in the current abstractions blocks it (with citations), and proposes the
minimal seam to add now — without building the feature — so F1/F2's
decomposition isn't immediately re-broken when these land.

### Current implementation (cite file:line)

- **Multi-monitor.** `WebRtcPeer` has exactly one `video_track: Arc<
TrackLocalStaticSample>` (`rtc/mod.rs:88`, created once in `new`,
  108-118). `MediaPipeline::start` builds exactly one capture+encoder pair
  per call (`media/pipeline.rs:71-75`), and `session.rs`'s
  `start_media_pipeline` (465-508) is called exactly once per session,
  storing the result in a single `pipeline: Option<MediaPipeline>` local
  (152). `CaptureConfig` (referenced at `pipeline.rs:26`, defined in
  `media/capture/mod.rs`, not fully re-read here but its use is unambiguous)
  has no display-selector field visible from any call site read. The
  signaling protocol has no display concept either: `SessionStartPayload`
  (`messages.rs:124-132`) and its TS counterpart (`signaling.ts:104-112`)
  carry `sessionId`/`grantedScopes`/`iceServers` only.
- **Audio.** `build_api()` (`rtc/mod.rs:285-294`) calls
  `media.register_default_codecs()` (287), which registers webrtc-rs's
  default audio codecs too, but nothing in `WebRtcPeer::new` (96-218) ever
  creates or adds an audio `TrackLocal` — only the one H.264 video track
  (108-118). `media/capture`'s `CaptureBackend` trait (referenced from
  `pipeline.rs:18`, capture producing `raw` BGRA frames per
  `pipeline.rs:127-133`) has no audio-analog trait at all in anything read.
- **Clipboard sync.** The phone→desktop direction is _already real_, not a
  stub: `InputEvent::Clipboard { text, ts }` (`input.ts:105-109`,
  `protocol.rs:113-116`) flows through `InputDispatcher::apply`'s
  `Clipboard` arm (`dispatcher.rs:173`) straight to
  `InputBackend::set_clipboard` (`input/mod.rs:81`). There is **no reverse
  direction**: no signaling/input message exists for desktop→phone clipboard
  push, and `ClipboardPlugin` (the piece with "Clipboard" in its name) is
  pure ceremony (F3) with no relation to the real, working half of this
  feature.
- **File transfer.** The only DataChannel that exists is
  `"lilypad-input"` (`rtc/mod.rs:153`), created eagerly and exclusively for
  input inside `WebRtcPeer::new` — there is no second channel, no channel
  registry, and `PeerEvent::InputMessage(Vec<u8>)` (`rtc/mod.rs:73-74`) is
  the only inbound-data event shape, hardcoded to mean "input batch bytes"
  everywhere it's consumed (`session.rs:347-349`, `input/worker.rs:64-77`).
- **Windows/Linux host parity.** `session_capture_kind()`
  (`session.rs:424-438`) and `session_encoder_kind()` (446-458) both
  **silently fall back to `Synthetic`/`Software`** on any non-macOS target
  (435-437, 455-457) — meaning a Windows build of the desktop app, launched
  by a real user for a real session (not a dev running
  `LILYPAD_CAPTURE_KIND=synthetic` on purpose), would stream a synthetic
  test pattern instead of the user's actual screen, with **no error, no
  degraded-health signal the user would see**, because
  `session_capture_kind`'s fallback is unconditional compile-time `cfg`
  branching, not a runtime capability check that could surface as a
  `SessionEvent::Error`. `os/windows.rs`'s `WinEncoder` (9-27) and the
  module doc at `os/mod.rs:1-12` both confirm Windows encode is not real
  yet either.
- **Browser viewer.** `DeviceKindSchema` (`pairing.ts:11`) is
  `z.enum(['desktop', 'mobile'])` — exactly two roles, baked into the zod
  schema every backend/mobile/desktop consumer type-checks against. `Room`
  (`hub.ts:52-68`) has exactly one `desktop?: Peer` and one `mobile?: Peer`
  field, not a list — the aggregate itself has no shape for "a third kind of
  viewer joins."
- **Multi-user sessions.** Same root cause as browser viewer: `Room`'s
  single `mobile?: Peer` field (`hub.ts:55`) and `session.rs`'s single
  `peer: Option<Arc<WebRtcPeer>>` (151) both hard-code "exactly one remote
  party" into the aggregate/orchestrator shape, not just into a specific
  method.

### Problems

Building any of these today means widening a `Option<T>` into a
`Vec<T>`/`Map<K,V>` inside the exact god-object/god-class files F1/F2 already
flag as hard to change safely — i.e., the future-readiness gap and the
decomposition debt are the same problem, not two separate ones. The Windows
fallback-to-Synthetic behavior (`session.rs:435-437`) is additionally a
**live correctness risk today**, not just a future gap: it means "build for
Windows" currently produces an app that looks like it's streaming but isn't,
with no operator-visible signal.

### Root cause

M1-M4 correctly scoped to "one desktop, one phone, macOS, video+input only"
to ship fast — but the data shapes chosen to do that (`Option<Peer>` instead
of a collection, exactly two `DeviceKind` variants, one video track, one
DataChannel) encode that scope into types that every future capability must
now unwind, rather than types that were merely _defaulted_ to the M1-M4 scope
and could grow.

### Redesign

Minimal, additive seams per capability — none of these build the feature,
all of them make the eventual feature a local change:

- **Multi-monitor:** add `display_id: Option<String>` to `CaptureConfig`
  (optional today, ignored by the single-display synthetic/ScreenCaptureKit
  backends) and to the signaling `SessionStartPayload`/offer messages as an
  optional field (zod `.optional()`, serde `#[serde(default)]`) — zero
  behavior change today, but once F1's `MediaController` exists as its own
  unit, "a `Vec<MediaController>` keyed by `display_id`" is a contained
  change instead of a `session.rs` rewrite.
- **Audio:** define an `AudioCaptureBackend`/`AudioEncoderBackend` trait pair
  now (mirroring `CaptureBackend`/`EncoderBackend`'s shape) with only an
  `UnsupportedAudioCapture` stub implementation (matching the existing
  `UnsupportedEncoder`/`UnsupportedInputBackend` pattern at
  `os/mod.rs:50-69`, `input/mod.rs:101-132`) — this reserves the trait
  boundary and the "which backend per OS" factory-function shape without
  writing a single line of real audio code, and reserves a second
  `TrackLocal`/data-channel slot in `WebRtcPeer` behind a config flag so
  adding it later doesn't change `WebRtcPeer::new`'s signature.
- **Clipboard sync (desktop→phone):** add a `clipboard` message to the
  _signaling_ protocol (not the input protocol, which is phone→desktop only
  by design) or, more simply, a second reliable DataChannel
  `"lilypad-clipboard"` alongside `"lilypad-input"` — the input protocol's
  existing `Clipboard` event/`set_clipboard` trait method (F3's discovery)
  proves the OS-integration half already works; only the wire direction is
  missing, which is a small, additive protocol change once F4's fixture
  process exists to keep both sides honest.
- **File transfer:** reserve a second named DataChannel
  (`"lilypad-files"`) in `WebRtcPeer::new` behind a capability flag (created
  only if the session's granted scopes include a future `'file_transfer'`
  `SessionScope` variant — `pairing.ts:18` already models scopes as an
  extensible enum, so adding one is cheap) — `PeerEvent` gains a
  `FileChannelMessage(Vec<u8>)` variant parallel to today's
  `InputMessage`, keeping the two data paths independently gated exactly
  like input already is gated on `input_channel_open`
  (`session.rs:163,339-346`).
- **Windows/Linux host parity:** the immediate, low-risk fix is to make
  `session_capture_kind()`/`session_encoder_kind()` (`session.rs:424-458`)
  **fail loudly instead of silently substituting** on a real (non-dev)
  session when no real backend exists for the target OS — i.e., only fall
  back to `Synthetic` when the explicit `LILYPAD_CAPTURE_KIND=synthetic` dev
  override is set (already the existing opt-in path, 425-427), and return a
  `SessionEvent::Error`/refuse to start otherwise on a platform with no real
  capture backend, rather than the current unconditional `cfg`-gated
  fallback (430-437) that can't distinguish "developer explicitly asked for
  synthetic" from "this OS has no real backend yet." This is a correctness
  fix available today, independent of when real Windows capture/encode
  actually lands.
- **Browser viewer / multi-user:** widen `DeviceKindSchema`
  (`pairing.ts:11`) from a closed 2-value enum to a 2-value **role** enum
  (`'host' | 'viewer'`) plus a separate `deviceId`/session-scoped identity —
  "viewer" then covers phone, browser, or a second simultaneous phone
  uniformly. On the backend, widen `Room`'s `mobile?: Peer` field
  (`hub.ts:55`) to `viewers: Map<string, Peer>` (a Map, not a single
  optional field) as part of F2's `Room` extraction — since F2 already
  proposes rewriting `Room` as its own class, this is the single best moment
  to make this change, before the old shape calcifies further behind a
  bigger API. On the desktop, F1's `MediaController`/peer-ownership split
  means "one `WebRtcPeer` per viewer" becomes "the orchestrator owns a
  `HashMap<ViewerId, Arc<WebRtcPeer>>`" instead of `session.rs`'s current
  single `Option<Arc<WebRtcPeer>>` (151) — track fan-out (one encoded frame
  sent to N tracks) is the one genuinely new mechanism needed, and it
  belongs entirely inside `MediaController`, not spread across the
  orchestrator.

### Tradeoffs

Every seam above is optional/inert until used (a `None` field, an
`Unsupported` stub, a role rename with identical runtime behavior for the
current 2-party case) — the cost is a small amount of "why does this field
exist if nothing sets it yet" friction for reviewers, mitigated by clear
doc-comments (following this codebase's own strong existing convention of
explaining _why_, not just _what_ — nearly every file read for this audit
does this well already). The `DeviceKindSchema` rename (`'desktop'/'mobile'`
→ `'host'/'viewer'`) is the one seam with real migration cost: it's a wire
format change every consumer (backend, mobile, desktop) must adopt
simultaneously, so it should be scheduled deliberately (see migration
strategy) rather than snuck in as a side effect of F2's `Room` refactor.

### Implementation plan

Sequence by dependency, not by capability priority: F1 and F2 (session/room
decomposition) first, since every seam above assumes `MediaController` and
`Room` already exist as separate units; then the low-risk additive seams
(optional `display_id`, `Unsupported*` audio stubs, the Windows
fail-loudly fix, which is valuable independent of everything else); then the
higher-cost `DeviceKindSchema`/`Room.viewers` widening, timed to a milestone
boundary (M5/M6) rather than folded into F2's initial extraction.

### Migration strategy

The Windows fail-loudly fix (session.rs:424-458) can and should ship
immediately, independent of this entire audit's other findings — it's a
correctness bug with no dependency on F1's decomposition. Everything else in
this finding should land only after F1/F2 are in place, each as its own
small, reviewable PR adding one inert seam at a time, with an explicit
"nothing uses this yet" note in the PR description so reviewers don't
mistake seam-laying for feature work (which the mandate explicitly excludes).

### Testing strategy

Each seam gets a narrow test proving it's inert today: e.g. a test that
`CaptureConfig::default().display_id.is_none()` and that omitting the field
from a `session-start` payload still parses identically to today (protecting
against the optional-field addition accidentally becoming a required one).
For the Windows fail-loudly fix specifically: a test on a non-macOS `cfg`
target (or a refactored, OS-independent version of
`session_capture_kind`/`session_encoder_kind` that takes "is a real backend
available" as an injected parameter, so the logic is testable on any host)
asserting the function returns an error/refusal rather than a silent
`Synthetic` substitution when the dev override env var is absent.

### Risk assessment

Low for the additive/inert seams (by construction, they change no current
behavior). Medium for the `DeviceKindSchema` role rename specifically,
since it is the one wire-format change touching three codebases at once —
treat it as its own scheduled migration with its own rollout plan, not a
drive-by rename.

### Performance impact

None for the additive seams. The Windows fail-loudly fix has no performance
impact and is a pure safety improvement.

### Future extensibility

This finding's whole point: **F1 and F2 are the prerequisite, not an
alternative, to F10.** Landing the decomposition without also landing at
least the low-risk inert seams above means the next engineer who picks up
multi-monitor or multi-user work re-discovers exactly the same "which
`Option<T>` becomes a `Vec<T>`" problem this audit already mapped —
capturing the seam now, while the relevant code is already being touched for
F1/F2, is materially cheaper than re-deriving it cold in a later milestone.
