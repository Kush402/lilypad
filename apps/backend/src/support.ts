import { aliasedTable, desc, eq, or } from 'drizzle-orm';
import { db } from './db/client.js';
import { auditLogs, devices, trustedDevices, users } from './db/schema.js';

/**
 * `pnpm support <email>` — everything known about one customer, in one place.
 *
 * The question this exists to answer is the one every support conversation
 * opens with: *a customer says it is broken — what does their account actually
 * look like?* Until now the only way to find out was SSH to the VM and write
 * the joins by hand, which means remembering the two device-id namespaces and
 * getting them the right way round at the moment you are least inclined to be
 * careful.
 *
 * Deliberately a script and not an admin API. An endpoint that reads any
 * user's devices needs an admin auth model this product does not have, and
 * getting that wrong is a worse outcome than typing a command. When there are
 * enough customers that this does not scale, the answer is an authenticated
 * admin surface — not a wider version of this.
 *
 * **Read-only.** It runs SELECTs and prints. Nothing here writes.
 */

/** Both id namespaces, kept apart on purpose. `devices.id` is the internal
 * uuid every account-scoped route takes; `devices.fingerprint` is the wire id
 * the phone stores and `/connect/request` resolves. Confusing them is the bug
 * that made linking hand the phone an id that rang nothing, so the output
 * labels which is which every time it prints one. */
const SHORT = (id: string) => `${id.slice(0, 8)}…`;

