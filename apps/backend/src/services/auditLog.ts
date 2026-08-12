import { db as defaultDb } from '../db/client.js';
import { auditLogs } from '../db/schema.js';

/**
 * Audit event types this service actually writes today. This is a
 * deliberate SUBSET of the full list `docs/threat-model.md`'s "Repudiation"
 * row promises: "Audit logs: login, login_failed, device_paired,
 * session_start/stop, pair_denied, panic_disconnect (with ip + metadata)."
 *
 *  - `login` / `login_failed` ship in M8 with the auth routes that finally
 *    produce a login attempt to record (`routes/auth.ts`). `login_failed`
 *    deliberately carries the REAL reason in `metadata` even though the HTTP
 *    response flattens every failure to `invalid_token` — the distinction an
 *    operator needs for incident response is exactly the one a caller must
 *    not be handed.
 *  - `panic_disconnect` is NOT its own event type. Both the desktop's tray
 *    "Panic disconnect" and its ordinary "Disconnect" command resolve to the
 *    exact same `Control::Disconnect` value with no distinguishing payload
 *    (apps/desktop/src-tauri/src/commands.rs:254-269), which the session
 *    runner turns into an IDENTICAL `disconnect` wire message hardcoding
 *    `reason: "desktop disconnected"` regardless of which button was pressed
 *    (apps/desktop/src-tauri/src/session/mod.rs's `Control::Disconnect` arm;
 *    `Envelope::disconnect` in apps/desktop/src-tauri/src/signaling/messages.rs).
 *    The backend has no field to key off — a distinct `panic_disconnect` row
 *    would be fabricated. Every disconnect (panic or ordinary) is still
 *    captured generically by `session_end` below, whose `metadata.reason`
 *    carries whatever string the room actually ended with.
 */
export type AuditEventType =
  'login' | 'login_failed' | 'device_paired' | 'session_start' | 'session_end' | 'pair_denied';

export interface AuditLogFields {
  /** The authenticated `users.id`. Written by the auth routes since M8;
   * still null for events on paths that have not been moved behind
   * `requireAuth` yet. */
  userId?: string | null;
  /**
   * A `devices.id` (Postgres) UUID foreign key. Always `null` today: the
   * `devices` table is defined in the schema but nothing in the backend
   * inserts rows into it yet — pairing/signaling only ever carry
   * client-generated fingerprint-style strings (e.g. `"desktop-01"`), never
   * a real `devices.id`. Writing that string here would violate the
   * column's FK/UUID type. Those identifiers are carried in `metadata`
   * instead so nothing is silently dropped.
   */
  deviceId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

interface AuditLogRow {
  eventType: string;
  userId: string | null;
  deviceId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
}

/** Minimal DB surface this service needs — satisfied by the real Drizzle
 * client and by an in-memory fake in tests, mirroring the injectable-store
 * pattern already used by `KvStore` (session/manager.ts) and `RoomKvStore`
 * (session/roomStore.ts). */
export interface AuditLogStore {
  insert(row: AuditLogRow): Promise<void>;
}

/** Adapts the real Drizzle client to `AuditLogStore`. */
export function createDrizzleAuditLogStore(
  database: Pick<typeof defaultDb, 'insert'> = defaultDb,
): AuditLogStore {
  return {
    async insert(row) {
      await database.insert(auditLogs).values(row);
    },
  };
}

/**
 * Real-row audit trail for the "Repudiation" threat-model mitigation
 * (docs/threat-model.md). See `AuditEventType`'s doc comment for exactly
 * which promised events this implements today and which are an honest scope
 * boundary.
 *
 * Writes are NOT swallowed here — a rejected `insert` rejects the returned
 * promise, same as `SessionManager`/`RoomStore`. It is every CALLER's job to
 * treat this as fire-and-forget (`void auditLog.sessionStart(...).catch(...)`),
 * exactly like the existing `sessions.create`/`sessions.end` call sites in
 * `routes/signaling.ts` — a Postgres blip must never take down live
 * signaling or pairing.
 */
export class AuditLogService {
  constructor(private readonly store: AuditLogStore) {}

  /** A caller proved an identity and was issued a session (M8). */
  login(fields: AuditLogFields = {}): Promise<void> {
    return this.write('login', fields);
  }

  /** A sign-in or refresh attempt was rejected. `metadata.reason` carries the
   * real cause; the HTTP response deliberately does not. */
  loginFailed(fields: AuditLogFields = {}): Promise<void> {
    return this.write('login_failed', fields);
  }

  /** A mobile device successfully redeemed a pairing token — the desktop and
   * mobile device are now bound to the same room. */
  devicePaired(fields: AuditLogFields = {}): Promise<void> {
    return this.write('device_paired', fields);
  }

  /** The desktop approved a pending pair request; a session was minted. */
  sessionStart(fields: AuditLogFields = {}): Promise<void> {
    return this.write('session_start', fields);
  }

  /** A session ended, for any reason (disconnect, heartbeat reap, denial
   * after a session existed, graceful shutdown, ...). */
  sessionEnd(fields: AuditLogFields = {}): Promise<void> {
    return this.write('session_end', fields);
  }

  /** The desktop explicitly denied a pending pair request, before any
   * session was ever minted. */
  pairDenied(fields: AuditLogFields = {}): Promise<void> {
    return this.write('pair_denied', fields);
  }

  private write(eventType: AuditEventType, fields: AuditLogFields): Promise<void> {
    return this.store.insert({
      eventType,
      userId: fields.userId ?? null,
      deviceId: fields.deviceId ?? null,
      metadata: fields.metadata ?? {},
      ip: fields.ip ?? null,
    });
  }
}
