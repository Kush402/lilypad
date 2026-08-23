import { describe, it, expect, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, users } from '../db/schema.js';
import { createDrizzleDeviceIdentityStore } from './deviceRegistry.js';

/**
 * What build is this customer running?
 *
 * Until 2026-08-22 that question had no answer at all: no client sent a
 * version, and every iOS build called itself `1.0` because `pnpm release`
 * never touched the mobile app. `devices.app_version` is written on the token
 * exchange every client makes on launch and every ten minutes after, so it
 * stays current without a heartbeat.
 *
 * Against the real database, because the behaviour under test is a partial
 * UPDATE: the interesting case is the column a write must NOT touch, and a
 * hand-written fake would only be a restatement of the code.
 */

const store = createDrizzleDeviceIdentityStore(db);

/** One prefix for everything this file creates, so the sweep below can find
 * it all without knowing which ids were handed out. The first version cleaned
 * up per-test in a `finally`, which leaks whenever the seed itself throws —
 * and it did, on the run before the migration had been applied, leaving four
 * orphan users behind in the dev database. */
const PREFIX = `app-version-${Date.now()}-`;

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

async function seedDevice(): Promise<{ deviceId: string; userId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `${PREFIX}${crypto.randomUUID()}@example.test` })
    .returning({ id: users.id });
  const [device] = await db
    .insert(devices)
    .values({
      userId: user!.id,
      kind: 'mobile',
      fingerprint: `mobile-${crypto.randomUUID()}`,
      publicKey: crypto.randomUUID(),
    })
    .returning({ id: devices.id });
  return { deviceId: device!.id, userId: user!.id };
}

async function read(deviceId: string) {
  const rows = await db
    .select({ appVersion: devices.appVersion, lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return rows[0]!;
}

describe('devices.app_version', () => {
  it('records what the client said it was running', async () => {
    const { deviceId } = await seedDevice();
    await store.touchLastSeen(deviceId, '0.1.5');
    const row = await read(deviceId);
    expect(row.appVersion).toBe('0.1.5');
    expect(row.lastSeenAt).not.toBeNull();
  });

  it('moves forward when the device updates', async () => {
    const { deviceId } = await seedDevice();
    await store.touchLastSeen(deviceId, '0.1.4');
    await store.touchLastSeen(deviceId, '0.1.5');
    expect((await read(deviceId)).appVersion).toBe('0.1.5');
  });

  it('does NOT forget a known version when a client sends none', async () => {
    const { deviceId } = await seedDevice();
    await store.touchLastSeen(deviceId, '0.1.5');
    // Every build already installed sends nothing. If those writes cleared
    // the column, the field would go blank the moment it mattered most —
    // and the older the build, the more certainly it would be blank.
    await store.touchLastSeen(deviceId);
    await store.touchLastSeen(deviceId, null);
    expect((await read(deviceId)).appVersion).toBe('0.1.5');
  });

  it('leaves it null for a device that has not reported one', async () => {
    const { deviceId } = await seedDevice();
    await store.touchLastSeen(deviceId);
    // Truthfully unknown, not a guessed default. A listing that showed
    // "0.1.4" here would be inventing the one fact it exists to report.
    expect((await read(deviceId)).appVersion).toBeNull();
  });
});
