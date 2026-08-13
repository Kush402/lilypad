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
 * Full Lilypad schema. Short-lived, single-use credentials (pairing tokens,
 * magic-link tokens, device challenges) and signaling room state live in
 * Redis, NOT here — they expire by TTL and must never outlive a restart.
 * Anything that needs to be *revoked*, *listed*, or *audited* lives here.
 */

export const tierEnum = pgEnum('tier', ['free', 'pro', 'team']);
export const platformEnum = pgEnum('platform', ['macos', 'windows', 'linux', 'ios', 'android']);
export const deviceKindEnum = pgEnum('device_kind', ['desktop', 'mobile']);
export const sessionStatusEnum = pgEnum('session_status', ['pending', 'active', 'ended']);
/** Third-party identity providers ([ADR-0001](../../../../docs/adr/0001-account-authentication.md)).
 * Magic-link sign-in is deliberately NOT a value here: its identity *is*
 * `users.email`, so it needs no linking row. */
export const authProviderEnum = pgEnum('auth_provider', ['apple', 'google']);

// ── users (M8) ───────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  /** Deliberately unused — ADR-0001 chose OAuth + magic link, no passwords.
   * Kept nullable so the column's existence is never mistaken for a plan. */
  passwordHash: text('password_hash'),
  tier: tierEnum('tier').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── oauth_identities (M8) ────────────────────────────────────────────────────
/**
 * One row = one provider identity linked to one account. Separate from `users`
 * because a single account may sign in with Apple *and* Google (same verified
 * email), and because the provider's subject — not the email — is the stable
 * key: Apple's Hide My Email can change the address a provider reports, but
 * `sub` never changes for the same (provider, app, user).
 */
export const oauthIdentities = pgTable(
  'oauth_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProviderEnum('provider').notNull(),
    /** The provider's `sub` claim. Opaque; never displayed. */
    subject: text('subject').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The join key for every sign-in. UNIQUE is the security control, not an
    // optimisation: without it a race could link one provider identity to two
    // accounts, and the sign-in lookup would pick arbitrarily between them.
    uniqueIndex('oauth_identities_provider_subject_idx').on(t.provider, t.subject),
    index('oauth_identities_user_idx').on(t.userId),
  ],
);

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
    /** Base64url raw Ed25519 public key (32 bytes), written at enrollment once
     * the device proves possession of the private half
     * ([ADR-0002](../../../../docs/adr/0002-device-identity.md)). NULL for
     * dev-mode rows that predate keys — `fingerprint` deliberately keeps its
     * self-asserted meaning so no existing data needs a lossy
     * reinterpretation. An enrolled device is exactly one with a non-NULL
     * `publicKey` AND a non-NULL `userId`. */
    publicKey: text('public_key'),
    /** Per-device revocation — "I lost my laptop". Set here rather than by
     * deleting the row so trust history and audit references survive, and so
     * the device token gate (which checks this) fails closed rather than
     * treating an unknown device as a new one. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('devices_fingerprint_idx').on(t.fingerprint),
    // `upsertDevice` is select-then-insert, so two concurrent first-contacts
    // for one device could create two rows and split its trust across them
    // (PROJECT-INDEX SEC-7). The constraint is what actually prevents that;
    // the application-side conflict handling is only the friendly path.
    uniqueIndex('devices_kind_fingerprint_idx').on(t.kind, t.fingerprint),
    // A public key must name exactly one device, or it cannot be an identity.
    // Postgres treats NULLs as distinct, so unenrolled rows are unaffected.
    uniqueIndex('devices_public_key_idx').on(t.publicKey),
  ],
);

// ── refresh_tokens (M8) ──────────────────────────────────────────────────────
/**
 * Rotating opaque refresh tokens for ACCOUNT sessions
 * ([ADR-0001](../../../../docs/adr/0001-account-authentication.md)).
 *
 * Deliberately not per-device. An enrolled device renews by signing a fresh
 * challenge with its Ed25519 key ([ADR-0002](../../../../docs/adr/0002-device-identity.md)),
 * so issuing it a refresh token as well would add a second, weaker, copyable
 * credential for a job a non-exportable hardware-backed key already does.
 * These rows therefore belong to browser sessions and to the window between
 * sign-in and enrollment.
 *
 * In Postgres rather than Redis precisely because they must be *revocable* and
 * *enumerable*: "sign out everywhere" is a query, and a Redis flush must not
 * silently un-revoke a stolen token.
 *
 * Only the SHA-256 of the token is stored. The token is 32 bytes of CSPRNG
 * output, so a plain hash is correct — there is no low-entropy input to
 * stretch, and the same reasoning as the per-pair connect secret applies
 * (`services/trust.ts`).
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set on rotation (superseded) or explicit sign-out. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** The token that replaced this one on rotation. Presenting an already
     * rotated token means it leaked *or* was replayed, so the whole chain is
     * revoked — this column is what makes that detectable. */
    replacedById: uuid('replaced_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId)],
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
    /** SHA-256 of the per-pair connect secret (M5.4 security). The plaintext
     * is issued to the phone over the mobile seat at trust time and never
     * stored server-side. `/connect/request` must present a secret hashing to
     * this value. NULL = a pair created before secrets existed; `0005` revoked
     * the ones that existed and `authorizeConnect` refuses any that appear
     * (SEC-5). The column stays nullable because a secret cannot be
     * backfilled — it is only ever known to the phone it was issued to. */
    connectSecretHash: text('connect_secret_hash'),
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
