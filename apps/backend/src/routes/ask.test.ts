import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { ASK_MAX_REQUEST_BYTES, HostedAskStatusSchema } from '@lilypad/protocol';
import type * as AuthTokens from '../auth/tokens.js';

/**
 * The gates on `/ask/v1/systemone` (ADR-0020).
 *
 * Only the token check and the three services behind the route are faked, so
 * what is under test is the route's own order of decisions: who may call it,
 * in what state the server may serve it, and what a refusal is allowed to
 * say. `askAllowance.test.ts` owns the arithmetic; `entitlement.test.ts` owns
 * which tiers count.
 */
vi.mock('../auth/tokens.js', async () => {
  const actual = await vi.importActual<typeof AuthTokens>('../auth/tokens.js');
  return {
    ...actual,
    verifyAccessToken: vi.fn(async (token: string) => {
      if (token === 'device-token') return { userId: 'user-alice', deviceId: 'device-mac' };
      // A phone's sign-in session: a perfectly valid token that is not a Mac.
      if (token === 'account-token') return { userId: 'user-alice', deviceId: null };
      return null;
    }),
  };
});

// The revocation gate is `liveDevice.test.ts`'s subject, and it is backed by
// Postgres. Stubbed to "still there" so this file tests the route.
vi.mock('../auth/ownership.js', () => ({
  accountExists: vi.fn(async () => true),
  deviceOwnershipById: vi.fn(async () => ({ userId: 'user-alice', revokedAt: null })),
  deviceOwnershipByFingerprint: vi.fn(async () => null),
  pairOwnership: vi.fn(async () => null),
  ownsDevice: vi.fn(() => true),
  canManagePair: vi.fn(() => false),
}));

const hostedAskAccessFor = vi.fn(async () => 'entitled' as const);
vi.mock('../services/entitlement.js', () => ({
  hostedAskAccessFor: (...args: unknown[]) => hostedAskAccessFor(...(args as [])),
}));

const claimHostedAskTask = vi.fn();
vi.mock('../services/askAllowance.js', () => ({
  claimHostedAskTask: (...args: unknown[]) => claimHostedAskTask(...(args as [])),
}));

const askSystemOne = vi.fn();
const hostedAskConfigured = vi.fn(() => true);
vi.mock('../services/askSystemOne.js', () => ({
  askSystemOne: (...args: unknown[]) => askSystemOne(...(args as [])),
  hostedAskConfigured: () => hostedAskConfigured(),
}));

const logged: unknown[] = [];
vi.mock('../logging.js', () => {
  const capture = (...args: unknown[]) => void logged.push(args);
  const logger = { info: capture, warn: capture, error: capture, debug: capture };
  return { log: { server: logger, security: logger, audit: logger } };
});

const { askRoutes } = await import('./ask.js');

const ALLOWANCE = { used: 3, limit: 25, resetsAt: '2026-09-20T00:00:00.000Z' };

/** A real step's shape: the command and the screen in `state`, one yes/no and
 *  one many-way question. Nothing here is a screenshot, by construction. */
function step(taskId = 'task-aaaaaaaa') {
  return {
    taskId,
    model: 'jev-1.13.0',
    state: {
      command: 'archive the email from GitHub',
      'app in front': 'Mail',
      'controls on the screen': ['e1: row “GitHub”', 'e2: button “Archive”'],
    },
    questions: {
      done: { type: 'noul', instructions: 'Has the command been carried out completely?' },
      step: {
        type: 'choice',
        instructions: 'What is the very next step?',
        criteria: { press: 'Click one control', impossible: null },
      },
    },
  };
}

