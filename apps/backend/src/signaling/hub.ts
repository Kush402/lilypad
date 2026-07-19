import { randomUUID } from 'node:crypto';
import {
  SignalingMessageSchema,
  BACKEND_HEARTBEAT_TIMEOUT_MS,
  BACKEND_REREGISTER_GRACE_MS,
  presenceRoomDeviceId,
  presenceRoomId,
  type SignalingMessage,
  type DeviceKind,
  type IceServer,
  type SessionScope,
} from '@lilypad/protocol';
import { TERMINAL_STATES, type SessionState } from '../session/stateMachine.js';
import type { RoomStore } from '../session/roomStore.js';
import { log } from '../logging.js';
import type { Peer } from './peer.js';
import { LifecyclePolicy } from './lifecyclePolicy.js';
import { MessageRouter } from './messageRouter.js';
import type { Room } from './room.js';
import { RoomRegistry } from './roomRegistry.js';

export type { Peer } from './peer.js';

/** Dependencies injected so the hub stays pure + testable. */
export interface SignalingHubDeps {
  /** Build STUN+TURN servers for one peer (fresh, time-limited credential). */
  buildIceServers: (label: string) => IceServer[];
  /** Fire-and-forget persistence hooks (the hub never awaits them). */
  onSessionStart?: (info: {
    sessionId: string;
    roomId: string;
    desktopDeviceId: string | null;
    mobileDeviceId: string | null;
    scopes: SessionScope[];
  }) => void;
  onStateChange?: (
    roomId: string,
    sessionId: string | undefined,
    from: SessionState,
    to: SessionState,
  ) => void;
  onSessionEnd?: (sessionId: string, reason: string) => void;
  /** Fired whenever a room is torn down, session or not — the hook for
   * cleaning up room-scoped external state (today: the room's
   * `RoomAuthStore` record, which must not outlive the room it guards —
   * see `docs/m5.4-trusted-devices-audit.md` BUG-1). */
  onRoomClosed?: (roomId: string) => void;
  /** Fired when an approval carried `trust: true` (M5.4) — the desktop user
   * checked "Trust this device." The route layer records the persistent
   * pair (`trusted_devices`) and delivers the connect secret back to the
   * mobile seat via `deliverPairSecret`; fire-and-forget. */
  onTrustEstablished?: (info: {
    roomId: string;
    desktopDeviceId: string;
    mobileDeviceId: string;
  }) => void;
  /** Fired when the desktop explicitly denies a pending pair request. The
   * room ends right here, before a session ever gets minted, so
   * `onSessionEnd` (only fired when `room.sessionId` is set — see
   * `endRoom`) never fires for this path; audit-log wiring for
   * `pair_denied` needs this dedicated hook instead. */
  onPairDenied?: (info: {
    roomId: string;
    desktopDeviceId: string | null;
    mobileDeviceId: string | null;
    reason: string | null;
  }) => void;
  now?: () => number;
  /** A peer is considered stale after this many ms without a heartbeat/message. */
  heartbeatTimeoutMs?: number;
  /** Mid-session transport drops: how long the seat waits for the same device
   * to re-register before the room is torn down. */
  reregisterGraceMs?: number;
  /** Hard cap on concurrent rooms — a global backstop against room-exhaustion
   * memory DoS even if per-IP limits are bypassed. */
  maxRooms?: number;
  /** Redis-backed room persistence, so a backend restart can resurrect every
   * room it was mid-session on (`resurrectRoomsFromStore`) instead of
   * silently dropping them. Optional: omitted (as in every existing test)
   * the hub behaves exactly as before — purely in-memory, no persistence
   * I/O anywhere on the hot path. See `docs/audit/m3/reconnect-lifecycle.md`
   * Finding 3. */
  roomStore?: RoomStore;
}

interface PeerCtx {
  roomId: string;
  role: DeviceKind;
  deviceId: string;
}

// Defaults derive from the shared cross-tier timing budget in
// `@lilypad/protocol` (docs/audit/m3/reconnect-lifecycle.md Finding 6) rather
// than being tuned independently here — both client tiers' heartbeat/backoff
// schedules are sized against these SAME values.
const DEFAULT_HEARTBEAT_TIMEOUT_MS = BACKEND_HEARTBEAT_TIMEOUT_MS;
const DEFAULT_REREGISTER_GRACE_MS = BACKEND_REREGISTER_GRACE_MS;
const DEFAULT_MAX_ROOMS = 10_000;

