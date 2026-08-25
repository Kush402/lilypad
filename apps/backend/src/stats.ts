import { and, count, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from './db/client.js';
import { auditLogs, devices, trustedDevices, users } from './db/schema.js';

/**
 * `pnpm stats` — how the product is actually doing, from the only source that
 * cannot flatter it.
 *
 * `/metrics` answers "is the server working": request counts, hub sessions,
 * error rates. Nobody could ask "how many people got all the way to a working
 * setup", or "did the update reach anyone", without SSHing to the VM and
 * writing the joins by hand — so nobody asked.
 *
 * The numbers here are chosen to be the ones a decision turns on:
 *
 * - **Activation**, not signups. An account with no devices is somebody who
 *   filled in a form; an account with a paired laptop and phone is somebody
 *   using the product. The gap between those two is the funnel.
 * - **Versions in the field**, because "we shipped it" and "customers have it"
 *   are different claims and only the second one matters.
 * - **Failed sign-ins**, because a rise there is the first sign of something
 *   broken that nobody has reported yet.
 *
 * A script and not an endpoint, for the same reason as `support.ts`: an API
 * that reads across every account needs an admin auth model this product does
 * not have, and getting that wrong is worse than typing a command.
 *
 * **Read-only.** Nothing here writes.
 */

/** Where a run's output goes. Bound by `report` so a test can read exactly
 * what a person would see. */
let emit: (line: string) => void = (l) => console.log(l);

function say(text = ''): void {
  emit(text);
}

function line(label: string, value: string | number): void {
  emit(`  ${label.padEnd(30)} ${value}`);
}

function since(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** `count()` returns one row; this is the value in it. */
function only(rows: { value: number }[]): number {
  return rows[0]?.value ?? 0;
}

export async function report(out: (l: string) => void = (l) => console.log(l)): Promise<void> {
  emit = out;

  // ── Accounts ───────────────────────────────────────────────────────────
  const accounts = only(await db.select({ value: count() }).from(users));
  const accounts7 = only(
    await db
      .select({ value: count() })
      .from(users)
      .where(gt(users.createdAt, since(7))),
  );
  const accounts1 = only(
    await db
      .select({ value: count() })
      .from(users)
      .where(gt(users.createdAt, since(1))),
  );

  say('\nACCOUNTS');
  line('total', accounts);
  line('new in the last 7 days', accounts7);
  line('new in the last 24 hours', accounts1);

  // ── Activation ─────────────────────────────────────────────────────────
  //
  // The three states an account can be in, and the only one that means the
  // product is being used. A phone alone can do nothing; a laptop cannot even
  // be added without a phone.
  const withAnyDevice = only(
    await db
      .select({ value: sql<number>`count(distinct ${devices.userId})`.mapWith(Number) })
      .from(devices)
      .where(isNull(devices.revokedAt)),
  );
  const withAPair = only(
    await db
      .select({ value: sql<number>`count(distinct ${devices.userId})`.mapWith(Number) })
      .from(trustedDevices)
      .innerJoin(devices, eq(devices.id, trustedDevices.desktopDeviceId))
      .where(isNull(trustedDevices.revokedAt)),
  );

  say('\nACTIVATION');
  line('accounts with no device', accounts - withAnyDevice);
  line('accounts with a device', withAnyDevice);
  line('accounts with a paired laptop', withAPair);
  if (accounts > 0) {
    // Stated as a fraction rather than a percentage: at these numbers a
    // percentage would imply a precision that three accounts do not have.
    line('activated', `${withAPair} of ${accounts}`);
  }

  // ── Devices ────────────────────────────────────────────────────────────
  const byKind = await db
    .select({ kind: devices.kind, value: count() })
    .from(devices)
    .where(isNull(devices.revokedAt))
    .groupBy(devices.kind);
  const revoked = only(
    await db.select({ value: count() }).from(devices).where(isNotNull(devices.revokedAt)),
  );
  const seen7 = only(
    await db
      .select({ value: count() })
      .from(devices)
      .where(and(isNull(devices.revokedAt), gt(devices.lastSeenAt, since(7)))),
  );
  const neverSeen = only(
    await db
      .select({ value: count() })
      .from(devices)
      .where(and(isNull(devices.revokedAt), isNull(devices.lastSeenAt))),
  );

  say('\nDEVICES');
  for (const row of byKind) line(row.kind, row.value);
  line('signed in within 7 days', seen7);
  line('never connected', neverSeen);
  line('revoked', revoked);

  // ── Versions in the field ──────────────────────────────────────────────
  //
  // Written on every token exchange, so this is what customers are RUNNING
  // rather than what was released. `null` is a device that has not signed in
  // since the column existed, reported as unknown rather than folded in.
  const versions = await db
    .select({ kind: devices.kind, version: devices.appVersion, value: count() })
    .from(devices)
    .where(isNull(devices.revokedAt))
    .groupBy(devices.kind, devices.appVersion)
    .orderBy(devices.kind, devices.appVersion);

  say('\nVERSIONS IN THE FIELD');
  if (versions.length === 0) say('  no devices yet.');
  for (const row of versions) {
    line(`${row.kind} ${row.version ?? 'unreported'}`, row.value);
  }

  // ── What has been happening ────────────────────────────────────────────
  //
  // The audit log is the only record of events; `sessions` is still never
  // written, so a session count would be a zero that means "not implemented"
  // rather than "none happened" — and is left out instead of printed.
  const events = await db
    .select({ eventType: auditLogs.eventType, value: count() })
    .from(auditLogs)
    .where(gt(auditLogs.createdAt, since(7)))
    .groupBy(auditLogs.eventType)
    .orderBy(auditLogs.eventType);

  say('\nLAST 7 DAYS');
  if (events.length === 0) say('  nothing recorded.');
  for (const row of events) line(row.eventType, row.value);
  say('');
  say('  session_start / session_end are screens actually being watched.');
  say('  sessions_revoked is access being withdrawn — a removed device, a');
  say('  severed pair, a deleted account. They were one event type until');
  say('  2026-08-25, which made 11 real sessions read as 59.');

  const failed = events.find((e) => e.eventType === 'login_failed')?.value ?? 0;
  if (failed > 0) {
    // Named rather than left in the list. A desktop polls `/devices/token`
    // between install and linking and every one of those writes a
    // `login_failed`, so this number is normally ordinary — which is exactly
    // why a rise in it needs to be looked at rather than skimmed past.
    say('');
    say(`  ${failed} failed sign-in(s). Many are a desktop polling before it has been`);
    say('  linked, which is normal. `pnpm support <email>` shows whose they were.');
  }

  say('');
}

// `pnpm stats` runs this file directly; importing it (the test) must not.
if (process.argv[1]?.endsWith('stats.ts') || process.argv[1]?.endsWith('stats.js')) {
  await report();
  process.exit(0);
}
