/**
 * Subscription ordering against a **real** Postgres (L-295, L-296, L-298).
 *
 * The reducer tests next door prove what the rules are. They cannot prove that
 * two writers arriving at once produce one of those outcomes rather than a
 * torn mixture of both, because that is a property of the database and the
 * transaction, not of the function. A client receipt and an App Store
 * notification for the same subscription arrive concurrently by design, so
 * this is not a hypothetical race.
 *
 * Skipped when `DATABASE_URL` is unset, so a laptop with no Postgres still
 * runs the suite. CI has one, and the `Migrate the test database` step has
 * already applied the migrations by the time this runs — a skipped run is
 * reported as skipped rather than counted as a pass.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { subscriptions, users } from '../db/schema.js';
import { applySubscriptionEvent, subscriptionForOwner } from './subscriptionStore.js';
import type { SubscriptionEvent, SubscriptionState } from './subscription.js';

const DATABASE_URL = process.env.DATABASE_URL;
const PRO = 'com.takedia.lilypad.pro.monthly';
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T00:00:00Z');

const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb('subscription ordering, against a real database', () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let userId: string;
  let otherUserId: string;
  let originalTransactionId: string;

  beforeAll(() => {
    // A small pool: this file opens real connections and CI's budget is
    // shared with the rest of the suite.
    queryClient = postgres(DATABASE_URL as string, { max: 4 });
    db = drizzle(queryClient);
  });

  beforeEach(async () => {
    // A fresh identity per test, so a failure cannot poison the next one and
    // nothing depends on the order tests happen to run in.
    originalTransactionId = `ot-${randomUUID()}`;
    userId = randomUUID();
    otherUserId = randomUUID();
    for (const id of [userId, otherUserId]) {
      await db.insert(users).values({ id, email: `${id}@example.test` });
    }
  });

  function event(over: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
    return {
      environment: 'Production',
      originalTransactionId,
      transactionId: 'tx-1',
      productId: PRO,
      purchaseDate: T0,
      expiresAt: T0 + 30 * DAY,
      revocationDate: null,
      notificationType: null,
      ...over,
    };
  }

  /** The real thing the service calls — not a copy of it. */
  async function apply(ev: SubscriptionEvent, claimant: string | null): Promise<SubscriptionState> {
    const { state } = await applySubscriptionEvent(db as never, ev, claimant);
    return state;
  }

  async function stored() {
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.environment, 'Production'),
          eq(subscriptions.originalTransactionId, originalTransactionId),
        ),
      )
      .limit(1);
    return row;
  }

  it('a client receipt and a webhook arriving together leave one coherent row', async () => {
    await apply(event(), userId);
    const renewal = event({
      transactionId: 'tx-2',
      purchaseDate: T0 + 30 * DAY,
      expiresAt: T0 + 60 * DAY,
      notificationType: 'DID_RENEW',
    });
    // Both writers, at once, on the same identity. Without the row lock these
    // interleave into a lost update; with it, one waits.
    await Promise.all([apply(renewal, null), apply(renewal, userId)]);

    const row = await stored();
    expect(row).toBeDefined();
    expect(row?.lastTransactionId).toBe('tx-2');
    expect(row?.expiresAt?.getTime()).toBe(T0 + 60 * DAY);
    expect(row?.ownerUserId).toBe(userId);
    expect(row?.status).toBe('active');
  });

  it('a replayed older receipt racing a renewal does not win', async () => {
    await apply(event(), userId);
    const renewal = event({
      transactionId: 'tx-2',
      purchaseDate: T0 + 30 * DAY,
      expiresAt: T0 + 60 * DAY,
    });
    const replayOfTheFirst = event();
    await Promise.all([apply(renewal, userId), apply(replayOfTheFirst, userId)]);
    await apply(replayOfTheFirst, userId);

    const row = await stored();
    expect(row?.lastTransactionId).toBe('tx-2');
    expect(row?.expiresAt?.getTime()).toBe(T0 + 60 * DAY);
  });

  it('the same event delivered many times over produces one row and one state', async () => {
    const duplicate = event({ transactionId: 'tx-1' });
    await Promise.all(Array.from({ length: 8 }, () => apply(duplicate, userId)));
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.originalTransactionId, originalTransactionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastTransactionId).toBe('tx-1');
  });

  it('expiry then renewal finds the same account', async () => {
    await apply(event(), userId);
    await apply(event({ notificationType: 'EXPIRED' }), null);
    expect((await stored())?.status).toBe('expired');
    // The account association is what a renewal is routed by, so it has to
    // have survived the expiry (L-296).
    expect((await stored())?.ownerUserId).toBe(userId);

    await apply(
      event({
        transactionId: 'tx-3',
        purchaseDate: T0 + 40 * DAY,
        expiresAt: T0 + 70 * DAY,
        notificationType: 'DID_RENEW',
      }),
      null,
    );
    const row = await stored();
    expect(row?.status).toBe('active');
    expect(row?.ownerUserId).toBe(userId);
    expect(row?.expiresAt?.getTime()).toBe(T0 + 70 * DAY);
  });

  it('one Apple subscription cannot be held by two accounts, in the same environment', async () => {
    await apply(event(), userId);
    // Within one environment the database enforces this on its own: a second
    // row for the same identity violates the unique index. Across
    // environments it does not, which is the case below.
    await expect(
      db.insert(subscriptions).values({
        environment: 'Production',
        originalTransactionId,
        ownerUserId: otherUserId,
        productId: PRO,
        status: 'active',
      }),
    ).rejects.toThrow();
  });

  it('the same original transaction id in each environment is two rows for ONE account', async () => {
    // A TestFlight tester who later buys for real. Two rows, two environments,
    // one owner -- which is the case the split identity exists to allow.
    await apply(event(), userId);
    await apply(event({ environment: 'Sandbox', transactionId: 'tx-s' }), userId);
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.originalTransactionId, originalTransactionId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.environment))).toEqual(new Set(['Production', 'Sandbox']));
    expect(new Set(rows.map((r) => r.ownerUserId))).toEqual(new Set([userId]));
  });

  it('refuses a second account claiming the same subscription under the other environment (L-308)', async () => {
    // This is the shape the previous version of the test above had, with the
    // second row given to a DIFFERENT account -- and it passed, because the
    // unique index is on (environment, originalTransactionId) and two labels
    // are two identities. So the check that was supposed to stop one payment
    // entitling two accounts never saw the second claimant at all.
    //
    // Observed in production: a legacy Sandbox purchase recorded as Production
    // by migration 0012, then the same Apple subscription bought again under
    // Sandbox by a second Lilypad account. Both accounts held it at once.
    await apply(event(), userId);

    const { state, conflict } = await applySubscriptionEvent(
      db as never,
      event({ environment: 'Sandbox', transactionId: 'tx-s' }),
      otherUserId,
    );
    expect(conflict).toBe(true);
    expect(state.ownerUserId).toBe(userId);

    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.originalTransactionId, originalTransactionId));
    expect(rows.filter((r) => r.ownerUserId === otherUserId)).toHaveLength(0);
  });

  it('still lets a notification reach a subscription another account owns', async () => {
    // Notifications claim nothing, so the ownership refusal must not apply to
    // them: Apple addresses the subscription, and the row it addresses has an
    // owner by definition. Refusing here would have stopped every renewal.
    await apply(event(), userId);
    const renewed = await apply(
      event({ transactionId: 'tx-2', purchaseDate: T0 + DAY, expiresAt: T0 + 60 * DAY }),
      null,
    );
    expect(renewed.ownerUserId).toBe(userId);
    expect(renewed.lastTransactionId).toBe('tx-2');
  });

  it('a webhook winning the first-purchase race does not cost the buyer the claim', async () => {
    // Apple's SUBSCRIBED and the phone's receipt name the SAME transaction and
    // arrive together. Whoever loses the insert race must still end up with
    // the subscription attached to the account that paid -- the row was
    // created unowned by the notification, and the receipt is the claim.
    const first = event();
    await Promise.all([apply(first, null), apply(first, userId)]);

    const row = await stored();
    expect(row?.ownerUserId).toBe(userId);
  });

  it('an account holding both a test and a real subscription is judged on the real one', async () => {
    // A TestFlight tester who later buys for real owns two rows. `ownerUserId`
    // is not unique, so "take one row" is a coin toss, and the toss decides
    // whether they get the Pro they paid for.
    const sandboxOnly = `ot-${randomUUID()}`;
    await db.insert(subscriptions).values({
      environment: 'Sandbox',
      originalTransactionId: sandboxOnly,
      ownerUserId: userId,
      productId: PRO,
      status: 'active',
      expiresAt: new Date(T0 + 90 * DAY),
    });
    // Inserted second, so a query with no ordering will tend to return the
    // Sandbox row above -- which entitles an ordinary account to nothing.
    await apply(event(), userId);

    const chosen = await subscriptionForOwner(db as never, userId, 'Production');
    expect(chosen?.environment).toBe('Production');
    expect(chosen?.originalTransactionId).toBe(originalTransactionId);
  });

  afterAll(async () => {
    // Only what these tests made; the subscriptions cascade with them.
    await db.execute(sql`DELETE FROM users WHERE email LIKE '%@example.test'`);
    await queryClient?.end();
  });
});
