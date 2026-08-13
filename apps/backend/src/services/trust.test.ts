import { describe, it, expect } from 'vitest';
import { TrustService, type PairListing, type TrustStore, type TrustedPair } from './trust.js';
import type { DeviceKind } from '@lilypad/protocol';

/** In-memory TrustStore, mirroring the FakeRedis pattern of sibling tests. */
class FakeTrustStore implements TrustStore {
  devices = new Map<string, { id: string; kind: DeviceKind; fingerprint: string }>();
  pairs = new Map<string, TrustedPair & { lastConnectedAt: Date | null }>();
  private nextId = 1;

  private key(kind: DeviceKind, fingerprint: string) {
    return `${kind}:${fingerprint}`;
  }

  async upsertDevice(kind: DeviceKind, fingerprint: string): Promise<string> {
    const k = this.key(kind, fingerprint);
    const existing = this.devices.get(k);
    if (existing) return existing.id;
    const id = `dev-${this.nextId++}`;
    this.devices.set(k, { id, kind, fingerprint });
    return id;
  }

  async getPairByDeviceIds(desktopId: string, mobileId: string): Promise<TrustedPair | null> {
    for (const pair of this.pairs.values()) {
      if (pair.desktopDeviceId === desktopId && pair.mobileDeviceId === mobileId) return pair;
    }
    return null;
  }

  async insertPair(
    desktopId: string,
    mobileId: string,
    autoApprove: boolean,
    connectSecretHash: string,
  ): Promise<TrustedPair> {
    const pair = {
      pairId: `pair-${this.nextId++}`,
      desktopDeviceId: desktopId,
      mobileDeviceId: mobileId,
      autoApprove,
      revoked: false,
      displayName: null,
      connectSecretHash,
      lastConnectedAt: null,
    };
    this.pairs.set(pair.pairId, pair);
    return pair;
  }

  async listPairsForDesktop(desktopId: string): Promise<PairListing[]> {
    const byId = new Map([...this.devices.values()].map((d) => [d.id, d]));
    return [...this.pairs.values()]
      .filter((p) => p.desktopDeviceId === desktopId)
      .map((p) => ({
        pairId: p.pairId,
        mobileFingerprint: byId.get(p.mobileDeviceId)?.fingerprint ?? '?',
        displayName: p.displayName,
        autoApprove: p.autoApprove,
        revoked: p.revoked,
        lastConnectedAt: p.lastConnectedAt ? p.lastConnectedAt.toISOString() : null,
        createdAt: new Date(0).toISOString(),
      }));
  }

  async updatePair(
    pairId: string,
    patch: {
      revoked?: boolean;
      autoApprove?: boolean;
      lastConnectedAt?: Date;
      connectSecretHash?: string;
    },
  ): Promise<void> {
    const pair = this.pairs.get(pairId);
    if (!pair) throw new Error(`no pair ${pairId}`);
    if (patch.revoked !== undefined) pair.revoked = patch.revoked;
    if (patch.autoApprove !== undefined) pair.autoApprove = patch.autoApprove;
    if (patch.lastConnectedAt !== undefined) pair.lastConnectedAt = patch.lastConnectedAt;
    if (patch.connectSecretHash !== undefined) pair.connectSecretHash = patch.connectSecretHash;
  }

  async getDeviceByFingerprint(kind: DeviceKind, fingerprint: string) {
    const found = this.devices.get(this.key(kind, fingerprint));
    return found ? { id: found.id } : null;
  }

  async getPairFingerprints(pairId: string) {
    const pair = this.pairs.get(pairId);
    if (!pair) return null;
    const byId = new Map([...this.devices.values()].map((d) => [d.id, d]));
    const desktop = byId.get(pair.desktopDeviceId);
    const mobile = byId.get(pair.mobileDeviceId);
    if (!desktop || !mobile) return null;
    return { desktopFingerprint: desktop.fingerprint, mobileFingerprint: mobile.fingerprint };
  }
}

