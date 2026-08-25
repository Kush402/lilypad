import { deviceLabel, getDeviceId } from './device';

describe('getDeviceId', () => {
  it('returns the same id on repeated calls (stable for the process lifetime)', () => {
    const first = getDeviceId();
    const second = getDeviceId();
    expect(second).toBe(first);
  });

  it('is prefixed with "mobile-" and non-empty', () => {
    const id = getDeviceId();
    expect(id.startsWith('mobile-')).toBe(true);
    expect(id.length).toBeGreaterThan('mobile-'.length);
  });
});

/**
 * The name a human reads, in two places: "Your devices" on the account, and
 * the approve prompt a Mac shows when this phone asks for a session.
 *
 * Both said "ios phone" until 2026-08-24, so an account with two phones on it
 * listed two rows with the same name — the screenshot that started this.
 */
describe('deviceLabel', () => {
  it('names the form factor rather than the platform id', () => {
    // `Platform.OS` is 'ios' under jest's react-native preset.
    expect(deviceLabel()).toBe('iPhone');
    expect(deviceLabel()).not.toMatch(/ios/);
  });
});
