/**
 * Live end-to-end verification of the device-identity flow
 * ([ADR-0002](../../../../docs/adr/0002-device-identity.md),
 * [ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)).
 *
 * Unlike the unit tests beside it, this drives the app's REAL `identity.ts` and
 * `auth.ts` against a REAL backend, with real Postgres and real Redis. Only the
 * Keychain is substituted, because that is the one piece that cannot exist off
 * a device. Everything else is genuine: the Ed25519 keys, the wire format, the
 * HTTP round-trips, the Redis single-use semantics, the Postgres rows.
 *
 * It is opt-in and skipped by default, so `pnpm test` stays hermetic:
 *
 *   pnpm --filter @lilypad/backend build && BACKEND_PORT=8099 \
 *     node apps/backend/dist/index.js > /tmp/lilypad-e2e.log 2>&1 &
 *   LILYPAD_E2E_BASE_URL=http://127.0.0.1:8099 \
 *   LILYPAD_E2E_LOG=/tmp/lilypad-e2e.log \
 *     pnpm --filter @lilypad/mobile test -- deviceFlow.e2e
 *
 * The log path is required because the dev mail sender writes the magic-link
 * token to the server log — that is how a test signs in without a real inbox
 * and without a fake provider token.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { DEVICE_AUTH_PREFIX } from '@lilypad/protocol';

/**
 * Node's `fs` and `process`, reached without adding `@types/node` to this
 * package. That would put every Node global into scope for the React Native
 * sources too, where several of them (`Buffer`, timer return types) shadow the
 * RN equivalents and quietly change what typechecks. One opt-in test file is
 * not worth that, so it declares the two things it needs and nothing else.
 */
declare const process: { env: Record<string, string | undefined> };
const { readFileSync, statSync } = jest.requireActual<{
  readFileSync(path: string): { subarray(start: number): { toString(encoding: string): string } };
  statSync(path: string): { size: number };
}>('node:fs');

const BASE_URL = process.env.LILYPAD_E2E_BASE_URL;
const LOG_PATH = process.env.LILYPAD_E2E_LOG;

// An in-memory stand-in for the Keychain. `mock`-prefixed so Jest's hoisting
// of the factory below is allowed to reference it.
const mockKeychainStore = new Map<string, { username: string; password: string }>();

jest.mock('react-native-get-random-values', () => ({}));
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly' },
  getGenericPassword: ({ service }: { service: string }) =>
    Promise.resolve(mockKeychainStore.get(service) ?? false),
  setGenericPassword: (username: string, password: string, { service }: { service: string }) => {
    mockKeychainStore.set(service, { username, password });
    return Promise.resolve(true);
  },
}));

import { devicePublicKey, toBase64Url, fromBase64Url, utf8, resetDeviceKeyCache } from './identity';
import {
  enrollDevice,
  signInDevice,
  accessToken,
  approveDesktopEnrollment,
  resetAuthState,
} from './auth';

ed.hashes.sha512 = sha512;

const run = BASE_URL && LOG_PATH ? describe : describe.skip;
const base = BASE_URL ?? '';

async function post(
  path: string,
  body: unknown,
  bearer?: string,
): Promise<{ status: number; json: Record<string, string> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, string>) : {} };
}

/** Sign in for real: request a link, read the token the dev sender logged,
 * redeem it. No provider credentials, no stubbed route. */
async function signInByEmail(email: string): Promise<string> {
  const offset = statSync(LOG_PATH!).size;
  const requested = await post('/auth/magic-link/request', { email });
  expect(requested.status).toBe(202);

  let token: string | undefined;
  for (let attempt = 0; attempt < 40 && !token; attempt++) {
    const fresh = readFileSync(LOG_PATH!).subarray(offset).toString('utf8');
    token = [...fresh.matchAll(/token=([A-Za-z0-9_-]{20,})/g)].pop()?.[1];
    if (!token) await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));
  }
  if (!token) throw new Error('the backend never logged a magic-link token');

  const verified = await post('/auth/magic-link/verify', { token });
  expect(verified.status).toBe(200);
  return verified.json.accessToken;
}

/** A second, independent Ed25519 identity standing in for a laptop. The real
 * desktop uses Rust `ring`; this only has to produce the same wire format. */
function newKeypair(): { secret: Uint8Array; publicKey: string } {
  const secret = ed.utils.randomSecretKey();
  return { secret, publicKey: toBase64Url(ed.getPublicKey(secret)) };
}

async function proofFor(secret: Uint8Array): Promise<Record<string, string>> {
  const { status, json } = await post('/devices/challenge', {});
  expect(status).toBe(201);
  const challenge = json.challenge;
  return {
    challenge,
    publicKey: toBase64Url(ed.getPublicKey(secret)),
    signature: toBase64Url(ed.sign(utf8(`${DEVICE_AUTH_PREFIX}${challenge}`), secret)),
  };
}

