import { redisKeys } from '@lilypad/shared';
import type { DeviceKind } from '@lilypad/protocol';

/** What the pairing flow authoritatively knows about who a room belongs to.
 * `mobileDeviceId` is absent until `/pairing/redeem` succeeds — a room has a
 * desktop from the moment its QR is minted, but no mobile device until one
 * actually redeems the token. */
interface RoomAuthRecord {
  desktopDeviceId: string;
  mobileDeviceId: string | null;
}

/** The slice of Redis `RoomAuthStore` needs — injectable for tests, mirrors
 * `PairingRedis` (`services/pairing.ts`) and `KvStore` (`session/manager.ts`). */
export interface RoomAuthRedis {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

/** How long a room's authorization record survives before any device has
 * redeemed the token — long enough to cover minting the QR, displaying it,
 * the user scanning it, and redeeming. Independent of, and deliberately
 * looser than, `PAIRING_TOKEN_TTL_SECONDS`. */
const ROOM_CLAIM_WINDOW_SECONDS = 10 * 60;

/** Once a mobile device has redeemed, the record must live as long as the
 * SESSION may: every mid-session signaling reconnect (phone lock, network
 * flip, backend restart + room resurrection) re-runs the register gate
 * against this record, and an expired record hard-rejects the reconnect
 * (4403) — killing the renegotiate/ICE-restart channel for a session whose
 * media still flows. Matches `RoomStore`'s 6h room-record window
 * (`session/roomStore.ts`), and `verify()` additionally slides it on every
 * successful re-register so even longer sessions keep their auth alive.
 * See `docs/m5.4-trusted-devices-audit.md` BUG-1. */
const SESSION_AUTH_WINDOW_SECONDS = 6 * 60 * 60;

/**
 * Redis-backed source of truth for "which devices is this room actually for,"
 * written by the pairing flow (`services/pairing.ts`) and read by
 * `SignalingHub.register()` before a `Room`/seat is ever created. This is
 * what turns `roomId` from a bearer capability (whoever's `register` frame
 * arrives first wins the seat) into an authorized claim (only the device the
 * pairing flow actually issued the room to can claim its seat). See
 * `docs/audit/m3/backend-security.md` Finding 1.
 *
 * Deliberately NOT the resumption/device-identity system Finding 15 (M5)
 * specs — this proves "the same device the pairing flow saw" (still a
 * self-asserted string), not "the same device cryptographically." That's
 * the seam `RoomAuthStore.verify()` is built for M5 to upgrade in place,
 * without any caller needing to change (see `docs/m5-auth-design.md`'s
 * "Interaction with the seat-hijack fix" section).
 */
export class RoomAuthStore {
  constructor(
    private readonly store: RoomAuthRedis,
    private readonly claimTtlSeconds: number = ROOM_CLAIM_WINDOW_SECONDS,
    private readonly sessionTtlSeconds: number = SESSION_AUTH_WINDOW_SECONDS,
  ) {}

  /** Called when `/pairing/create` mints a room — the desktop is the only
   * device known at this point, and the record only needs to survive the
   * scan-and-redeem window. */
  async recordDesktop(roomId: string, desktopDeviceId: string): Promise<void> {
    const record: RoomAuthRecord = { desktopDeviceId, mobileDeviceId: null };
    await this.write(roomId, record, this.claimTtlSeconds);
  }

  /** Called when `/pairing/redeem` succeeds — extends the same record with
   * the redeeming mobile device. From this point the record guards every
   * mid-session reconnect, so it gets the session window, not the claim
   * window (BUG-1: a 10-min TTL here rejected any signaling reconnect more
   * than 10 minutes into a session). */
  async recordMobile(
    roomId: string,
    desktopDeviceId: string,
    mobileDeviceId: string,
  ): Promise<void> {
    const record: RoomAuthRecord = { desktopDeviceId, mobileDeviceId };
    await this.write(roomId, record, this.sessionTtlSeconds);
  }

  /** Does `deviceId` match the device the pairing flow actually issued this
   * room's `role` seat to? `false` for any room with no record at all (never
   * paired, or the record expired) — a virgin `roomId` an attacker invents
   * out of thin air can never pass this check, which also closes the
   * room-exhaustion DoS Finding 1 describes (no `Room` gets created for an
   * unauthorized attempt at all). `false` for `role: 'mobile'` before
   * redemption — there is nothing to match yet.
   *
   * A successful verification also SLIDES the record's TTL back out to the
   * session window: reconnects are exactly the signal that the session is
   * still alive and will need this record again. Best-effort — a failed
   * refresh must never turn a valid verification into a rejection. */
  async verify(roomId: string, role: DeviceKind, deviceId: string): Promise<boolean> {
    const raw = await this.store.get(redisKeys.roomAuth(roomId));
    if (!raw) return false;
    let record: RoomAuthRecord;
    try {
      record = JSON.parse(raw) as RoomAuthRecord;
    } catch {
      return false; // corrupt record can't be verified safe — fail closed
    }
    const expected = role === 'desktop' ? record.desktopDeviceId : record.mobileDeviceId;
    const ok = expected !== null && expected === deviceId;
    if (ok) {
      try {
        await this.store.set(redisKeys.roomAuth(roomId), raw, 'EX', this.sessionTtlSeconds);
      } catch {
        /* refresh is an optimization; verification stands */
      }
    }
    return ok;
  }

  /** Called when the room itself ends (`SignalingHub.endRoom` via the
   * `onRoomClosed` hook) — a dead room's auth record must not outlive it,
   * or the two bound devices could re-register into the dead `roomId` and
   * resurrect a zombie room the session lifecycle already tore down. */
  async delete(roomId: string): Promise<void> {
    await this.store.del(redisKeys.roomAuth(roomId));
  }

  private async write(roomId: string, record: RoomAuthRecord, ttlSeconds: number): Promise<void> {
    await this.store.set(redisKeys.roomAuth(roomId), JSON.stringify(record), 'EX', ttlSeconds);
  }
}
