import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@apple/app-store-server-library', () => {
  class VerificationException extends Error {}
  return {
    Environment: { SANDBOX: 'Sandbox', PRODUCTION: 'Production' },
    NotificationTypeV2: {
      EXPIRED: 'EXPIRED',
      REVOKE: 'REVOKE',
      REFUND: 'REFUND',
      GRACE_PERIOD_EXPIRED: 'GRACE_PERIOD_EXPIRED',
      DID_RENEW: 'DID_RENEW',
    },
    VerificationException,
    SignedDataVerifier: class {
      constructor() {}
      verifyAndDecodeTransaction(jws: string) {
        if (jws === 'bad') throw new VerificationException('bad');
        return Promise.resolve(JSON.parse(jws) as Record<string, unknown>);
      }
      verifyAndDecodeNotification(payload: string) {
        if (payload === 'bad') throw new VerificationException('bad');
        return Promise.resolve(JSON.parse(payload) as Record<string, unknown>);
      }
    },
  };
});

vi.mock('../config.js', () => ({
  env: {
    DATABASE_URL: 'postgres://unused',
    APPLE_IAP_BUNDLE_ID: 'com.takedia.lilypad',
    APPLE_IAP_ENVIRONMENT: 'Sandbox',
    APPLE_APP_APPLE_ID: undefined,
  },
  config: {
    env: {
      APPLE_IAP_BUNDLE_ID: 'com.takedia.lilypad',
      APPLE_IAP_ENVIRONMENT: 'Sandbox',
      APPLE_APP_APPLE_ID: undefined,
    },
  },
}));

vi.mock('../db/client.js', () => ({
  db: {},
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readdirSync: () => ['AppleRootCA-G3.cer'],
    readFileSync: () => Buffer.from('fake-cert'),
  };
});

import { applySignedTransaction, applyNotificationPayload } from './appleBilling.js';
import { PRO_MONTHLY_PRODUCT_ID } from '@lilypad/protocol';

type UserRow = {
  id: string;
  tier: 'free' | 'pro' | 'team';
  appleOriginalTransactionId: string | null;
  subscriptionProductId: string | null;
  subscriptionExpiresAt: Date | null;
};

/**
 * Tiny stand-in: `select` returns every row; callers that filter for "other
 * account holding this originalTransactionId" still work because tests seed
 * at most one matching foreign row, and the grant path's conflict query looks
 * for a *different* id — so we drop the acting user when the selected columns
 * are only `{ id }`.
 */
function fakeDb(store: { users: UserRow[] }, actingUserId?: string) {
  return {
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const keys = Object.keys(cols);
            const onlyId = keys.length === 1 && keys[0] === 'id';
            return store.users
              .filter((u) => !(onlyId && actingUserId && u.id === actingUserId))
              .filter((u) => {
                if (!onlyId) return true;
                // Conflict query: only rows that actually hold an Apple id.
                return u.appleOriginalTransactionId != null;
              })
              .map((u) => {
                const out: Record<string, unknown> = {};
                for (const key of keys) {
                  if (key === 'id') out.id = u.id;
                  if (key === 'tier') out.tier = u.tier;
                  if (key === 'subscriptionProductId') {
                    out.subscriptionProductId = u.subscriptionProductId;
                  }
                  if (key === 'subscriptionExpiresAt') {
                    out.subscriptionExpiresAt = u.subscriptionExpiresAt;
                  }
                  if (key === 'appleOriginalTransactionId') {
                    out.appleOriginalTransactionId = u.appleOriginalTransactionId;
                  }
                }
                return out;
              });
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Partial<UserRow>) => ({
        where: async () => {
          const u = store.users[0];
          if (!u) return;
          Object.assign(u, values);
        },
      }),
    }),
  } as never;
}

describe('applySignedTransaction', () => {
  let store: { users: UserRow[] };

  beforeEach(() => {
    store = {
      users: [
        {
          id: 'user-1',
          tier: 'free',
          appleOriginalTransactionId: null,
          subscriptionProductId: null,
          subscriptionExpiresAt: null,
        },
      ],
    };
  });

  it('grants pro for a live monthly subscription', async () => {
    const expires = Date.now() + 30 * 24 * 3600 * 1000;
    const jws = JSON.stringify({
      originalTransactionId: 'ot-1',
      productId: PRO_MONTHLY_PRODUCT_ID,
      expiresDate: expires,
    });
    const result = await applySignedTransaction('user-1', jws, fakeDb(store, 'user-1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.tier).toBe('pro');
    expect(result.status.productId).toBe(PRO_MONTHLY_PRODUCT_ID);
    expect(store.users[0]?.tier).toBe('pro');
    expect(store.users[0]?.appleOriginalTransactionId).toBe('ot-1');
  });

  it('refuses a product that is not Pro', async () => {
    const jws = JSON.stringify({
      originalTransactionId: 'ot-2',
      productId: 'com.other.app.gold',
      expiresDate: Date.now() + 1000,
    });
    const result = await applySignedTransaction('user-1', jws, fakeDb(store, 'user-1'));
    expect(result).toEqual({ ok: false, error: 'wrong_product' });
  });

  it('refuses a forged JWS', async () => {
    const result = await applySignedTransaction('user-1', 'bad', fakeDb(store, 'user-1'));
    expect(result).toEqual({ ok: false, error: 'invalid_transaction' });
  });
});

describe('applyNotificationPayload', () => {
  it('drops pro on EXPIRED', async () => {
    const store = {
      users: [
        {
          id: 'user-1',
          tier: 'pro' as const,
          appleOriginalTransactionId: 'ot-1',
          subscriptionProductId: PRO_MONTHLY_PRODUCT_ID,
          subscriptionExpiresAt: new Date(),
        },
      ],
    };
    const signedTx = JSON.stringify({
      originalTransactionId: 'ot-1',
      productId: PRO_MONTHLY_PRODUCT_ID,
      expiresDate: Date.now() - 1000,
    });
    const payload = JSON.stringify({
      notificationType: 'EXPIRED',
      data: { signedTransactionInfo: signedTx },
    });
    const result = await applyNotificationPayload(payload, fakeDb(store));
    expect(result.handled).toBe(true);
    expect(store.users[0]?.tier).toBe('free');
    expect(store.users[0]?.appleOriginalTransactionId).toBeNull();
  });
});
