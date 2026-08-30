import { redeemToken, requestUnpair, requestConnect } from './api';
import { RedeemError } from './errors';
import { accessToken, DeviceAuthError } from './auth';

// The device-token exchange is `auth.ts`'s job and has its own tests. Mocking
// it keeps these about `api.ts` — and keeps a single `fetch` mock from having
// to serve two unrelated conversations.
jest.mock('./auth', () => {
  // Mirrors the real constructor: it takes a reason CODE, not a message, so a
  // test written against this shape stays honest about the real signature.
  // A parameter property (`readonly code`) is rejected by babel's mock-factory
  // guard, so the field is assigned explicitly.
  class FakeDeviceAuthError extends Error {
    code: 'device_not_enrolled' | 'device_revoked';
    constructor(reason: 'device_not_enrolled' | 'device_revoked') {
      super(
        reason === 'device_revoked'
          ? 'This phone was removed from the account. Sign in to add it again.'
          : 'This phone is not signed in yet.',
      );
      this.code = reason;
      this.name = 'DeviceAuthError';
    }
  }
  return { accessToken: jest.fn(), DeviceAuthError: FakeDeviceAuthError };
});

const accessTokenMock = accessToken as jest.MockedFunction<typeof accessToken>;

/**
 * The default state is now SIGNED IN.
 *
 * It used to be the opposite — "the un-enrolled majority until P1" — because
 * the backend accepted a pairing request from a phone no account owned. The
 * product model is account → devices now: that lane is closed, so a phone
 * reaching these calls has an account, and the un-enrolled case is the
 * exception each surface handles explicitly below.
 */
beforeEach(() => {
  accessTokenMock.mockResolvedValue('a-device-token');
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headersOf(fetchMock: jest.Mock): Record<string, string> {
  return (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
}

describe('redeemToken', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.useRealTimers();
  });

  it('returns the parsed response on success', async () => {
    const body = { roomId: 'r1', signalingUrl: 'ws://x', scopes: ['view'], desktopDeviceName: 'x' };
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(body));

    const res = await redeemToken('http://api', 'tok');
    expect(res).toEqual(body);
  });

  it('classifies a 410 as a non-retryable token_expired RedeemError', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'token_invalid' }, 410));

    await expect(redeemToken('http://api', 'tok')).rejects.toMatchObject({
      code: 'token_expired',
      retryable: false,
    });
  });

  it('classifies a 500 as a retryable server_error RedeemError', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({}, 500));

    await expect(redeemToken('http://api', 'tok')).rejects.toMatchObject({
      code: 'server_error',
      retryable: true,
    });
  });

  it('classifies a rejected fetch as network_unreachable', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

    await expect(redeemToken('http://api', 'tok')).rejects.toMatchObject({
      code: 'network_unreachable',
    });
  });

  it('classifies its own timeout as request_timeout, not network_unreachable', async () => {
    jest.useFakeTimers();
    globalThis.fetch = jest.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const pending = redeemToken('http://api', 'tok');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'request_timeout' });
    await jest.advanceTimersByTimeAsync(8_000);
    await assertion;
  });

  it('lets an external AbortSignal cancel the request', async () => {
    const controller = new AbortController();
    globalThis.fetch = jest.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const pending = redeemToken('http://api', 'tok', controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(RedeemError);
  });
});

describe('requestUnpair', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.useRealTimers();
  });

  it('resolves true and posts { desktopDeviceId, mobileDeviceId } on a 200', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock;

    const result = await requestUnpair('http://api', 'desktop-1');

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api/devices/unpair',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.desktopDeviceId).toBe('desktop-1');
    expect(typeof body.mobileDeviceId).toBe('string');
    expect(body.mobileDeviceId.length).toBeGreaterThan(0);
  });

  it('resolves false (never throws) on a non-ok response', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({}, 500));

    await expect(requestUnpair('http://api', 'desktop-1')).resolves.toBe(false);
  });

  it('resolves false (never throws) on a network error', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

    await expect(requestUnpair('http://api', 'desktop-1')).resolves.toBe(false);
  });

  it('resolves false (never throws) on its own timeout', async () => {
    jest.useFakeTimers();
    globalThis.fetch = jest.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const pending = requestUnpair('http://api', 'desktop-1');
    const assertion = expect(pending).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(8_000);
    await assertion;
  });
});

/**
 * M9 — proving WHICH phone this is
 * ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
 *
 * The backend demands a device token for a phone an account owns, and accepts
 * none for a phone nobody owns. These are the client half of that contract:
 * send one whenever we can get one, and never let its absence break pairing.
 */
describe('device token on the pairing surface', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const calls = [
    ['redeemToken', () => redeemToken('http://api', 'tok')],
    ['requestConnect', () => requestConnect('http://api', 'desktop-1')],
    ['requestUnpair', () => requestUnpair('http://api', 'desktop-1')],
  ] as const;

  for (const [name, call] of calls) {
    it(`${name} sends the device token when this phone has one`, async () => {
      accessTokenMock.mockResolvedValue('a-device-token');
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true }));
      globalThis.fetch = fetchMock;

      await call();

      expect(headersOf(fetchMock).authorization).toBe('Bearer a-device-token');
    });
  }

  /**
   * A phone on no account can no longer pair or connect: `authorize.ts` denies
   * it, and the 404 that comes back is indistinguishable from "no such
   * laptop". So these two must not send the request at all — they surface
   * `DeviceAuthError` so the scanner can route to sign-in, which is the only
   * thing that actually fixes it.
   */
  for (const [name, call] of [calls[0], calls[1]] as const) {
    it(`${name} reports the missing account instead of sending a doomed request`, async () => {
      accessTokenMock.mockRejectedValue(new DeviceAuthError('device_not_enrolled'));
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true }));
      globalThis.fetch = fetchMock;

      await expect(call()).rejects.toBeInstanceOf(DeviceAuthError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  /**
   * `requestUnpair` is the exception, and deliberately: forgetting a laptop
   * must succeed locally even offline, with a stale address, or signed out.
   * It is best-effort by contract and returns false rather than throwing.
   */
  it('requestUnpair still succeeds with no account, because forgetting must always work', async () => {
    accessTokenMock.mockRejectedValue(new DeviceAuthError('device_not_enrolled'));
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock;

    await expect(requestUnpair('http://api', 'desktop-1')).resolves.toBe(true);
    expect(headersOf(fetchMock).authorization).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * `/connect/request` refuses for four different reasons, and only one of them
 * used to have its own sentence. What is pinned here is the newest, because it
 * is the one the product's own behaviour created: signing out of a Mac releases
 * it (ADR-0015), so a laptop that is switched on, online, and still paired can
 * refuse to be rung.
 */
describe('ringing a laptop that signed itself out', () => {
  it('is told apart from a laptop that is off, and from a pairing that ended', async () => {
    const cases: Array<[number, string, string]> = [
      [403, 'desktop_not_on_account', 'desktop_not_on_account'],
      [403, 'revoked', 'trust_revoked'],
      [503, 'desktop_offline', 'desktop_offline'],
      [404, 'not_trusted', 'not_trusted'],
      [409, 'session_gone', 'session_gone'],
    ];
    for (const [status, serverCode, expected] of cases) {
      globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: serverCode }, status));
      await expect(requestConnect('http://api', 'desktop-1')).rejects.toMatchObject({
        code: expected,
      });
    }
  });
});
