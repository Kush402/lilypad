import type { DeviceKind, SessionScope } from '@lilypad/protocol';
import { redisKeys } from '@lilypad/shared';
import { SESSION_STATES, type SessionState } from './stateMachine.js';

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

  /**
   * Non-expired room records for the one-time boot-time resurrection scan, at
   * most `limit` of them.
   *
   * **Bounds (L-251).** `limit` is applied to the key list *before* the bulk
   * read, and the read itself is chunked, so this process decodes at most
   * `limit` records and holds at most `MGET_CHUNK` raw strings at a time. The
   * previous comment claimed the scan was "bounded by `maxRooms`", but the cap
   * lived in `RoomRegistry.resurrect` — every key was fetched, parsed and
   * materialised first, and only then discarded. A Redis holding far more room
   * keys than this instance's cap would have been decoded in full at boot.
   *
   * **Limitation, stated rather than implied:** `KEYS` is still O(keyspace)
   * *inside Redis*, and briefly blocks it. Capping our side does not change
   * that. This is acceptable only because it is one call at process start on a
   * single-instance deployment; a horizontally scaled deployment needs a
   * cursor (`SCAN`) here, and that is M11 work, not a comment.
   */
  async loadAll(limit = DEFAULT_MAX_RECORDS): Promise<RoomRecord[]> {
    const keys = (await this.store.keys(`${redisKeys.room('')}*`)).slice(0, limit);
    if (keys.length === 0) return [];
    const records: RoomRecord[] = [];
    for (let i = 0; i < keys.length; i += MGET_CHUNK) {
      const values = await this.store.mget(...keys.slice(i, i + MGET_CHUNK));
      for (const raw of values) {
        if (!raw) continue; // expired between KEYS and MGET, or a stray key
        const record = decodeRoomRecord(raw);
        if (record) records.push(record);
      }
    }
    return records;
  }
}

/** How many keys one `MGET` asks for. Keeps the reply size bounded regardless
 * of how many rooms are being recovered. */
const MGET_CHUNK = 256;

/** Fallback cap when a caller does not pass the registry's room cap. */
const DEFAULT_MAX_RECORDS = 10_000;

/** Largest stored record recovery will even parse. */
const MAX_RECORD_BYTES = 16 * 1024;

/**
 * Parse one stored record, returning `null` for anything that is not a
 * structurally valid `RoomRecord` (L-250).
 *
 * `JSON.parse(raw) as RoomRecord` is a lie the compiler cannot catch: `"null"`
 * is valid JSON, so the cast produced `null`, `loadAll` pushed it, and
 * `resurrectRoomsFromStore` dereferenced `record.fsmState` and threw — during
 * boot, before the signaling route was serving. One malformed key (a bad
 * deploy, a truncated write, anything else writing to the same Redis) took the
 * whole backend down on start, and it stayed down through every restart
 * because the record is still there. The `try/catch` only ever covered
 * *syntactically* invalid JSON.
 *
 * A skipped record loses one room's resurrection — which is exactly what a
 * corrupt record already means — instead of losing the process.
 */
export function decodeRoomRecord(raw: string): RoomRecord | null {
  // A per-record size limit, so one oversized value cannot make recovery cost
  // whatever the writer felt like. A real record is a few hundred bytes; this
  // is generous by two orders of magnitude and still bounded.
  if (raw.length > MAX_RECORD_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // not JSON at all
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.fsmState !== 'string' || !SESSION_STATES.includes(r.fsmState as SessionState)) {
    return null;
  }
  if (r.sessionId !== undefined && typeof r.sessionId !== 'string') return null;
  if (!Array.isArray(r.scopes) || r.scopes.some((s) => typeof s !== 'string')) return null;
  if (typeof r.deviceIds !== 'object' || r.deviceIds === null || Array.isArray(r.deviceIds)) {
    return null;
  }
  if (Object.values(r.deviceIds as Record<string, unknown>).some((v) => typeof v !== 'string')) {
    return null;
  }
  if (typeof r.established !== 'boolean') return null;
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return null;
  return parsed as RoomRecord;
}
