import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  RefreshTokenService,
  hashRefreshToken,
  type RefreshTokenStore,
  type RefreshTokenRow,
} from './refreshTokens.js';

/** In-memory `RefreshTokenStore`, mirroring the fake-store pattern the trust
 * and audit-log suites already use. Models the one behaviour that matters:
 * rows are retired, never deleted. */
function fakeStore(): RefreshTokenStore & {
  rows: Map<string, RefreshTokenRow & { hash: string }>;
} {
  const rows = new Map<string, RefreshTokenRow & { hash: string }>();
  return {
    rows,
    insert(row) {
      const id = randomUUID();
      rows.set(id, {
        id,
        userId: row.userId,
        expiresAt: row.expiresAt,
        revokedAt: null,
        hash: row.tokenHash,
      });
      return Promise.resolve(id);
    },
    findByHash(tokenHash) {
      for (const row of rows.values()) if (row.hash === tokenHash) return Promise.resolve(row);
      return Promise.resolve(null);
    },
    markRotated(id) {
      const row = rows.get(id);
      if (row) row.revokedAt = new Date();
      return Promise.resolve();
    },
    revokeAllForUser(userId) {
      for (const row of rows.values()) {
        if (row.userId === userId && row.revokedAt === null) row.revokedAt = new Date();
      }
      return Promise.resolve();
    },
  };
}

describe('RefreshTokenService', () => {
  let store: ReturnType<typeof fakeStore>;
  let service: RefreshTokenService;

  beforeEach(() => {
    store = fakeStore();
    service = new RefreshTokenService(store);
  });

  it('stores only the hash, never the token', async () => {
    const issued = await service.issue('user-1');
    const stored = [...store.rows.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.hash).toBe(hashRefreshToken(issued.token));
    expect(JSON.stringify(stored)).not.toContain(issued.token);
  });

  it('rotates a valid token into a new one', async () => {
    const first = await service.issue('user-1');
    const result = await service.rotate(first.token);
    expect(result).toMatchObject({ ok: true, userId: 'user-1' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.token).not.toBe(first.token);
  });

  it('retires the presented token, so it is single-use', async () => {
    const first = await service.issue('user-1');
    await service.rotate(first.token);
    expect(await service.rotate(first.token)).toEqual({ ok: false, reason: 'reused' });
  });

  // The property that makes rotation worth having: a leaked token cannot be
  // used quietly alongside the legitimate one.
  it('revokes the whole family when a retired token is replayed', async () => {
    const first = await service.issue('user-1');
    const second = await service.rotate(first.token);
    if (!second.ok) throw new Error('unreachable');

    expect(await service.rotate(first.token)).toEqual({ ok: false, reason: 'reused' });
    // The successor the legitimate client holds is now dead too — it must
    // sign in again, which is the correct outcome for a loose token.
    expect(await service.rotate(second.token)).toEqual({ ok: false, reason: 'reused' });
  });

  it('does not touch another user when revoking a family', async () => {
    const victim = await service.issue('user-1');
    const bystander = await service.issue('user-2');
    await service.rotate(victim.token);
    await service.rotate(victim.token); // triggers family revocation

    const stillWorks = await service.rotate(bystander.token);
    expect(stillWorks.ok).toBe(true);
  });

  it('rejects an unknown token', async () => {
    expect(await service.rotate('never-issued')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an expired token without revoking anything', async () => {
    const expiring = new RefreshTokenService(store, -1);
    const issued = await expiring.issue('user-1');
    expect(await expiring.rotate(issued.token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('signs out everywhere', async () => {
    const one = await service.issue('user-1');
    const two = await service.issue('user-1');
    await service.revokeUser('user-1');

    expect((await service.rotate(one.token)).ok).toBe(false);
    expect((await service.rotate(two.token)).ok).toBe(false);
  });
});
