import { requestConnectForPair, lanSignalingUrlFromApiBase } from '../api';
import { resolveConnectTarget } from '../connectPath';
import { lanFetch } from '../lanTls';
import { accessToken } from '../auth';

jest.mock('../connectPath');
jest.mock('../lanTls', () => ({
  lanFetch: jest.fn(),
  lanPinningAvailable: jest.fn().mockReturnValue(true),
}));
jest.mock('../auth', () => ({
  accessToken: jest.fn().mockResolvedValue('token'),
  DeviceAuthError: class extends Error {},
  unauthorizedError: (msg: string) => new Error(msg),
}));
jest.mock('../device', () => ({
  initDeviceIdentity: jest.fn().mockResolvedValue('mobile-12345678'),
  deviceLabel: () => 'phone',
}));

const resolveMock = resolveConnectTarget as jest.MockedFunction<typeof resolveConnectTarget>;
const lanFetchMock = lanFetch as jest.MockedFunction<typeof lanFetch>;

describe('requestConnectForPair', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.clearAllMocks();
  });

  it('derives LAN signaling URL from the selected API base', () => {
    expect(lanSignalingUrlFromApiBase('https://192.168.1.20:8787')).toBe(
      'wss://192.168.1.20:8787/ws/signal',
    );
  });

  it('falls back to cloud when LAN connect/request fails', async () => {
    resolveMock.mockResolvedValue({
      apiBaseUrl: 'https://192.168.1.10:8787',
      lanTlsCertSha256: 'a'.repeat(64),
    });
    lanFetchMock.mockRejectedValue(new Error('not_trusted'));
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          roomId: 'room-cloud',
          signalingUrl: 'wss://api.takedia.com/ws/signal',
          scopes: ['view'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const res = await requestConnectForPair({
      desktopDeviceId: 'desktop-abcdefgh',
      name: 'Mac',
      apiBaseUrl: 'https://api.takedia.com',
      lanApiBaseUrl: 'https://192.168.1.10:8787',
      lanTlsCertSha256: 'a'.repeat(64),
      connectSecret: 'secret',
      addedAt: 0,
      lastConnectedAt: null,
    });

    expect(res.roomId).toBe('room-cloud');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.takedia.com/connect/request',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(accessToken).toHaveBeenCalled();
  });
});
