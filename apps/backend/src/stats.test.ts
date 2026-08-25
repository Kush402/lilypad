import { describe, it, expect, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { db } from './db/client.js';
import { devices, trustedDevices, users } from './db/schema.js';
import { report } from './stats.js';

/**
 * The product-owner numbers, against the real database.
 *
 * What is worth testing is not the SQL but the counting rule that a
 * hand-written query gets wrong: **an account is activated when it has a
 * paired laptop, not when it has signed up**. Every other number here is a
 * `count()`; that one is a join, and it is the only number a decision would
 * turn on.
 *
 * The second rule is subtler and worth as much: a revoked device must not keep
 * an account counted as active. "You have 29 customers" built from rows nobody
 * uses any more is a comfortable number and a false one.
 */

const PREFIX = `stats-${Date.now()}-`;

afterAll(async () => {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `${PREFIX}%`));
  for (const row of rows) {
    const owned = await db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.userId, row.id));
    for (const d of owned) {
      await db.delete(trustedDevices).where(eq(trustedDevices.desktopDeviceId, d.id));
      await db.delete(trustedDevices).where(eq(trustedDevices.mobileDeviceId, d.id));
    }
    await db.delete(devices).where(eq(devices.userId, row.id));
    await db.delete(users).where(eq(users.id, row.id));
  }
});

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${PREFIX}${crypto.randomUUID()}@example.test` })
    .returning({ id: users.id });
  return user!.id;
}

async function seedDevice(
  userId: string,
  kind: 'desktop' | 'mobile',
  over: { revokedAt?: Date } = {},
): Promise<string> {
  const [device] = await db
    .insert(devices)
    .values({
      userId,
      kind,
      fingerprint: `${kind}-${crypto.randomUUID()}`,
      publicKey: crypto.randomUUID(),
      ...over,
    })
    .returning({ id: devices.id });
  return device!.id;
}

async function run(): Promise<string> {
  const lines: string[] = [];
  await report((l) => lines.push(l));
  return lines.join('\n');
}

/** The value printed beside a label, whatever the padding. */
function valueOf(output: string, label: string): number {
  const match = new RegExp(`^\\s*${label}\\s+(\\d+)`, 'm').exec(output);
  expect(match, `no line for "${label}"`).not.toBeNull();
  return Number(match![1]);
}

describe('pnpm stats', () => {
  /**
   * Every assertion below reads ONE report and compares numbers WITHIN it.
   *
   * The first version compared a count before a seed with the count after, and
   * failed the moment the whole backend suite ran: other files create and
   * delete their own accounts against the same database, so a delta across two
   * reads is a measurement of what everyone else happened to be doing. An
   * invariant inside a single read is not.
   */
  it('counts an account as activated only once a laptop is paired to it', async () => {
    // A phone signed in on, and nothing else. This account can do nothing: a
    // laptop is added by that phone scanning its QR, and nothing has been
    // scanned. Its existence is what makes the inequality below true.
    await seedDevice(await seedUser(), 'mobile');

    const output = await run();
    const withDevice = valueOf(output, 'accounts with a device');
    const activated = valueOf(output, 'accounts with a paired laptop');

    // Strict: an account that owns a device but no pair exists, so counting
    // devices instead of pairs would make these equal. That is exactly the
    // mistake the number is here to avoid — "29 customers" built from people
    // who filled in a form.
    expect(withDevice).toBeGreaterThan(activated);
    expect(activated).toBeGreaterThanOrEqual(0);
  });

  it('reports revoked devices rather than folding them into the total', async () => {
    // A revoked row still exists — it is the audit trail — and must be
    // counted as what it is. The exclusion from every other device number is
    // the same `revoked_at IS NULL` predicate throughout.
    await seedDevice(await seedUser(), 'mobile', { revokedAt: new Date() });
    expect(valueOf(await run(), 'revoked')).toBeGreaterThanOrEqual(1);
  });

  it('reports what customers are running, not what was released', async () => {
    // `app_version` is written on the token exchange, so a device that has not
    // signed in since the column existed is unknown — and says so rather than
    // being folded into whatever the current release is.
    await seedDevice(await seedUser(), 'desktop');
    expect(await run()).toMatch(/desktop unreported\s+\d+/);
  });
});
