import { autonomyFor, resetAutonomyCache, setAutonomy } from './aiAutonomy';

const mockItems = new Map<string, string>();
const mockFail = { get: false, set: false };

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly' },
  getGenericPassword: jest.fn(async ({ service }: { service: string }) => {
    if (mockFail.get) throw new Error('keychain locked');
    const stored = mockItems.get(service);
    return stored === undefined ? false : { username: 'u', password: stored };
  }),
  setGenericPassword: jest.fn(
    async (_u: string, password: string, { service }: { service: string }) => {
      if (mockFail.set) throw new Error('keychain write denied');
      mockItems.set(service, password);
      return true;
    },
  ),
}));

beforeEach(() => {
  mockItems.clear();
  mockFail.get = false;
  mockFail.set = false;
  resetAutonomyCache();
});

test('nothing is chosen until the person chooses, per Mac', async () => {
  expect(await autonomyFor('mac-a')).toBeNull();
  expect(await setAutonomy('mac-a', 'full')).toBe(true);
  expect(await autonomyFor('mac-a')).toBe('full');
  expect(await autonomyFor('mac-b')).toBeNull();
  // Survives a restart of the app.
  resetAutonomyCache();
  expect(await autonomyFor('mac-a')).toBe('full');
  await setAutonomy('mac-a', 'supervised');
  expect(await autonomyFor('mac-a')).toBe('supervised');
});

test('full control is never inferred from something unreadable', async () => {
  mockItems.set('com.takedia.lilypad.ai-autonomy', JSON.stringify({ 'mac-a': 'everything' }));
  expect(await autonomyFor('mac-a')).toBeNull();
  mockItems.set('com.takedia.lilypad.ai-autonomy', 'not json');
  resetAutonomyCache();
  expect(await autonomyFor('mac-a')).toBeNull();
  mockFail.get = true;
  resetAutonomyCache();
  expect(await autonomyFor('mac-a')).toBeNull();
  expect(await autonomyFor('')).toBeNull();
});

test('a choice that cannot be stored still holds for this run and says so', async () => {
  mockFail.set = true;
  expect(await setAutonomy('mac-a', 'full')).toBe(false);
  expect(await autonomyFor('mac-a')).toBe('full');
});
