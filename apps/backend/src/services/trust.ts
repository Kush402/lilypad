import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db as defaultDb } from '../db/client.js';
import { devices, trustedDevices } from '../db/schema.js';
import type { DeviceKind } from '@lilypad/protocol';

/** A high-entropy per-pair connect secret (url-safe, ~32 chars) and its
 * SHA-256 hash. Only the hash is stored; the plaintext is handed to the phone
 * once, over the authenticated mobile seat. SHA-256 (not a slow KDF) is
 * correct here — the input is already 192 bits of CSPRNG output, so there is
 * nothing to brute-force. */
export function newConnectSecret(): { secret: string; hash: string } {
  const secret = randomBytes(24).toString('base64url');
  return { secret, hash: hashSecret(secret) };
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Show only a short suffix of a device fingerprint in listings. */
function maskFingerprint(fp: string): string {
  return fp.length <= 6 ? fp : `…${fp.slice(-6)}`;
}

/** Constant-time hash comparison. */
function hashesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Persistent desktop↔mobile pair trust (M5.4) — the durable record behind
 * "pair once, reconnect without a QR." Rows are created when a desktop
 * approval carries `trust: true` (the "Trust this device" checkbox), read by
 * `POST /connect/request`, and severed by Forget/Revoke (which SETS
 * `revokedAt` rather than deleting — the row is the audit trail).
 *
 * Identity note (pre-M5-keys): devices are keyed by their wire `deviceId`
 * string, stored as `devices.fingerprint` — the same self-asserted identity
 * the rest of the system runs on today. The M5 device-identity milestone
 * upgrades what's PROVEN about these strings (Ed25519 challenge-response
 * filling `devices.publicKey`); this service's shape doesn't change.
 */

/** One trust row, as the service exposes it. */
export interface TrustedPair {
  pairId: string;
  desktopDeviceId: string; // devices.id (uuid)
  mobileDeviceId: string; // devices.id (uuid)
  autoApprove: boolean;
  revoked: boolean;
  displayName: string | null;
  /** SHA-256 of the connect secret, or null for a legacy pre-secret pair. */
  connectSecretHash: string | null;
}

/** The verdict of authorizing a no-QR connect. */
export type ConnectAuthz =
  { ok: true; pair: TrustedPair } | { ok: false; reason: 'not_trusted' | 'revoked' | 'bad_secret' };

/** A pair as the desktop's Trusted Devices dashboard sees it — joined with
 * the mobile device row so the UI can show WHICH phone. */
export interface PairListing {
  pairId: string;
  mobileFingerprint: string;
  displayName: string | null;
  autoApprove: boolean;
  revoked: boolean;
  lastConnectedAt: string | null; // ISO, for the wire
  createdAt: string;
}

/** Minimal DB surface — satisfied by the real Drizzle adapter below and by
 * an in-memory fake in tests (the `AuditLogStore`/`KvStore` pattern). */
export interface TrustStore {
  /** Find a device row id by (kind, fingerprint); create it if missing. */
  upsertDevice(kind: DeviceKind, fingerprint: string): Promise<string>;
  /** The pair row for two device UUIDs, if one exists. */
  getPairByDeviceIds(desktopId: string, mobileId: string): Promise<TrustedPair | null>;
  insertPair(
    desktopId: string,
    mobileId: string,
    autoApprove: boolean,
    connectSecretHash: string,
  ): Promise<TrustedPair>;
  /** Every pair for one desktop, joined with each mobile device row. */
  listPairsForDesktop(desktopId: string): Promise<PairListing[]>;
  /** Patch mutable pair fields. Absent fields are left untouched. */
  updatePair(
    pairId: string,
    patch: {
      revoked?: boolean;
      autoApprove?: boolean;
      lastConnectedAt?: Date;
      connectSecretHash?: string;
    },
  ): Promise<void>;
  /** Device row (uuid + fingerprint) by fingerprint, if registered. */
  getDeviceByFingerprint(kind: DeviceKind, fingerprint: string): Promise<{ id: string } | null>;
  /** The wire fingerprints of both sides of a pair, by pair id — used to find
   * the live signaling room(s) this pair maps to (rooms are keyed by wire
   * fingerprint, not by these `devices.id` uuids). Null if the pair doesn't
   * exist. */
  getPairFingerprints(
    pairId: string,
  ): Promise<{ desktopFingerprint: string; mobileFingerprint: string } | null>;
}