describe('/ask/v1 routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    logged.length = 0;
    hostedAskAccessFor.mockReset().mockResolvedValue('entitled');
    claimHostedAskTask.mockReset().mockResolvedValue({ ok: true, allowance: ALLOWANCE });
    askSystemOne
      .mockReset()
      .mockResolvedValue({ ok: true, model: 'jev-1.13.0', answers: { done: { noul: 0.02 } } });
    hostedAskConfigured.mockReset().mockReturnValue(true);
    app = Fastify();
    await app.register(askRoutes);
    await app.ready();
  });

  const post = (token: string | null, body: unknown = step()) =>
    app.inject({
      method: 'POST',
      url: '/ask/v1/systemone',
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      payload: body as object,
    });

  const status = (token: string | null) =>
    app.inject({
      method: 'GET',
      url: '/ask/v1/status',
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });

  it('preflights the same entitlement the hosted route enforces', async () => {
    const res = await status('device-token');
    expect(res.statusCode).toBe(200);
    expect(HostedAskStatusSchema.parse(res.json())).toEqual({
      configured: true,
      access: 'entitled',
    });
    expect(hostedAskAccessFor).toHaveBeenCalledWith('user-alice');

    hostedAskAccessFor.mockResolvedValue('not_entitled');
    expect(HostedAskStatusSchema.parse((await status('device-token')).json())).toEqual({
      configured: true,
      access: 'not_entitled',
    });
  });

  it('reports a missing service credential without blaming the subscription', async () => {
    hostedAskConfigured.mockReturnValue(false);
    const res = await status('device-token');
    expect(res.statusCode).toBe(200);
    expect(HostedAskStatusSchema.parse(res.json())).toEqual({ configured: false });
    expect(hostedAskAccessFor).not.toHaveBeenCalled();
  });

  it('preflights only for a live device, not a phone session', async () => {
    expect((await status(null)).statusCode).toBe(401);
    expect((await status('account-token')).statusCode).toBe(403);
  });

  it('answers a device on an entitled account', async () => {
    const res = await post('device-token');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      model: 'jev-1.13.0',
      answers: { done: { noul: 0.02 } },
      allowance: ALLOWANCE,
    });
  });

  it('accepts the dense grounded action choice the desktop actually sends', async () => {
    const controls = Array.from({ length: 120 }, (_, id) => ({
      id,
      role: 'button',
      label: `Action ${id}`,
      where: 'middle centre',
    }));
    const body = {
      ...step(),
      state: {
        ...step().state,
        'controls on the screen': controls.map(
          ({ id, role, label, where }) => `e${id}: ${role} “${label}” (${where})`,
        ),
      },
      questions: {
        done: { type: 'noul', instructions: 'Is the command complete?' },
        evidence: { type: 'noul', instructions: 'Does the screen show it complete?' },
        action: {
          type: 'choice',
          instructions: 'Choose the next offered action.',
          criteria: Object.fromEntries([
            ...controls.map(({ id, role, label, where }) => [
              `press:e${id}`,
              { operation: 'click', role, label, where },
            ]),
            ['wait', 'Wait briefly'],
            ['blocked', 'No offered action can make progress'],
            ['done', 'The screen proves the command is complete'],
          ]),
        },
      },
    };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(ASK_MAX_REQUEST_BYTES);
    const res = await post('device-token', body);
    expect(res.statusCode).toBe(200);
    expect(askSystemOne).toHaveBeenCalledOnce();
  });

  it('accepts the Rust desktop’s unreadable-screen app bootstrap request', async () => {
    // The Rust request builder asserts that it still emits this same shared
    // fixture. This side proves the hosted route accepts those exact bytes,
    // including structured Choice criteria, before a device gets the build.
    const desktopBody = JSON.parse(
      readFileSync(
        new URL(
          '../../../../packages/protocol/fixtures/grounded-bootstrap-step.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const body = { taskId: 'task-aaaaaaaa', ...desktopBody };
    const res = await post('device-token', body);
    expect(res.statusCode).toBe(200);
    expect(askSystemOne).toHaveBeenCalledWith(body);
  });

  it('needs a token at all', async () => {
    expect((await post(null)).statusCode).toBe(401);
    expect((await post('nonsense')).statusCode).toBe(401);
    expect(askSystemOne).not.toHaveBeenCalled();
  });

  it('needs a DEVICE token, not a signed-in phone', async () => {
    // Identity comes only from the token (ADR-0002), and the thing spending
    // an allowance is a Mac. An account session is a valid caller elsewhere
    // and must not be one here.
    const res = await post('account-token');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('device_token_required');
    expect(askSystemOne).not.toHaveBeenCalled();
  });

  it('refuses an account without a subscription, and spends nothing', async () => {
    hostedAskAccessFor.mockResolvedValue('not_entitled');
    const res = await post('device-token');
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe('not_entitled');
    // A free account must not be able to move a paying account's counters,
    // and must not learn what they are.
    expect(claimHostedAskTask).not.toHaveBeenCalled();
    expect(res.json().allowance).toBeUndefined();
    expect(askSystemOne).not.toHaveBeenCalled();
  });

  it('refuses a deleted account the same way, rather than serving it', async () => {
    hostedAskAccessFor.mockResolvedValue('no_such_account');
    expect((await post('device-token')).statusCode).toBe(402);
    expect(askSystemOne).not.toHaveBeenCalled();
  });

  it('fails closed with no service credential, before anything else is decided', async () => {
    hostedAskConfigured.mockReturnValue(false);
    const res = await post('device-token');
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('unconfigured');
    // Not "you are not entitled" to a customer who is: the server, not the
    // account, is what is missing something.
    expect(hostedAskAccessFor).not.toHaveBeenCalled();
    expect(claimHostedAskTask).not.toHaveBeenCalled();
  });

  it('fails closed when the allowance cannot be checked', async () => {
    claimHostedAskTask.mockRejectedValue(new Error('redis is down'));
    const res = await post('device-token');
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('allowance_unavailable');
    // Serving anyway would make 25 a day unbounded for the length of the
    // outage — which is an outage worth causing.
    expect(askSystemOne).not.toHaveBeenCalled();
  });

  it('says so when today’s tasks are spent', async () => {
    claimHostedAskTask.mockResolvedValue({
      ok: false,
      reason: 'daily_limit',
      allowance: { used: 25, limit: 25, resetsAt: '2026-09-20T00:00:00.000Z' },
    });
    const res = await post('device-token');
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('daily_limit');
    expect(res.json().allowance.resetsAt).toBe('2026-09-20T00:00:00.000Z');
    expect(askSystemOne).not.toHaveBeenCalled();
  });

  it('spends the allowance against the TOKEN’s account and the body’s task', async () => {
    await post('device-token');
    expect(claimHostedAskTask).toHaveBeenCalledWith('user-alice', 'task-aaaaaaaa');
  });

  it('counts a task once however many steps it takes', async () => {
    // The route's contribution to "count tasks, not steps" is that it passes
    // the SAME id for every step and does not invent one per request.
    await post('device-token', step('task-multistep'));
    await post('device-token', step('task-multistep'));
    await post('device-token', step('task-multistep'));
    expect(claimHostedAskTask.mock.calls.map((c) => c[1])).toEqual([
      'task-multistep',
      'task-multistep',
      'task-multistep',
    ]);
  });

  it('maps an upstream failure to 502 without quoting it', async () => {
    askSystemOne.mockResolvedValue({
      ok: false,
      reason: 'upstream',
      status: 401,
      detail: 'refused',
    });
    const res = await post('device-token');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('upstream');
    // A 401 from TypeSafe is a fact about Lilypad's account, not the
    // caller's. Passing the status through would tell every customer when the
    // service credential lapsed.
    expect(JSON.stringify(res.json())).not.toContain('401');
  });

  it('refuses a body that is not a step', async () => {
    for (const bad of [
      {},
      { ...step(), taskId: 'short' },
      { ...step(), questions: {} },
      { ...step(), state: { command: { nested: true } } },
      { ...step(), questions: { q: { type: 'essay', instructions: 'write' } } },
    ]) {
      const res = await post('device-token', bad);
      expect(res.statusCode).toBe(400);
    }
    expect(askSystemOne).not.toHaveBeenCalled();
  });

  it('refuses a body big enough to hold a screenshot', async () => {
    const huge = step();
    huge.state['controls on the screen'] = Array.from({ length: 64 }, () => 'x'.repeat(1000));
    expect(JSON.stringify(huge).length).toBeGreaterThan(ASK_MAX_REQUEST_BYTES / 4);
    const enormous = {
      ...step(),
      state: { command: 'x'.repeat(ASK_MAX_REQUEST_BYTES + 1_000) },
    };
    const res = await post('device-token', enormous);
    // Fastify's body limit rejects it before the schema is even consulted.
    expect(res.statusCode).toBe(413);
    expect(askSystemOne).not.toHaveBeenCalled();
  });

  it('never writes the request body to a log line', async () => {
    askSystemOne.mockResolvedValue({
      ok: false,
      reason: 'upstream',
      status: 500,
      detail: 'refused',
    });
    await post('device-token');
    const text = JSON.stringify(logged);
    expect(text).not.toContain('archive the email from GitHub');
    expect(text).not.toContain('GitHub');
    expect(text).not.toContain('task-aaaaaaaa');
  });

  it('never writes the request body to a log line on an allowance outage either', async () => {
    claimHostedAskTask.mockRejectedValue(new Error('redis is down'));
    await post('device-token');
    expect(JSON.stringify(logged)).not.toContain('archive the email from GitHub');
  });

  it('forwards only what the model is asked, never the accounting id', async () => {
    await post('device-token');
    const forwarded = askSystemOne.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(forwarded).sort()).toEqual(['model', 'questions', 'state', 'taskId']);
    // The route hands the validated request on whole; `askSystemOne` is what
    // strips `taskId` before it reaches TypeSafe, and its own test pins that.
    expect(forwarded.taskId).toBe('task-aaaaaaaa');
  });
});
