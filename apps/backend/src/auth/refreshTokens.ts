import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';

/**
 * Rotating opaque refresh tokens ([ADR-0001](../../../../docs/adr/0001-account-authentication.md)).
 *
 * Access tokens are short-lived and stateless by design, which means they
 * cannot be revoked. Refresh is where that is paid back: it is a database
 * check, so this is the one place "sign out everywhere" and "revoke this
 * laptop" actually take effect.
 *
 * **Rotation is single-use.** Every refresh mints a new token and retires the
 * presented one. Presenting a retired token therefore means it leaked or was
 * replayed, and the response is to revoke the whole family rather than to fail
 * only that request — the legitimate holder is forced to sign in again, which
 * is the correct outcome when a token is known to be loose.
 *
 * Only the SHA-256 of a token is stored. The token is 32 bytes of CSPRNG
 * output, so a plain hash is right and a slow KDF would protect nothing: there
 * is no low-entropy input to stretch. Same reasoning as the per-pair connect
 * secret in `services/trust.ts`.
 */

/** How long a refresh token stays valid if never used. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface RefreshTokenRow {
  id: string;
  userId: string;
  deviceId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** A freshly minted refresh token: the plaintext (returned once, to the
 * client) and the row id it was stored under. */
export interface IssuedRefreshToken {
  token: string;
  id: string;
}

/** Minimal DB surface — satisfied by the Drizzle adapter below and by an
 * in-memory fake in tests, matching `TrustStore` / `AuditLogStore`. */
export interface RefreshTokenStore {
  insert(row: {
    userId: string;
    deviceId: string | null;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<string>;
  findByHash(tokenHash: string): Promise<RefreshTokenRow | null>;
  /** Retire `id` in favour of `replacedById`, in one write. */
  markRotated(id: string, replacedById: string): Promise<void>;
  /** Revoke every live token for one user+device pair (reuse detection, and
   * "this laptop was stolen"). */
  revokeForUserDevice(userId: string, deviceId: string | null): Promise<void>;
  /** Revoke every live token for a user ("sign out everywhere"). */
  revokeAllForUser(userId: string): Promise<void>;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Why a presented refresh token was rejected. `reused` is reported separately
 * from `invalid` for the AUDIT LOG only — the HTTP response must not
 * distinguish them, or it becomes an oracle telling an attacker their stolen
 * token was real. */
export type RefreshFailure = 'invalid' | 'expired' | 'reused';

export type RefreshResult =
  | { ok: true; token: string; userId: string; deviceId: string | null }
  | { ok: false; reason: RefreshFailure };

export class RefreshTokenService {
  constructor(
    private readonly store: RefreshTokenStore,
    private readonly ttlSeconds: number = REFRESH_TOKEN_TTL_SECONDS,
  ) {}

  /** Mint a new refresh token for a user (and device, when there is one). */
  async issue(userId: string, deviceId: string | null): Promise<IssuedRefreshToken> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const id = await this.store.insert({
      userId,
      deviceId,
      tokenHash: hashRefreshToken(token),
      expiresAt,
    });
    return { token, id };
  }

  /**
   * Exchange a refresh token for its successor. Fails closed on unknown,
   * expired, and already-rotated tokens; an already-rotated one additionally
   * revokes the whole family, because a retired token in an attacker's hands
   * and in the legitimate client's hands are indistinguishable from here.
   */
  async rotate(presented: string): Promise<RefreshResult> {
    const row = await this.store.findByHash(hashRefreshToken(presented));
    if (!row) return { ok: false, reason: 'invalid' };

    if (row.revokedAt !== null) {
      await this.store.revokeForUserDevice(row.userId, row.deviceId);
      return { ok: false, reason: 'reused' };
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: 'expired' };
    }

    const next = await this.issue(row.userId, row.deviceId);
    await this.store.markRotated(row.id, next.id);
    return { ok: true, token: next.token, userId: row.userId, deviceId: row.deviceId };
  }

  /** Sign out one device. */
  async revokeDevice(userId: string, deviceId: string | null): Promise<void> {
    await this.store.revokeForUserDevice(userId, deviceId);
  }

  /** Sign out everywhere. */
  async revokeUser(userId: string): Promise<void> {
    await this.store.revokeAllForUser(userId);
  }
}

/** Adapts the real Drizzle client to `RefreshTokenStore`. */
export function createDrizzleRefreshTokenStore(
  database: typeof defaultDb = defaultDb,
): RefreshTokenStore {
  // `device_id` is nullable, and SQL `= NULL` never matches — a plain `eq`
  // here would silently revoke nothing for browser sessions, which is exactly
  // the case where a missed revocation matters.
  const deviceMatches = (deviceId: string | null) =>
    deviceId === null ? isNull(refreshTokens.deviceId) : eq(refreshTokens.deviceId, deviceId);

  return {
    async insert(row) {
      const inserted = await database.insert(refreshTokens).values(row).returning({
        id: refreshTokens.id,
      });
      const created = inserted[0];
      if (!created) throw new Error('refresh_tokens insert returned no row');
      return created.id;
    },
    async findByHash(tokenHash) {
      const rows = await database
        .select({
          id: refreshTokens.id,
          userId: refreshTokens.userId,
          deviceId: refreshTokens.deviceId,
          expiresAt: refreshTokens.expiresAt,
          revokedAt: refreshTokens.revokedAt,
        })
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    },
    async markRotated(id, replacedById) {
      await database
        .update(refreshTokens)
        .set({ revokedAt: new Date(), replacedById })
        .where(eq(refreshTokens.id, id));
    },
    async revokeForUserDevice(userId, deviceId) {
      await database
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.userId, userId),
            deviceMatches(deviceId),
            isNull(refreshTokens.revokedAt),
          ),
        );
    },
    async revokeAllForUser(userId) {
      await database
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    },
  };
}
