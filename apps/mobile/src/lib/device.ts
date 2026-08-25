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
import { Platform } from 'react-native';
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

/**
 * Throw this phone's id away so the next load mints a new one. The partner of
 * `clearDeviceKey` — `devices` is unique on the key AND on (kind,
 * fingerprint), so resetting only one of them would land on the same row and
 * be refused all over again.
 */
export async function clearDeviceId(): Promise<void> {
  cached = null;
  initPromise = null;
  try {
    await Keychain.resetGenericPassword({ service: SERVICE });
  } catch {
    /* best effort — the cache is already cleared, so this run mints a new id */
  }
}

/** Test seam: drop the memoized id so a fresh keychain state can be loaded. */
export function resetDeviceIdCacheForTests(): void {
  cached = null;
  initPromise = null;
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

/**
 * What this phone calls itself, for the two places its name is shown to a
 * human: "Your devices" on the account, and the approve prompt on a Mac when
 * this phone asks for a session.
 *
 * It used to send `` `${Platform.OS} phone` `` — so both surfaces said "ios
 * phone", and an account with two phones on it showed two identical rows
 * (reported with a screenshot, 2026-08-24).
 *
 * ponytail: the form factor, not the model. React Native exposes no model
 * name, and `UIDevice.name` has returned the generic "iPhone" since iOS 16
 * without a special entitlement — so the real model needs a native module.
 * Add one if two phones of the same kind on one account turns out to be
 * common; renaming from "Your devices" already covers it. Android reports no
 * `isPad`, so a tablet there says "phone" until that native module exists.
 */
export function deviceLabel(): string {
  if (Platform.OS === 'ios') return Platform.isPad ? 'iPad' : 'iPhone';
  return 'Android phone';
}
