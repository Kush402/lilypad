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

/**
 * A memorized secret, per NIST SP 800-63B §5.1.1.2 and
 * [ADR-0012](../../../docs/adr/0012-password-authentication.md).
 *
 * Length is the ONLY rule. No required character classes: the evidence is that
 * composition rules push users toward predictable substitutions rather than
 * toward entropy. The maximum exists so an unbounded string cannot be used to
 * make the server do arbitrary scrypt work, and is generous enough that a
 * passphrase or a password manager's output always fits.
 */
export const PasswordSchema = z.string().min(12).max(200);

/** A display name. Consumer signup asks for one; nothing authenticates on it. */
export const DisplayNameSchema = z.string().trim().min(1).max(80);

/** Create an account with name + email + password. */
export const SignUpRequestSchema = z.object({
  name: DisplayNameSchema,
  email: z.string().email().max(320),
  password: PasswordSchema,
});
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>;

/** Sign in with email + password. Answered identically for an unknown address
 * and a wrong password — see the route's doc comment. */
export const PasswordSignInRequestSchema = z.object({
  email: z.string().email().max(320),
  /** Deliberately NOT `PasswordSchema`: rejecting a short password at sign-in
   * would tell a caller that the stored one is longer, and would lock out any
   * account whose password predates a future policy change. Bounded only. */
  password: z.string().min(1).max(200),
});
export type PasswordSignInRequest = z.infer<typeof PasswordSignInRequestSchema>;

/** Ask for a password-reset token. Always answered identically whether or not
 * the address has an account. */
export const PasswordResetRequestSchema = z.object({
  email: z.string().email().max(320),
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

/** Spend a reset token on a new password. Signs the user in on success: they
 * have just proved inbox possession, which is the same proof magic link
 * accepts, so making them sign in again immediately proves nothing. */
export const PasswordResetConfirmSchema = z.object({
  token: z.string().min(16).max(256),
  password: PasswordSchema,
});
export type PasswordResetConfirm = z.infer<typeof PasswordResetConfirmSchema>;

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
  | 'magic_link_unavailable'
  /** Password sign-in failed. Covers unknown address, wrong password, and an
   * account that has no password set, for the same oracle reason as
   * `invalid_token` (ADR-0012). */
  | 'invalid_credentials'
  /** Signup only. The one place the API does distinguish — see ADR-0012's
   * Consequences for why that tradeoff is taken here and nowhere else. */
  | 'email_in_use';
