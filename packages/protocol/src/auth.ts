import { z } from 'zod';

/**
 * REST contract for account authentication (M8,
 * [ADR-0001](../../../docs/adr/0001-account-authentication.md)).
 *
 * Account identity and DEVICE identity are separate contracts on purpose: an
 * account session says who the human is, a device token says which machine is
 * asking. Both are required before a device may act — see
 * [ADR-0002](../../../docs/adr/0002-device-identity.md) and `identity.ts`.
 */

export const OAuthProviderSchema = z.enum(['apple', 'google']);
export type OAuthProviderName = z.infer<typeof OAuthProviderSchema>;

/** Sign in with an ID token the client already obtained from the provider.
 * Lilypad never handles the provider password or the authorization-code
 * exchange — the platform SDK does that, and we verify what it produced. */
export const OAuthSignInRequestSchema = z.object({
  provider: OAuthProviderSchema,
  /** The provider's ID token (a JWT). Bounded because an unbounded string
   * here is a free way to make the server do public-key work. */
  idToken: z.string().min(16).max(8192),
});
export type OAuthSignInRequest = z.infer<typeof OAuthSignInRequestSchema>;

/** Ask for a sign-in link. Always answered identically whether or not the
 * address has an account — see the route's doc comment. */
export const MagicLinkRequestSchema = z.object({
  email: z.string().email().max(320),
});
export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;

/** Redeem the single-use token from the emailed link. */
export const MagicLinkVerifyRequestSchema = z.object({
  token: z.string().min(16).max(256),
});
export type MagicLinkVerifyRequest = z.infer<typeof MagicLinkVerifyRequestSchema>;

/** Exchange a refresh token for a fresh pair. Single-use: the presented token
 * is retired by the exchange. */
export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(16).max(256),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/** What every successful sign-in and refresh returns. */
export const AuthSessionSchema = z.object({
  accessToken: z.string(),
  /** Seconds until `accessToken` expires — the client refreshes before this,
   * rather than parsing the token, which it has no business decoding. */
  expiresInSeconds: z.number().int().positive(),
  /** Rotating and single-use: the client MUST replace its stored copy with
   * this value, because presenting the old one again revokes the family. */
  refreshToken: z.string(),
  userId: z.string().uuid(),
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

/** Machine-readable failure codes the auth endpoints return. Deliberately
 * coarse: `invalid_token` covers expired, forged, replayed, and unknown alike,
 * because telling a caller which one it was is an oracle. */
export type AuthErrorCode =
  | 'invalid_request'
  | 'invalid_token'
  | 'provider_not_configured'
  | 'email_required'
  | 'email_unverified'
  | 'magic_link_unavailable';
