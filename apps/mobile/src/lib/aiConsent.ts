/**
 * Consent to send a Mac's screen and window titles to a third-party AI model.
 *
 * Ask is the one feature in Lilypad where data leaves the two machines that
 * own it. Everything else in the product is a stream between a phone and a
 * laptop that the control plane never sees; Ask takes what is on the screen,
 * puts it in a prompt, and sends it to Anthropic or OpenAI. That is a
 * different promise from the one the rest of the app makes, and the customer
 * has to make it themselves.
 *
 * App Store Review Guideline 5.1.2(i) says so in as many words: "You must
 * clearly disclose where personal data will be shared with third parties,
 * including with third-party AI, and obtain explicit permission before doing
 * so." Bringing your own API key does not exempt Lilypad — Lilypad built the
 * pipe, and the screen contents still leave the machine for a company the
 * customer has not been introduced to on this screen.
 *
 * Stored on the phone rather than the account, deliberately. Consent is given
 * by a person holding a device, and a second phone added to the same account
 * later has its own owner and its own decision to make.
 */
import * as Keychain from 'react-native-keychain';

const SERVICE = 'com.takedia.lilypad.ai-consent';

/** Matches every other keychain write in this app — see the note in
 * `pairs.ts`. A restored backup should start with no consent recorded, which
 * is the honest default: the new phone's owner has not agreed to anything. */
const ACCESSIBLE = Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY;

/** The answer for this run, so the panel does not hit the keychain on every
 * render. `null` means "not read yet", which is distinct from "declined". */
let cache: boolean | null = null;

/**
 * Has this phone's owner agreed to Ask sending screen contents to a model?
 *
 * Fails CLOSED. A keychain that will not answer means no recorded consent,
 * and no recorded consent means the feature stays behind the explanation. The
 * failure mode of guessing wrong in the other direction is sending someone's
 * screen to a third party because their keychain was locked.
 */
export async function hasAiConsent(): Promise<boolean> {
  if (cache !== null) return cache;
  try {
    const stored = await Keychain.getGenericPassword({ service: SERVICE });
    cache = stored !== false && stored.password === 'granted';
  } catch {
    cache = false;
  }
  return cache;
}

/** Record that the person said yes, on this phone. */
export async function grantAiConsent(): Promise<void> {
  cache = true;
  try {
    await Keychain.setGenericPassword('ai-consent', 'granted', {
      service: SERVICE,
      accessible: ACCESSIBLE,
    });
  } catch {
    /* Best effort. The in-memory answer still serves this run, and the
       question is asked again next launch — which is the safe direction. */
  }
}

/**
 * Take it back.
 *
 * Consent that cannot be withdrawn is not consent, and a customer who changes
 * their mind should not have to delete the app to act on it.
 */
export async function revokeAiConsent(): Promise<void> {
  cache = false;
  try {
    await Keychain.resetGenericPassword({ service: SERVICE });
  } catch {
    /* Best effort — `cache` already refuses for the rest of this run. */
  }
}

/** Test seam. The module-level cache would otherwise carry one test's answer
 * into the next. */
export function resetAiConsentCache(): void {
  cache = null;
}
