/** Cross-service constants that are not part of a wire format. */

/** Redis key helpers — one namespace, easy to scan/flush in dev. */
export const redisKeys = {
  /** Single-use pairing token → JSON blob (TTL = PAIRING_TOKEN_TTL_SECONDS). */
  pairingToken: (token: string) => `lilypad:pairing:${token}`,
  /** Single-use magic-link sign-in token → the email address it proves
   * (M8). Ephemeral and single-use, exactly like a pairing token, which is
   * why it lives in Redis rather than Postgres. */
  magicLink: (token: string) => `lilypad:magic-link:${token}`,
  /** Single-use password-reset token → the email address it authorizes a reset
   * for ([ADR-0012](../../../docs/adr/0012-password-authentication.md)).
   *
   * A DIFFERENT namespace from `magicLink` on purpose, not for tidiness: the
   * two tokens authorize different things, and one key space would make a
   * reset token spendable at `/auth/magic-link/verify` as a full sign-in. */
  passwordReset: (token: string) => `lilypad:password-reset:${token}`,
  /** Single-use device-enrollment / login challenge → the JSON challenge
   * record the signature is checked against (M8). Redis for the same reason:
   * a nonce that survives a restart is a replay window. */
  deviceChallenge: (challengeId: string) => `lilypad:device-challenge:${challengeId}`,
  /** Single-use desktop-enrollment code → the JSON record binding it to the
   * desktop's public key (M8). Redis for the same reason as the others: a
   * pending enrollment that survives a restart is a standing invitation. */
  desktopEnrollment: (code: string) => `lilypad:desktop-enrollment:${code}`,
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
    /**
     * Whether outbound email is configured (`RESEND_API_KEY` + `MAIL_FROM`).
     *
     * Deliberately NOT part of `status`. A deployment with no mailer signs
     * devices in, pairs them and relays sessions perfectly well — degrading
     * health would take the API out of rotation over a feature that was still
     * working. But it is not something an operator should have to discover
     * from a user's support ticket either: with no mailer, password reset and
     * magic-link sign-in answer 503, and nothing else says so out loud.
     */
    mail: 'configured' | 'unconfigured';
  };
  /** The commit the running image was built from, or `unknown` for a build
   * that was not given one. This is the only way to tell from outside the VM
   * which code is actually serving. */
  revision: string;
}