describe('TrustService', () => {
  it('establishTrust creates device rows and one pair, idempotently', async () => {
    const store = new FakeTrustStore();
    const trust = new TrustService(store);

    await trust.establishTrust('desktop-01', 'mobile-01');
    await trust.establishTrust('desktop-01', 'mobile-01'); // same ceremony again

    expect(store.devices.size).toBe(2);
    expect(store.pairs.size).toBe(1);
    const pair = await trust.findPair('desktop-01', 'mobile-01');
    expect(pair).not.toBeNull();
    expect(pair!.revoked).toBe(false);
    // The trust ceremony IS the consent moment — trusted phones reconnect
    // without a per-session desktop tap (visible indicator + audit + the
    // dashboard toggle keep "no silent access" honest).
    expect(pair!.autoApprove).toBe(true);
  });

  // Account enrollment (ADR-0008) already holds both devices.id uuids and must
  // not re-derive them from wire fingerprints. Regression guard for a real
  // defect: approving a laptop wrote devices.user_id and nothing else, while
  // authorizeConnect authorizes purely on a trusted_devices row — so the user
  // completed the whole linking ceremony and still could not connect.
  it('establishTrustForDeviceIds makes an enrolled laptop reachable, not merely owned', async () => {
    const store = new FakeTrustStore();
    const trust = new TrustService(store);

    // Both rows already exist, as they do after enrollment.
    const desktopId = await store.upsertDevice('desktop', 'desktop-enrolled');
    const mobileId = await store.upsertDevice('mobile', 'mobile-approver');

    // Ownership alone leaves it unreachable.
    expect(await trust.authorizeConnect('desktop-enrolled', 'mobile-approver', undefined)).toEqual({
      ok: false,
      reason: 'not_trusted',
    });

    const { pairSecret } = await trust.establishTrustForDeviceIds(desktopId, mobileId);

    expect(store.devices.size).toBe(2); // no duplicate rows minted
    expect(store.pairs.size).toBe(1);
    const authorized = await trust.authorizeConnect(
      'desktop-enrolled',
      'mobile-approver',
      pairSecret,
    );
    expect(authorized.ok).toBe(true);
    // The secret is load-bearing: seeing the laptop is not reaching it.
    const wrongSecret = await trust.authorizeConnect(
      'desktop-enrolled',
      'mobile-approver',
      'not-the-secret',
    );
    expect(wrongSecret).toEqual({ ok: false, reason: 'bad_secret' });
  });

  it('the dashboard toggle flips autoApprove and re-trusting never overrides it', async () => {
    const store = new FakeTrustStore();
    const trust = new TrustService(store);
    await trust.establishTrust('desktop-01', 'mobile-01');
    const pair = (await trust.findPair('desktop-01', 'mobile-01'))!;

    await trust.setAutoApprove(pair.pairId, false); // user wants approval again
    expect((await trust.findPair('desktop-01', 'mobile-01'))!.autoApprove).toBe(false);

    await trust.establishTrust('desktop-01', 'mobile-01'); // re-scan later
    expect((await trust.findPair('desktop-01', 'mobile-01'))!.autoApprove).toBe(false);
  });

  it('listForDesktop returns each phone with its settings; empty for unknown', async () => {
    const store = new FakeTrustStore();
    const trust = new TrustService(store);
    await trust.establishTrust('desktop-01', 'mobile-01');
    await trust.establishTrust('desktop-01', 'mobile-02');

    const listing = await trust.listForDesktop('desktop-01');
    expect(listing.map((p) => p.mobileFingerprint).sort()).toEqual(['mobile-01', 'mobile-02']);
    expect(listing.every((p) => p.autoApprove)).toBe(true);

    expect(await trust.listForDesktop('desktop-unknown')).toEqual([]);
  });

  it('findPair returns null for unknown devices or an untrusted combination', async () => {
    const store = new FakeTrustStore();
    const trust = new TrustService(store);
    await trust.establishTrust('desktop-01', 'mobile-01');

    expect(await trust.findPair('desktop-01', 'mobile-99')).toBeNull();
    expect(await trust.findPair('desktop-99', 'mobile-01')).toBeNull();
  });

  it('revoke severs the pair but keeps the row; the pair reads as revoked', async () => {
    const store = new FakeTrustStore();
    const trust = new TrustService(store);
    await trust.establishTrust('desktop-01', 'mobile-01');
    const pair = (await trust.findPair('desktop-01', 'mobile-01'))!;

    await trust.revoke(pair.pairId);

    expect(store.pairs.size).toBe(1); // audit trail retained
    expect((await trust.findPair('desktop-01', 'mobile-01'))!.revoked).toBe(true);
  });

  it('re-running the full trust ceremony un-revokes a revoked pair', async () => {
    const store = new FakeTrustStore();
    const trust = new TrustService(store);
    await trust.establishTrust('desktop-01', 'mobile-01');
    const pair = (await trust.findPair('desktop-01', 'mobile-01'))!;
    await trust.revoke(pair.pairId);

    await trust.establishTrust('desktop-01', 'mobile-01'); // fresh QR + approve

    expect((await trust.findPair('desktop-01', 'mobile-01'))!.revoked).toBe(false);
    expect(store.pairs.size).toBe(1); // same row, no duplicate
  });

  it('two phones trusted by one desktop are independent pairs', async () => {
    const store = new FakeTrustStore();
    const trust = new TrustService(store);
    await trust.establishTrust('desktop-01', 'mobile-01');
    await trust.establishTrust('desktop-01', 'mobile-02');

    expect(store.pairs.size).toBe(2);
    const first = (await trust.findPair('desktop-01', 'mobile-01'))!;
    await trust.revoke(first.pairId);
    expect((await trust.findPair('desktop-01', 'mobile-02'))!.revoked).toBe(false);
  });

  it('establishTrust issues a fresh connect secret and stores only its hash', async () => {
    const store = new FakeTrustStore();
    const trust = new TrustService(store);

    const { pairSecret } = await trust.establishTrust('desktop-01', 'mobile-01');
    expect(pairSecret.length).toBeGreaterThanOrEqual(16);
    const pair = (await trust.findPair('desktop-01', 'mobile-01'))!;
    // The plaintext must NEVER be what's stored.
    expect(pair.connectSecretHash).not.toBeNull();
    expect(pair.connectSecretHash).not.toBe(pairSecret);

    // Re-establishing rotates the secret.
    const again = await trust.establishTrust('desktop-01', 'mobile-01');
    expect(again.pairSecret).not.toBe(pairSecret);
  });

  describe('authorizeConnect', () => {
    it('accepts the correct secret, rejects a wrong/absent one', async () => {
      const store = new FakeTrustStore();
      const trust = new TrustService(store);
      const { pairSecret } = await trust.establishTrust('desktop-01', 'mobile-01');

      const ok = await trust.authorizeConnect('desktop-01', 'mobile-01', pairSecret);
      expect(ok.ok).toBe(true);

      expect((await trust.authorizeConnect('desktop-01', 'mobile-01', 'wrong')).ok).toBe(false);
      expect((await trust.authorizeConnect('desktop-01', 'mobile-01', undefined)).ok).toBe(false);
    });

    it('fails closed on unknown and revoked pairs', async () => {
      const store = new FakeTrustStore();
      const trust = new TrustService(store);
      const { pairSecret } = await trust.establishTrust('desktop-01', 'mobile-01');

      const unknown = await trust.authorizeConnect('desktop-01', 'mobile-99', pairSecret);
      expect(unknown).toEqual({ ok: false, reason: 'not_trusted' });

      const pair = (await trust.findPair('desktop-01', 'mobile-01'))!;
      await trust.revoke(pair.pairId);
      const revoked = await trust.authorizeConnect('desktop-01', 'mobile-01', pairSecret);
      expect(revoked).toEqual({ ok: false, reason: 'revoked' });
    });

    // SEC-5. This used to assert the OPPOSITE — a legacy pre-secret pair was
    // admitted with no secret at all for back-compat, which made knowing two
    // device ids sufficient to ring a laptop, on exactly the pairs whose owners
    // never had the chance to opt into a secret. Migration `0005` revokes the
    // rows that exist; this is the guard that keeps it shut.
    it('refuses a legacy pre-secret pair rather than admitting it with no secret', async () => {
      const store = new FakeTrustStore();
      const trust = new TrustService(store);
      const desktopId = await store.upsertDevice('desktop', 'desktop-01');
      const mobileId = await store.upsertDevice('mobile', 'mobile-01');
      await store.insertPair(desktopId, mobileId, true, '');
      // Force the hash null (the '' above is a placeholder the fake stored).
      const pair = (await trust.findPair('desktop-01', 'mobile-01'))!;
      store.pairs.get(pair.pairId)!.connectSecretHash = null as unknown as string;

      expect(await trust.authorizeConnect('desktop-01', 'mobile-01', undefined)).toEqual({
        ok: false,
        reason: 'not_trusted',
      });
      // Nor by guessing a secret — there is nothing to match against.
      expect(await trust.authorizeConnect('desktop-01', 'mobile-01', 'anything')).toEqual({
        ok: false,
        reason: 'not_trusted',
      });
    });

    // The recovery path has to actually work, or the fix is a lockout: the QR
    // ceremony issues a secret and un-revokes the row.
    it('lets a purged pair recover by re-pairing with a QR', async () => {
      const store = new FakeTrustStore();
      const trust = new TrustService(store);
      const desktopId = await store.upsertDevice('desktop', 'desktop-01');
      const mobileId = await store.upsertDevice('mobile', 'mobile-01');
      await store.insertPair(desktopId, mobileId, true, '');
      const pair = (await trust.findPair('desktop-01', 'mobile-01'))!;
      store.pairs.get(pair.pairId)!.connectSecretHash = null as unknown as string;
      await trust.revoke(pair.pairId); // what migration 0005 does

      const { pairSecret } = await trust.establishTrust('desktop-01', 'mobile-01');
      const authz = await trust.authorizeConnect('desktop-01', 'mobile-01', pairSecret);
      expect(authz.ok).toBe(true);
    });
  });

  it("revoke returns the pair's wire fingerprints; null for a nonexistent pairId", async () => {
    const store = new FakeTrustStore();
    const trust = new TrustService(store);
    await trust.establishTrust('desktop-01', 'mobile-01');
    const pair = (await trust.findPair('desktop-01', 'mobile-01'))!;

    const fingerprints = await trust.revoke(pair.pairId);
    expect(fingerprints).toEqual({
      desktopFingerprint: 'desktop-01',
      mobileFingerprint: 'mobile-01',
    });

    expect(await trust.revoke('nonexistent-pair-id')).toBeNull();
  });

  describe('mobile-initiated unpair (POST /devices/unpair)', () => {
    // The route itself is a thin wrapper over findPair + revoke (mirroring
    // the desktop's DELETE /devices/pairs/:pairId), so these exercise that
    // same sequence directly against the service.
    it('an active pair found by (desktopId, mobileId) becomes revoked', async () => {
      const store = new FakeTrustStore();
      const trust = new TrustService(store);
      await trust.establishTrust('desktop-01', 'mobile-01');

      const pair = await trust.findPair('desktop-01', 'mobile-01');
      expect(pair).not.toBeNull();
      expect(pair!.revoked).toBe(false);
      await trust.revoke(pair!.pairId);

      expect((await trust.findPair('desktop-01', 'mobile-01'))!.revoked).toBe(true);
      expect(store.pairs.size).toBe(1); // audit trail retained, same as desktop revoke
    });

    it('is idempotent: an unknown pair and an already-revoked pair are both no-ops (route still answers ok)', async () => {
      const store = new FakeTrustStore();
      const trust = new TrustService(store);

      // Unknown pair — never trusted.
      expect(await trust.findPair('desktop-99', 'mobile-99')).toBeNull();

      // Already-revoked pair — a second unpair must not throw or double-act.
      await trust.establishTrust('desktop-01', 'mobile-01');
      const pair = (await trust.findPair('desktop-01', 'mobile-01'))!;
      await trust.revoke(pair.pairId);
      const second = await trust.findPair('desktop-01', 'mobile-01');
      expect(second!.revoked).toBe(true); // route sees revoked:true and skips re-revoking
    });
  });

  it('touchConnected stamps lastConnectedAt', async () => {
    const store = new FakeTrustStore();
    const trust = new TrustService(store);
    await trust.establishTrust('desktop-01', 'mobile-01');
    const pair = (await trust.findPair('desktop-01', 'mobile-01'))!;

    await trust.touchConnected(pair.pairId);

    expect(store.pairs.get(pair.pairId)!.lastConnectedAt).toBeInstanceOf(Date);
  });
});
