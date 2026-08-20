import * as Keychain from 'react-native-keychain';

/**
 * Whether this phone is signed in, and to what.
 *
 * **This is a record, not a credential.** Nothing here authenticates anything:
 * the phone's only durable credential is the Ed25519 private key in the
 * Keychain, exactly as `signIn.ts` describes, and every backend call is still
 * authorized by a freshly signed challenge. What this file adds is the ability
 * to answer "is somebody signed in?" *without* a network round trip — which the
 * app now has to answer on launch, before its first screen, and must answer
 * correctly on a plane.
 *
 * Deleting it is therefore a local sign-out: the key is still enrolled
 * server-side until the account revokes the device, which is the honest model
 * — signing out of an app has never been the same act as revoking a device, and
 * `AccountDevicesScreen` is where the second one lives.
 *
 * Stored in the Keychain rather than AsyncStorage for one practical reason:
 * `identity.ts` and `pairs.ts` already are, so a wipe of app storage leaves all
 * three in the same state instead of a signed-out app that still holds pairs.
 */

const SERVICE = 'com.takedia.lilypad.session';

/**
 * Every Keychain write in this app uses the same accessibility class, and it
 * has to be the strictest one: `identity.ts` already pins the device key to
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY, so the key never rides an iCloud or iTunes
 * backup onto another phone.
 *
 * Leaving the other two stores on the library default (`WhenUnlocked`, which
 * DOES migrate) produced two problems. The smaller one is a credential in a
 * backup for no reason: `connectSecret` is a bearer secret presented on every
 * no-QR reconnect. The larger one is incoherence — a restored phone would find
 * a list of paired Macs and no device key to reach them with, so the user sees
 * their computers, taps one, and it fails with nothing to explain why.
 *
 * A restored backup should start signed out and empty, which is what actually
 * happened to the identity all along.
 */
const ACCESSIBLE = Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY;

export interface StoredSession {
  /** The account this phone enrolled onto. */
  userId: string;
  /** The backend that account lives on. Recorded rather than assumed so a
   * phone enrolled against a self-hosted server keeps talking to it even after
   * the shipped default changes. */
  apiBaseUrl: string;
  /** What to show in the UI. Absent for sign-ins that never revealed one —
   * Apple's Hide My Email, most obviously. */
  email?: string;
  name?: string;
  signedInAt: number;
}

let cache: StoredSession | null = null;
let loaded = false;

/** The current session, or null. Cached after the first read. */
export async function loadSession(): Promise<StoredSession | null> {
  if (loaded) return cache;
  try {
    const stored = await Keychain.getGenericPassword({ service: SERVICE });
    if (stored && stored.password) {
      const parsed: unknown = JSON.parse(stored.password);
      if (parsed && typeof parsed === 'object' && 'userId' in parsed) {
        cache = parsed as StoredSession;
      }
    }
  } catch {
    /* keychain unavailable — treat as signed out, which is the safe answer */
  }
  loaded = true;
  return cache;
}

/** Record a successful sign-in. Called once enrollment has actually succeeded,
 * never before: a record written on an attempt would put the app past its own
 * gate with no device behind it. */
export async function saveSession(session: Omit<StoredSession, 'signedInAt'>): Promise<void> {
  const full: StoredSession = { ...session, signedInAt: Date.now() };
  cache = full;
  loaded = true;
  try {
    await Keychain.setGenericPassword('session', JSON.stringify(full), {
      service: SERVICE,
      accessible: ACCESSIBLE,
    });
  } catch {
    /* best effort — the in-memory copy still serves this run */
  }
}

/** Sign out on this phone. Does NOT revoke the device: that is an account-level
 * act, performed from "Your devices", and conflating the two would mean every
 * sign-out silently destroyed a laptop's trust relationship. */
export async function clearSession(): Promise<void> {
  cache = null;
  loaded = true;
  try {
    await Keychain.resetGenericPassword({ service: SERVICE });
  } catch {
    /* best effort */
  }
}

/** Drop the memo so the next read hits the Keychain. Tests only. */
export function resetSessionCacheForTests(): void {
  cache = null;
  loaded = false;
}
