import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  jsonb,
  inet,
  index,
  uniqueIndex,
  boolean,
} from 'drizzle-orm/pg-core';

/**
 * Full Lilypad schema. Tables are defined now; most columns are populated
 * across later milestones (auth = M5). Pairing tokens + signaling room state
 * live in Redis, NOT here.
 */

export const tierEnum = pgEnum('tier', ['free', 'pro', 'team']);
export const platformEnum = pgEnum('platform', ['macos', 'windows', 'linux', 'ios', 'android']);
export const deviceKindEnum = pgEnum('device_kind', ['desktop', 'mobile']);
export const sessionStatusEnum = pgEnum('session_status', ['pending', 'active', 'ended']);

// ── users (M5) ───────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  tier: tierEnum('tier').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── devices ──────────────────────────────────────────────────────────────────
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'),
    platform: platformEnum('platform'),
    kind: deviceKindEnum('kind').notNull(),
    /** Stable client-generated id (dev mode) / device fingerprint. */
    fingerprint: text('fingerprint').notNull(),
    /** Base64 Ed25519 public key, set once verified via challenge-response
     * (`docs/m5-auth-design.md`). NULL for dev-mode rows that predate keys —
     * `fingerprint` deliberately keeps its self-asserted meaning so no
     * existing data needs a lossy reinterpretation. */
    publicKey: text('public_key'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('devices_fingerprint_idx').on(t.fingerprint)],
);

// ── trusted_devices (M5.4 pair-trust; M5 adds the user linkage) ──────────────
/**
 * One row = one persistent desktop↔mobile trust relationship, created at the
 * QR-approve moment when the user opts to trust the device, consumed by the
 * no-QR reconnect flow (`/connect/request`), severed by Forget/Revoke.
 *
 * Deliberately evolved IN PLACE rather than via a parallel `device_pairs`
 * table (docs/m5.4-trusted-devices-audit.md §6, revised): `userId` is
 * nullable so pre-account pairs exist with NULL user, and M5's account
 * milestone attaches users with a plain backfill UPDATE — never a
 * table-to-table data migration.
 */
export const trustedDevices = pgTable(
  'trusted_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** NULL until accounts (M5) — then backfilled, never restructured. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    desktopDeviceId: uuid('desktop_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    mobileDeviceId: uuid('mobile_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    /** What each side calls the pair (e.g. "Kush's iPhone" on the desktop
     * list, "MacBook Pro" on the phone list). */
    displayName: text('display_name'),
    /** Desktop-side "Always allow": skip the ring and auto-start the session.
     * Explicit per-pair opt-in; the live session indicator + audit log still
     * apply (threat-model "no silent access" holds). */
    autoApprove: boolean('auto_approve').notNull().default(false),
    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    /** Set by Forget (phone) / Revoke (desktop). A revoked pair fails the
     * connect gate closed; rows are kept (not deleted) for the audit trail. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('trusted_devices_pair_idx').on(t.desktopDeviceId, t.mobileDeviceId)],
);

// ── sessions ─────────────────────────────────────────────────────────────────
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    desktopDeviceId: uuid('desktop_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    mobileDeviceId: uuid('mobile_device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** Granted scopes, e.g. ['view','control']. */
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`ARRAY['view']::text[]`),
    status: sessionStatusEnum('status').notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_status_idx').on(t.status)],
);

// ── audit_logs ───────────────────────────────────────────────────────────────
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** login, login_failed, device_paired, session_start, session_end,
     *  pair_denied, panic_disconnect, ... (open-ended). */
    eventType: text('event_type').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    ip: inet('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_event_type_idx').on(t.eventType)],
);
