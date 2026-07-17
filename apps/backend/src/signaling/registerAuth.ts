import type { DeviceKind } from '@lilypad/protocol';

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
 * before. `verify` rejecting (a Redis error, not an authorization failure)
 * maps to `'error'` — distinct from `'reject_unauthorized'` so the caller can
 * close the socket without implying the device was actually checked and
 * found unauthorized.
 */
export async function decideRegisterGate(
  json: unknown,
  isRegistered: boolean,
  verify: (roomId: string, role: DeviceKind, deviceId: string) => Promise<boolean>,
): Promise<GateDecision> {
  const attempt = isRegistered ? null : extractRegisterAttempt(json);
  if (!attempt) return { action: 'proceed' };

  let authorized: boolean;
  try {
    authorized = await verify(attempt.roomId, attempt.role, attempt.deviceId);
  } catch {
    return { action: 'error', attempt };
  }
  return authorized ? { action: 'proceed' } : { action: 'reject_unauthorized', attempt };
}