export class TrustService {
  constructor(private readonly store: TrustStore) {}

  /**
   * Record (or re-affirm) trust between two devices, by their wire ids.
   * Re-trusting a previously revoked pair un-revokes it — the user just
   * re-ran the full QR + approve ceremony, which is exactly the bar that
   * established trust the first time. Idempotent for an active pair.
   *
   * New pairs default to `autoApprove: true`: the explicit trust ceremony IS
   * the consent moment — a trusted phone reconnecting like a Bluetooth
   * device is the whole product promise, and requiring a desktop-side tap on
   * every reconnect would make "trusted" meaningless. The visible session
   * indicator, audit log, panic disconnect, and the per-pair dashboard
   * toggle (require approval / revoke) keep this inside the threat model's
   * "no silent access" line. An EXISTING pair's setting is never overridden
   * here — the user may have deliberately turned approval back on.
   */
  async establishTrust(
    desktopFingerprint: string,
    mobileFingerprint: string,
  ): Promise<{ pairSecret: string }> {
    const desktopId = await this.store.upsertDevice('desktop', desktopFingerprint);
    const mobileId = await this.store.upsertDevice('mobile', mobileFingerprint);
    return this.establishTrustForDeviceIds(desktopId, mobileId);
  }

  /**
   * The same ceremony, for callers that already hold both `devices.id` uuids.
   *
   * Account enrollment ([ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md))
   * is one of them: approving a laptop resolves both rows itself, and must not
   * re-derive them from wire fingerprints.
   *
   * This exists because enrollment previously wrote `devices.user_id` and
   * nothing else, while `authorizeConnect` authorizes purely on a
   * `trusted_devices` row — so a user could complete the linking ceremony and
   * still be unable to connect. Ownership and reachability are separate facts,
   * and the ceremony has to establish both.
   */
  async establishTrustForDeviceIds(
    desktopId: string,
    mobileId: string,
  ): Promise<{ pairSecret: string }> {
    // A fresh secret every time trust is (re)established — a re-pair or an
    // un-revoke re-issues, and the phone stores whatever it's handed. Only the
    // hash is persisted; the plaintext is returned for one-time delivery.
    const { secret, hash } = newConnectSecret();
    const existing = await this.store.getPairByDeviceIds(desktopId, mobileId);
    if (!existing) {
      await this.store.insertPair(desktopId, mobileId, true, hash);
    } else {
      await this.store.updatePair(existing.pairId, {
        connectSecretHash: hash,
        ...(existing.revoked ? { revoked: false } : {}),
      });
    }
    return { pairSecret: secret };
  }

  /**
   * Authorize a no-QR connect. Fails closed on: unknown/untrusted devices, a
   * revoked pair, a missing/wrong secret, and a pair that has no secret at all.
   * The presented secret is compared in constant time.
   *
   * **A null `connectSecretHash` is refused (SEC-5).** Such rows predate
   * per-pair secrets and used to be admitted with no secret whatsoever for
   * back-compat — which made knowing two device ids sufficient to ring a
   * laptop, on exactly the pairs whose owners had never had a chance to opt in.
   * Migration `0005` revokes the ones that exist; this branch is what keeps the
   * hole shut if one is ever created again. Recovery is the QR ceremony, which
   * issues a secret and un-revokes the row.
   */
  async authorizeConnect(
    desktopFingerprint: string,
    mobileFingerprint: string,
    presentedSecret: string | undefined,
  ): Promise<ConnectAuthz> {
    const pair = await this.findPair(desktopFingerprint, mobileFingerprint);
    if (!pair) return { ok: false, reason: 'not_trusted' };
    if (pair.revoked) return { ok: false, reason: 'revoked' };
    if (pair.connectSecretHash === null) return { ok: false, reason: 'not_trusted' };
    if (!presentedSecret) return { ok: false, reason: 'bad_secret' };
    const presentedHash = hashSecret(presentedSecret);
    if (!hashesMatch(presentedHash, pair.connectSecretHash)) {
      return { ok: false, reason: 'bad_secret' };
    }
    return { ok: true, pair };
  }

