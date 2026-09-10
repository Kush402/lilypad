import { SessionScopeSchema, type DeviceKind, type SessionScope } from '@lilypad/protocol';
import { z } from 'zod';
import { redisKeys } from '@lilypad/shared';
import { SESSION_STATES, type SessionState } from './stateMachine.js';

/** Redis surface `RoomStore` needs — satisfied by ioredis in production and
 * an in-memory fake in tests. A superset of `manager.ts`'s `KvStore`
 * (adds bounded `scan`/`mget` for boot-time recovery). */
export interface RoomKvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  scan(
    cursor: string,
    match: 'MATCH',
    pattern: string,
    count: 'COUNT',
    size: number,
  ): Promise<[string, string[]]>;
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
    await this.store.set(
      redisKeys.room(record.id),
      JSON.stringify({ ...full, version: 1 }),
      'EX',
      this.ttlSeconds,
    );
  }

  async delete(id: string): Promise<void> {
    await this.store.del(redisKeys.room(id));
  }

  /**
   * Bounded cursor recovery. Invalid/expired keys consume work budget, not
   * valid room capacity. No KEYS call or whole-keyspace array is allocated.
   * SCAN count is a hint: oversized batches are truncated to the work budget.
   *
   * **Every wait is bounded, not just the loop.** `MAX_SCAN_MS` is checked
   * between commands, which bounds a *slow* Redis but not an unresponsive one:
   * a single `await` that never settles hangs recovery, and recovery is awaited
   * during boot, so the whole backend would come up never — with a healthy
   * Redis TCP connection and no error to log. Each command therefore races a
   * deadline of its own, and a command that misses it ends recovery with
   * whatever was already read.
   *
   * Degrading is the right failure here: rooms that are not resurrected are
   * rooms whose peers reconnect, whereas a backend that does not start serves
   * nobody. Live P2P media never touches Redis at all.
   */
  async loadAll(limit = DEFAULT_MAX_RECORDS): Promise<RoomRecord[]> {
    const cap = Math.min(DEFAULT_MAX_RECORDS, Math.max(0, Math.floor(limit)));
    if (!Number.isFinite(cap) || cap === 0) return [];
    const records: RoomRecord[] = [];
    const seen = new Set<string>();
    let cursor = '0';
    let scanned = 0;
    let scans = 0;
    const started = performance.now();
    do {
      scans++;
      const scanned_batch = await settleWithin(
        this.store.scan(cursor, 'MATCH', `${redisKeys.room('')}*`, 'COUNT', MGET_CHUNK),
        remaining(started),
      );
      if (!scanned_batch) break; // Redis stopped answering — keep what we have
      const [next, batch] = scanned_batch;
      cursor = next;
      const keys = batch.slice(0, MAX_SCAN_KEYS - scanned).filter((key) => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      scanned += Math.min(batch.length, MAX_SCAN_KEYS - scanned);
      for (
        let i = 0;
        i < keys.length && records.length < cap && performance.now() - started < MAX_SCAN_MS;
      ) {
        const chunk = keys.slice(i, i + Math.min(MGET_CHUNK, cap - records.length));
        const values = await settleWithin(this.store.mget(...chunk), remaining(started));
        if (!values) return records; // stopped answering mid-read
        i += chunk.length;
        for (let j = 0; j < values.length; j++) {
          const raw = values[j];
          if (!raw) continue;
          const record = decodeRoomRecord(raw);
          if (record && redisKeys.room(record.id) === chunk[j]) records.push(record);
        }
      }
    } while (
      cursor !== '0' &&
      scans < 256 &&
      records.length < cap &&
      scanned < MAX_SCAN_KEYS &&
      performance.now() - started < MAX_SCAN_MS &&
      seen.size < MAX_SCAN_KEYS
    );
    return records;
  }
}

/**
 * How long is left of the recovery budget, never negative.
 *
 * One budget covers the whole of recovery rather than each command separately:
 * thirty commands that each take just under a per-command limit is still an
 * unbounded boot.
 */
function remaining(started: number): number {
  return Math.max(0, MAX_SCAN_MS - (performance.now() - started));
}

/**
 * Resolve `work`, or `null` if it has not settled within `ms`.
 *
 * The pending command is abandoned, not cancelled — Redis may still answer,
 * and its reply is simply ignored. That is deliberate: there is no way to
 * un-send a command, and pretending otherwise would be the same class of
 * claim this ledger keeps correcting.
 */
async function settleWithin<T>(work: Promise<T>, ms: number): Promise<T | null> {
  if (ms <= 0) return null;
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    // Do not keep the process alive just to time out a read.
    timer.unref?.();
  });
  try {
    return await Promise.race([work.catch(() => null), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Keys per MGET, not a byte bound on a corrupt Redis reply. Record sizes
 * are checked before JSON parsing; transport-level reply limits remain separate. */
const MGET_CHUNK = 256;
const MAX_SCAN_KEYS = 40_000;
const MAX_SCAN_MS = 5_000;

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
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) return null;
  try {
    const result = PersistedRoomSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Add a version to new records while accepting existing versionless records.
const PersistedRoomSchema = z
  .object({
    version: z.literal(1).optional(),
    id: z.string().min(1).max(128),
    fsmState: z.enum(SESSION_STATES),
    sessionId: z.string().min(1).max(128).optional(),
    scopes: z.array(SessionScopeSchema).max(8),
    deviceIds: z
      .object({
        desktop: z.string().min(1).max(256).optional(),
        mobile: z.string().min(1).max(256).optional(),
      })
      .strict(),
    established: z.boolean(),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .transform(({ version, ...record }) => {
    void version;
    return record;
  });
