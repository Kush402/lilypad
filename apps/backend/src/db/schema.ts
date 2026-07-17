import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, uuid, text, timestamp, jsonb, inet, index } from 'drizzle-orm/pg-core';

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
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('devices_fingerprint_idx').on(t.fingerprint)],
);

// ── trusted_devices (M5) ─────────────────────────────────────────────────────
export const trustedDevices = pgTable('trusted_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  desktopDeviceId: uuid('desktop_device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  mobileDeviceId: uuid('mobile_device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
