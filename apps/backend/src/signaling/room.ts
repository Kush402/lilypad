import type { DeviceKind, SessionScope, SignalingMessage } from '@lilypad/protocol';
import { SessionStateMachine, type SessionState } from '../session/stateMachine.js';
import type { RoomRecord } from '../session/roomStore.js';
import type { Peer } from './peer.js';

/** Outcome of claiming a seat. Failure reasons mirror the wire error codes
 * `SignalingHub` sends back to a rejected peer. */
export type SeatResult =
  | { ok: true; reclaimed: boolean; evicted?: Peer }
  | { ok: false; reason: 'seat_taken' | 'seat_reserved' };

/** Matches `SignalingHubDeps.onStateChange`'s shape. */
export type RoomStateChangeListener = (
  roomId: string,
  sessionId: string | undefined,
  from: SessionState,
  to: SessionState,
) => void;

/**
 * The room aggregate: two seats (desktop + mobile), their device identities,
 * liveness bookkeeping, and the session FSM — with the invariants that
 * `SignalingHub` used to enforce ad hoc from six different methods now owned
 * in one place (e.g. a seat can't be both vacated and currently occupied;
 * `established` only flips one way). Pure data + rules, no I/O — nothing in
 * here calls `Peer.send`/`Peer.close`.
 */
export class Room {
  private readonly peers: Partial<Record<DeviceKind, Peer>> = {};
  private readonly deviceIds: Partial<Record<DeviceKind, string>> = {};
  private readonly lastSeen: Partial<Record<DeviceKind, number>> = {};
  private readonly vacatedAt: Partial<Record<DeviceKind, number>> = {};
  private establishedFlag = false;

  public scopes: SessionScope[] = ['view'];
  public sessionId?: string;

  /**
   * Frames addressed to a seat that had not attached yet, replayed the moment
   * it does. Same job as LAN `pending_desktop`: the phone has the room id the
   * instant `/connect/request` returns, while a takeover desktop may still be
   * tearing down the previous runner (`SESSION_TEARDOWN_WAIT`). Dropping that
   * `pair-request` is how Ring-while-Active hung on "Waiting for approval…".
   */
  private readonly pending: Partial<Record<DeviceKind, SignalingMessage[]>> = {};

  private constructor(
    public readonly id: string,
    private readonly fsm: SessionStateMachine,
  ) {}

  /** `onStateChange` is called with this room's CURRENT `sessionId` at the
   * moment of each transition (not a snapshot taken at construction) — the
   * session id is only minted later, on approval. */
  static create(id: string, onStateChange: RoomStateChangeListener): Room {
    // `self` is referenced inside the closure below before its own
    // declaration runs — legal, since closures resolve bindings by
    // reference at CALL time (a transition, always after `create` returns),
    // not at the time the closure literal is written.
    const fsm = new SessionStateMachine('idle', (from, to) =>
      onStateChange(id, self?.sessionId, from, to),
    );
    const self = new Room(id, fsm);
    return self;
  }

  /** Rebuild a room from a `RoomRecord` a prior process persisted to Redis —
   * used only at boot (`SignalingHub.resurrectRoomsFromStore`), never on the
   * per-message hot path. Both `Peer` slots start empty (a WebSocket to the
   * OLD process can't survive regardless), and both device slots that WERE
   * occupied are marked vacated `now` — from this process's point of view a
   * resurrected seat vacated at the moment of resurrection, and it gets the
   * SAME grace window any other mid-session drop would (see
   * `SignalingHub.handleClose`/`LifecyclePolicy.isSeatGoneForGood`). */
  static resurrect(record: RoomRecord, now: number, onStateChange: RoomStateChangeListener): Room {
    const fsm = new SessionStateMachine(record.fsmState, (from, to) =>
      onStateChange(record.id, self?.sessionId, from, to),
    );
    const self = new Room(record.id, fsm);
    self.sessionId = record.sessionId;
    self.scopes = record.scopes;
    self.establishedFlag = record.established;
    for (const role of ['desktop', 'mobile'] as const) {
      const deviceId = record.deviceIds[role];
      if (deviceId !== undefined) {
        self.deviceIds[role] = deviceId;
        self.vacatedAt[role] = now;
      }
    }
    return self;
  }

  /** Snapshot for `RoomStore.save` — everything needed to resurrect this
   * room later, minus the live `Peer` handles (never serializable). */
  toRecord(): Omit<RoomRecord, 'updatedAt'> {
    return {
      id: this.id,
      fsmState: this.fsm.state,
      sessionId: this.sessionId,
      scopes: this.scopes,
      deviceIds: { ...this.deviceIds },
      established: this.establishedFlag,
    };
  }

  // ── seats ──────────────────────────────────────────────────────────────

  seat(role: DeviceKind): Peer | undefined {
    return this.peers[role];
  }

  hasSeat(role: DeviceKind): boolean {
    return this.peers[role] !== undefined;
  }

  deviceIdFor(role: DeviceKind): string | undefined {
    return this.deviceIds[role];
  }

  otherRole(role: DeviceKind): DeviceKind {
    return role === 'desktop' ? 'mobile' : 'desktop';
  }

