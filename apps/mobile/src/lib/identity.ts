import 'react-native-get-random-values';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import * as Keychain from 'react-native-keychain';
import { deviceProofMessage } from '@lilypad/protocol';

/**
 * This phone's Ed25519 identity ([ADR-0002](../../../../docs/adr/0002-device-identity.md)).
 *
 * The private key is generated once, kept in the OS keychain, and never leaves
 * the phone. It is what proves to the backend that THIS phone is asking — the
 * `deviceId` string in `device.ts` is a label beside it, not a credential.
 *
 * Deliberately a separate keychain service from `device.ts`'s id: the id is a
 * disclosable identifier and the key is a secret, so losing or migrating one
 * must never take the other with it.
 *
 * Storage is the Keychain, NOT the Secure Enclave — the Enclave holds P-256
 * keys only, and ADR-0002 records why Ed25519 was kept anyway.
 */

// @noble/ed25519 v3 ships without a hash so callers pick one; `@noble/hashes`
// is the matching audited implementation. Set once at module load, because
// every sign/verify call goes through it.
ed.hashes.sha512 = sha512;

const SERVICE = 'com.takedia.lilypad.device-key';
const ACCOUNT = 'ed25519-secret';

let cached: Uint8Array | null = null;
let initPromise: Promise<Uint8Array> | null = null;

/**
 * base64url and UTF-8, written out rather than taken from the runtime.
 *
 * React Native does not guarantee `btoa`/`atob`/`TextEncoder` as globals — what
 * exists depends on the JS engine and which polyfills a build happens to pull
 * in. Depending on that would make key encoding work on one platform and fail
 * on another, at the one boundary where a wrong byte means the backend rejects
 * every request this phone ever makes. These are ~20 lines, pure, and unit
 * tested.
 */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64URL[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64URL[b2 & 0b111111];
  }
  return out;
}

export function fromBase64Url(value: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const index = B64URL.indexOf(char);
    if (index < 0) throw new Error('not base64url');
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** Minimal UTF-8 encoder. The messages signed here are ASCII in practice (an
 * ASCII prefix plus a base64url challenge), but encoding them by char code
 * would silently produce the wrong bytes if that ever stopped being true. */
export function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

async function loadOrCreate(): Promise<Uint8Array> {
  const stored = await Keychain.getGenericPassword({ service: SERVICE });
  if (stored && stored.password) {
    const secret = fromBase64Url(stored.password);
    // A stored value of the wrong length means a corrupt or foreign entry.
    // Replacing it silently would orphan this phone's enrollment, so it is
    // surfaced rather than swallowed.
    if (secret.length !== 32) throw new Error('the stored device key is the wrong length');
    return secret;
  }
  const secret = ed.utils.randomSecretKey();
  await Keychain.setGenericPassword(ACCOUNT, toBase64Url(secret), {
    service: SERVICE,
    // The key must not ride an iCloud backup onto a different phone: identity
    // is per-device, and a restored duplicate would be a second device holding
    // the first one's credential.
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return secret;
}

/**
 * Load (or create-and-persist) this phone's key. Idempotent and memoized, so
 * concurrent callers share one keychain round-trip — the same shape as
 * `initDeviceIdentity()` in `device.ts`.
 *
 * Unlike the device *id*, a failure here is NOT degraded to an ephemeral
 * value. A key that changes per launch would re-enroll endlessly and orphan
 * the phone's own trust relationships, so the error propagates and the UI can
 * say something true about it.
 */
export function initDeviceKey(): Promise<Uint8Array> {
  if (!initPromise) {
    initPromise = loadOrCreate()
      .then((secret) => {
        cached = secret;
        return secret;
      })
      .catch((err: unknown) => {
        // Do not memoize a failure: a transient keychain error (locked device,
        // first-unlock race) must be retryable rather than permanent for the
        // life of the process.
        initPromise = null;
        throw err;
      });
  }
  return initPromise;
}

/** This device's public key, base64url — 43 characters. */
export async function devicePublicKey(): Promise<string> {
  return toBase64Url(ed.getPublicKey(await initDeviceKey()));
}

/**
 * Sign a server-issued challenge, base64url — 86 characters.
 *
 * The domain-separation prefix is not decoration: the same key binds the
 * desktop's LAN TLS certificate in ADR-0006, so without a prefix a signature
 * made for one purpose would authenticate the other.
 *
 * `origin` names the server the proof is for, and putting it inside the
 * signature is what stops a hostile host relaying a challenge from the real
 * backend and replaying what this phone signs (L-30). Omitted, this produces
 * the v1 message — which is what a server that has not been updated still
 * expects, so the two must not drift apart. `deviceProofMessage` is the single
 * definition both sides build from, for exactly that reason.
 */
export async function signChallenge(challenge: string, origin?: string | null): Promise<string> {
  const secret = await initDeviceKey();
  const message = utf8(deviceProofMessage(challenge, origin));
  return toBase64Url(ed.sign(message, secret));
}

/**
 * Throw this phone's key away so the next use mints a new one.
 *
 * The one legitimate reason to do this: `/devices/enroll` refuses a key that
 * already names a device on somebody else's account, and that refusal is
 * correct — a device row that changed hands would carry the previous owner's
 * pairings with it. But the key lives in the Keychain, which survives deleting
 * the app, so without this the phone could never be used with another account
 * again. A new key is a new device: it inherits nothing, which is exactly why
 * it is safe to offer.
 */
export async function clearDeviceKey(): Promise<void> {
  cached = null;
  initPromise = null;
  await Keychain.resetGenericPassword({ service: SERVICE });
}

/** Test seam: drop the memoized key so a fresh keychain state can be loaded. */
export function resetDeviceKeyCache(): void {
  cached = null;
  initPromise = null;
}

/** Whether a key has already been loaded this session. */
export function hasDeviceKey(): boolean {
  return cached !== null;
}
