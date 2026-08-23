import { describe, it, expect } from 'vitest';
import { safeErrorResponse } from './errorResponse.js';

/**
 * The specific string this exists to stop shipping. It is what Fastify's
 * default handler returned for a thrown `Error` — verified by running one
 * against the pinned version — and it names a table, a file path and a line
 * number to an anonymous caller.
 */
const LEAKY = 'relation "devices_secret" does not exist at /repo/apps/backend/dist/db/client.js:42';

describe('what a 5xx is allowed to say', () => {
  it('says nothing about the failure itself', () => {
    const res = safeErrorResponse(new Error(LEAKY), 'req-4f');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('devices_secret');
    expect(JSON.stringify(res.body)).not.toContain('/repo/');
    expect(res.body.error).toBe('internal_error');
    expect(res.logAsServerError).toBe(true);
  });

  it('carries the request id, so the log can answer what the body cannot', () => {
    expect(safeErrorResponse(new Error(LEAKY), 'req-4f').body.requestId).toBe('req-4f');
  });

  it('treats anything without a status as a server fault, not a client one', () => {
    // The safe direction. An error that forgot to classify itself must not be
    // assumed harmless and echoed.
    for (const thrown of [new Error(LEAKY), 'a bare string', null, undefined, { message: LEAKY }]) {
      const res = safeErrorResponse(thrown, 'req-1');
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('devices_secret');
    }
  });

  it('keeps a 503 a 503 rather than flattening every server fault to 500', () => {
    const res = safeErrorResponse(Object.assign(new Error(LEAKY), { statusCode: 503 }), 'req-2');
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('devices_secret');
  });
});

describe('what a 4xx is allowed to say', () => {
  it('passes Fastify’s own validation message through, because it names the field', () => {
    const err = Object.assign(new Error('body/email must match format "email"'), {
      statusCode: 400,
      code: 'FST_ERR_VALIDATION',
      validation: [{ instancePath: '/email' }],
    });
    const res = safeErrorResponse(err, 'req-3');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('FST_ERR_VALIDATION');
    expect(res.body.message).toContain('email');
    // A client mistake is not a server error, and logging every one at error
    // level is how a log stops being read.
    expect(res.logAsServerError).toBe(false);
  });

  it('passes the rate limiter’s 429 through, because waiting is the remedy', () => {
    const err = Object.assign(new Error('Rate limit exceeded, retry in 1 minute'), {
      statusCode: 429,
      code: 'FST_ERR_RATE_LIMIT',
    });
    const res = safeErrorResponse(err, 'req-5');
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/retry in 1 minute/);
  });

  it('never invents a code it was not given', () => {
    const res = safeErrorResponse(Object.assign(new Error('nope'), { statusCode: 403 }), 'req-6');
    expect(res.body.error).toBe('bad_request');
  });
});
