import { getDeviceId } from './device';

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
