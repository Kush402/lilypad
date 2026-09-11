import type * as NodeFs from 'node:fs';
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
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    readdirSync: () => ['AppleRootCA-G3.cer'],
    readFileSync: () => Buffer.from('fake-cert'),
  };
});

import { applySignedTransaction, applyNotificationPayload } from './appleBilling.js';
import { users as usersTable } from '../db/schema.js';
import { PRO_MONTHLY_PRODUCT_ID } from '@lilypad/protocol';

type UserRow = {
  id: string;
  tier: 'free' | 'pro' | 'team';
  isBillingTester: boolean;
  appleOriginalTransactionId: string | null;
  subscriptionProductId: string | null;
  subscriptionExpiresAt: Date | null;
};

type SubRow = Record<string, unknown> & { id: string };

/**
 * A stand-in for drizzle, honest about what it is.
 *
 * `where` clauses are opaque objects here, so this cannot filter — it keys on
 * the table and returns the first row. That is enough to exercise the service
 * wiring, and deliberately not enough to establish ordering or concurrency
 * behaviour: those need a real database, and live in
 * `subscriptionOrdering.pg.test.ts`.
 */
function fakeDb(store: { users: UserRow[]; subs: SubRow[] }) {
  const rowsFor = (table: unknown): Record<string, unknown>[] =>
    table === usersTable ? (store.users as unknown as Record<string, unknown>[]) : store.subs;

  const api = {
    select: (cols?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        // `where(...)`, `where(...).limit(1)` and `where(...).limit(1).for('update')`
        // are all valid drizzle, so each step is a promise that also carries
        // the next one. `subscriptionForOwner` awaits `where` directly -- it
        // has to see every row an account owns, not the first one.
        where: () => {
          const project = (rows: Record<string, unknown>[]) =>
            cols
              ? rows.map((row) => {
                  const out: Record<string, unknown> = {};
                  for (const key of Object.keys(cols)) out[key] = row[key];
                  return out;
                })
              : rows;
          const all = project(rowsFor(table));
          return Object.assign(Promise.resolve(all), {
            limit: () => {
              const pending = Promise.resolve(all.slice(0, 1)) as Promise<
                Record<string, unknown>[]
              > & {
                for: () => Promise<Record<string, unknown>[]>;
              };
              pending.for = () => pending;
              return pending;
            },
          });
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          const row = rowsFor(table)[0];
          if (row) Object.assign(row, values);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const write = () => {
          if (table === usersTable) return;
          store.subs.push({ id: `sub-${store.subs.length + 1}`, ...values });
        };
        // `.values(x)` and `.values(x).onConflictDoNothing()` are both valid
        // drizzle; this fake is single-threaded, so there is never a conflict.
        const pending = Promise.resolve().then(write) as Promise<void> & {
          onConflictDoNothing: () => Promise<void>;
        };
        pending.onConflictDoNothing = () => pending;
        return pending;
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(api),
  };
  return api as never;
}

describe('applySignedTransaction', () => {
  let store: { users: UserRow[]; subs: SubRow[] };

  beforeEach(() => {
    store = {
      users: [
        {
          id: 'user-1',
          tier: 'free',
          isBillingTester: false,
          appleOriginalTransactionId: null,
          subscriptionProductId: null,
          subscriptionExpiresAt: null,
        },
      ],
      subs: [],
    };
  });

  it('grants pro for a live monthly subscription', async () => {
    const expires = Date.now() + 30 * 24 * 3600 * 1000;
    const jws = JSON.stringify({
      originalTransactionId: 'ot-1',
      productId: PRO_MONTHLY_PRODUCT_ID,
      expiresDate: expires,
    });
    const result = await applySignedTransaction('user-1', jws, fakeDb(store));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.tier).toBe('pro');
    expect(result.status.productId).toBe(PRO_MONTHLY_PRODUCT_ID);
    // The subscription is its own row now, and the account's own tier is the
    // manual grant — untouched by a purchase (L-299).
    expect(store.users[0]?.tier).toBe('free');
    expect(store.subs[0]?.originalTransactionId).toBe('ot-1');
    expect(store.subs[0]?.ownerUserId).toBe('user-1');
    expect(store.subs[0]?.status).toBe('active');
  });

  it('refuses a transaction Apple says was bought for another account (L-297)', async () => {
    // The stamp is inside the signed transaction, so it outranks the bearer
    // token presenting it: a delivery retried after a sign-out must not attach
    // to whoever happens to be signed in when it finally goes through.
    const jws = JSON.stringify({
      originalTransactionId: 'ot-9',
      productId: PRO_MONTHLY_PRODUCT_ID,
      expiresDate: Date.now() + 30 * 24 * 3600 * 1000,
      appAccountToken: 'user-2',
    });
    const result = await applySignedTransaction('user-1', jws, fakeDb(store));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('wrong_account');
    expect(store.subs).toHaveLength(0);
  });

  it('accepts a transaction stamped for the account presenting it', async () => {
    const jws = JSON.stringify({
      originalTransactionId: 'ot-10',
      productId: PRO_MONTHLY_PRODUCT_ID,
      expiresDate: Date.now() + 30 * 24 * 3600 * 1000,
      appAccountToken: 'user-1',
    });
    const result = await applySignedTransaction('user-1', jws, fakeDb(store));
    expect(result.ok).toBe(true);
    expect(store.subs[0]?.ownerUserId).toBe('user-1');
  });

  it('still accepts a transaction with no stamp at all', async () => {
    // Purchases made before the stamp existed, and purchases made outside the
    // app, carry nothing. They fall back to the ownership rules, which already
    // refuse a subscription another account holds.
    const jws = JSON.stringify({
      originalTransactionId: 'ot-11',
      productId: PRO_MONTHLY_PRODUCT_ID,
      expiresDate: Date.now() + 30 * 24 * 3600 * 1000,
    });
    const result = await applySignedTransaction('user-1', jws, fakeDb(store));
    expect(result.ok).toBe(true);
  });

  it('refuses a product that is not Pro', async () => {
    const jws = JSON.stringify({
      originalTransactionId: 'ot-2',
      productId: 'com.other.app.gold',
      expiresDate: Date.now() + 1000,
    });
    const result = await applySignedTransaction('user-1', jws, fakeDb(store));
    expect(result).toEqual({ ok: false, error: 'wrong_product' });
  });

  it('refuses a forged JWS', async () => {
    const result = await applySignedTransaction('user-1', 'bad', fakeDb(store));
    expect(result).toEqual({ ok: false, error: 'invalid_transaction' });
  });
});

describe('applyNotificationPayload', () => {
  it('ends access on EXPIRED and keeps the account association (L-296)', async () => {
    const store = {
      users: [
        {
          id: 'user-1',
          tier: 'free' as const,
          isBillingTester: false,
          appleOriginalTransactionId: null,
          subscriptionProductId: null,
          subscriptionExpiresAt: null,
        },
      ],
      subs: [
        {
          id: 'sub-1',
          environment: 'Sandbox',
          originalTransactionId: 'ot-1',
          ownerUserId: 'user-1',
          productId: PRO_MONTHLY_PRODUCT_ID,
          status: 'active',
          expiresAt: new Date(Date.now() + 1000),
          graceExpiresAt: null,
          lastTransactionId: 'tx-1',
          lastPurchaseDate: new Date(Date.now() - 10_000),
          revokedAt: null,
        },
      ] as SubRow[],
    };
    const signedTx = JSON.stringify({
      originalTransactionId: 'ot-1',
      transactionId: 'tx-2',
      productId: PRO_MONTHLY_PRODUCT_ID,
      purchaseDate: Date.now(),
      expiresDate: Date.now() - 1000,
      environment: 'Sandbox',
    });
    const payload = JSON.stringify({
      notificationType: 'EXPIRED',
      data: { signedTransactionInfo: signedTx },
    });
    const result = await applyNotificationPayload(payload, fakeDb(store));
    expect(result.handled).toBe(true);
    expect(store.subs[0]?.status).toBe('expired');
    // The defect this closes: the ownership binding used to be cleared here,
    // so the next renewal could not find the account.
    expect(store.subs[0]?.ownerUserId).toBe('user-1');
    expect(store.subs[0]?.originalTransactionId).toBe('ot-1');
  });

  it('keeps a notification for a subscription no account has claimed', async () => {
    const store = {
      users: [] as UserRow[],
      subs: [] as SubRow[],
    };
    const signedTx = JSON.stringify({
      originalTransactionId: 'ot-9',
      transactionId: 'tx-9',
      productId: PRO_MONTHLY_PRODUCT_ID,
      purchaseDate: Date.now(),
      expiresDate: Date.now() + 1000,
      environment: 'Sandbox',
    });
    const payload = JSON.stringify({
      notificationType: 'SUBSCRIBED',
      data: { signedTransactionInfo: signedTx },
    });
    const result = await applyNotificationPayload(payload, fakeDb(store));
    expect(result).toEqual({ handled: true, reason: 'unclaimed' });
    // Observed in production: SUBSCRIBED arrived before association. It is
    // authenticated, so it is kept rather than acknowledged and forgotten.
    expect(store.subs).toHaveLength(1);
    expect(store.subs[0]?.ownerUserId).toBeNull();
  });
});
