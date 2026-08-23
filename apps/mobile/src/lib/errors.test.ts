import {
  appError,
  classifyHttpStatus,
  classifyFetchError,
  toAppError,
  RedeemError,
} from './errors';

describe('appError', () => {
  it('fills in the default copy and retryability for a code', () => {
    const err = appError('token_expired');
    expect(err.code).toBe('token_expired');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/expired/i);
  });

  it('accepts a custom message while keeping the code/retryable mapping', () => {
    const err = appError('server_error', 'HTTP 503');
    expect(err.message).toBe('HTTP 503');
    expect(err.retryable).toBe(true);
  });
});

describe('classifyHttpStatus', () => {
  it('classifies 410 as a non-retryable expired token', () => {
    const err = classifyHttpStatus(410, 'gone');
    expect(err.code).toBe('token_expired');
    expect(err.retryable).toBe(false);
  });

  it('treats 404 the same way — the remedy is identical', () => {
    // A code from another backend, or one whose session is long gone. "Ask
    // for a new one on the laptop" is the true instruction for both, and a
    // separate code would only be a second way of saying it.
    expect(classifyHttpStatus(404, 'not found').code).toBe('token_expired');
  });

  it('classifies 429 as retryable, and says how long to wait', () => {
    // Reachable by a person who scans twice — the route is rate-limited.
    const err = classifyHttpStatus(429, '{"statusCode":429}');
    expect(err.code).toBe('rate_limited');
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/wait a minute/i);
  });

  it('classifies 5xx as a retryable server error', () => {
    expect(classifyHttpStatus(500, '').code).toBe('server_error');
    expect(classifyHttpStatus(503, '').retryable).toBe(true);
  });

  it('never puts a status line or a response body on screen', () => {
    // This replaces a test that asserted the OPPOSITE — it required the body
    // to be preserved in the message, which is how `HTTP 400: bad request`
    // came to be shown on the scanner. Nothing a server sends is copy this
    // app is willing to display; the backend logs its own 4xx, which is where
    // that answer actually lives.
    for (const status of [400, 401, 403, 409, 418]) {
      const err = classifyHttpStatus(status, '{"error":"internal_detail"}');
      expect(err.code).toBe('unknown');
      expect(err.message).not.toContain(String(status));
      expect(err.message).not.toContain('internal_detail');
      expect(err.message).not.toContain('HTTP');
    }
  });
});

describe('classifyFetchError', () => {
  it('classifies a timed-out abort as request_timeout', () => {
    expect(classifyFetchError(true).code).toBe('request_timeout');
  });

  it('classifies any other fetch failure as network_unreachable', () => {
    expect(classifyFetchError(false).code).toBe('network_unreachable');
  });
});

describe('toAppError', () => {
  it("preserves a RedeemError's classification", () => {
    const err = new RedeemError(appError('token_expired'));
    const normalized = toAppError(err);
    expect(normalized).toEqual({
      code: 'token_expired',
      message: err.message,
      retryable: false,
    });
  });

  it('flattens a plain Error to unknown, keeping its message', () => {
    const normalized = toAppError(new Error('boom'));
    expect(normalized).toEqual({ code: 'unknown', message: 'boom', retryable: true });
  });

  it('stringifies anything else thrown', () => {
    expect(toAppError('not an error').message).toBe('not an error');
  });
});
