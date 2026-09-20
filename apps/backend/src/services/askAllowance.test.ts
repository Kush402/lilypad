import { describe, it, expect } from 'vitest';
import { redisKeys } from '@lilypad/shared';
import { claimHostedAskTask, secondsUntilUtcMidnight, utcDay } from './askAllowance.js';
import { config } from '../config.js';

/** In-memory execution of the allowance script. The whole body runs before
 * the promise is returned, matching Redis EVAL's no-interleaving guarantee. */
function fakeRedis() {
  const values = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    values,
    ttls,
    eval: (
      _script: string,
      _numKeys: number,
      taskKey: string,
      dayKey: string,
      rawLimit: string | number,
      rawMaxSteps: string | number,
      rawTtl: string | number,
    ) => {
      const limit = Number(rawLimit);
      const maxSteps = Number(rawMaxSteps);
      const ttl = Number(rawTtl);
      const steps = (values.get(taskKey) ?? 0) + 1;
      values.set(taskKey, steps);
      ttls.set(taskKey, ttl);
      const current = values.get(dayKey) ?? 0;
      if (steps > maxSteps) return Promise.resolve([2, current, steps]);
      if (steps > 1) return Promise.resolve([0, current, steps]);
      const used = current + 1;
      if (used > limit) {
        values.set(dayKey, limit);
        values.delete(taskKey);
        ttls.delete(taskKey);
        return Promise.resolve([1, limit, steps]);
      }
      values.set(dayKey, used);
      ttls.set(dayKey, ttl);
      return Promise.resolve([0, used, steps]);
    },
  };
}

const NOON = Date.parse('2026-09-19T12:00:00Z');
const LIMIT = config.env.HOSTED_ASK_DAILY_TASKS;

