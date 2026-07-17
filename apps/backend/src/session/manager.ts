import { randomUUID } from 'node:crypto';
import type { SessionScope } from '@lilypad/protocol';
import { SessionStateMachine, TERMINAL_STATES, type SessionState } from './stateMachine.js';

/**
 * Minimal KV surface the manager needs — satisfied by ioredis in production and
 * by an in-memory fake in tests (so session logic needs no live Redis).
 *
 * `keys`/`mget` are only needed for the boot-time orphan sweep
 * (`findStaleActive`/`sweepOrphaned`) — every other method works against a
 * plain get/set/del store.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

export interface SessionRecord {
  id: string;
  roomId: string;
  desktopDeviceId: string | null;
  mobileDeviceId: string | null;
  scopes: SessionScope[];
  state: SessionState;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionInput {
  /** Reuse the signaling hub's session id so both agree; generated if omitted. */
  id?: string;
  roomId: string;
  desktopDeviceId: string | null;
  mobileDeviceId?: string | null;
  scopes: SessionScope[];
  initialState?: SessionState;
}

const sessionKey = (id: string) => `lilypad:session:${id}`;

export class SessionManager {
  constructor(
    private readonly store: KvStore,
    private readonly ttlSeconds = 3600,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const ts = this.now();
    const record: SessionRecord = {
      id: input.id ?? randomUUID(),
      roomId: input.roomId,
      desktopDeviceId: input.desktopDeviceId,
      mobileDeviceId: input.mobileDeviceId ?? null,
      scopes: input.scopes,
      state: input.initialState ?? 'connecting',
      createdAt: ts,
      updatedAt: ts,
    };
    await this.persist(record);
    return record;
  }

  async get(id: string): Promise<SessionRecord | null> {
    const raw = await this.store.get(sessionKey(id));
    return raw ? (JSON.parse(raw) as SessionRecord) : null;
  }

  /** Validate + apply a state transition, persisting the new state. */
  async transition(id: string, to: SessionState): Promise<SessionRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`session not found: ${id}`);
    const fsm = new SessionStateMachine(record.state);
    fsm.transition(to); // throws InvalidTransitionError on illegal move
    record.state = fsm.state;
    record.updatedAt = this.now();
    await this.persist(record);
    return record;
  }

  async end(id: string, reason?: string): Promise<void> {
    const record = await this.get(id);
    if (!record) return;
    const fsm = new SessionStateMachine(record.state);
    if (!fsm.isTerminal()) fsm.tryTransition('disconnected');
    record.state = fsm.state;
    record.updatedAt = this.now();
    // Keep the terminal record briefly for audit/debug, then let it expire.
    void reason;
    await this.persist(record, 60);
  }

  private async persist(record: SessionRecord, ttl = this.ttlSeconds): Promise<void> {
    await this.store.set(sessionKey(record.id), JSON.stringify(record), 'EX', ttl);
  }

  /** Every persisted session record whose state is non-terminal but hasn't
   * been touched in at least `staleAfterMs` — a record like this survived
   * whatever process crashed without ever reaching `disconnected`/`failed`/
   * `timeout`, and would otherwise show as "active" for up to its full TTL
   * (default 1 hour). `O(n)` full-table scan; only meant for a one-time
   * boot-time sweep, never a hot path. See
   * `docs/audit/m3/testing-reliability.md` Finding 5, redesign item 2. */
  async findStaleActive(staleAfterMs: number, now = this.now()): Promise<SessionRecord[]> {
    const keys = await this.store.keys(`${sessionKey('')}*`);
    if (keys.length === 0) return [];
    const values = await this.store.mget(...keys);
    const stale: SessionRecord[] = [];
    for (const raw of values) {
      if (!raw) continue; // expired between KEYS and MGET
      let record: SessionRecord;
      try {
        record = JSON.parse(raw) as SessionRecord;
      } catch {
        continue; // corrupt record — skip rather than crash the boot sequence
      }
      if (TERMINAL_STATES.includes(record.state)) continue;
      if (now - record.updatedAt >= staleAfterMs) stale.push(record);
    }
    return stale;
  }

  /** Boot-time companion to `findStaleActive`: find every orphaned session
   * and explicitly mark it `disconnected`, bounding "shows as active but
   * isn't" from up to the full TTL down to one boot cycle. Returns the
   * number swept. Best-effort per record — one corrupt/already-gone record
   * must not abort the sweep for the rest. */
  async sweepOrphaned(staleAfterMs: number, now = this.now()): Promise<number> {
    const stale = await this.findStaleActive(staleAfterMs, now);
    let swept = 0;
    for (const record of stale) {
      await this.end(record.id, 'orphaned: no update since before this process started');
      swept++;
    }
    return swept;
  }
}
