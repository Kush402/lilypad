/** Cross-service constants that are not part of a wire format. */

/** Redis key helpers — one namespace, easy to scan/flush in dev. */
export const redisKeys = {
  /** Single-use pairing token → JSON blob (TTL = PAIRING_TOKEN_TTL_SECONDS). */
  pairingToken: (token: string) => `lilypad:pairing:${token}`,
  /** Single-use magic-link sign-in token → the email address it proves
   * (M8). Ephemeral and single-use, exactly like a pairing token, which is
   * why it lives in Redis rather than Postgres. */
  magicLink: (token: string) => `lilypad:magic-link:${token}`,
  /** Single-use device-enrollment / login challenge → the JSON challenge
   * record the signature is checked against (M8). Redis for the same reason:
   * a nonce that survives a restart is a replay window. */
  deviceChallenge: (challengeId: string) => `lilypad:device-challenge:${challengeId}`,
  /** Signaling room membership/state (M2+). */
  room: (roomId: string) => `lilypad:room:${roomId}`,
  /** Room-authorization record written by the pairing flow (`desktopDeviceId`,
   * and `mobileDeviceId` once redeemed) — the source of truth
   * `SignalingHub.register()`'s room-auth check verifies a `register`
   * attempt against, so a room's very first seat claim can no longer be won
   * by whoever's WebSocket frame simply arrives first. See
   * `docs/audit/m3/backend-security.md` Finding 1. */
  roomAuth: (roomId: string) => `lilypad:room-auth:${roomId}`,
} as const;

/** Health probe result shape returned by GET /health. */
export interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  checks: {
    postgres: 'up' | 'down';
    redis: 'up' | 'down';
  };
  version: string;
}
