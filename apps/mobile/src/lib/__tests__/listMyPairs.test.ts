import { listMyPairs, AccountDeviceError } from '../accountDevices';
import { accessToken, DeviceAuthError } from '../auth';

jest.mock('../auth', () => {
  class FakeDeviceAuthError extends Error {
    code: 'device_not_enrolled' | 'device_revoked';
    constructor(reason: 'device_not_enrolled' | 'device_revoked') {
      super('This phone is not signed in yet.');
      this.code = reason;
      this.name = 'DeviceAuthError';
    }
  }
  return { accessToken: jest.fn(), DeviceAuthError: FakeDeviceAuthError };
});

const accessTokenMock = accessToken as jest.MockedFunction<typeof accessToken>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  accessTokenMock.mockResolvedValue('a-device-token');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  jest.clearAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The caller uses this result to DELETE local rows, so the one thing this
 * function may never do is answer an unsuccessful request with an empty list.
 * That would read as "you have no laptops" and wipe every one of them off the
 * phone — turning a dropped connection into data loss.
 */
describe('listMyPairs never reports emptiness it did not hear', () => {
  it('throws, rather than returning [], when the request fails', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

    await expect(listMyPairs('https://api.takedia.com')).rejects.toBeInstanceOf(AccountDeviceError);
  });

  it('throws on a non-2xx instead of reading it as no pairs', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));

    await expect(listMyPairs('https://api.takedia.com')).rejects.toBeInstanceOf(AccountDeviceError);
  });

  it('surfaces a missing account as itself, so the caller can route to sign-in', async () => {
    accessTokenMock.mockRejectedValue(new DeviceAuthError('device_not_enrolled'));
    globalThis.fetch = jest.fn();

    await expect(listMyPairs('https://api.takedia.com')).rejects.toBeInstanceOf(DeviceAuthError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns an empty list only when the backend actually says so', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({ pairs: [] }));

    await expect(listMyPairs('https://api.takedia.com')).resolves.toEqual([]);
  });

  it('sends the device token, because the route is scoped by who is asking', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ pairs: [] }));
    globalThis.fetch = fetchMock;

    await listMyPairs('https://api.takedia.com/');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.takedia.com/devices/pairs/mine');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer a-device-token');
  });
});
