import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Forwarding one Ask step on Lilypad's credential (ADR-0020).
 *
 * The config is faked rather than read, for two reasons: the real
 * `TYPESAFE_SERVICE_API_KEY` must never be needed to run the suite, and a
 * test that asserts "the key is not in the reply" is worth nothing unless it
 * knows exactly what the key is. `SERVICE_KEY` below is a fixture and is not
 * a credential for anything.
 */
const SERVICE_KEY = 'fixture-service-key-not-real-0000';

const env = {
  TYPESAFE_SERVICE_API_KEY: SERVICE_KEY as string | undefined,
  TYPESAFE_BASE_URL: 'https://api.typesafe.example/',
};
vi.mock('../config.js', () => ({
  config: {
    get env() {
      return env;
    },
  },
}));

const { askSystemOne, hostedAskConfigured } = await import('./askSystemOne.js');

function reply(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const STEP = {
  taskId: 'task-aaaaaaaa',
  model: 'jev-1.13.0',
  state: { command: 'archive the email from GitHub', 'app in front': 'Mail' },
  questions: {
    done: { type: 'noul' as const, instructions: 'Has the command been carried out?' },
  },
};

describe('the hosted System One call', () => {
  let calls: { url: string; init: RequestInit }[];
  let fetchImpl: typeof fetch;

  beforeEach(() => {
    env.TYPESAFE_SERVICE_API_KEY = SERVICE_KEY;
    calls = [];
    fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(reply({ model: 'jev-1.13.0', answers: { done: { noul: 0.9 } } }));
    }) as unknown as typeof fetch;
  });

  it('is unconfigured, and forwards nothing, without a key', async () => {
    env.TYPESAFE_SERVICE_API_KEY = undefined;
    expect(hostedAskConfigured()).toBe(false);
    expect(await askSystemOne(STEP, fetchImpl)).toEqual({ ok: false, reason: 'unconfigured' });
    expect(calls).toHaveLength(0);
  });

  it('treats a blank key as no key', async () => {
    // An operator who "cleared" the variable by setting it to spaces has a
    // server that must refuse, not one that sends `Bearer    `.
    env.TYPESAFE_SERVICE_API_KEY = '   ';
    expect(hostedAskConfigured()).toBe(false);
    expect(await askSystemOne(STEP, fetchImpl)).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('sends the service credential, and the desktop never sees it', async () => {
    const result = await askSystemOne(STEP, fetchImpl);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SERVICE_KEY}`);
    // Everything the route will hand back, searched for the key.
    expect(JSON.stringify(result)).not.toContain(SERVICE_KEY);
  });

  it('posts to the one endpoint, with no double slash from a trailing base', async () => {
    await askSystemOne(STEP, fetchImpl);
    expect(calls[0].url).toBe('https://api.typesafe.example/v1/systemone');
  });

  it('does not forward Lilypad’s own accounting id', async () => {
    await askSystemOne(STEP, fetchImpl);
    const body = JSON.parse(calls[0].init.body as string);
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    expect(calls[0].init.body).not.toContain('task-aaaaaaaa');
  });

  it('refuses to follow a redirect rather than re-sending the bearer', async () => {
    fetchImpl = (() =>
      Promise.resolve(
        new Response('', { status: 307, headers: { location: 'https://elsewhere.example/' } }),
      )) as unknown as typeof fetch;
    const result = await askSystemOne(STEP, fetchImpl);
    expect(result).toEqual({
      ok: false,
      reason: 'upstream',
      status: 307,
      detail: 'redirect refused',
    });
    expect(calls).toHaveLength(0);
  });

  it('sets `redirect: manual`, so the platform cannot follow one for it', async () => {
    await askSystemOne(STEP, fetchImpl);
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('drops the upstream’s own error text', async () => {
    fetchImpl = (() =>
      Promise.resolve(
        reply({ error: 'invalid_api_key', echo: 'archive the email from GitHub' }, { status: 401 }),
      )) as unknown as typeof fetch;
    const result = await askSystemOne(STEP, fetchImpl);
    expect(result).toEqual({ ok: false, reason: 'upstream', status: 401, detail: 'refused' });
    // TypeSafe's message is written for whoever holds the account, and is
    // exactly the sort of string that quotes back what was sent.
    expect(JSON.stringify(result)).not.toContain('archive the email');
    expect(JSON.stringify(result)).not.toContain('invalid_api_key');
  });

  it('abandons a reply too large to be a step’s answers', async () => {
    const huge = 'x'.repeat(200 * 1024);
    fetchImpl = (() =>
      Promise.resolve(reply({ model: 'jev-1.13.0', answers: { done: huge } }))) as never;
    const result = await askSystemOne(STEP, fetchImpl);
    expect(result).toEqual({
      ok: false,
      reason: 'upstream',
      status: 200,
      detail: 'reply too large',
    });
  });

  it('refuses an answer that is not the documented shape', async () => {
    for (const body of [{ answers: {} }, { model: 'jev-1.13.0' }, { model: 1, answers: {} }]) {
      fetchImpl = (() => Promise.resolve(reply(body))) as never;
      const result = await askSystemOne(STEP, fetchImpl);
      expect(result.ok).toBe(false);
    }
  });

  it('turns a transport failure into a reason, never an exception', async () => {
    fetchImpl = (() => Promise.reject(new TypeError('fetch failed'))) as never;
    const result = await askSystemOne(STEP, fetchImpl);
    expect(result).toEqual({ ok: false, reason: 'upstream', status: null, detail: 'TypeError' });
  });

  it('passes the answers through exactly as they arrived', async () => {
    // The calibrated numbers are the whole product of the call; rounding or
    // reshaping them here would silently move every threshold the Mac
    // measured (ADR-0019, ADR-0020).
    const answers = { done: { type: 'noul', noul: 0.8231 }, step: { choice: 'press' } };
    fetchImpl = (() => Promise.resolve(reply({ model: 'jev-1.13.0', answers }))) as never;
    const result = await askSystemOne(STEP, fetchImpl);
    expect(result).toEqual({ ok: true, model: 'jev-1.13.0', answers });
  });
});
