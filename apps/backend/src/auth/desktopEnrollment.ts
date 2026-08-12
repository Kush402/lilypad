import { randomBytes } from 'node:crypto';
import { redisKeys } from '@lilypad/shared';
import type { Platform } from '@lilypad/protocol';
import { redis } from '../redis.js';

/**
 * Enrolling a desktop through an already-signed-in phone
 * ([ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)).
 *
 * The desktop mints a code while proving it holds a keypair; a phone that is
 * already enrolled scans it and approves. The account the desktop joins is the
 * subject of the PHONE's device token — nothing in the request body decides it.
 *
 * The security property that makes a stolen code useless: **the code is bound
 * to the desktop's public key at mint time.** Approving a code can only ever
 * enroll that exact key, so an attacker who intercepts a code cannot substitute
 * their own laptop; they can only cause the victim's own desktop to be enrolled
 * onto the victim's own account, which is what the user was doing anyway.
 *
 * What this does NOT defend against is a user scanning a code shown by someone
 * else's screen — the device-code phishing pattern. That is why the phone shows
 * the device name and requires an explicit approval, and why the window is two
 * minutes rather than an hour. The name is supplied by the desktop, so it is a
 * label to help a human recognise their own machine, never an authorization
 * input.
 */

/** Long enough to pick up a phone and scan; short enough that a code left on a
 * screen stops being an invitation. */
export const DESKTOP_ENROLLMENT_TTL_SECONDS = 120;

/** What the code is bound to. Everything needed to enroll the desktop is fixed
 * at mint time, so approval supplies nothing except the approver's identity. */
export interface DesktopEnrollmentRecord {
  publicKey: string;
  fingerprint: string;
  name: string | null;
  platform: Platform | null;
}

/** The slice of Redis this needs — injectable for tests. */
export interface DesktopEnrollmentRedis {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

/** Mint a single-use code bound to this desktop's key. */
export async function createDesktopEnrollmentCode(
  record: DesktopEnrollmentRecord,
  client: DesktopEnrollmentRedis = redis,
): Promise<{ code: string; expiresInSeconds: number }> {
  const code = randomBytes(24).toString('base64url');
  await client.set(
    redisKeys.desktopEnrollment(code),
    JSON.stringify(record),
    'EX',
    DESKTOP_ENROLLMENT_TTL_SECONDS,
  );
  return { code, expiresInSeconds: DESKTOP_ENROLLMENT_TTL_SECONDS };
}

/**
 * Burn a code and return what it was bound to, or null if it is unknown,
 * expired, or already used. `GETDEL` makes single-use atomic, so two phones
 * racing on one code cannot both enroll.
 */
export async function consumeDesktopEnrollmentCode(
  code: string,
  client: DesktopEnrollmentRedis = redis,
): Promise<DesktopEnrollmentRecord | null> {
  const raw = await client.getdel(redisKeys.desktopEnrollment(code));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as DesktopEnrollmentRecord;
  } catch {
    // A malformed record is our own bug, not an attack vector, but it must not
    // become an unhandled rejection on an authenticated request path.
    return null;
  }
}
