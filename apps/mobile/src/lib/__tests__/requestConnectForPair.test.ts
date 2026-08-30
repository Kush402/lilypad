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
    // The whole v0.1.21 ring bug in one assertion. `api.takedia.com` is a
    // normal publicly-trusted endpoint; a socket to it carrying the laptop's
    // self-signed LAN pin can never complete its handshake, and on iOS it did
    // not even fail out loud — six rings hung on "Connecting…" with no error
    // and no WebSocket upgrade in the backend's logs. The pin is absent here
    // because the LAN target lost, and that is the only thing that decides it.
    expect(res.signalingTlsPin).toBeUndefined();
    expect(res.signalingUrl).toBe('wss://api.takedia.com/ws/signal');
  });

  it('carries the pin with the URL it was issued for when LAN wins', async () => {
    globalThis.fetch = jest.fn();
    resolveMock.mockResolvedValue({
      apiBaseUrl: 'https://192.168.1.10:8787',
      lanTlsCertSha256: 'a'.repeat(64),
    });
    lanFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          roomId: 'room-lan',
          // What the backend answers with — deliberately the cloud URL, which
          // is why `requestConnectForPair` rewrites it. The pin has to travel
          // with the rewrite, not with the pair it came from.
          signalingUrl: 'wss://api.takedia.com/ws/signal',
          scopes: ['view', 'control'],
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

    expect(res.signalingUrl).toBe('wss://192.168.1.10:8787/ws/signal');
    expect(res.signalingTlsPin).toBe('a'.repeat(64));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('sends resume: true when asked to rejoin a live session', async () => {
    resolveMock.mockResolvedValue({ apiBaseUrl: 'https://api.takedia.com' });
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          roomId: 'room-live',
          signalingUrl: 'wss://api.takedia.com/ws/signal',
          scopes: ['view'],
          resumed: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const res = await requestConnectForPair(
      {
        desktopDeviceId: 'desktop-abcdefgh',
        name: 'Mac',
        apiBaseUrl: 'https://api.takedia.com',
        connectSecret: 'secret',
        addedAt: 0,
        lastConnectedAt: null,
      },
      { resume: true },
    );

    expect(res.resumed).toBe(true);
    const body = JSON.parse((globalThis.fetch as jest.Mock).mock.calls[0][1].body as string);
    expect(body.resume).toBe(true);
  });
});
