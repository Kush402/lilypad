/**
 * Stable-ish device id for this phone. For the M1 mock it lives in memory;
 * Milestone 5 persists it to secure storage and binds it to the user account.
 */
let cached: string | null = null;

export function getDeviceId(): string {
  if (!cached) {
    cached = `mobile-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }
  return cached;
}
