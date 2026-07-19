/**
 * Persisted paired desktops (M5.4) — the phone-side half of the trust
 * relationship. One entry per desktop this phone has QR-paired with; drives
 * the My Devices list and the no-QR Connect flow. Stored as a JSON blob in
 * the OS keychain (same module as the device identity, its own service
 * namespace) so pairs survive restarts and OS backups.
 *
 * "Forget" here is phone-side only: it removes the entry (and the desktop
 * disappears from My Devices), while the backend pair row survives until the
 * desktop revokes — by design, so a re-scan can restore the pair without a
 * new trust ceremony.
 */
import * as Keychain from 'react-native-keychain';

const SERVICE = 'com.lilypad.paired-desktops';

export interface PairedDesktop {
  /** The desktop's wire deviceId — the key /connect/request rings. */
  desktopDeviceId: string;
  name: string | null;
  /** Where to reach the backend for this desktop (from the QR payload). */
  apiBaseUrl: string;
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
