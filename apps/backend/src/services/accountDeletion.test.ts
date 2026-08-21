import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { confirmsDeletion } from './accountDeletion.js';
import {
  auditLogs,
  devices,
  oauthIdentities,
  refreshTokens,
  sessions,
  trustedDevices,
  users,
} from '../db/schema.js';

/**
 * Account deletion rests almost entirely on the schema, so that is what this
 * asserts. `purgeAccount` is four lines because the cascade does the work; the
 * risk is therefore not in the four lines, it is that somebody later changes an
 * `onDelete` and turns a delete into a set of orphans nobody notices for a year.
 *
 * These read the real Drizzle table definitions — the same objects the
 * migrations were generated from — rather than restating what the schema
 * "should" say. A test that hardcoded the expected behaviour separately from
 * the schema would agree with itself forever.
 */

/** The `onDelete` action Postgres will take on a column's foreign key. */
function onDeleteFor(table: Parameters<typeof getTableConfig>[0], column: string): string {
  const config = getTableConfig(table);
  const inline = config.foreignKeys.find((fk) =>
    fk.reference().columns.some((c) => c.name === column),
  );
  if (!inline) throw new Error(`no foreign key on ${config.name}.${column}`);
  return inline.onDelete ?? 'no action';
}

/** Which table a column's foreign key points AT. */
function referencesTable(table: Parameters<typeof getTableConfig>[0], column: string): string {
  const config = getTableConfig(table);
  const fk = config.foreignKeys.find((k) => k.reference().columns.some((c) => c.name === column));
  if (!fk) throw new Error(`no foreign key on ${config.name}.${column}`);
  return getTableConfig(fk.reference().foreignTable).name;
}

describe('confirmsDeletion', () => {
  it('accepts the account address', () => {
    expect(confirmsDeletion('kush@example.com', 'kush@example.com')).toBe(true);
  });

  it('ignores case and surrounding space', () => {
    // `users.email` is stored lowercase and phone keyboards capitalise. An
    // account that cannot be deleted because of autocapitalisation is a
    // support ticket, not a safety feature.
    expect(confirmsDeletion('  Kush@Example.com ', 'kush@example.com')).toBe(true);
  });

  it('refuses a different address', () => {
    expect(confirmsDeletion('someone@else.com', 'kush@example.com')).toBe(false);
  });

  it('refuses an empty confirmation', () => {
    expect(confirmsDeletion('', 'kush@example.com')).toBe(false);
  });

  it('refuses a partial match', () => {
    // Substring matching here would make "k" delete the account.
    expect(confirmsDeletion('kush', 'kush@example.com')).toBe(false);
  });
});

describe('what deleting a user actually removes', () => {
  it('takes the devices with it', () => {
    expect(referencesTable(devices, 'user_id')).toBe('users');
    expect(onDeleteFor(devices, 'user_id')).toBe('cascade');
  });

  it('takes the pairs with it, through both sides of the pair', () => {
    // The pair rows are what let a phone reach a laptop. They cascade from
    // `devices`, not from `users` — `trusted_devices.user_id` is always NULL
    // (see its comment in the schema), so the device columns are the ONLY
    // thing that removes them. If either stopped cascading, a deleted
    // account's pairs would outlive both of its devices.
    expect(referencesTable(trustedDevices, 'desktop_device_id')).toBe('devices');
    expect(onDeleteFor(trustedDevices, 'desktop_device_id')).toBe('cascade');
    expect(referencesTable(trustedDevices, 'mobile_device_id')).toBe('devices');
    expect(onDeleteFor(trustedDevices, 'mobile_device_id')).toBe('cascade');
  });

  it('takes every account session with it', () => {
    // This is what makes deletion apply to the user other machines, not just
    // the one that asked. A surviving refresh token would mint fresh access
    // tokens for an account that no longer exists.
    expect(referencesTable(refreshTokens, 'user_id')).toBe('users');
    expect(onDeleteFor(refreshTokens, 'user_id')).toBe('cascade');
  });

  it('takes the Apple/Google links with it', () => {
    // Left behind, the next Apple sign-in would resolve `(provider, subject)`
    // to a `user_id` with no user — the lookup that runs before any other.
    expect(referencesTable(oauthIdentities, 'user_id')).toBe('users');
    expect(onDeleteFor(oauthIdentities, 'user_id')).toBe('cascade');
  });
});

describe('what deleting a user deliberately does NOT remove', () => {
  it('anonymises audit logs instead of deleting them', () => {
    // The rows survive the account, without the account. They then expire on
    // the ordinary 2-day retention clock (`services/auditRetention.ts`) — so
    // deleting an account neither erases the record of what it did nor keeps
    // it any longer than anyone else's.
    expect(onDeleteFor(auditLogs, 'user_id')).toBe('set null');
    expect(onDeleteFor(auditLogs, 'device_id')).toBe('set null');
  });

  it('anonymises session history instead of deleting it', () => {
    expect(onDeleteFor(sessions, 'user_id')).toBe('set null');
    expect(onDeleteFor(sessions, 'desktop_device_id')).toBe('set null');
    expect(onDeleteFor(sessions, 'mobile_device_id')).toBe('set null');
  });

  it('leaves nothing else pointing at a user', () => {
    // The orphan check: every foreign key that targets `users` anywhere in the
    // schema must be covered by one of the cases above. A new table added
    // later with a plain reference — no `onDelete` — would fail here rather
    // than silently blocking every future deletion with a constraint error.
    const tables = [
      oauthIdentities,
      devices,
      refreshTokens,
      trustedDevices,
      sessions,
      auditLogs,
      users,
    ];
    const usersName = getTableConfig(users).name;
    const referrers = tables.flatMap((table) => {
      const config = getTableConfig(table);
      return config.foreignKeys
        .filter((fk) => getTableConfig(fk.reference().foreignTable).name === usersName)
        .map((fk) => ({
          table: config.name,
          column: fk
            .reference()
            .columns.map((c) => c.name)
            .join(','),
          onDelete: fk.onDelete ?? 'no action',
        }));
    });

    expect(referrers.length).toBeGreaterThan(0);
    for (const ref of referrers) {
      expect(['cascade', 'set null']).toContain(ref.onDelete);
    }
  });
});
