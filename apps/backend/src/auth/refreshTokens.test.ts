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
  rows: Map<string, RefreshTokenRow & { hash: string; replacedById?: string }>;
} {
  const rows = new Map<string, RefreshTokenRow & { hash: string; replacedById?: string }>();
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
    // Deliberately atomic — no `await` between reading `revokedAt` and writing
    // it — because the real implementation is ONE `UPDATE … WHERE revoked_at
    // IS NULL RETURNING id`. A fake that yielded in the middle would invent an
    // interleaving Postgres does not have, and would let a broken `rotate`
    // pass.
    markRotatedIfLive(id, replacedById) {
      const row = rows.get(id);
      if (!row || row.revokedAt !== null) return Promise.resolve(false);
      row.revokedAt = new Date();
      row.replacedById = replacedById;
      return Promise.resolve(true);
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

  describe('concurrent rotation of one token', () => {
    /** The race this file's `markRotatedIfLive` exists for.
     *
     * `rotate` used to read the row, check `revokedAt`, then write. Two
     * requests presenting the SAME token interleave inside that gap: both read
     * a live row, both pass the reuse check, and both mint a successor. The
     * effect is worse than a duplicate — it is reuse detection silently not
     * working, which is the one thing rotation is for. */
    it('lets exactly one caller win, and treats the other as reuse', async () => {
      const issued = await service.issue('user-1');

      const [a, b] = await Promise.all([
        service.rotate(issued.token),
        service.rotate(issued.token),
      ]);

      const winners = [a, b].filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const loser = [a, b].find((r) => !r.ok);
      expect(loser).toEqual({ ok: false, reason: 'reused' });
    });

    it('leaves the account with no usable refresh token at all', async () => {
      // Concurrent use is indistinguishable from theft, so the family dies —
      // including the successor the winner had already minted. Re-authenticating
      // is the only way back, which is the intended posture for reuse.
      const issued = await service.issue('user-1');

      const results = await Promise.all([
        service.rotate(issued.token),
        service.rotate(issued.token),
      ]);

      const minted = results.find((r) => r.ok);
      expect(minted?.ok).toBe(true);
      if (minted?.ok) {
        expect((await service.rotate(minted.token)).ok).toBe(false);
      }
      expect([...store.rows.values()].every((r) => r.revokedAt !== null)).toBe(true);
    });

    it('does not punish a second, sequential rotation of the SUCCESSOR', async () => {
      // The guard must not turn normal serial refreshing into a logout.
      const first = await service.issue('user-1');
      const second = await service.rotate(first.token);
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect((await service.rotate(second.token)).ok).toBe(true);
      }
    });
  });
});
