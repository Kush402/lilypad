import type { RoomRecord } from '../session/roomStore.js';
import { Room, type RoomStateChangeListener } from './room.js';

/** Default global room cap (each room ≈ two seats). Generous for a single
 * backend instance; primarily a DoS backstop, not a capacity target. */
const DEFAULT_MAX_ROOMS = 10_000;

/**
 * Owns the room `Map` and the one policy attached to its shape: a hard cap on
 * concurrent rooms (a global backstop against room-exhaustion memory DoS
 * even if per-IP limits are bypassed). Moved verbatim from
 * `SignalingHub.register`'s capacity check.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly maxRooms: number;

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

  remove(id: string): void {
    this.rooms.delete(id);
  }

  /** Insert a room resurrected from a `RoomRecord` (boot-time only — see
   * `SignalingHub.resurrectRoomsFromStore`). Returns false, refusing to
   * insert, if a room with this id is already registered (a live room
   * always wins over a stale resurrection candidate) or the cap is reached. */
  resurrect(record: RoomRecord, now: number, onStateChange: RoomStateChangeListener): boolean {
    if (this.rooms.has(record.id) || this.rooms.size >= this.maxRooms) return false;
    this.rooms.set(record.id, Room.resurrect(record, now, onStateChange));
    return true;
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
}