  /** Every pair for a desktop (by wire id) — the Trusted Devices dashboard. */
  async listForDesktop(desktopFingerprint: string): Promise<PairListing[]> {
    const desktop = await this.store.getDeviceByFingerprint('desktop', desktopFingerprint);
    if (!desktop) return [];
    return this.store.listPairsForDesktop(desktop.id);
  }

  /** Flip a pair's "connect without approval" setting. */
  async setAutoApprove(pairId: string, enabled: boolean): Promise<void> {
    await this.store.updatePair(pairId, { autoApprove: enabled });
  }

  /** The ACTIVE (non-revoked) pair for two wire ids, or null. `null` covers
   * never-trusted, unknown devices, and revoked alike — the connect gate
   * fails closed on all three; the caller can distinguish revoked for a
   * clearer client message via `revoked` on the returned row. */
  async findPair(
    desktopFingerprint: string,
    mobileFingerprint: string,
  ): Promise<TrustedPair | null> {
    const desktop = await this.store.getDeviceByFingerprint('desktop', desktopFingerprint);
    const mobile = await this.store.getDeviceByFingerprint('mobile', mobileFingerprint);
    if (!desktop || !mobile) return null;
    return this.store.getPairByDeviceIds(desktop.id, mobile.id);
  }

  /** Mark a successful no-QR connect (updates `lastConnectedAt`). */
  async touchConnected(pairId: string): Promise<void> {
    await this.store.updatePair(pairId, { lastConnectedAt: new Date() });
  }

  /** Sever the pair (Forget on the phone / Revoke on the desktop). The row
   * stays for the audit trail; the connect gate fails closed from now on.
   * Returns the pair's wire fingerprints so the caller can force-end any
   * live room for this exact pair — `null` if the pair doesn't exist
   * (defensive; the route already validated it via a prior list call). */
  async revoke(
    pairId: string,
  ): Promise<{ desktopFingerprint: string; mobileFingerprint: string } | null> {
    const fingerprints = await this.store.getPairFingerprints(pairId);
    if (!fingerprints) return null;
    await this.store.updatePair(pairId, { revoked: true });
    return fingerprints;
  }
}

