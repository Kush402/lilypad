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

  it('classifies 5xx as a retryable server error', () => {
    expect(classifyHttpStatus(500, '').code).toBe('server_error');
    expect(classifyHttpStatus(503, '').retryable).toBe(true);
  });

  it('falls back to unknown for other statuses, preserving the body in the message', () => {
    const err = classifyHttpStatus(400, 'bad request');
    expect(err.code).toBe('unknown');
    expect(err.message).toContain('400');
    expect(err.message).toContain('bad request');
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