/**
 * Room-routed signaling. Each room has exactly two seats (desktop + mobile).
 * The hub relays offer/answer/ICE, brokers approve/deny, drives the session
 * state machine, and never trusts a client — every inbound frame is validated
 * and every sender's identity is checked against its registered seat.
 *
 * A thin orchestrator: the room aggregate (`Room`), the room map + capacity
 * policy (`RoomRegistry`), the pure message-routing decisions
 * (`MessageRouter`), and the reaping/shutdown policy (`LifecyclePolicy`) each
 * live in their own collaborating unit — see `docs/audit/m3/architecture.md`
 * (Finding F2) for the full before/after rationale. This class's own job is
 * just: parse + validate the inbound frame, look up the room, ask the router
 * what should happen, and execute it (the only piece that touches `Peer.send`/
 * `Peer.close` and the persistence hooks).
 */
export class SignalingHub {
  private readonly ctx = new Map<Peer, PeerCtx>();
  private readonly now: () => number;
  private readonly maxRooms: number;
  private readonly registry: RoomRegistry;
  private readonly router = new MessageRouter();
  private readonly lifecycle: LifecyclePolicy;
  // Monotonic operational counters (never reset) for the /metrics endpoint.
  private readonly counters = {
    sessionsStarted: 0,
    sessionsEnded: 0,
    roomsRejectedAtCapacity: 0,
    peersReaped: 0,
  };

  constructor(private readonly deps: SignalingHubDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.maxRooms = deps.maxRooms ?? DEFAULT_MAX_ROOMS;
    this.registry = new RoomRegistry(this.maxRooms);
    this.lifecycle = new LifecyclePolicy(
      this.registry,
      deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      deps.reregisterGraceMs ?? DEFAULT_REREGISTER_GRACE_MS,
      this.now,
    );
  }

  /** Operational snapshot for the /metrics endpoint. `activeRooms` is live
   * gauge; the rest are monotonic counters. */
  metricsSnapshot(): {
    activeRooms: number;
    sessionsStarted: number;
    sessionsEnded: number;
    roomsRejectedAtCapacity: number;
    peersReaped: number;
  } {
    return { activeRooms: this.registry.size, ...this.counters };
  }

  /** Whether this peer has claimed a room seat. The transport layer uses this
   * to close sockets that connect but never register. */
  isRegistered(peer: Peer): boolean {
    return this.ctx.has(peer);
  }

  /** Handle a raw inbound frame from a peer. Never throws on bad input. */
  handleMessage(peer: Peer, raw: unknown): void {
    const parsed = SignalingMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(peer, 'bad_message', 'malformed signaling frame');
      return;
    }
    const msg = parsed.data;
    const existing = this.ctx.get(peer);

    // The first valid frame must register the peer into a room seat.
    if (!existing) {
      if (msg.type !== 'register') {
        this.sendError(peer, 'not_registered', 'send a register message first');
        return;
      }
      this.register(peer, msg);
      return;
    }

    // Anti-spoof: the claimed `from` must match the registered seat.
    if (msg.from !== existing.role) {
      this.sendError(peer, 'role_mismatch', `sender is registered as ${existing.role}`);
      return;
    }
    if (msg.roomId !== existing.roomId) {
      this.sendError(peer, 'wrong_room', 'roomId does not match your registration');
      return;
    }

