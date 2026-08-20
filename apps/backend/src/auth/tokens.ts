import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';

/**
 * Lilypad's own access tokens ([ADR-0001](../../../../docs/adr/0001-account-authentication.md),
 * [ADR-0002](../../../../docs/adr/0002-device-identity.md)).
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **Authorization reads the token, never the request body.** Every route and
 *    every WebSocket `register` resolves its actor from here. That is what makes
 *    "knowing a device id / pair id / room id" worthless.
 * 2. **Verification needs no database.** A token is checked by signature and
 *    expiry alone, so an unavailable Postgres blocks new sign-ins but does not
 *    break sessions or reconnects already running — a deliberate trade recorded
 *    in ADR-0001, and the reason the TTL is short rather than the check
 *    stateful.
 *
 * The cost of (2) is that revocation is not instant: a revoked device or a
 * signed-out user keeps a working access token until it expires. The TTL below
 * IS that exposure window, which is why it is ten minutes and not an hour.
 * Anything needing immediate effect (Revoke, panic disconnect) additionally
 * tears down live rooms through the hub, and refresh is checked against the
 * database, so the window is bounded at both ends.
 */

/** How long an access token stays valid. This is the revocation lag; see above. */
export const ACCESS_TOKEN_TTL_SECONDS = 600;

const ISSUER = 'lilypad';
const AUDIENCE = 'lilypad-api';

/** Who a verified token says the caller is. `deviceId` is null for the web
 * dashboard, which is signed in but is not an enrolled device. */
export interface Actor {
  /** `users.id`. */
  userId: string;
  /** `devices.id`, or null for a browser session. */
  deviceId: string | null;
  /**
   * When this token was minted, from the JWT's `iat`.
   *
   * Exposed for exactly one caller. Revocation cannot be instant here — that is
   * the trade above — so a token issued before a device was revoked keeps
   * working until it expires. That is fine for every route whose worst case is
   * ten more minutes of access, and not fine for `/devices/enroll`, whose
   * effect is PERMANENT: enrolling clears `revoked_at`, so a stale token could
   * turn a ten-minute window into an undone revocation. Comparing this against
   * the row's `revoked_at` closes it without a database read on the hot path,
   * because the answer is already inside the token.
   *
   * Null only for a token minted before this claim was set, which is none.
   */
  issuedAt: Date | null;
}

function signingKey(): Uint8Array {
  return new TextEncoder().encode(config.env.AUTH_TOKEN_SECRET);
}

/** Mint an access token for an actor. */
export async function signAccessToken(
  actor: Pick<Actor, 'userId' | 'deviceId'>,
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  const jwt = new SignJWT(actor.deviceId ? { did: actor.deviceId } : {})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(actor.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`);
  return jwt.sign(signingKey());
}

/**
 * Verify an access token. Returns null for every failure — expired, tampered,
 * wrong issuer/audience, malformed — because the caller's only correct response
 * to any of them is an identical 401. Distinguishing them for the client would
 * hand an attacker a probing oracle.
 */
export async function verifyAccessToken(token: string): Promise<Actor | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      // Pinning the algorithm is the defence against `alg` confusion: without
      // it, a token whose header claims a different algorithm would be handed
      // to a verifier we did not choose.
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
    const did = payload.did;
    if (did !== undefined && typeof did !== 'string') return null;
    return {
      userId: payload.sub,
      deviceId: did ?? null,
      issuedAt: typeof payload.iat === 'number' ? new Date(payload.iat * 1000) : null,
    };
  } catch {
    return null;
  }
}

/** Pull a bearer token out of an `Authorization` header. Case-insensitive on
 * the scheme, per RFC 7235; null when the header is absent or not a bearer. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
