/**
 * Consent to send a Mac's screen and window titles to a third-party AI model.
 *
 * Ask is the one feature in Lilypad where data leaves the two machines that
 * own it. Everything else in the product is a stream between a phone and a
 * laptop that the control plane never sees; Ask takes what is on the screen,
 * puts it in a prompt, and sends it to a model provider. That is a different
 * promise from the one the rest of the app makes, and the customer has to make
 * it themselves.
 *
 * App Store Review Guideline 5.1.2(i) says so in as many words: "You must
 * clearly disclose where personal data will be shared with third parties,
 * including with third-party AI, and obtain explicit permission before doing
 * so." Bringing your own API key does not exempt Lilypad — Lilypad built the
 * pipe, and the screen contents still leave the machine for a company the
 * customer has not been introduced to on this screen.
 *
 * ### Consent is bound to a destination (L-265)
 *
 * This used to be one boolean. One phone, one "granted", forever — while the
 * copy on the consent screen named Anthropic and OpenAI and the Mac would
 * accept any OpenAI-compatible base URL its owner typed in. So the recorded
 * agreement was to a provider that was never shown, and pointing the Mac
 * somewhere else afterwards changed nothing about it. A grant now names the
 * Mac, the exact origin, and the revision of the wording that was on screen,
 * and none of those may drift without asking again.
 *
 * ### Withdrawal has to survive a restart (L-266)
 *
 * Revoking used to set the in-memory answer to false and call
 * `resetGenericPassword`, ignoring the result. If that delete failed — locked
 * keychain, denied item — the stored "granted" was still there, and the next
 * launch read it back and carried on sharing. The person had done everything
 * the interface asked of them.
 *
 * So revocation is a *write*, not a delete, and it goes to its own keychain
 * item first: a tombstone that `hasAiConsent` consults before anything else.
 * A write failing and a delete failing are different operations on different
 * items, which is what makes the tombstone independent rather than decorative.
 * If even that cannot be stored, `revokeAiConsent` reports the failure instead
 * of claiming success, and sharing stays blocked for the rest of this run.
 *
 * Stored on the phone rather than the account, deliberately. Consent is given
 * by a person holding a device, and a second phone added to the same account
 * later has its own owner and its own decision to make.
 */
import * as Keychain from 'react-native-keychain';
import { AI_CONSENT_POLICY, type AgentDestination } from '@lilypad/protocol';

const SERVICE = 'com.takedia.lilypad.ai-consent';
/** Revocations. A separate item so a failure to delete a grant is not also a
 * failure to record that it was withdrawn. */
const TOMBSTONE_SERVICE = 'com.takedia.lilypad.ai-consent-revoked';

/** Matches every other keychain write in this app — see the note in
 * `pairs.ts`. A restored backup should start with no consent recorded, which
 * is the honest default: the new phone's owner has not agreed to anything. */
const ACCESSIBLE = Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY;

/** Most destinations remembered. Bounded so a Mac cycling through endpoints
 * cannot grow this item without limit; the oldest grant is dropped first. */
const MAX_GRANTS = 20;

/** What the person agreed to send, and to where. */
export type ConsentTarget = {
  /** Which Mac — the phone's own record of the desktop it paired with. */
  desktopDeviceId: string;
  /** scheme://host[:port] the Mac disclosed. */
  origin: string;
  /** The model that was named on the card, or '' when none was. */
  model: string;
  /** Whether the card said the model runs on the Mac. */
  local: boolean;
  /** Which wording revision the Mac disclosed under. */
  policy: number;
  /**
   * The Mac's own digest of the destination, echoed back on every command so
   * the Mac can refuse one aimed at a destination that has since changed.
   *
   * The phone does not trust this for change detection — it keys grants on the
   * fields it actually showed the person, above. This is carried so the two
   * devices can agree on which disclosure a command belongs to.
   */
  revision: string;
};

type Grant = Omit<ConsentTarget, 'revision'> & { grantedAt: string };

/**
 * Key for one destination.
 *
 * Built from exactly what the consent card said: which Mac, which endpoint,
 * which model, whether it was local, and under which wording. Two Macs pointed
 * at the same provider are still two separate decisions, and a Mac that
 * switches model has made a different statement than the one agreed to.
 *
 * Deliberately not the Mac's `revision` digest: this phone should be able to
 * detect a changed destination from what it was shown, without depending on
 * the other device to compute a digest honestly.
 */
function keyOf(target: Omit<ConsentTarget, 'revision'>): string {
  return [
    target.desktopDeviceId,
    target.origin,
    target.model,
    target.local ? 'local' : 'remote',
    String(target.policy),
  ].join('|');
}

/**
 * The destination a Mac disclosed, as a consent target.
 *
 * `null` when the Mac disclosed nothing. That is not a failure to be smoothed
 * over — an undisclosed destination is one the person cannot agree to, and the
 * panel says so rather than reusing an older grant.
 */
export function targetFor(
  desktopDeviceId: string,
  destination: AgentDestination | undefined,
): ConsentTarget | null {
  if (!destination || !destination.origin) return null;
  // A Mac disclosing under wording this phone does not have cannot be agreed
  // to: the card would be describing something other than what was sent.
  if (destination.consentPolicy !== AI_CONSENT_POLICY) return null;
  return {
    desktopDeviceId,
    origin: destination.origin,
    model: destination.model ?? '',
    local: destination.local,
    policy: destination.consentPolicy,
    revision: destination.consentRevision,
  };
}

type Cache = {
  grants: Grant[];
  revoked: string[];
  loaded: boolean;
  /** The revocation list could not be read this time. Distinct from a failed
   * *write*: this one is likely transient (a locked phone), so it is not
   * cached and it is not reported to the person as a lost withdrawal — but it
   * still means no for as long as it lasts. */
  revokedUnknown: boolean;
};
let cache: Cache = { grants: [], revoked: [], loaded: false, revokedUnknown: false };
/** Set when a withdrawal could not be made durable. Blocks everything for the
 * rest of this run; the UI surfaces it rather than pretending. */
