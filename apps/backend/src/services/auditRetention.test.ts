import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AUDIT_RETENTION_DAYS,
  AUDIT_RETENTION_MS,
  auditCutoff,
  pruneAuditLogs,
  startAuditRetention,
  type AuditRetentionStore,
} from './auditRetention.js';

/**
 * The retention policy is a promise about data that has already been
 * collected, so what matters is that it is exact at the boundary and that it
 * cannot quietly stop running. Both are tested here without a database: the
 * policy is a pure function of a row's age and the clock, which is the
 * property that makes it deterministic in the first place.
 */

/** Rows with `createdAt`, and a store that applies the cutoff to them. */
function storeOf(rows: Date[]): AuditRetentionStore & { rows: Date[]; calls: Date[] } {
  const state = {
    rows: [...rows],
    calls: [] as Date[],
    async deleteOlderThan(cutoff: Date) {
      state.calls.push(cutoff);
      const kept = state.rows.filter((r) => r.getTime() >= cutoff.getTime());
      const removed = state.rows.length - kept.length;
      state.rows = kept;
      return removed;
    },
  };
  return state;
}

const NOW = new Date('2026-08-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

describe('the policy', () => {
  it('is two days', () => {
    // Stated as a number so a change to it is a visible change to the policy,
    // not an incidental edit to an arithmetic expression.
    expect(AUDIT_RETENTION_DAYS).toBe(2);
    expect(AUDIT_RETENTION_MS).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it('measures the window backwards from now', () => {
    expect(auditCutoff(NOW).toISOString()).toBe('2026-08-18T12:00:00.000Z');
  });

  it('depends only on the clock, never on when it last ran', () => {
    // Two prunes an hour apart from the same start state must reach the same
    // answer about the same row. A pruner that skipped a day would otherwise
    // leave a permanent hole in the policy.
    const late = auditCutoff(new Date(NOW.getTime() + HOUR));
    const onTime = auditCutoff(NOW);
    expect(late.getTime() - onTime.getTime()).toBe(HOUR);
  });
});

describe('pruneAuditLogs', () => {
  it('removes rows older than two days', async () => {
    const store = storeOf([ago(3 * 24 * HOUR), ago(2 * 24 * HOUR + HOUR), ago(HOUR)]);
    expect(await pruneAuditLogs(store, NOW)).toBe(2);
    expect(store.rows).toEqual([ago(HOUR)]);
  });

  it('keeps everything inside the window', async () => {
    const store = storeOf([ago(HOUR), ago(24 * HOUR), ago(47 * HOUR)]);
    expect(await pruneAuditLogs(store, NOW)).toBe(0);
    expect(store.rows).toHaveLength(3);
  });

  it('keeps a row that is exactly two days old, and drops it a millisecond later', async () => {
    // "may remain for up to 2 days" — the boundary belongs to the row.
    const boundary = ago(AUDIT_RETENTION_MS);
    expect(await pruneAuditLogs(storeOf([boundary]), NOW)).toBe(0);
    expect(await pruneAuditLogs(storeOf([boundary]), new Date(NOW.getTime() + 1))).toBe(1);
  });

  it('is a no-op on an empty table', async () => {
    expect(await pruneAuditLogs(storeOf([]), NOW)).toBe(0);
  });

  it('does not care whose rows they are', async () => {
    // Rows anonymised by a deleted account (`user_id` set to NULL) expire on
    // exactly the same clock as everyone else's. Deletion is not a shortcut
    // through retention, and retention is not a shortcut through deletion.
    const store = storeOf([ago(3 * 24 * HOUR), ago(3 * 24 * HOUR)]);
    expect(await pruneAuditLogs(store, NOW)).toBe(2);
    expect(store.rows).toHaveLength(0);
  });
});

describe('startAuditRetention', () => {
  afterEach(() => vi.useRealTimers());

  it('prunes immediately rather than waiting out the first interval', async () => {
    // A restart must not grant every stale row another hour.
    const store = storeOf([ago(3 * 24 * HOUR)]);
    const handle = startAuditRetention(store, 60_000);
    await vi.waitFor(() => expect(store.calls).toHaveLength(1));
    handle.stop();
  });

  it('keeps pruning on the interval', async () => {
    vi.useFakeTimers();
    const store = storeOf([]);
    const handle = startAuditRetention(store, 60_000);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(store.calls.length).toBeGreaterThanOrEqual(4); // boot + three ticks
    handle.stop();
  });

  it('stops when told to', async () => {
    vi.useFakeTimers();
    const store = storeOf([]);
    startAuditRetention(store, 60_000).stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(store.calls).toHaveLength(1); // the boot run, and nothing after it
  });

  it('survives a failing prune and tries again on the next tick', async () => {
    // Retention falling behind is an operational problem. Taking the API down
    // over it would be a worse one.
    vi.useFakeTimers();
    const calls: number[] = [];
    const flaky: AuditRetentionStore = {
      async deleteOlderThan() {
        calls.push(Date.now());
        if (calls.length === 1) throw new Error('connection terminated');
        return 0;
      },
    };
    startAuditRetention(flaky, 60_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});