  /** Every currently-occupied seat, for teardown/broadcast (send + close to
   * every present peer). */
  occupiedSeats(): Array<{ role: DeviceKind; peer: Peer }> {
    const result: Array<{ role: DeviceKind; peer: Peer }> = [];
    for (const role of ['desktop', 'mobile'] as const) {
      const peer = this.peers[role];
      if (peer) result.push({ role, peer });
    }
    return result;
  }

  /** Claim a seat for `peer`. Rejects a seat already held by a DIFFERENT
   * device, and a vacated-but-still-in-grace seat claimed by a different
   * device than the one that held it — otherwise the grace window would be a
   * seat-hijack window. `reclaimed` tells the caller whether this was a
   * same-device re-registration within grace (worth a log line), vs. a
   * fresh claim.
   *
   * A seat held by the SAME device on a different `Peer` is a zombie-socket
   * replacement, not a conflict: the client's old transport died without the
   * server noticing (no close event yet, heartbeat not yet stale) and the
   * client reconnected. Newest transport wins — seat it and hand the stale
   * `Peer` back as `evicted` for the orchestrator to close. Rejecting here
   * strands the client permanently (observed live on cellular-through-
   * tunnel: the dropped phone burned its whole 4-attempt/~7.5s reconnect
   * budget on `seat_taken` rejections while the zombie sat un-reaped for
   * 25s — the retry budget can never outlast the heartbeat timeout).
   * Device identity is trusted here exactly as far as the grace-reclaim
   * check below trusts it: `deviceId` was already verified against the
   * pairing-time Redis binding by the register gate (`registerAuth.ts`). */
  registerSeat(role: DeviceKind, peer: Peer, deviceId: string, now: number): SeatResult {
    const current = this.peers[role];
    if (current && current !== peer) {
      if (this.deviceIds[role] !== deviceId) {
        return { ok: false, reason: 'seat_taken' };
      }
      this.peers[role] = peer;
      this.lastSeen[role] = now;
      delete this.vacatedAt[role];
      return { ok: true, reclaimed: false, evicted: current };
    }
    const reclaimed = this.vacatedAt[role] !== undefined;
    if (reclaimed && this.deviceIds[role] !== deviceId) {
      return { ok: false, reason: 'seat_reserved' };
    }
    if (reclaimed) {
      delete this.vacatedAt[role];
    }
    this.peers[role] = peer;
    this.deviceIds[role] = deviceId;
    this.lastSeen[role] = now;
    return { ok: true, reclaimed };
  }

  /** Transport dropped: clear the seat. Does not, by itself, decide whether
   * the room should hold it for grace — that's `markVacated`, a separate
   * call the orchestrator makes only when `isEstablished()`. */
  clearSeat(role: DeviceKind): void {
    this.peers[role] = undefined;
  }

  markVacated(role: DeviceKind, now: number): void {
    this.vacatedAt[role] = now;
  }

  isVacatedPastGrace(role: DeviceKind, cutoff: number): boolean {
    const vacated = this.vacatedAt[role];
    return vacated !== undefined && vacated < cutoff;
  }

  // ── liveness ───────────────────────────────────────────────────────────

  bumpLastSeen(role: DeviceKind, now: number): void {
    this.lastSeen[role] = now;
  }

  isHeartbeatStale(role: DeviceKind, cutoff: number): boolean {
    const peer = this.peers[role];
    const seen = this.lastSeen[role];
    return peer !== undefined && seen !== undefined && seen < cutoff;
  }

  // ── session establishment ──────────────────────────────────────────────

  /** Set once the media session is established (mobile `answer` received).
   * From then on the room ends only on an explicit `disconnect` or when BOTH
   * peers are gone — a one-sided signaling drop must not kill a stream that
   * flows peer-to-peer. */
  isEstablished(): boolean {
    return this.establishedFlag;
  }

  markEstablished(): void {
    this.establishedFlag = true;
  }

  // ── pending relay ──────────────────────────────────────────────────────

  static readonly MAX_PENDING = 32;

  /** Queue a frame for a seat that is not here yet. Returns false if the
   * buffer is full — the caller must not treat that as delivered. */
  enqueuePending(role: DeviceKind, msg: SignalingMessage): boolean {
    const q = (this.pending[role] ??= []);
    if (q.length >= Room.MAX_PENDING) return false;
    q.push(msg);
    return true;
  }

  takePending(role: DeviceKind): SignalingMessage[] {
    const q = this.pending[role] ?? [];
    this.pending[role] = [];
    return q;
  }

  // ── FSM ────────────────────────────────────────────────────────────────

  fsmState(): SessionState {
    return this.fsm.state;
  }

  fsmIsTerminal(): boolean {
    return this.fsm.isTerminal();
  }

  /** Attempt the transition; returns whether it was legal. Callers MUST
   * check the result (this is the exact safety `tryTransition` already
   * provides — the point of extracting `Room` is to stop discarding it). */
  tryFsm(to: SessionState): boolean {
    return this.fsm.tryTransition(to);
  }
}
