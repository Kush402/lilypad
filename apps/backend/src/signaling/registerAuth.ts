import { presenceRoomDeviceId, type DeviceKind } from '@lilypad/protocol';

/**
 * A `register` message's `roomId`/`role`/`deviceId`, loosely extracted from
 * an already-JSON-parsed (but not yet zod-validated) inbound frame — just
 * enough for the route layer to decide whether a room-authorization check is
 * needed before the frame ever reaches `SignalingHub.handleMessage` (which
 * still does the real, full schema validation on everything, register
 * attempts included). Returns `null` for anything that doesn't look like a
 * register attempt; a malformed "register-shaped" frame safely falls
 * through to the hub's own `bad_message` rejection unchanged — this is a
 * fast preliminary filter for the one message type that needs an extra,
 * async, security-relevant check, not a replacement validator.
 */
export interface RegisterAttempt {
  roomId: string;
  role: DeviceKind;
  deviceId: string;
}

export function extractRegisterAttempt(json: unknown): RegisterAttempt | null {
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (obj.type !== 'register' || typeof obj.roomId !== 'string') return null;

  const payload = obj.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if ((p.role !== 'desktop' && p.role !== 'mobile') || typeof p.deviceId !== 'string') return null;

  return { roomId: obj.roomId, role: p.role, deviceId: p.deviceId };
}

/** What the route layer should do with one inbound frame, decided BEFORE it
 * ever reaches `SignalingHub.handleMessage`. Pulled out as its own pure-ish
 * decision function (mirroring `MessageRouter`'s pure-decisions/thin-executor
 * split) specifically so the room-auth gating logic — the part that matters
 * for `docs/audit/m3/backend-security.md` Finding 1 — is unit-testable
 * without a real WebSocket/Fastify/Redis stack. */
export type GateDecision =
  | { action: 'proceed' }
  | { action: 'reject_unauthorized'; attempt: RegisterAttempt }
  | { action: 'error'; attempt: RegisterAttempt };

/**
 * Should this frame be allowed to reach the hub? Only a not-yet-registered
 * peer's `register` attempt is gated at all — every other message (including
 * a harmless duplicate `register` from an already-seated peer, or any
 * message from a peer that isn't attempting to register) proceeds exactly as
 * before. `verify`/`verifyPresenceOwner` rejecting (a Redis or Postgres error,
 * not an authorization failure) maps to `'error'` — distinct from
 * `'reject_unauthorized'` so the caller can close the socket without implying
 * the device was actually checked and found unauthorized.
 *
 * Both lookups therefore fail CLOSED on an outage. For presence that is a
 * deliberate trade: a Postgres outage stops new presence registrations, but
 * `/connect/request` needs the same database to authorize a ring at all, so a
 * presence seat nobody could use is worth less than an unauthenticated one.
 * Live sessions are unaffected — they registered already.
 */
export async function decideRegisterGate(
  json: unknown,
  isRegistered: boolean,
  verify: (roomId: string, role: DeviceKind, deviceId: string) => Promise<boolean>,
  verifyPresenceOwner: (deviceId: string) => Promise<boolean>,
): Promise<GateDecision> {
  const attempt = isRegistered ? null : extractRegisterAttempt(json);
  if (!attempt) return { action: 'proceed' };

  // Presence rooms (`presence:<deviceId>`, M5.4) have no pairing-flow record
  // to check against — none exists, because presence outlives any one pairing.
  // So the shape of the claim is checked here (only a desktop, only into ITS
  // OWN device's room, and a suffix long enough that `presence:` alone can
  // never become a claimable room) and WHO is claiming it is checked by
  // `verifyPresenceOwner`.
  //
  // That second half is SEC-4 and it is not cosmetic. A presence seat receives
  // the `connect-request` frames a trusted phone sends to ring its laptop, and
  // claiming an occupied seat EVICTS the incumbent as a same-device reconnect.
  // Until M9 the suffix match was the whole gate, so knowing a laptop's device
  // id was enough to take over its presence — silently intercepting every ring
  // meant for it and knocking the real machine offline.
  const presenceOwner = presenceRoomDeviceId(attempt.roomId);
  if (presenceOwner !== null) {
    if (
      attempt.role !== 'desktop' ||
      presenceOwner.length < 8 ||
      attempt.deviceId !== presenceOwner
    ) {
      return { action: 'reject_unauthorized', attempt };
    }
    try {
      return (await verifyPresenceOwner(attempt.deviceId))
        ? { action: 'proceed' }
        : { action: 'reject_unauthorized', attempt };
    } catch {
      return { action: 'error', attempt };
    }
  }

  let authorized: boolean;
  try {
    authorized = await verify(attempt.roomId, attempt.role, attempt.deviceId);
  } catch {
    return { action: 'error', attempt };
  }
  return authorized ? { action: 'proceed' } : { action: 'reject_unauthorized', attempt };
}
