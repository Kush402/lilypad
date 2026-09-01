import type { DeviceKind } from '@lilypad/protocol';
import { presenceRoomDeviceId } from '@lilypad/protocol';
import type { RoomRecord } from '../session/roomStore.js';
import { Room, type RoomStateChangeListener } from './room.js';

/** Default global room cap (each room ≈ two seats). Generous for a single
 * backend instance; primarily a DoS backstop, not a capacity target. */
const DEFAULT_MAX_ROOMS = 10_000;

/** Shared, never-mutated empty set — `roomIdsForDevice` returns this instead
 * of allocating a fresh empty `Set` on every miss (the common case for most
 * device ids most of the time). */
const EMPTY_ROOM_IDS: ReadonlySet<string> = new Set();

/**
 * Owns the room `Map` and the one policy attached to its shape: a hard cap on
 * concurrent rooms (a global backstop against room-exhaustion memory DoS
 * even if per-IP limits are bypassed). Moved verbatim from
 * `SignalingHub.register`'s capacity check.
 *
 * Also owns a secondary index — `${DeviceKind}:${deviceId}` → the set of
 * roomIds where that device currently holds that role's seat — so
 * `SignalingHub.hasLiveSession`/`findLiveSessionForPair` no longer have to
 * linearly scan every active room per lookup (`GET /devices` calls
 * `hasLiveSession` once per device row; a platform-wide scan per row was
 * O(devices × all rooms) on an endpoint the mobile app hits every load — see
 * the audit finding this index exists to fix).
 *
 * Index invariant, and why it needs so few update points: a room's seat
 * deviceId, once set, can never change to a DIFFERENT device for that room's
 * lifetime — `Room.registerSeat` refuses a different device the seat, both
 * live (`seat_taken`) and vacated-in-grace (`seat_reserved`). So the index
 * only ever needs an ADD (`indexSeat`, idempotent — safe to call on every
 * successful register, including a same-device zombie-socket reconnect or a
 * grace reclaim) at the two places a seat's deviceId is first set
 * (`Room.registerSeat` via `indexSeat`, and boot-time `resurrect` below), and
 * a bulk REMOVE at the one place a room ever stops existing (`remove`,
 * itself only ever called from `SignalingHub.endRoom`). Presence rooms are
 * never indexed — same exclusion `hasLiveSession` has always applied, since
 * they mirror a live socket, not a session.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly maxRooms: number;
  private readonly deviceIndex = new Map<string, Set<string>>();

  constructor(maxRooms?: number) {
    this.maxRooms = maxRooms ?? DEFAULT_MAX_ROOMS;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  /** Look up an existing room, or create one — unless that would exceed the
   * cap, in which case the caller must reject the register attempt. */
  getOrCreate(
    id: string,
    onStateChange: RoomStateChangeListener,
  ): { room: Room } | { rejected: 'capacity' } {
    const existing = this.rooms.get(id);
    if (existing) return { room: existing };
    if (this.rooms.size >= this.maxRooms) {
      return { rejected: 'capacity' };
    }
    const room = Room.create(id, onStateChange);
    this.rooms.set(id, room);
    return { room };
  }

  /** Removes the room AND drops it from the device index — the only place a
   * room's entries ever leave the index, which is what lets `indexSeat`
   * below add unconditionally without ever worrying about a stale roomId
   * surviving past the room it named. */
  remove(id: string): void {
    const room = this.rooms.get(id);
    if (room) this.dropFromIndex(room);
    this.rooms.delete(id);
  }

  /** Insert a room resurrected from a `RoomRecord` (boot-time only — see
   * `SignalingHub.resurrectRoomsFromStore`). Returns false, refusing to
   * insert, if a room with this id is already registered (a live room
   * always wins over a stale resurrection candidate) or the cap is reached.
   * Indexes whichever device ids the record carried — a resurrected room's
   * seats are populated directly from the record (`Room.resurrect`), not
   * through `Room.registerSeat`, so this is a SEPARATE mutation point that
   * needs its own index update rather than reusing `indexSeat`. */
  resurrect(record: RoomRecord, now: number, onStateChange: RoomStateChangeListener): boolean {
    if (this.rooms.has(record.id) || this.rooms.size >= this.maxRooms) return false;
    const room = Room.resurrect(record, now, onStateChange);
    this.rooms.set(record.id, room);
    if (presenceRoomDeviceId(record.id) === null) {
      for (const role of ['desktop', 'mobile'] as const) {
        const deviceId = room.deviceIdFor(role);
        if (deviceId !== undefined) this.addToIndex(role, deviceId, record.id);
      }
    }
    return true;
  }

  /** Record that `deviceId` now holds `role`'s seat in room `roomId`. Called
   * by `SignalingHub` right after every successful `Room.registerSeat` —
   * unconditionally, regardless of which of `registerSeat`'s success
   * branches ran (fresh claim, grace reclaim, or same-device zombie-socket
   * eviction), since adding an already-present roomId to a `Set` is a no-op
   * and a device id can never actually change for an existing room+role (see
   * the class doc comment). Presence rooms are never indexed. */
  indexSeat(roomId: string, role: DeviceKind, deviceId: string): void {
    if (presenceRoomDeviceId(roomId) !== null) return;
    this.addToIndex(role, deviceId, roomId);
  }

  /** O(1): is `deviceId` (as `role`) seated in ANY non-presence room right
   * now? "Seated" matches `Room.deviceIdFor`'s notion, not live-socket
   * presence — a vacated-but-in-grace seat still counts, exactly as the
   * linear scan this replaces always did (see `SignalingHub.hasLiveSession`'s
   * doc comment). Only `remove` (the room actually ending) clears an entry. */
  hasIndexedDevice(role: DeviceKind, deviceId: string): boolean {
    return (this.deviceIndex.get(RoomRegistry.indexKey(role, deviceId))?.size ?? 0) > 0;
  }

  /** The roomIds where `deviceId` currently holds `role`'s seat — for
   * `SignalingHub.findLiveSessionForPair`'s pair intersection. Never mutate
   * the returned set (it's the index's own backing `Set`, not a copy). */
  roomIdsForDevice(role: DeviceKind, deviceId: string): ReadonlySet<string> {
    return this.deviceIndex.get(RoomRegistry.indexKey(role, deviceId)) ?? EMPTY_ROOM_IDS;
  }

  /** Snapshot: callers that mutate the registry (ending rooms) while
   * iterating must not iterate the live `Map` — mutating a `Map` during its
   * own `for..of` can skip entries. */
  all(): Room[] {
    return [...this.rooms.values()];
  }

  get size(): number {
    return this.rooms.size;
  }

  private static indexKey(role: DeviceKind, deviceId: string): string {
    return `${role}:${deviceId}`;
  }

  private addToIndex(role: DeviceKind, deviceId: string, roomId: string): void {
    const key = RoomRegistry.indexKey(role, deviceId);
    let set = this.deviceIndex.get(key);
    if (!set) {
      set = new Set();
      this.deviceIndex.set(key, set);
    }
    set.add(roomId);
  }

  private dropFromIndex(room: Room): void {
    if (presenceRoomDeviceId(room.id) !== null) return; // never indexed to begin with
    for (const role of ['desktop', 'mobile'] as const) {
      const deviceId = room.deviceIdFor(role);
      if (deviceId === undefined) continue;
      const key = RoomRegistry.indexKey(role, deviceId);
      const set = this.deviceIndex.get(key);
      if (!set) continue;
      set.delete(room.id);
      if (set.size === 0) this.deviceIndex.delete(key); // no unbounded growth from churned devices
    }
  }
}
