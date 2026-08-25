import { describe, it, expect, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, users } from '../db/schema.js';
import { createDrizzleDeviceIdentityStore, isPlaceholderName } from './deviceRegistry.js';

/**
 * A device's name heals itself, and a person's choice survives.
 *
 * Every Mac used to enroll under the literal `"macos desktop"` and every phone
 * under `"ios phone"`, so an account with several listed rows that were
 * word-for-word identical — a screenshot on 2026-08-24 showed five rows with
 * two names between them. Both clients now send what the machine is really
 * called on the token exchange they already make every ten minutes, so the
 * existing rows fix themselves without anyone re-pairing anything.
 *
 * The rule that makes that safe is the one under test: the client's name is
 * applied ONLY over a placeholder. "Your devices" has a Rename button, and a
 * name a person typed being silently reverted by the machine minutes later
 * would be a worse bug than the one this fixes.
 *
 * Against the real database, for the same reason as `appVersion.test.ts`: the
 * behaviour is a conditional partial UPDATE, and the interesting case is the
 * value a write must NOT touch. A hand-written fake would only restate the
 * code — and here it would restate it in a different language, since the
 * condition lives in SQL.
 */

const store = createDrizzleDeviceIdentityStore(db);

const PREFIX = `device-name-${Date.now()}-`;

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

async function seedDevice(name: string | null): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${PREFIX}${crypto.randomUUID()}@example.test` })
    .returning({ id: users.id });
  const [device] = await db
    .insert(devices)
    .values({
      userId: user!.id,
      kind: 'desktop',
      name,
      fingerprint: `desktop-${crypto.randomUUID()}`,
      publicKey: crypto.randomUUID(),
    })
    .returning({ id: devices.id });
  return device!.id;
}

async function nameOf(deviceId: string): Promise<string | null> {
  const rows = await db
    .select({ name: devices.name })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return rows[0]!.name;
}

describe('devices.name on the token exchange', () => {
  it('replaces the placeholder every desktop used to enroll under', async () => {
    const deviceId = await seedDevice('macos desktop');
    await store.touchLastSeen(deviceId, '0.1.11', 'Kush’s MacBook Pro');
    expect(await nameOf(deviceId)).toBe('Kush’s MacBook Pro');
  });

  it('replaces the phone placeholder too', async () => {
    const deviceId = await seedDevice('ios phone');
    await store.touchLastSeen(deviceId, '0.1.11', 'iPhone');
    expect(await nameOf(deviceId)).toBe('iPhone');
  });

  it('fills a name in where a device had none', async () => {
    const deviceId = await seedDevice(null);
    await store.touchLastSeen(deviceId, null, 'Studio Mac');
    expect(await nameOf(deviceId)).toBe('Studio Mac');
  });

  it('NEVER overwrites a name the user chose', async () => {
    // The whole safety of doing this automatically. "Your devices" offers a
    // Rename, and a rename that the machine reverts within ten minutes is a
    // worse defect than identical rows.
    const deviceId = await seedDevice('Work laptop');
    await store.touchLastSeen(deviceId, '0.1.11', 'Kush’s MacBook Pro');
    expect(await nameOf(deviceId)).toBe('Work laptop');
  });

  it('does not clear a name when a client sends none', async () => {
    // Every build already installed sends nothing at all.
    const deviceId = await seedDevice('Work laptop');
    await store.touchLastSeen(deviceId, '0.1.11');
    await store.touchLastSeen(deviceId, '0.1.11', null);
    expect(await nameOf(deviceId)).toBe('Work laptop');
  });

  it('matches the placeholder however it was cased or padded', async () => {
    const deviceId = await seedDevice('  MacOS Desktop ');
    await store.touchLastSeen(deviceId, '0.1.11', 'Kush’s MacBook Pro');
    expect(await nameOf(deviceId)).toBe('Kush’s MacBook Pro');
  });
});

/** The same rule, stated where it can be read without a database. The SQL is
 * built from the same list, so this pins the membership rather than a second
 * implementation of it. */
describe('isPlaceholderName', () => {
  it('recognises every name the old clients could produce', () => {
    for (const name of [
      'macos desktop',
      'windows desktop',
      'linux desktop',
      'ios phone',
      'android phone',
    ]) {
      expect(isPlaceholderName(name), name).toBe(true);
    }
  });

  it('treats an absent name as one', () => {
    expect(isPlaceholderName(null)).toBe(true);
  });

  it('leaves anything a person might have typed alone', () => {
    for (const name of ['Work laptop', 'macos desktop 2', 'iPhone', 'Kush’s MacBook Pro']) {
      expect(isPlaceholderName(name), name).toBe(false);
    }
  });
});