describe('the daily allowance for Ask on Lilypad’s account', () => {
  it('spends one task, not one per step', async () => {
    const redis = fakeRedis();
    // Five steps of one run — what "reply to Rae saying I'll be there"
    // measured at, live, in ADR-0020.
    for (let step = 0; step < 5; step += 1) {
      const claim = await claimHostedAskTask('u', 'task-aaaaaaaa', NOON, redis);
      expect(claim.ok).toBe(true);
      expect(claim.allowance.used).toBe(1);
    }
    expect(redis.values.get(redisKeys.hostedAskDay('u', '2026-09-19'))).toBe(1);
  });

  it('counts a second task separately', async () => {
    const redis = fakeRedis();
    await claimHostedAskTask('u', 'task-aaaaaaaa', NOON, redis);
    await claimHostedAskTask('u', 'task-aaaaaaaa', NOON, redis);
    const second = await claimHostedAskTask('u', 'task-bbbbbbbb', NOON, redis);
    expect(second.ok).toBe(true);
    expect(second.allowance.used).toBe(2);
  });

  it('allows exactly the limit and refuses the next one', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < LIMIT; i += 1) {
      const claim = await claimHostedAskTask(
        'u',
        `task-${String(i).padStart(8, '0')}`,
        NOON,
        redis,
      );
      expect(claim.ok).toBe(true);
      expect(claim.allowance.used).toBe(i + 1);
    }
    const over = await claimHostedAskTask('u', 'task-overover', NOON, redis);
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.reason).toBe('daily_limit');
    // The refused request must not leave the day counter at 26, or tomorrow's
    // arithmetic starts wrong and the account silently loses a task.
    expect(redis.values.get(redisKeys.hostedAskDay('u', '2026-09-19'))).toBe(LIMIT);
  });

  it('forgets a refused task, so the same id is a first step tomorrow', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < LIMIT; i += 1) {
      await claimHostedAskTask('u', `task-${String(i).padStart(8, '0')}`, NOON, redis);
    }
    await claimHostedAskTask('u', 'task-overover', NOON, redis);
    // Had the task key survived, retrying it after midnight would have found
    // `steps > 1` and been waved through as "already counted" — a free task
    // for anyone who kept one refused id around.
    expect(redis.values.has(redisKeys.hostedAskTask('u', '2026-09-19', 'task-overover'))).toBe(
      false,
    );
  });

  it('gives exactly one caller the last slot when several arrive together', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < LIMIT - 1; i += 1) {
      await claimHostedAskTask('u', `task-${String(i).padStart(8, '0')}`, NOON, redis);
    }
    // Four distinct tasks racing for one remaining slot. `INCR` returns the
    // value it produced, so exactly one of them can be the one that produced
    // the limit. A read-then-write allowance passes every sequential test
    // above and fails this one.
    const results = await Promise.all(
      ['task-r1aaaaaa', 'task-r2aaaaaa', 'task-r3aaaaaa', 'task-r4aaaaaa'].map((id) =>
        claimHostedAskTask('u', id, NOON, redis),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(redis.values.get(redisKeys.hostedAskDay('u', '2026-09-19'))).toBe(LIMIT);
  });

  it('never admits a concurrent retry of the same over-limit task', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < LIMIT; i += 1) {
      await claimHostedAskTask('u', `task-${String(i).padStart(8, '0')}`, NOON, redis);
    }
    const results = await Promise.all([
      claimHostedAskTask('u', 'task-sameover', NOON, redis),
      claimHostedAskTask('u', 'task-sameover', NOON, redis),
    ]);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(redis.values.get(redisKeys.hostedAskDay('u', '2026-09-19'))).toBe(LIMIT);
    expect(redis.values.has(redisKeys.hostedAskTask('u', '2026-09-19', 'task-sameover'))).toBe(
      false,
    );
  });

  it('keeps one account’s tasks out of another’s count', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < LIMIT; i += 1) {
      await claimHostedAskTask('a', `task-${String(i).padStart(8, '0')}`, NOON, redis);
    }
    const other = await claimHostedAskTask('b', 'task-aaaaaaaa', NOON, redis);
    expect(other.ok).toBe(true);
    expect(other.allowance.used).toBe(1);
  });

  it('starts again at the UTC day boundary, and not a second before', async () => {
    const redis = fakeRedis();
    const lastMoment = Date.parse('2026-09-19T23:59:59.999Z');
    for (let i = 0; i < LIMIT; i += 1) {
      await claimHostedAskTask('u', `task-${String(i).padStart(8, '0')}`, lastMoment, redis);
    }
    expect((await claimHostedAskTask('u', 'task-latelate', lastMoment, redis)).ok).toBe(false);
    // One millisecond later is a different bucket.
    const midnight = Date.parse('2026-09-20T00:00:00.000Z');
    const fresh = await claimHostedAskTask('u', 'task-latelate', midnight, redis);
    expect(fresh.ok).toBe(true);
    expect(fresh.allowance.used).toBe(1);
  });

  it('expires both counters at midnight rather than leaving them behind', async () => {
    const redis = fakeRedis();
    await claimHostedAskTask('u', 'task-aaaaaaaa', NOON, redis);
    const halfADay = 12 * 60 * 60;
    expect(redis.ttls.get(redisKeys.hostedAskDay('u', '2026-09-19'))).toBe(halfADay);
    expect(redis.ttls.get(redisKeys.hostedAskTask('u', '2026-09-19', 'task-aaaaaaaa'))).toBe(
      halfADay,
    );
  });

  it('stops a task that will not stop, without refunding it', async () => {
    const redis = fakeRedis();
    const maxSteps = config.env.HOSTED_ASK_MAX_STEPS;
    for (let step = 0; step < maxSteps; step += 1) {
      expect((await claimHostedAskTask('u', 'task-runaway1', NOON, redis)).ok).toBe(true);
    }
    const over = await claimHostedAskTask('u', 'task-runaway1', NOON, redis);
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.reason).toBe('task_step_limit');
    // Refunding here would end the day one task richer for the client that
    // misbehaved most.
    expect(redis.values.get(redisKeys.hostedAskDay('u', '2026-09-19'))).toBe(1);
  });

  it('stores counters and expiries, and nothing else', async () => {
    const redis = fakeRedis();
    await claimHostedAskTask('u', 'task-aaaaaaaa', NOON, redis);
    // Two keys, two integers. No command, no screen reading, no answers —
    // ADR-0020 promises counters, and this is the assertion that means it.
    expect([...redis.values.keys()].sort()).toEqual([
      redisKeys.hostedAskDay('u', '2026-09-19'),
      redisKeys.hostedAskTask('u', '2026-09-19', 'task-aaaaaaaa'),
    ]);
    for (const v of redis.values.values()) expect(Number.isInteger(v)).toBe(true);
  });

  it('reports when the count returns to zero', async () => {
    const redis = fakeRedis();
    const claim = await claimHostedAskTask('u', 'task-aaaaaaaa', NOON, redis);
    expect(claim.allowance.resetsAt).toBe('2026-09-20T00:00:00.000Z');
    expect(claim.allowance.limit).toBe(LIMIT);
  });
});

describe('the UTC day', () => {
  it('is the same bucket either side of a local midnight', () => {
    expect(utcDay(Date.parse('2026-09-19T00:00:00Z'))).toBe('2026-09-19');
    expect(utcDay(Date.parse('2026-09-19T23:59:59Z'))).toBe('2026-09-19');
    expect(utcDay(Date.parse('2026-09-20T00:00:00Z'))).toBe('2026-09-20');
  });

  it('never asks Redis for a TTL of zero', () => {
    // `EXPIRE key 0` deletes the key immediately, which would hand a free
    // task to anyone whose request landed in the final millisecond.
    expect(secondsUntilUtcMidnight(Date.parse('2026-09-19T23:59:59.999Z'))).toBe(1);
    expect(secondsUntilUtcMidnight(Date.parse('2026-09-19T00:00:00.000Z'))).toBe(86_400);
  });
});
