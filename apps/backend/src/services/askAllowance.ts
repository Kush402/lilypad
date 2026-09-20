import { redisKeys } from '@lilypad/shared';
import type { AskAllowance } from '@lilypad/protocol';
import { config } from '../config.js';
import { redis } from '../redis.js';

/**
 * The daily allowance for Ask on Lilypad's own account (ADR-0020).
 *
 * Twenty-five **tasks** an account a UTC day. Tasks, not steps: one run of
 * "reply to Rae saying I'll be there" is five requests to this route and must
 * cost one, or the number on the price page would be a number about the
 * model's verbosity rather than about what a person did.
 *
 * ### Why this is one script and not four commands
 *
 * The first version of this file did the obvious thing — `INCR` the task,
 * `INCR` the day, and `DECR`/`DEL` back out when the day was over. Each
 * command is atomic on its own, and the sequence still has a hole, because
 * the decision spans them:
 *
 *   - two first steps of the SAME task arrive together on the day's
 *     twenty-sixth task;
 *   - both `INCR` the task key; one gets 1, the other gets 2;
 *   - the one that got 2 reads "a continuing task, already paid for" and is
 *     **allowed** — while the one that got 1 goes on to find the day full,
 *     refuses, and deletes the task key underneath it.
 *
 * The result is a step served for a task that was never counted, and a task
 * key deleted while a run is still using it. It is not a rare interleaving
 * either: the Mac fires steps back to back, and a retried first step is
 * exactly how two of them end up in flight.
 *
 * So the whole decision — is this task new, is there room for it, how many
 * steps has it had — is one `EVAL`. Redis runs a script to completion with
 * nothing else interleaved, which is the only way "check and claim" is one
 * event rather than two.
 *
 * ### What is stored
 *
 * Two integers and their expiry. No command, no screen reading, no question,
 * no answer, no task id beyond its use as part of a key that dies at
 * midnight. There is no table here to leak, and none to hand over on request,
 * because ADR-0020 promises counters and this is the file that has to mean it.
 */

/**
 * The claim, as Redis runs it.
 *
 * `KEYS[1]` is the task's step counter, `KEYS[2]` the day's task counter.
 * `ARGV` is the daily limit, the per-task step limit, and the TTL both keys
 * expire under.
 *
 * Returns `{outcome, used, steps}`:
 *   `0` allowed · `1` the day is full · `2` this task has had too many steps.
 *
 * The task key's expiry is re-asserted on every step rather than only on
 * creation: `INCR` makes a key with no TTL, so a script that died between the
 * two would leave one behind for ever. The TTL is computed from an absolute
 * instant by the caller, so re-setting it never pushes the bucket past
 * midnight.
 */
const CLAIM = `
local steps = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[3])
local used = tonumber(redis.call('GET', KEYS[2])) or 0
if steps > tonumber(ARGV[2]) then
  -- The task already paid for itself; this is a client that will not stop.
  -- The day counter is deliberately untouched: refunding here would end the
  -- day one task richer for whoever misbehaved most.
  return {2, used, steps}
end
if steps > 1 then
  -- A continuing task. Already counted, so nothing to spend.
  return {0, used, steps}
end
used = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
if used > tonumber(ARGV[1]) then
  -- Hand the increment back so tomorrow does not start the day already
  -- over, and forget the task so retrying it after midnight is a first step
  -- again rather than a free one.
  redis.call('DECR', KEYS[2])
  redis.call('DEL', KEYS[1])
  return {1, tonumber(ARGV[1]), steps}
end
return {0, used, steps}
`;

/** Seconds from `now` until the next UTC midnight, floored at one second so a
 *  key minted in the final millisecond of a day still gets a TTL Redis
 *  accepts — `EXPIRE key 0` deletes it outright. */
export function secondsUntilUtcMidnight(now: number): number {
  return Math.max(1, Math.ceil((utcMidnightAfter(now) - now) / 1000));
}

/** The next UTC midnight strictly after `now`, in ms. */
function utcMidnightAfter(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** `YYYY-MM-DD` in UTC — the bucket a task is counted against. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The slice of Redis this needs — injectable, as everywhere else here. */
export interface AskAllowanceRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export type AskAllowanceResult =
  | { ok: true; allowance: AskAllowance }
  | { ok: false; reason: 'daily_limit' | 'task_step_limit'; allowance: AskAllowance };

/**
 * Spend one task of today's allowance, or say why not.
 *
 * Idempotent per `(account, day, taskId)`: the first step of a task spends
 * one, and every later step of the same task spends nothing and is allowed.
 *
 * Throws if Redis cannot answer. That is deliberate and the route depends on
 * it: an allowance that cannot be enforced is not one, so the caller turns
 * this into a 503 rather than serving.
 */
export async function claimHostedAskTask(
  userId: string,
  taskId: string,
  now = Date.now(),
  client: AskAllowanceRedis = redis,
): Promise<AskAllowanceResult> {
  const limit = config.env.HOSTED_ASK_DAILY_TASKS;
  const maxSteps = config.env.HOSTED_ASK_MAX_STEPS;
  const day = utcDay(now);
  const ttl = secondsUntilUtcMidnight(now);
  const resetsAt = new Date(utcMidnightAfter(now)).toISOString();

  const raw = await client.eval(
    CLAIM,
    2,
    redisKeys.hostedAskTask(userId, day, taskId),
    redisKeys.hostedAskDay(userId, day),
    limit,
    maxSteps,
    ttl,
  );

  const [outcome, used] = asNumbers(raw);
  const allowance: AskAllowance = { used, limit, resetsAt };
  if (outcome === 1) return { ok: false, reason: 'daily_limit', allowance };
  if (outcome === 2) return { ok: false, reason: 'task_step_limit', allowance };
  return { ok: true, allowance };
}

/**
 * The script's reply, as numbers.
 *
 * Redis returns a Lua table as an array of integers, but a reply that is not
 * that shape means the script did not run — and guessing "allowed" from an
 * unreadable answer is exactly the failure this whole file exists to prevent.
 * So it throws, and the route fails closed.
 */
function asNumbers(raw: unknown): [number, number] {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error('the allowance script did not answer');
  }
  const [outcome, used] = raw;
  if (typeof outcome !== 'number' || typeof used !== 'number') {
    throw new Error('the allowance script answered in an unexpected shape');
  }
  return [outcome, Math.max(0, used)];
}