    const room = this.registry.get(existing.roomId);
    if (!room) {
      this.sendError(peer, 'no_room', 'room no longer exists');
      return;
    }
    room.bumpLastSeen(existing.role, this.now());
    this.executeRoute(room, existing.role, msg);
    // Covers every routed mutation uniformly (approve, answer's `established`
    // flip, FSM transitions, …) with one call site instead of one per case.
    // `endRoom` (itself reachable from an 'end' action above) deletes the
    // record instead — persisting a room this call just removed would just
    // resurrect a dead room on the next restart.
    if (this.registry.get(room.id)) this.persistRoom(room);
  }

  /** A peer's transport closed. Mid-session the seat is held for the same
   * device to re-register within the grace window — a transient WS drop must
   * not kill a stream that flows peer-to-peer regardless. Outside a live
   * session, signaling IS the session, so the room ends immediately. */
  handleClose(peer: Peer): void {
    const c = this.ctx.get(peer);
    if (!c) return;
    this.ctx.delete(peer);
    const room = this.registry.get(c.roomId);
    if (!room) return;
    room.clearSeat(c.role);

    // Once established, a dropped signaling socket never ends the session on
    // its own: media + input flow peer-to-peer, so we hold the seat and keep
    // the room alive as long as the OTHER peer isn't gone for good. The room
    // ends synchronously only on an explicit `disconnect`, or once the other
    // seat is confirmed gone (never here, or its own grace already elapsed).
    //
    // Deliberately NOT `!room.hasSeat(other)`: a disruption that drops both
    // seats within milliseconds of each other (a router restart is the
    // textbook case) would otherwise have the second `handleClose` see the
    // first seat's freshly-empty slot and tear the room down instantly,
    // skipping the grace window entirely. `isSeatGoneForGood` tells "never
    // here" apart from "just left, still within grace" — the latter is left
    // for `reapStale`'s periodic sweep (`LifecyclePolicy.findGraceExpired`)
    // to reconcile, which is the single source of truth for "both eventually
    // expired." See `docs/audit/m3/reconnect-lifecycle.md` Finding 2.
    if (room.isEstablished()) {
      room.markVacated(c.role, this.now());
      const other = room.otherRole(c.role);
      if (this.lifecycle.isSeatGoneForGood(room, other)) {
        this.endRoom(room, `${c.role} disconnected`);
        return;
      }
      log.signaling.info(
        { roomId: room.id, role: c.role },
        'mid-session transport drop — holding seat, session continues peer-to-peer',
      );
      return;
    }
    this.endRoom(room, `${c.role} disconnected`);
  }

  /** Reap peers that stopped sending heartbeats, and rooms whose vacated
   * mid-session seat was never re-taken. Call on an interval. */
  reapStale(): void {
    for (const { room, reason } of this.lifecycle.findGraceExpired()) {
      this.endRoom(room, reason);
    }
    for (const { room, role, peer } of this.lifecycle.findHeartbeatStale()) {
      log.signaling.warn({ roomId: room.id, role }, 'heartbeat timeout — reaping peer');
      this.counters.peersReaped++;
      peer.close(4408, 'heartbeat timeout');
      this.handleClose(peer);
    }
  }

  /** Graceful shutdown: tell every live peer WHY (session-end) and close its
   * socket, so a clean deploy is distinguishable from a fault. */
  shutdownAll(reason: string): void {
    for (const room of this.registry.all()) {
      this.endRoom(room, reason);
    }
  }

  roomCount(): number {
    return this.registry.size;
  }

  /** Is this desktop's presence seat currently online? */
  isDesktopPresent(desktopDeviceId: string): boolean {
    return this.registry.get(presenceRoomId(desktopDeviceId))?.hasSeat('desktop') ?? false;
  }

  /** Deliver the per-pair connect secret to a room's mobile seat (M5.4
   * security). Called after the async trust write; the mobile is in the room
   * (it just received session-start), so the seat exists. Best-effort — if
   * the phone's socket flapped and missed it, a later connect fails the
   * secret check and the phone re-pairs. */
  deliverPairSecret(roomId: string, secret: string): void {
    const room = this.registry.get(roomId);
    if (!room) return;
    this.send(room, 'mobile', { type: 'pair-secret', payload: { secret } });
  }

  /** Deliver a `connect-request` to a desktop's presence seat (M5.4 no-QR
   * reconnect). Returns false when the desktop is offline — the caller
   * turns that into an honest "desktop is offline" for the phone. */
  notifyConnectRequest(
    desktopDeviceId: string,
    payload: Extract<SignalingMessage, { type: 'connect-request' }>['payload'],
  ): boolean {
    const room = this.registry.get(presenceRoomId(desktopDeviceId));
    if (!room || !room.hasSeat('desktop')) return false;
    this.send(room, 'desktop', { type: 'connect-request', payload });
    return true;
  }

  /** One-time boot-time resurrection: load every non-terminal room record a
   * prior process persisted and re-seed the in-memory registry with it,
   * BEFORE the server starts accepting connections (call this from the
   * signaling route's async setup, awaited). Returns the number resurrected.
   *
   * Deliberately the only async method on this class — the whole point is
   * to keep `register`/`handleMessage` themselves fully synchronous, so a
   * client's `register` never risks racing against an in-flight Redis read
   * for the SAME peer's next message. See `RoomStore`'s doc comment for why
   * this only covers a full-process restart, not a live multi-replica
   * deployment. */
  async resurrectRoomsFromStore(): Promise<number> {
    if (!this.deps.roomStore) return 0;
    const records = await this.deps.roomStore.loadAll();
    let count = 0;
    for (const record of records) {
      if (TERMINAL_STATES.includes(record.fsmState)) continue; // already over — nothing to resurrect
      const inserted = this.registry.resurrect(record, this.now(), (roomId, sessionId, from, to) =>
        this.deps.onStateChange?.(roomId, sessionId, from, to),
      );
      if (inserted) count++;
    }
    return count;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private register(peer: Peer, msg: Extract<SignalingMessage, { type: 'register' }>): void {
    const role = msg.payload.role;
    if (msg.from !== role) {
      this.sendError(peer, 'role_mismatch', 'register.from must equal payload.role');
      return;
    }

    const outcome = this.registry.getOrCreate(msg.roomId, (roomId, sessionId, from, to) =>
      this.deps.onStateChange?.(roomId, sessionId, from, to),
    );
    if ('rejected' in outcome) {
      this.counters.roomsRejectedAtCapacity++;
      log.signaling.warn(
        { roomId: msg.roomId, maxRooms: this.maxRooms },
        'room cap reached — rejecting register',
      );
      this.sendError(peer, 'capacity', 'server at capacity, try again later');
      peer.close(4429, 'server at capacity');
      return;
    }
    const { room } = outcome;

    const result = room.registerSeat(role, peer, msg.payload.deviceId, this.now());
    if (!result.ok) {
      const message =
        result.reason === 'seat_taken'
          ? `the ${role} seat is already occupied`
          : `the ${role} seat is reserved for the disconnected device`;
      this.sendError(peer, result.reason, message);
      peer.close(4409, result.reason === 'seat_taken' ? 'seat taken' : 'seat reserved');
      return;
    }
    if (result.reclaimed) {
      log.signaling.info({ roomId: msg.roomId, role }, 'peer re-registered within grace');
    }
    if (result.evicted) {
      // Same-device reconnect over a zombie socket: drop our context for the
      // stale transport BEFORE closing it, so its close event finds no ctx
      // and cannot clear the seat the new transport now holds.
      this.ctx.delete(result.evicted);
      result.evicted.close(4408, 'superseded by same-device reconnect');
      log.signaling.info(
        { roomId: msg.roomId, role },
        'zombie socket evicted by same-device reconnect',
      );
    }
    this.ctx.set(peer, { roomId: msg.roomId, role, deviceId: msg.payload.deviceId });
    log.signaling.info({ roomId: msg.roomId, role }, 'peer registered');

    // A mobile (re)claiming its seat AFTER approval but BEFORE the session
    // established missed its `session-start` — its socket flapped across the
    // exact delivery window, and nothing else ever re-sends it. Observed
    // live (M5.4 bring-up): phone stuck on "Waiting for approval…" while
    // the desktop's offer sat unanswered until the recovery deadline killed
    // the room. Re-issue to THIS seat only, with fresh ICE credentials.
    // Mobile-only: the desktop authored the approval (it can't miss it),
    // and its client treats session-start as a fresh negotiation — safe
    // here for the phone precisely because no answer exists yet.
    if (room.sessionId && !room.isEstablished() && role === 'mobile') {
      this.send(room, role, {
        type: 'session-start',
        payload: {
          sessionId: room.sessionId,
          grantedScopes: room.scopes,
          iceServers: this.deps.buildIceServers(`${room.sessionId}:${role}:rejoin`),
        },
      });
      log.signaling.info(
        { roomId: room.id, role },
        're-issued session-start to a rejoining pre-established seat',
      );
    }

    // Desktop present → move out of idle so a pairing can proceed.
    if (role === 'desktop') room.tryFsm('pairing');
    this.persistRoom(room);
  }

  /** Best-effort write-behind persistence — never awaited, never throws into
   * the caller. A Redis outage degrades resurrection capability only; it
   * must never block or fail live signaling relay, which doesn't touch
   * Redis at all.
   *
   * Presence rooms are never persisted: they mirror a live socket, not a
   * session — after a restart the desktop's own reconnect loop re-registers
   * and recreates its room, and resurrecting a stale one would only assert
   * presence nobody holds. */
  private persistRoom(room: Room): void {
    if (!this.deps.roomStore) return;
    if (presenceRoomDeviceId(room.id) !== null) return;
    this.deps.roomStore
      .save(room.toRecord())
      .catch((err) => log.signaling.warn({ err, roomId: room.id }, 'room persistence failed'));
  }

  /** Ask the router what this message means for the room, then execute each
   * resulting action — the only place `Peer.send`/`Peer.close` happen for
   * routed traffic. */
  private executeRoute(room: Room, from: DeviceKind, msg: SignalingMessage): void {
    for (const action of this.router.route(room, from, msg)) {
      switch (action.kind) {
        case 'relay':
          this.relay(room, action.to, action.msg);
          break;
        case 'respond':
          this.send(room, action.to, { type: action.type, payload: action.payload });
          break;
        case 'approve':
          this.approve(room, action.grantedScopes, action.trust);
          break;
        case 'end':
          this.endRoom(room, action.reason);
          // `endRoom` only fires `onSessionEnd` when a session was already
          // minted (`room.sessionId` set by `approve()`); a pair-denied room
          // never got that far, so fire the dedicated audit hook here.
          if (msg.type === 'pair-denied') {
            this.deps.onPairDenied?.({
              roomId: room.id,
              desktopDeviceId: room.deviceIdFor('desktop') ?? null,
              mobileDeviceId: room.deviceIdFor('mobile') ?? null,
              reason: msg.payload.reason,
            });
          }
          break;
        case 'reject':
          this.sendErrorToRoom(room, action.to, action.code, action.message);
          break;
      }
    }
  }

  private approve(room: Room, grantedScopes: SessionScope[], trust: boolean): void {
    room.tryFsm('connecting');
    const sessionId = randomUUID();
    room.sessionId = sessionId;
    room.scopes = grantedScopes;
    this.counters.sessionsStarted++;

    // "Trust this device" rode on the approval (M5.4): record the persistent
    // pair. Both ids are present — the router only approves with both seats
    // occupied — but stay defensive since the hook writes durable state.
    if (trust) {
      const desktopDeviceId = room.deviceIdFor('desktop');
      const mobileDeviceId = room.deviceIdFor('mobile');
      if (desktopDeviceId && mobileDeviceId) {
        this.deps.onTrustEstablished?.({ roomId: room.id, desktopDeviceId, mobileDeviceId });
      }
    }

    this.deps.onSessionStart?.({
      sessionId,
      roomId: room.id,
      desktopDeviceId: room.deviceIdFor('desktop') ?? null,
      mobileDeviceId: room.deviceIdFor('mobile') ?? null,
      scopes: grantedScopes,
    });

    // Each peer gets its own fresh time-limited ICE credentials.
    for (const role of ['desktop', 'mobile'] as const) {
      this.send(room, role, {
        type: 'session-start',
        payload: {
          sessionId,
          grantedScopes,
          iceServers: this.deps.buildIceServers(`${sessionId}:${role}`),
        },
      });
    }
    log.session.info({ roomId: room.id, sessionId }, 'session approved, ICE issued');
  }

  private relay(room: Room, to: DeviceKind, msg: SignalingMessage): void {
    const target = room.seat(to);
    if (!target) {
      log.signaling.debug({ roomId: room.id, to, type: msg.type }, 'relay dropped: peer absent');
      return;
    }
    target.send(msg);
  }

  private endRoom(room: Room, reason: string): void {
    if (!room.fsmIsTerminal()) room.tryFsm('disconnected');
    if (room.sessionId) {
      this.counters.sessionsEnded++;
      this.deps.onSessionEnd?.(room.sessionId, reason);
    }
    for (const { role, peer } of room.occupiedSeats()) {
      // Tell the peer WHY before the socket closes — a bare transport close
      // is indistinguishable from a network fault on the client side.
      this.send(room, role, { type: 'session-end', payload: { reason } });
      this.ctx.delete(peer);
      peer.close(1000, reason);
    }
    this.registry.remove(room.id);
    if (this.deps.roomStore) {
      this.deps.roomStore
        .delete(room.id)
        .catch((err) => log.signaling.warn({ err, roomId: room.id }, 'room record delete failed'));
    }
    this.deps.onRoomClosed?.(room.id);
    log.signaling.info({ roomId: room.id, reason }, 'room closed');
  }

  /** Send a fully-formed message to a room seat, stamping the envelope. */
  private send(
    room: Room,
    to: DeviceKind,
    partial: { type: SignalingMessage['type']; payload: unknown },
  ): void {
    const peer = room.seat(to);
    if (!peer) return;
    peer.send({
      type: partial.type,
      roomId: room.id,
      from: to === 'desktop' ? 'mobile' : 'desktop', // server speaks as the counterpart's channel
      ts: this.now(),
      payload: partial.payload,
    } as SignalingMessage);
  }

  private sendError(peer: Peer, code: string, message: string): void {
    log.signaling.warn({ code, message }, 'signaling error to peer');
    peer.send({
      type: 'error',
      roomId: '',
      from: 'desktop',
      ts: this.now(),
      payload: { code, message },
    });
  }

  private sendErrorToRoom(room: Room, to: DeviceKind, code: string, message: string): void {
    const peer = room.seat(to);
    if (peer) this.sendError(peer, code, message);
  }
}