function ago(at: Date | null): string {
  if (!at) return 'never';
  const mins = Math.round((Date.now() - at.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** How recently a device must have exchanged a token for us to say the app is
 * probably running. The clients re-authenticate on launch and roughly every
 * nine minutes, so fifteen covers a renewal that has not come round yet
 * without calling a laptop shut two hours ago "online". */
const PROBABLY_RUNNING_MINUTES = 15;

/** Where a run's output goes. Bound by `report`, so a test can read exactly
 * what a person would see rather than asserting on the queries. */
let emit: (line: string) => void = (l) => console.log(l);

function say(text = ''): void {
  emit(text);
}

function line(label: string, value: string): void {
  emit(`  ${label.padEnd(16)} ${value}`);
}

/**
 * Print everything known about one account.
 *
 * `out` exists so the integration test can read the report the way a person
 * reads it. The thing worth testing here is not the SQL, it is that the two
 * device-id namespaces and the two sides of a pair come out the right way
 * round — the confusion that has already produced one shipped bug.
 */
export async function report(
  query: string,
  out: (line: string) => void = (l) => console.log(l),
): Promise<void> {
  emit = out;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, query.trim().toLowerCase()))
    .limit(1);

  if (!user) {
    // Said plainly rather than as an empty result: "no such account" and "an
    // account with no devices" need completely different next questions.
    say(`No account for ${query}.`);
    say('Check the spelling with them — a typo at signup is a real and common cause.');
    return;
  }

  say(`\nACCOUNT  ${user.email}`);
  line('id', user.id);
  line('name', user.name ?? '—');
  line('created', `${user.createdAt.toISOString()} (${ago(user.createdAt)})`);
  line('sign-in', user.passwordHash ? 'email + password' : 'OAuth / magic link only');

  const owned = await db
    .select()
    .from(devices)
    .where(eq(devices.userId, user.id))
    .orderBy(desc(devices.createdAt));

  say(`\nDEVICES  ${owned.length}`);
  if (owned.length === 0) {
    say('  none — the account exists but nothing has been added to it.');
    say('  A phone is added by signing in on it; a laptop by that phone scanning its QR.');
  }
  for (const d of owned) {
    const state = d.revokedAt ? `REVOKED ${ago(d.revokedAt)}` : d.publicKey ? 'linked' : 'no key';
    say(`\n  ${d.kind === 'desktop' ? '💻' : '📱'} ${d.name ?? `unnamed ${d.kind}`}`);
    line('state', state);
    line('platform', d.platform ?? '—');
    line('app version', d.appVersion ?? 'unreported (has not signed in since the column existed)');
    line('last seen', ago(d.lastSeenAt));
    line('wire id', d.fingerprint);
    line('devices.id', d.id);
  }

  // Presence is held in the signaling hub's memory and never persisted, so
  // "is this laptop reachable right now" cannot be answered from here. What
  // CAN be answered is when it last proved itself, which is close enough to
  // be useful and is stated as the approximation it is.
  const live = owned.filter(
    (d) =>
      !d.revokedAt &&
      d.lastSeenAt !== null &&
      Date.now() - d.lastSeenAt.getTime() < PROBABLY_RUNNING_MINUTES * 60_000,
  );
  say(
    `\n  ${live.length} of ${owned.length} device(s) signed in within ${PROBABLY_RUNNING_MINUTES}m` +
      ` — a proxy for "the app is running", not live presence, which is not stored.`,
  );

  const desktop = aliasedTable(devices, 'desktop');
  const mobile = aliasedTable(devices, 'mobile');
  const pairs = await db
    .select({
      id: trustedDevices.id,
      desktopName: desktop.name,
      desktopFingerprint: desktop.fingerprint,
      mobileName: mobile.name,
      mobileFingerprint: mobile.fingerprint,
      autoApprove: trustedDevices.autoApprove,
      revokedAt: trustedDevices.revokedAt,
      lastConnectedAt: trustedDevices.lastConnectedAt,
      createdAt: trustedDevices.createdAt,
    })
    .from(trustedDevices)
    .innerJoin(desktop, eq(trustedDevices.desktopDeviceId, desktop.id))
    .innerJoin(mobile, eq(trustedDevices.mobileDeviceId, mobile.id))
    .where(or(eq(desktop.userId, user.id), eq(mobile.userId, user.id)))
    .orderBy(desc(trustedDevices.createdAt));

  say(`\nPAIRS    ${pairs.length}`);
  if (pairs.length === 0 && owned.length > 0) {
    say('  none — the devices are on the account but no phone can reach any laptop.');
    say('  That is the state after linking if pairing never completed.');
  }
  for (const p of pairs) {
    const tag = p.revokedAt ? `REVOKED ${ago(p.revokedAt)}` : 'active';
    say(`\n  ${p.mobileName ?? 'phone'} → ${p.desktopName ?? 'laptop'}   [${tag}]`);
    line('connected', ago(p.lastConnectedAt));
    line('auto-approve', p.autoApprove ? 'yes' : 'no (asks on the Mac each time)');
    line('paired', `${ago(p.createdAt)}`);
    line('wire ids', `${SHORT(p.mobileFingerprint)} → ${SHORT(p.desktopFingerprint)}`);
  }

  const events = await db
    .select({
      at: auditLogs.createdAt,
      type: auditLogs.eventType,
      ip: auditLogs.ip,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .where(eq(auditLogs.userId, user.id))
    .orderBy(desc(auditLogs.createdAt))
    .limit(15);

  say(`\nRECENT   ${events.length} event(s)`);
  if (events.length === 0) {
    say('  nothing — either brand new, or past the audit retention window.');
  }
  for (const e of events) {
    const meta = JSON.stringify(e.metadata);
    say(
      `  ${e.at.toISOString()}  ${e.type.padEnd(14)} ${e.ip ?? '—'}` +
        `${meta === '{}' ? '' : `  ${meta}`}`,
    );
  }
  say();
}

/** CLI entry. Kept separate from `report` so importing this module for a test
 * does not run a query or call `process.exit`. */
if (process.argv[1]?.endsWith('support.ts') || process.argv[1]?.endsWith('support.js')) {
  const email = process.argv[2];
  if (!email) {
    console.error('usage: pnpm support <email>');
    process.exit(2);
  }
  report(email)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
