import type { DeviceKind } from '@lilypad/protocol';
import type { Peer } from './peer.js';
import type { Room } from './room.js';
import type { RoomRegistry } from './roomRegistry.js';

export interface GraceExpiry {
  room: Room;
  role: DeviceKind;
  reason: string;
}

export interface HeartbeatTimeout {
  room: Room;
  role: DeviceKind;
  peer: Peer;
}

/**
 * Staleness policy, extracted from `SignalingHub.reapStale`'s two
 * independent sweeps (grace-cutoff, heartbeat-cutoff) that used to mutate
 * the same `rooms` map inside one method. These methods only *identify* what
 * needs reaping — the orchestrator still performs the actual teardown I/O
 * (`peer.close`, `endRoom`'s persistence hook + counters), since none of
 * that belongs in a policy object.
 */
export class LifecyclePolicy {
  constructor(
    private readonly registry: RoomRegistry,
    private readonly heartbeatTimeoutMs: number,
    private readonly reregisterGraceMs: number,
    private readonly now: () => number,
  ) {}

  /** Rooms whose vacated seat exceeded its re-register grace AND whose other
   * seat is also empty — i.e. genuinely nothing left to serve, not just a
   * seat waiting on a same-device reconnect while a live partner streams on. */
  findGraceExpired(): GraceExpiry[] {
    const cutoff = this.now() - this.reregisterGraceMs;
    const result: GraceExpiry[] = [];
    for (const room of this.registry.all()) {
      for (const role of ['desktop', 'mobile'] as const) {
        if (room.isVacatedPastGrace(role, cutoff) && !room.hasSeat(room.otherRole(role))) {
          result.push({ room, role, reason: `${role} did not re-register within grace` });
          break;
        }
      }
    }
    return result;
  }

  /** Is `role`'s seat gone for good — never part of this room, or vacated
   * past its OWN re-register grace window? Used by `SignalingHub.handleClose`
   * to decide whether a just-vacated peer's counterpart justifies ending the
   * room synchronously, versus holding it for `findGraceExpired`'s periodic
   * sweep to reconcile once its own grace elapses.
   *
   * This exists because testing CURRENT occupancy alone (`!room.hasSeat(role)`)
   * can't distinguish "never here" from "just left, still within grace" — a
   * disruption that drops both seats within milliseconds of each other (a
   * router restart is the textbook case) must not have the second
   * `handleClose` treat the first seat's freshly-empty slot as "abandoned."
   * See `docs/audit/m3/reconnect-lifecycle.md` Finding 2. */
  isSeatGoneForGood(room: Room, role: DeviceKind): boolean {
    if (room.deviceIdFor(role) === undefined) return true;
    const cutoff = this.now() - this.reregisterGraceMs;
    return room.isVacatedPastGrace(role, cutoff);
  }

  /** Seats that stopped heart-beating. Bumps `lastSeen` as it finds each one
   * (avoids double-firing for the same peer before its `close()` lands) —
   * matches the original's exact ordering. */
  findHeartbeatStale(): HeartbeatTimeout[] {
    const cutoff = this.now() - this.heartbeatTimeoutMs;
    const result: HeartbeatTimeout[] = [];
    for (const room of this.registry.all()) {
      for (const role of ['desktop', 'mobile'] as const) {
        if (room.isHeartbeatStale(role, cutoff)) {
          const peer = room.seat(role);
          if (peer) {
            room.bumpLastSeen(role, this.now());
            result.push({ room, role, peer });
          }
        }
      }
    }
    return result;
  }
}
