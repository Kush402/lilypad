import {
  appError,
  classifyHttpStatus,
  classifyFetchError,
  toAppError,
  classifyHubError,
  RedeemError,
  UserFacingError,
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

  /**
   * Both of these pinned the opposite behaviour until 2026-08-24, and both are
   * flipped rather than deleted because the assertion is still the one worth
   * making — it just pointed the wrong way.
   *
   * `boom` is a stand-in for what a real unplanned throw says: a TypeError
   * from the WebRTC path reads "undefined is not an object (evaluating
   * 'this.pc.close')". Keeping the message meant that sentence rendered in the
   * viewer, mid-session, to a customer — the exact failure this module's
   * opening comment says it exists to prevent, fixed for HTTP bodies and left
   * live on the catch-all.
   */
  it('does not put an unplanned Error message on screen', () => {
    const normalized = toAppError(new Error('boom'));
    expect(normalized).toEqual({
      code: 'unknown',
      message: 'Something went wrong. Try again in a moment.',
      retryable: true,
    });
  });

  it('keeps a message that was written for a person', () => {
    // The distinction cannot be made from the type — our own curated copy was
    // thrown as a plain `Error` too — so it is marked, not guessed.
    const ours = new UserFacingError('That code has expired. Show a new one on the computer.');
    expect(toAppError(ours).message).toBe('That code has expired. Show a new one on the computer.');
  });

  it('does not stringify a non-Error onto the screen', () => {
    // `String({})` is "[object Object]", which is not an explanation of
    // anything.
    expect(toAppError('not an error').message).toBe('Something went wrong. Try again in a moment.');
    expect(toAppError({}).message).not.toMatch(/object Object/);
  });
});

/**
 * The comment on `classifyHubError` calls passing the hub's own words through
 * "alarming, and about the wrong thing" — and then the default branch did
 * exactly that for every code except the one that had been fixed. `message` is
 * a protocol string aimed at a developer.
 */
describe('classifyHubError', () => {
  it('never repeats the hub’s protocol text to a person', () => {
    const err = classifyHubError(
      'some_future_code',
      'this device is not authorized to join this room',
    );
    expect(err.message).not.toMatch(/not authorized to join/);
    expect(err.code).toBe('unknown');
  });

  it('still translates the one that actually happens', () => {
    // A laptop's lid closing is enough to cause this; observed four times in
    // 48 hours on production with a single user.
    expect(classifyHubError('unauthorized_room', 'whatever').code).toBe('session_gone');
  });
});

/**
 * A pair joins two devices on ONE account
 * ([ADR-0015](../../../docs/adr/0015-ownership-follows-sign-in.md)), so
 * scanning a colleague's Mac is refused.
 *
 * Without its own branch it lands on `unknown` — "Something went wrong. Try
 * again in a moment." — about the one failure where trying again can only fail
 * the same way, and where the remedy (sign in to the same account on both) is
 * not guessable from a 403.
 */
describe('a laptop on someone else’s account', () => {
  it('is named, and is not offered as retryable', () => {
    const err = classifyHttpStatus(403, '{"error":"different_account","message":"…"}');
    expect(err.code).toBe('different_account');
    expect(err.message).toMatch(/different Lilypad account/i);
    expect(err.retryable).toBe(false);
  });

  /** Other 403s must not be relabelled as this one — they have no such remedy
   * and saying so would send the user to change an account that is fine. */
  it('does not claim it about every refusal', () => {
    expect(classifyHttpStatus(403, '{"error":"forbidden"}').code).not.toBe('different_account');
  });
});

/**
 * A laptop that is no longer on the account — because it signed itself out, or
 * because its owner removed it from "Your devices". The backend cannot tell
 * those apart and both have the same remedy, so the code is named for the fact.
 *
 * Signing out of a Mac releases it from the account (ADR-0015), and the pair
 * survives — so this phone still lists it, still holds the connect secret, and
 * still gets a refusal when it rings. The refusal had two previous shapes and
 * both misdirected: `desktop_offline` sends the owner to check a power cable
 * for a machine sitting switched on in front of them, and `not_trusted` sends
 * them to a pairing screen that refuses a computer no account owns.
 */
describe('a laptop that is not on the account', () => {
  it('is named, is not retryable, and says the pairing survived', () => {
    const err = appError('desktop_not_on_account');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/not on your Lilypad account/i);
    expect(err.message).toMatch(/sign in to lilypad on it/i);
    // The half that stops it reading as "start over".
    expect(err.message).toMatch(/pairing is still there/i);
  });

  it('is not confused with a pairing somebody ended', () => {
    expect(appError('desktop_not_on_account').message).not.toBe(appError('trust_revoked').message);
    expect(appError('desktop_not_on_account').message).not.toBe(
      appError('desktop_offline').message,
    );
  });
});
