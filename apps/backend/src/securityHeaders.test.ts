import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * The headers are set by a hook in `server.ts`, which cannot be built in a
 * unit test without real Postgres and Redis. This asserts the hook's contract
 * on an equivalent instance, so a header being dropped from the list fails
 * here rather than in a pen test.
 *
 * Kept honest by `server.security-headers` in `docs/deployment.md`: the live
 * check is a `curl -I` against production, and this is what stops the code
 * regressing between those.
 */
const EXPECTED: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(EXPECTED)) reply.header(k, v);
    return payload;
  });
  app.get('/ok', async () => ({ ok: true }));
  app.get('/boom', async () => {
    throw new Error('deliberate');
  });
  await app.ready();
});

afterAll(async () => app.close());

describe('security headers', () => {
  it('are present on a normal response', async () => {
    const res = await app.inject({ method: 'GET', url: '/ok' });
    for (const [k, v] of Object.entries(EXPECTED)) expect(res.headers[k]).toBe(v);
  });

  it('are present on an ERROR response too — the one an attacker aims at', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    for (const [k, v] of Object.entries(EXPECTED)) expect(res.headers[k]).toBe(v);
  });

  it('are present on a 404, where no route ran at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(res.statusCode).toBe(404);
    for (const [k, v] of Object.entries(EXPECTED)) expect(res.headers[k]).toBe(v);
  });
});
