/** Cross-service constants that are not part of a wire format. */

/** Redis key helpers — one namespace, easy to scan/flush in dev. */
export const redisKeys = {
  /** Single-use pairing token → JSON blob (TTL = PAIRING_TOKEN_TTL_SECONDS). */
  pairingToken: (token: string) => `lilypad:pairing:${token}`,
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
