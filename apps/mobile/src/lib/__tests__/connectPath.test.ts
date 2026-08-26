import { resolveConnectTarget } from '../connectPath';
import { lanFetch } from '../lanTls';
import type { PairedDesktop } from '../pairs';

jest.mock('../lanDiscovery', () => ({
  discoverLanDesktop: jest.fn().mockResolvedValue(null),
}));

jest.mock('../lanTls', () => ({
  lanFetch: jest.fn(),
  lanPinningAvailable: jest.fn().mockReturnValue(false),
}));

const basePair: PairedDesktop = {
  desktopDeviceId: 'desktop-abcdefgh',
  name: 'Mac',
  apiBaseUrl: 'https://api.takedia.com',
  addedAt: 0,
  lastConnectedAt: null,
};

describe('resolveConnectTarget', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses cloud when no LAN URLs are cached', async () => {
    const target = await resolveConnectTarget(basePair);
    expect(target.apiBaseUrl).toBe('https://api.takedia.com');
  });

  it('falls back to cloud when LAN probe fails', async () => {
    (lanFetch as jest.Mock).mockRejectedValue(new Error('offline'));
    const target = await resolveConnectTarget({
      ...basePair,
      lanApiBaseUrl: 'https://192.168.1.10:8787',
      lanSignalingUrl: 'wss://192.168.1.10:8787/ws/signal',
      lanTlsCertSha256: 'a'.repeat(64),
    });
    expect(target.apiBaseUrl).toBe('https://api.takedia.com');
  });

  it('prefers LAN when probe succeeds', async () => {
    (lanFetch as jest.Mock).mockResolvedValue({ ok: true } as Response);
    const target = await resolveConnectTarget({
      ...basePair,
      lanApiBaseUrl: 'https://192.168.1.10:8787/',
      lanSignalingUrl: 'wss://192.168.1.10:8787/ws/signal',
      lanTlsCertSha256: 'a'.repeat(64),
    });
    expect(target.apiBaseUrl).toBe('https://192.168.1.10:8787');
  });
});
