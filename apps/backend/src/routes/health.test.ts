import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/**
 * `GET /health` — the one endpoint an operator hits to ask "what is running?".
 *
 * It used to answer with two version fields, and one of them lied. `version`
 * was the literal `'0.1.0'` written into this route's source; `pnpm release`
 * bumps the desktop and the phone but has never touched it, so production
 * reported `0.1.0` through v0.1.1, v0.1.2, v0.1.3 and v0.1.4 while `revision`
 * sat next to it holding the truth. Nothing read the field — it existed only
 * to be wrong.
 *
 * These tests pin the two properties that matter: the commit is reported and
 * comes from the environment, and a hand-edited version string does not come
 * back. The second is the one that fails if somebody re-adds the literal.
 */

vi.mock('../db/client.js', () => ({ pingPostgres: vi.fn(async () => true) }));
vi.mock('../redis.js', () => ({ pingRedis: vi.fn(async () => true) }));
vi.mock('../config.js', () => ({
  config: { env: { RESEND_API_KEY: undefined, MAIL_FROM: undefined } },
}));

async function get() {
  // Imported inside the helper so each test observes the GIT_SHA set for it —
  // the module reads process.env once, at import time.
  vi.resetModules();
  const { healthRoutes } = await import('./health.js');
  const app = Fastify();
  await app.register(healthRoutes);
  const res = await app.inject({ method: 'GET', url: '/health' });
  await app.close();
  return { res, body: res.json() };
}

describe('GET /health', () => {
  const original = process.env.GIT_SHA;
  beforeEach(() => {
    if (original === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = original;
  });

  it('reports the commit the image was built from', async () => {
    process.env.GIT_SHA = 'abc123def456';
    const { res, body } = await get();
    expect(res.statusCode).toBe(200);
    expect(body.revision).toBe('abc123def456');
  });

  it('says `unknown` rather than guessing when no commit was baked in', async () => {
    delete process.env.GIT_SHA;
    const { body } = await get();
    expect(body.revision).toBe('unknown');
  });

  it('carries no hand-edited version string', async () => {
    const { body } = await get();
    // `revision` is the only version this service has. A `version` key here is
    // a literal in the source that no release step updates, which is exactly
    // how production came to report 0.1.0 four releases running.
    expect(body).not.toHaveProperty('version');
  });

  it('still reports dependency state and an unconfigured mailer', async () => {
    const { body } = await get();
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ postgres: 'up', redis: 'up', mail: 'unconfigured' });
  });
});
