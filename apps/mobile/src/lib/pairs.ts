/**
 * Persisted paired desktops (M5.4) — the phone-side half of the trust
 * relationship. One entry per desktop this phone has QR-paired with; drives
 * the My Devices list and the no-QR Connect flow. Stored as a JSON blob in
 * the OS keychain (same module as the device identity, its own service
 * namespace) so pairs survive restarts. NOT backups — see ACCESSIBLE below;
 * a pair is worthless without the device key, which never leaves the phone.
 *
 * "Forget" here is phone-side only: it removes the entry (and the desktop
 * disappears from My Devices), while the backend pair row survives until the
 * desktop revokes — by design, so a re-scan can restore the pair without a
 * new trust ceremony.
 */
import * as Keychain from 'react-native-keychain';

const SERVICE = 'com.takedia.lilypad.paired-desktops';

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

export interface PairedDesktop {
  /** The desktop's wire deviceId — the key /connect/request rings. */
  desktopDeviceId: string;
  name: string | null;
  /** Where to reach the backend for this desktop (from the QR payload). */
  apiBaseUrl: string;
  /** Per-pair connect secret (M5.4 security), delivered by the backend over
   * signaling after a trusted approval. Presented on every no-QR reconnect.
   * Absent for a pair made before secrets existed (still works via the
   * backend's legacy allowance until it re-pairs). */
  connectSecret?: string;
  addedAt: number;
  lastConnectedAt: number | null;
}

/** In-memory mirror so reads after the first load are synchronous-fast and
 * the keychain-unavailable fallback (old binary, simulator quirk) still
 * works within a run. */
let cache: PairedDesktop[] | null = null;

async function persist(pairs: PairedDesktop[]): Promise<void> {
  cache = pairs;
  try {
    await Keychain.setGenericPassword('paired-desktops', JSON.stringify(pairs), {
      service: SERVICE,
      accessible: ACCESSIBLE,
    });
  } catch {
    /* best effort — the in-memory cache still serves this run */
  }
}

export async function loadPairs(): Promise<PairedDesktop[]> {
  if (cache) return cache;
  try {
    const stored = await Keychain.getGenericPassword({ service: SERVICE });
    if (stored && stored.password) {
      const parsed: unknown = JSON.parse(stored.password);
      if (Array.isArray(parsed)) {
        cache = parsed as PairedDesktop[];
        return cache;
      }
    }
  } catch {
    /* fall through to empty */
  }
  cache = [];
  return cache;
}

/** Add or refresh a pair (keyed by desktopDeviceId). Called after every
 * successful QR redeem — re-pairing refreshes the name/URL. */
export async function upsertPair(
  pair: Omit<PairedDesktop, 'addedAt' | 'lastConnectedAt'>,
): Promise<void> {
  const pairs = await loadPairs();
  const existing = pairs.find((p) => p.desktopDeviceId === pair.desktopDeviceId);
  if (existing) {
    existing.name = pair.name;
    existing.apiBaseUrl = pair.apiBaseUrl;
  } else {
    pairs.push({ ...pair, addedAt: Date.now(), lastConnectedAt: null });
  }
  await persist([...pairs]);
}

/** Store the connect secret the backend delivered for a desktop pair. Creates
 * a minimal pair entry if somehow missing (defensive — the pair is normally
 * saved at redeem time just before the secret arrives). */
export async function setPairSecret(desktopDeviceId: string, connectSecret: string): Promise<void> {
  const pairs = await loadPairs();
  const pair = pairs.find((p) => p.desktopDeviceId === desktopDeviceId);
  if (pair) {
    pair.connectSecret = connectSecret;
    await persist([...pairs]);
  }
}

export async function touchPair(desktopDeviceId: string): Promise<void> {
  const pairs = await loadPairs();
  const pair = pairs.find((p) => p.desktopDeviceId === desktopDeviceId);
  if (pair) {
    pair.lastConnectedAt = Date.now();
    await persist([...pairs]);
  }
}

export async function forgetPair(desktopDeviceId: string): Promise<void> {
  const pairs = await loadPairs();
  await persist(pairs.filter((p) => p.desktopDeviceId !== desktopDeviceId));
}

/**
 * Forget every pair. Sign-out only — a phone that is no longer on the account
 * must not keep a list of that account's laptops, complete with the connect
 * secrets that ring them.
 *
 * Phone-side only, exactly like `forgetPair`: the backend rows survive until
 * the desktop or the account revokes them, so signing back in and re-scanning
 * restores the pair without a fresh trust ceremony.
 */
export async function forgetAllPairs(): Promise<void> {
  await persist([]);
}
