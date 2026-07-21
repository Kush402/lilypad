import { redeemToken, requestUnpair } from './api';
import { RedeemError } from './errors';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
