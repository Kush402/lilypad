import { randomBytes, randomUUID } from 'node:crypto';
import { redisKeys } from '@lilypad/shared';
import type {
  PairingCreateRequest,
  PairingCreateResponse,
  PairingRedeemRequest,
  PairingRedeemResponse,
  SessionScope,
} from '@lilypad/protocol';
import { redis } from '../redis.js';
import { config } from '../config.js';
import { advertisedUrls } from './advertisedUrls.js';
import { RoomAuthStore } from './roomAuth.js';

const defaultRoomAuthStore = new RoomAuthStore(redis);

/** What we persist in Redis under the single-use token (60s TTL). */
interface PairingRecord {
  roomId: string;
  desktopDeviceId: string;
  desktopDeviceName: string | null;
  scopes: SessionScope[];
  createdAt: number;
}

const DEFAULT_SCOPES: SessionScope[] = ['view', 'control'];

/** The slice of Redis the pairing service needs — injectable for tests. */
export interface PairingRedis {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

/**
 * Desktop mints a pairing session: a single-use token bound to the desktop
 * device + a fresh signaling room, stored in Redis with a 60s TTL. The token
 * itself is a high-entropy opaque string; it carries no meaning off-server.
 */
export async function createPairing(
  req: PairingCreateRequest,
  client: PairingRedis = redis,
  roomAuth: RoomAuthStore = defaultRoomAuthStore,
): Promise<PairingCreateResponse> {
  const token = randomBytes(24).toString('base64url'); // ~32 chars, url-safe
  const roomId = randomUUID();
  const scopes = req.scopes ?? DEFAULT_SCOPES;

  const record: PairingRecord = {
    roomId,
    desktopDeviceId: req.deviceId,
    desktopDeviceName: req.deviceName ?? null,
    scopes,
    createdAt: Date.now(),
  };

  await client.set(
    redisKeys.pairingToken(token),
    JSON.stringify(record),
    'EX',
    config.pairingTokenTtlSeconds,
  );
  // Security-critical, not an audit trail: this record is what
  // `SignalingHub.register()` checks before granting the desktop seat, so it
  // must be durably written before the QR/token ever reaches the desktop —
  // awaited, not fire-and-forget. See `docs/audit/m3/backend-security.md`
  // Finding 1.
  await roomAuth.recordDesktop(roomId, req.deviceId);

  const urls = advertisedUrls();
  return {
    token,
    roomId,
    apiBaseUrl: urls.apiBaseUrl,
    signalingUrl: urls.signalingUrl,
    expiresInSeconds: config.pairingTokenTtlSeconds,
  };
}

/** Raised when a token is missing, expired, or already used. */
export class PairingTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingTokenError';
  }
}

/**
 * Mobile redeems the token. GETDEL makes redemption atomic + single-use: the
 * key is read and removed in one operation, so a replayed token fails.
 */
export async function redeemPairing(
  req: PairingRedeemRequest,
  client: PairingRedis = redis,
  roomAuth: RoomAuthStore = defaultRoomAuthStore,
): Promise<PairingRedeemResponse> {
  const raw = await client.getdel(redisKeys.pairingToken(req.token));
  if (!raw) {
    throw new PairingTokenError('pairing token is invalid, expired, or already used');
  }

  const record = JSON.parse(raw) as PairingRecord;
  // Extends the room-auth record with the redeeming mobile device, before
  // this response (which carries `roomId` to the phone) is ever returned —
  // otherwise the phone's WS `register` could race ahead of its own seat
  // becoming authorized. See `docs/audit/m3/backend-security.md` Finding 1.
  await roomAuth.recordMobile(record.roomId, record.desktopDeviceId, req.deviceId);

  // M2 will push a `pair-request` to the desktop over its signaling socket here.
  return {
    roomId: record.roomId,
    signalingUrl: advertisedUrls().signalingUrl,
    scopes: record.scopes,
    desktopDeviceName: record.desktopDeviceName,
  };
}
