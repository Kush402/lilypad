import { describe, it, expect, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { db } from './db/client.js';
import { devices, trustedDevices, users } from './db/schema.js';
import { report } from './support.js';

/**
 * The support lookup, against the real database.
 *
 * What is worth testing is not the SQL but the two things a hand-written join
 * gets wrong: **which side of a pair is which**, and **which of the two device
 * ids is which**. Confusing those is not hypothetical here — it is the bug
 * that made linking hand the phone an id that rang nothing, and this is the
 * tool someone reaches for at the moment they are least inclined to check.
 *
 * A fake would prove nothing: the join is the thing under test.
 */

const PREFIX = `support-${Date.now()}-`;

afterAll(async () => {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `${PREFIX}%`));
  for (const row of rows) {
    await db.delete(devices).where(eq(devices.userId, row.id));
    await db.delete(users).where(eq(users.id, row.id));
  }
});

async function seedAccount(): Promise<{ email: string; userId: string }> {
  const email = `${PREFIX}${crypto.randomUUID()}@example.test`;
  const [user] = await db.insert(users).values({ email }).returning({ id: users.id });
  return { email, userId: user!.id };
}

async function seedDevice(
  userId: string,
  kind: 'desktop' | 'mobile',
  name: string,
  extra: { appVersion?: string; lastSeenAt?: Date } = {},
): Promise<{ id: string; fingerprint: string }> {
  const fingerprint = `${kind}-${crypto.randomUUID()}`;
  const [row] = await db
    .insert(devices)
    .values({
      userId,
      kind,
      name,
      platform: kind === 'desktop' ? 'macos' : 'ios',
      fingerprint,
      publicKey: crypto.randomUUID(),
      ...extra,
    })
    .returning({ id: devices.id });
  return { id: row!.id, fingerprint };
}

/** Run the report and hand back what a person would read. */
async function run(email: string): Promise<string> {
  const lines: string[] = [];
  await report(email, (l) => lines.push(l));
  return lines.join('\n');
}

describe('pnpm support <email>', () => {
  it('says plainly when there is no such account', async () => {
    const out = await run(`${PREFIX}absent@example.test`);
    // "No account" and "an account with nothing on it" need completely
    // different next questions, so they must not read the same.
    expect(out).toContain('No account');
    expect(out).toContain('typo at signup');
  });

  it('reports a pair in the direction it actually runs: phone → laptop', async () => {
    const { email, userId } = await seedAccount();
    const laptop = await seedDevice(userId, 'desktop', 'Ben’s MacBook');
    const phone = await seedDevice(userId, 'mobile', 'Ben’s iPhone');
    await db.insert(trustedDevices).values({
      desktopDeviceId: laptop.id,
      mobileDeviceId: phone.id,
      pairSecret: 'x'.repeat(32),
    });

    const out = await run(email);

    // Swapping the two aliases in the join would still produce a plausible
    // line; this is what catches it.
    expect(out).toContain('Ben’s iPhone → Ben’s MacBook');
    expect(out).not.toContain('Ben’s MacBook → Ben’s iPhone');
  });

  it('prints both device ids, labelled, because they are different things', async () => {
    const { email, userId } = await seedAccount();
    const laptop = await seedDevice(userId, 'desktop', 'Ben’s MacBook');

    const out = await run(email);

    // The wire id is what /connect/request resolves; devices.id is what the
    // account-scoped routes take. Printing one under the other's name is how
    // a support session goes wrong.
    expect(out).toContain(`wire id          ${laptop.fingerprint}`);
    expect(out).toContain(`devices.id       ${laptop.id}`);
  });

  it('distinguishes "no devices" from "devices but no pair"', async () => {
    const bare = await seedAccount();
    expect(await run(bare.email)).toContain('nothing has been added to it');

    const partial = await seedAccount();
    await seedDevice(partial.userId, 'mobile', 'a phone');
    const out = await run(partial.email);
    expect(out).toContain('no phone can reach any laptop');
  });

  it('reports an unreported version as unknown rather than guessing', async () => {
    const { email, userId } = await seedAccount();
    await seedDevice(userId, 'mobile', 'old phone');
    await seedDevice(userId, 'desktop', 'new mac', { appVersion: '0.1.5' });

    const out = await run(email);

    expect(out).toContain('unreported');
    expect(out).toContain('0.1.5');
  });

  it('counts recently-seen devices, and says the number is a proxy', async () => {
    const { email, userId } = await seedAccount();
    await seedDevice(userId, 'desktop', 'awake', { lastSeenAt: new Date() });
    await seedDevice(userId, 'mobile', 'asleep', {
      lastSeenAt: new Date(Date.now() - 3 * 60 * 60_000),
    });

    const out = await run(email);

    // Presence lives in the hub's memory and is never persisted, so the honest
    // thing is to say what this number is rather than let it be read as
    // "online now".
    expect(out).toContain('1 of 2 device(s) signed in within 15m');
    expect(out).toContain('not live presence');
  });
});
