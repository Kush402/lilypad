/**
 * Stable device identity for this phone, persisted in the OS keychain so the
 * SAME id survives app restarts and reinstalls-from-backup.
 *
 * Why this matters (docs/m5.4-trusted-devices-audit.md BUG-2): the signaling
 * hub's mid-session re-register grace only releases a held seat to the SAME
 * deviceId, so a per-launch random id locked a restarted app out of its own
 * session until the grace expired — and persistent device trust (M5.4) has
 * nothing to bind to without a stable identity.
 *
 * Layering: `initDeviceIdentity()` is the async, keychain-backed load/create —
 * awaited once at the redeem boundary (`api.ts`) and warmed at app start
 * (`App.tsx`). `getDeviceId()` stays synchronous for the post-redeem call
 * sites (`webrtc.ts` registration/reconnect), reading the warmed cache. If
 * the keychain native module isn't available (an old binary running new JS
 * before a rebuild), everything degrades to exactly the old per-launch
 * behavior instead of crashing.
 */
import * as Keychain from 'react-native-keychain';

/** Keychain service namespace — distinct from any credential storage. */
const SERVICE = 'com.takedia.lilypad.device-identity';

let cached: string | null = null;
let initPromise: Promise<string> | null = null;

function freshId(): string {
  return `mobile-${Math.random().toString(36).slice(2, 10)}${Math.random()
    .toString(36)
    .slice(2, 10)}${Date.now().toString(36)}`;
}

async function loadOrCreate(): Promise<string> {
  try {
    const stored = await Keychain.getGenericPassword({ service: SERVICE });
    if (stored && stored.password) return stored.password;
  } catch {
    /* keychain unavailable (old binary / simulator quirk) — fall through */
  }
  const id = freshId();
  try {
    await Keychain.setGenericPassword('device-id', id, { service: SERVICE });
  } catch {
    /* best effort — worst case we mint again next launch (old behavior) */
  }
  return id;
}

/**
 * Load (or create-and-persist) this phone's stable identity. Idempotent and
 * memoized — concurrent callers share one keychain round-trip. Await this
 * before the identity's FIRST use (redeem); later sync reads hit the cache.
 */
export function initDeviceIdentity(): Promise<string> {
  if (!initPromise) {
    initPromise = loadOrCreate().then((id) => {
      // `??=`: if a sync caller raced ahead and minted a fallback id, keep it
      // for this run (consistency within the session beats persistence).
      cached ??= id;
      return cached;
    });
  }
  return initPromise;
}

/** Synchronous read for post-init call sites. Falls back to a per-launch id
 * if somehow read before `initDeviceIdentity` resolved — same behavior the
 * app always had, never a crash. */
export function getDeviceId(): string {
  if (!cached) {
    cached = freshId();
  }
  return cached;
}
