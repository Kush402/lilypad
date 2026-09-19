/**
 * How much Ask may do on a Mac without asking first (ADR-0018).
 *
 * `full`: Ask clicks, types and opens what the task needs on its own. The Mac
 * still refuses, in every mode, to type into password fields, operate Lilypad
 * itself, answer security or permission prompts, or lock the screen and log
 * out — and a touch on the phone, or the Mac's own mouse or keyboard, takes
 * over at once.
 * `supervised`: every click, value change, URL and consequential key waits for
 * Approve on this phone.
 *
 * Chosen per Mac, by the person holding this phone, after they have agreed to
 * the destination in `aiConsent`. `null` means they have not chosen yet, and
 * the panel asks. Kept apart from consent on purpose: agreeing to where the
 * screen goes and agreeing to how much the assistant may do are two different
 * questions, and withdrawing one should not silently answer the other.
 */
import * as Keychain from 'react-native-keychain';
import type { AgentAutonomy } from '@lilypad/protocol';

const SERVICE = 'com.takedia.lilypad.ai-autonomy';
const ACCESSIBLE = Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
/** Macs remembered; the oldest choice is dropped first. */
const MAX_MACS = 20;

type Choices = Record<string, AgentAutonomy>;
let cache: Choices | null = null;

async function load(): Promise<Choices> {
  if (cache) return cache;
  try {
    const stored = await Keychain.getGenericPassword({ service: SERVICE });
    const parsed: unknown = stored === false ? {} : JSON.parse(stored.password);
    cache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Choices) : {};
  } catch {
    // Not cached: a locked phone is transient, and the next read retries.
    return {};
  }
  return cache;
}

/** What the person chose for this Mac, or `null` if they have not. Anything
 * unreadable or unrecognised is `null`, so the panel asks rather than guesses
 * — and full control is never inferred. */
export async function autonomyFor(desktopDeviceId: string): Promise<AgentAutonomy | null> {
  if (!desktopDeviceId) return null;
  const choice = (await load())[desktopDeviceId];
  return choice === 'full' || choice === 'supervised' ? choice : null;
}

/** Record the choice. Returns whether it was stored; it applies to this run of
 * the app either way. */
export async function setAutonomy(
  desktopDeviceId: string,
  autonomy: AgentAutonomy,
): Promise<boolean> {
  const current = await load();
  const next: Choices = { ...current };
  delete next[desktopDeviceId];
  next[desktopDeviceId] = autonomy;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_MACS))) delete next[k];
  cache = next;
  try {
    await Keychain.setGenericPassword('ai-autonomy', JSON.stringify(next), {
      service: SERVICE,
      accessible: ACCESSIBLE,
    });
    return true;
  } catch {
    return false;
  }
}

/** Test seam. */
export function resetAutonomyCache(): void {
  cache = null;
}
