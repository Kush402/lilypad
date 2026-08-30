import {
  loadResumeHandle,
  saveResumeHandle,
  clearResumeHandle,
  resetResumeHandleCache,
} from '../sessionResume';

const mockStore = new Map<string, { username: string; password: string }>();

jest.mock('react-native-keychain', () => {
  const key = (options?: { service?: string }) => options?.service ?? 'default';
  return {
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
    getGenericPassword: jest.fn((options?: { service?: string }) =>
      Promise.resolve(mockStore.get(key(options)) ?? false),
    ),
    setGenericPassword: jest.fn(
      (username: string, password: string, options?: { service?: string }) => {
        mockStore.set(key(options), { username, password });
        return Promise.resolve(true);
      },
    ),
    resetGenericPassword: jest.fn((options?: { service?: string }) => {
      mockStore.delete(key(options));
      return Promise.resolve(true);
    }),
  };
});

describe('sessionResume handle', () => {
  beforeEach(() => {
    mockStore.clear();
    resetResumeHandleCache();
  });

  it('round-trips a desktop id and ignores a handle for a different laptop', async () => {
    await saveResumeHandle({ desktopDeviceId: 'desktop-1' });
    expect(await loadResumeHandle()).toEqual({ desktopDeviceId: 'desktop-1' });
    await clearResumeHandle('desktop-other');
    expect(await loadResumeHandle()).toEqual({ desktopDeviceId: 'desktop-1' });
    await clearResumeHandle('desktop-1');
    expect(await loadResumeHandle()).toBeNull();
  });
});