/** Adapts the real Drizzle client to `TrustStore`. */
export function createDrizzleTrustStore(database: typeof defaultDb = defaultDb): TrustStore {
  const toPair = (row: typeof trustedDevices.$inferSelect): TrustedPair => ({
    pairId: row.id,
    desktopDeviceId: row.desktopDeviceId,
    mobileDeviceId: row.mobileDeviceId,
    autoApprove: row.autoApprove,
    revoked: row.revokedAt !== null,
    displayName: row.displayName,
    connectSecretHash: row.connectSecretHash,
  });
  return {
    async upsertDevice(kind, fingerprint) {
      // Fast path: the device almost always already exists, and a bare SELECT
      // avoids write amplification on every connect.
      const found = await database
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.kind, kind), eq(devices.fingerprint, fingerprint)))
        .limit(1);
      if (found[0]) return found[0].id;
      // Slow path: select-then-insert is a race, and since M8 the unique index
      // `devices_kind_fingerprint_idx` enforces the invariant it used to
      // violate. Yielding to the concurrent winner rather than raising keeps
      // the race invisible to callers — the outcome ("one row for this
      // device") is identical either way.
      const inserted = await database
        .insert(devices)
        .values({ kind, fingerprint })
        .onConflictDoNothing({ target: [devices.kind, devices.fingerprint] })
        .returning({ id: devices.id });
      if (inserted[0]) return inserted[0].id;
      const raced = await database
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.kind, kind), eq(devices.fingerprint, fingerprint)))
        .limit(1);
      const row = raced[0];
      if (!row) throw new Error('device insert conflicted but no row exists');
      return row.id;
    },
    async getPairByDeviceIds(desktopId, mobileId) {
      const rows = await database
        .select()
        .from(trustedDevices)
        .where(
          and(
            eq(trustedDevices.desktopDeviceId, desktopId),
            eq(trustedDevices.mobileDeviceId, mobileId),
          ),
        )
        .limit(1);
      return rows[0] ? toPair(rows[0]) : null;
    },
    async insertPair(desktopId, mobileId, autoApprove, connectSecretHash) {
      const inserted = await database
        .insert(trustedDevices)
        .values({
          desktopDeviceId: desktopId,
          mobileDeviceId: mobileId,
          autoApprove,
          connectSecretHash,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('trusted_devices insert returned no row');
      return toPair(row);
    },
    async listPairsForDesktop(desktopId) {
      const rows = await database
        .select({
          pairId: trustedDevices.id,
          mobileFingerprint: devices.fingerprint,
          displayName: trustedDevices.displayName,
          autoApprove: trustedDevices.autoApprove,
          revokedAt: trustedDevices.revokedAt,
          lastConnectedAt: trustedDevices.lastConnectedAt,
          createdAt: trustedDevices.createdAt,
        })
        .from(trustedDevices)
        .innerJoin(devices, eq(trustedDevices.mobileDeviceId, devices.id))
        .where(eq(trustedDevices.desktopDeviceId, desktopId));
      return rows.map((r) => ({
        pairId: r.pairId,
        // Mask the raw fingerprint — the dashboard shows displayName; leaking
        // the full self-asserted id to any caller that knows a desktop id is
        // needless (2026-07-19 audit). Keep a short suffix to disambiguate.
        mobileFingerprint: maskFingerprint(r.mobileFingerprint),
        displayName: r.displayName,
        autoApprove: r.autoApprove,
        revoked: r.revokedAt !== null,
        lastConnectedAt: r.lastConnectedAt ? r.lastConnectedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      }));
    },
    async updatePair(pairId, patch) {
      const set: Partial<typeof trustedDevices.$inferInsert> = {};
      if (patch.revoked !== undefined) set.revokedAt = patch.revoked ? new Date() : null;
      if (patch.autoApprove !== undefined) set.autoApprove = patch.autoApprove;
      if (patch.lastConnectedAt !== undefined) set.lastConnectedAt = patch.lastConnectedAt;
      if (patch.connectSecretHash !== undefined) set.connectSecretHash = patch.connectSecretHash;
      await database.update(trustedDevices).set(set).where(eq(trustedDevices.id, pairId));
    },
    async getDeviceByFingerprint(kind, fingerprint) {
      const rows = await database
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.kind, kind), eq(devices.fingerprint, fingerprint)))
        .limit(1);
      return rows[0] ?? null;
    },
    async getPairFingerprints(pairId) {
      // Two joins to `devices` for the same pair row (desktop side, mobile
      // side) — alias the table once per side so Drizzle can disambiguate.
      const desktopDevices = alias(devices, 'desktop_devices');
      const mobileDevices = alias(devices, 'mobile_devices');
      const rows = await database
        .select({
          desktopFingerprint: desktopDevices.fingerprint,
          mobileFingerprint: mobileDevices.fingerprint,
        })
        .from(trustedDevices)
        .innerJoin(desktopDevices, eq(trustedDevices.desktopDeviceId, desktopDevices.id))
        .innerJoin(mobileDevices, eq(trustedDevices.mobileDeviceId, mobileDevices.id))
        .where(eq(trustedDevices.id, pairId))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