let unresolvedRevocation = false;

async function load(): Promise<Cache> {
  if (cache.loaded) return cache;
  // The tombstone is read first and independently. A grants item that will not
  // load must never mean "no revocations either".
  let revoked: string[] = [];
  let revokedUnknown = false;
  try {
    const stored = await Keychain.getGenericPassword({ service: TOMBSTONE_SERVICE });
    if (stored !== false) revoked = JSON.parse(stored.password) as string[];
  } catch {
    // Not knowing which grants were withdrawn is not the same as knowing none
    // were. Fail closed, and do not cache the gap — the next call retries.
    revoked = [];
    revokedUnknown = true;
  }
  let grants: Grant[] = [];
  try {
    const stored = await Keychain.getGenericPassword({ service: SERVICE });
    if (stored !== false) {
      const parsed: unknown = JSON.parse(stored.password);
      if (Array.isArray(parsed)) grants = parsed as Grant[];
    }
  } catch {
    grants = [];
  }
  cache = { grants, revoked, loaded: !revokedUnknown, revokedUnknown };
  return cache;
}

/**
 * Has this phone's owner agreed to send this Mac's screen to this destination?
 *
 * Fails CLOSED at every step. A keychain that will not answer, a destination
 * the Mac did not disclose, a grant recorded under older wording, or an
 * unresolved withdrawal all mean no — because the failure mode of guessing
 * wrong in the other direction is sending someone's screen to a third party
 * they never chose.
 */
export async function hasAiConsent(target: ConsentTarget | null): Promise<boolean> {
  if (!target) return false;
  if (unresolvedRevocation) return false;
  let state: Cache;
  try {
    state = await load();
  } catch {
    return false;
  }
  // Re-checked after the load: a tombstone read that failed sets this, and
  // checking only before would let the very first call through.
  if (state.revokedUnknown || unresolvedRevocation) return false;
  const key = keyOf(target);
  if (state.revoked.includes(key)) return false;
  // The key already carries the policy revision, so an agreement made under
  // older wording simply does not match.
  return state.grants.some((g) => keyOf(g) === key);
}

/** Record that the person said yes, to this Mac and this destination. */
export async function grantAiConsent(target: ConsentTarget): Promise<boolean> {
  const state = await load();
  const key = keyOf(target);
  // Granting clears the tombstone for this destination only — agreeing again
  // is allowed, and it is the one thing that should lift a withdrawal.
  const revoked = state.revoked.filter((k) => k !== key);
  const { revision: _revision, ...stored } = target;
  const grants = [
    ...state.grants.filter((g) => keyOf(g) !== key),
    { ...stored, grantedAt: new Date().toISOString() },
  ].slice(-MAX_GRANTS);
  try {
    await writeTombstones(revoked);
    await Keychain.setGenericPassword('ai-consent', JSON.stringify(grants), {
      service: SERVICE,
      accessible: ACCESSIBLE,
    });
    cache = { grants, revoked, loaded: true, revokedUnknown: false };
    unresolvedRevocation = false;
    return true;
  } catch {
    // The in-memory answer still serves this run, and the question is asked
    // again next launch — which is the safe direction for a *grant*.
    cache = { grants, revoked, loaded: true, revokedUnknown: false };
    return false;
  }
}

/**
 * Take it back.
 *
 * Returns whether the withdrawal was made durable. `false` means it holds for
 * this run and the caller must say so — never that it worked.
 */
export async function revokeAiConsent(target: ConsentTarget | null): Promise<boolean> {
  const state = await load();
  const keys = target ? [keyOf(target)] : state.grants.map(keyOf);
  const revoked = Array.from(new Set([...state.revoked, ...keys])).slice(-MAX_GRANTS);
  const grants = state.grants.filter((g) => !keys.includes(keyOf(g)));
  // Tombstone first. If the second write fails the stored grant survives, and
  // the tombstone is what stops it being honoured on the next launch.
  let durable = true;
  try {
    await writeTombstones(revoked);
  } catch {
    durable = false;
    unresolvedRevocation = true;
  }
  try {
    if (grants.length === 0) {
      await Keychain.resetGenericPassword({ service: SERVICE });
    } else {
      await Keychain.setGenericPassword('ai-consent', JSON.stringify(grants), {
        service: SERVICE,
        accessible: ACCESSIBLE,
      });
    }
  } catch {
    // Survivable exactly because of the tombstone above — but only if that
    // one landed.
    if (!durable) unresolvedRevocation = true;
  }
  cache = { grants, revoked, loaded: true, revokedUnknown: false };
  return durable;
}

/** True when a withdrawal could not be stored and sharing is blocked only by
 * this process staying alive. The panel must show this. */
export function hasUnresolvedRevocation(): boolean {
  return unresolvedRevocation;
}

/** Retry a withdrawal that could not be stored. */
export async function retryRevocation(): Promise<boolean> {
  try {
    await writeTombstones(cache.revoked);
    unresolvedRevocation = false;
    return true;
  } catch {
    return false;
  }
}

async function writeTombstones(revoked: string[]): Promise<void> {
  await Keychain.setGenericPassword('ai-consent-revoked', JSON.stringify(revoked), {
    service: TOMBSTONE_SERVICE,
    accessible: ACCESSIBLE,
  });
}

/** Test seam. The module-level cache would otherwise carry one test's answer
 * into the next. */
export function resetAiConsentCache(): void {
  cache = { grants: [], revoked: [], loaded: false, revokedUnknown: false };
  unresolvedRevocation = false;
}
