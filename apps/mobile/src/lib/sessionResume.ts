/**
 * Opaque handle for reopening the Mac's still-Active session after this
 * process died. Only the desktop id — room id is not a bearer capability,
 * and `/connect/request` `{ resume: true }` is what looks up the live room.
 * Pair secret stays in the pairs keychain; room-auth + the device JWT still
 * gate join.
 *
 * Cleared on End, unpair, and a session the hub has actually torn down.
 * A brief app-switch does not write or clear this.
 */
import * as Keychain from 'react-native-keychain';

const SERVICE = 'com.takedia.lilypad.session-resume';
const ACCESSIBLE = Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY;

export interface ResumeHandle {
  desktopDeviceId: string;
}

let cache: ResumeHandle | null | undefined;

async function persist(handle: ResumeHandle | null): Promise<void> {
  cache = handle;
  try {
    if (!handle) {
      await Keychain.resetGenericPassword({ service: SERVICE });
      return;
    }
    await Keychain.setGenericPassword('session-resume', JSON.stringify(handle), {
      service: SERVICE,
      accessible: ACCESSIBLE,
    });
  } catch {
    /* in-memory cache still serves this run */
  }
}

export async function loadResumeHandle(): Promise<ResumeHandle | null> {
  if (cache !== undefined) return cache;
  try {
    const stored = await Keychain.getGenericPassword({ service: SERVICE });
    if (stored && stored.password) {
      const parsed: unknown = JSON.parse(stored.password);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'desktopDeviceId' in parsed &&
        typeof (parsed as ResumeHandle).desktopDeviceId === 'string'
      ) {
        cache = parsed as ResumeHandle;
        return cache;
      }
    }
  } catch {
    /* fall through */
  }
  cache = null;
  return null;
}

export async function saveResumeHandle(handle: ResumeHandle): Promise<void> {
  await persist(handle);
}

export async function clearResumeHandle(desktopDeviceId?: string): Promise<void> {
  const current = await loadResumeHandle();
  if (desktopDeviceId && current && current.desktopDeviceId !== desktopDeviceId) {
    return;
  }
  await persist(null);
}

/** Test / sign-out helper: drop the in-memory mirror so the next load hits storage. */
export function resetResumeHandleCache(): void {
  cache = undefined;
}