run('device flow against a live backend', () => {
  jest.setTimeout(30_000);

  let accountToken: string;
  let userId: string;
  let phoneDeviceId: string;

  beforeAll(async () => {
    mockKeychainStore.clear();
    resetDeviceKeyCache();
    resetAuthState();
    accountToken = await signInByEmail(`e2e-${Date.now()}@example.test`);
  });

  it('enrolls this phone against a real account', async () => {
    const session = await enrollDevice(base, accountToken);
    expect(session.deviceId).toBeTruthy();
    expect(session.userId).toBeTruthy();
    userId = session.userId;
    phoneDeviceId = session.deviceId;
  });

  // The point of ADR-0002: a restart re-authenticates by signing, holding no
  // stored bearer credential at all.
  it('signs back in with the key alone, as the same device', async () => {
    resetAuthState();
    const session = await signInDevice(base);
    expect(session.deviceId).toBe(phoneDeviceId);
    expect(session.userId).toBe(userId);
  });

  it('persists the private key, so a fresh process is still the same device', async () => {
    const before = await devicePublicKey();
    resetDeviceKeyCache();
    expect(await devicePublicKey()).toBe(before);
  });

  it('refuses a replayed challenge', async () => {
    const proof = await proofFor(await phoneSecret());
    expect((await post('/devices/token', proof)).status).toBe(200);
    expect((await post('/devices/token', proof)).status).toBe(401);
  });

  it('refuses a signature from a different key', async () => {
    const { status, json } = await post('/devices/challenge', {});
    expect(status).toBe(201);
    const impostor = newKeypair();
    const forged = {
      challenge: json.challenge,
      publicKey: await devicePublicKey(),
      signature: toBase64Url(
        ed.sign(utf8(`${DEVICE_AUTH_PREFIX}${json.challenge}`), impostor.secret),
      ),
    };
    expect((await post('/devices/token', forged)).status).toBe(401);
  });

  it('refuses a signature over the challenge without the domain prefix', async () => {
    const secret = await phoneSecret();
    const { json } = await post('/devices/challenge', {});
    const unprefixed = {
      challenge: json.challenge,
      publicKey: toBase64Url(ed.getPublicKey(secret)),
      signature: toBase64Url(ed.sign(utf8(json.challenge), secret)),
    };
    expect((await post('/devices/token', unprefixed)).status).toBe(401);
  });

  describe('a laptop enrolled by this phone (ADR-0008)', () => {
    let laptop: ReturnType<typeof newKeypair>;
    let code: string;

    beforeAll(async () => {
      laptop = newKeypair();
      const minted = await post('/devices/enrollment-code', {
        ...(await proofFor(laptop.secret)),
        fingerprint: `desktop-e2e-${Date.now()}`,
        name: 'E2E Laptop',
        platform: 'macos',
      });
      expect(minted.status).toBe(201);
      code = minted.json.code;
    });

    it('cannot sign in before the phone approves it', async () => {
      const { status, json } = await post('/devices/token', await proofFor(laptop.secret));
      expect(status).toBe(403);
      expect(json.error).toBe('device_not_enrolled');
    });

    it('joins the phone’s account when the phone approves the code', async () => {
      const approved = await approveDesktopEnrollment(base, code);
      expect(approved.deviceId).toBeTruthy();

      const { status, json } = await post('/devices/token', await proofFor(laptop.secret));
      expect(status).toBe(200);
      expect(json.userId).toBe(userId);
      expect(json.deviceId).toBe(approved.deviceId);
    });

    it('burns the code, so a second approval finds nothing', async () => {
      await expect(approveDesktopEnrollment(base, code)).rejects.toThrow(/expired/i);
    });

    // The property that makes an intercepted code useless: approving it enrolls
    // the key it was minted for and no other, so a thief cannot land their own
    // machine on the account.
    it('enrolls only the key the code was minted for', async () => {
      const thief = newKeypair();
      const { status } = await post('/devices/token', await proofFor(thief.secret));
      expect(status).toBe(403);
    });
  });

  it('shares one exchange between concurrent callers', async () => {
    resetAuthState();
    const tokens = await Promise.all([
      accessToken(base),
      accessToken(base),
      accessToken(base),
      accessToken(base),
    ]);
    expect(new Set(tokens).size).toBe(1);
  });
});

/** The phone's own secret, read back out of the fake Keychain. */
async function phoneSecret(): Promise<Uint8Array> {
  await devicePublicKey();
  const stored = mockKeychainStore.get('com.takedia.lilypad.device-key');
  if (!stored) throw new Error('no device key was stored');
  return fromBase64Url(stored.password);
}
