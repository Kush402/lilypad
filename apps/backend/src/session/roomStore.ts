import type { DeviceKind, SessionScope } from '@lilypad/protocol';
import { redisKeys } from '@lilypad/shared';
import type { SessionState } from './stateMachine.js';

/** Redis surface `RoomStore` needs — satisfied by ioredis in production and
 * an in-memory fake in tests. A superset of `manager.ts`'s `KvStore`
 * (adds `keys`/`mget` for the boot-time full-table scan). */
export interface RoomKvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

/**
 * Everything needed to resurrect a `Room` after a backend restart, minus the
 * live `Peer` handles — those can't survive a process restart regardless
 * (the underlying WebSocket to the OLD process is gone either way).
 */
export interface RoomRecord {
  id: string;
  fsmState: SessionState;
  sessionId?: string;
  scopes: SessionScope[];
  deviceIds: Partial<Record<DeviceKind, string>>;
  established: boolean;
  updatedAt: number;
}

/** How long a room record survives in Redis with no further writes, i.e. the
 * outer backstop before an abandoned room's resurrection data disappears —
 * deliberately much longer than the in-process reregister grace window
 * (15s default): that window governs "how long we hold a seat open," this
 * one governs "how long we remember the room ever existed at all." */
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

/**
 * Redis-backed persistence for room routing state, so a backend restart can
 * resurrect every room it was mid-session on instead of silently dropping
 * them. See `docs/audit/m3/reconnect-lifecycle.md` Finding 3.
 *
 * Deliberately scoped to boot-time resurrection (`loadAll`, read once at
 * process startup — see `SignalingHub.resurrectRoomsFromStore`), NOT a
 * per-message read on the hot signaling path: the hub's `register`/
 * `handleMessage` stay fully synchronous, so this never risks reordering
 * messages from the same peer the way an inline per-register Redis read
 * would. That scoping means this does not (yet) help a client whose
 * reconnect lands on a *different*, still-running replica in a horizontally
 * scaled deployment — only a full process restart. Extending to the
 * cross-replica case is real, separate follow-up work (see the finding's
 * "Future extensibility" note), not something this pass silently claims.
 *
 * Writes are best-effort (logged by the caller, never thrown) — a Redis
 * outage should degrade resurrection capability, not block live signaling
 * relay, which doesn't touch Redis at all.
 */
export class RoomStore {
  constructor(
    private readonly store: RoomKvStore,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async save(record: Omit<RoomRecord, 'updatedAt'>): Promise<void> {
    const full: RoomRecord = { ...record, updatedAt: this.now() };
    await this.store.set(redisKeys.room(record.id), JSON.stringify(full), 'EX', this.ttlSeconds);
  }

  async delete(id: string): Promise<void> {
    await this.store.del(redisKeys.room(id));
  }

  /** Every non-expired room record, for the one-time boot-time resurrection
   * scan. `KEYS` is O(n) and briefly blocks Redis — acceptable for a single
   * startup call bounded by `maxRooms`, not something run on any hot path. */
  async loadAll(): Promise<RoomRecord[]> {
    const keys = await this.store.keys(`${redisKeys.room('')}*`);
    if (keys.length === 0) return [];
    const values = await this.store.mget(...keys);
    const records: RoomRecord[] = [];
    for (const raw of values) {
      if (!raw) continue; // expired between KEYS and MGET, or a stray key
      try {
        records.push(JSON.parse(raw) as RoomRecord);
      } catch {
        /* corrupt record — skip rather than crash the boot sequence */
      }
    }
    return records;
  }
}
