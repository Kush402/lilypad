import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from '../config.js';

/**
 * Verification of Apple / Google ID tokens ([ADR-0001](../../../../docs/adr/0001-account-authentication.md)).
 *
 * The client performs the interactive sign-in with the provider and hands us
 * the resulting ID token. Everything that makes that safe happens here:
 *
 * - **Signature** against the provider's published JWKS, so a forged token
 *   fails. `jose` handles key rotation and caching.
 * - **Issuer**, so a token from some other identity provider is not accepted.
 * - **Audience** against our own client ids, so an ID token minted for a
 *   DIFFERENT app cannot be replayed here to sign its bearer into Lilypad.
 *   This is the check people most often omit, and omitting it means any app
 *   the user has ever signed into can impersonate them to us.
 * - **Algorithms**, pinned to the asymmetric families the providers actually
 *   use, so `alg` confusion cannot downgrade the check.
 * - **Email verification status**, surfaced but not trusted here — the linking
 *   rule lives in `accounts.ts`, which refuses to attach an unverified address
 *   to an existing account.
 */

export type OAuthProvider = 'apple' | 'google';

export interface ProviderIdentity {
  provider: OAuthProvider;
  /** The provider's `sub`. Stable for (provider, app, user) forever, which is
   * why it — and not the email — is the account key. */
  subject: string;
  /** Apple omits this on every sign-in after the first authorization, so it is
   * genuinely optional rather than defensive. */
  email: string | null;
  emailVerified: boolean;
}

export type ProviderFailure = 'not_configured' | 'invalid_token';

export type ProviderResult =
  { ok: true; identity: ProviderIdentity } | { ok: false; reason: ProviderFailure };

interface ProviderSpec {
  issuer: string | string[];
  jwksUrl: string;
  audiences: () => string[];
}

const PROVIDERS: Record<OAuthProvider, ProviderSpec> = {
  apple: {
    issuer: 'https://appleid.apple.com',
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    audiences: () => splitList(config.env.APPLE_CLIENT_IDS),
  },
  google: {
    // Google mints both spellings and treats them as equivalent; accepting
    // only one would reject valid tokens depending on which surface issued
    // them.
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    audiences: () => splitList(config.env.GOOGLE_CLIENT_IDS),
  },
};

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Remote JWKS resolvers are created once per provider: each caches keys and
 * rate-limits its own refetches, so rebuilding one per request would defeat
 * both and hammer the provider. */
const remoteKeys = new Map<OAuthProvider, JWTVerifyGetKey>();

function keysFor(provider: OAuthProvider): JWTVerifyGetKey {
  let resolver = remoteKeys.get(provider);
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL(PROVIDERS[provider].jwksUrl));
    remoteKeys.set(provider, resolver);
  }
  return resolver;
}

/** Is this provider usable, i.e. does it have at least one audience configured? */
export function isProviderConfigured(provider: OAuthProvider): boolean {
  return PROVIDERS[provider].audiences().length > 0;
}

/**
 * Verify a provider ID token and extract the identity it asserts.
 *
 * `getKey` is injectable so tests can verify against a locally generated
 * keypair — the alternative is either mocking the network or not testing the
 * verification rules at all, and these are exactly the rules that must be
 * tested.
 */
export async function verifyProviderToken(
  provider: OAuthProvider,
  idToken: string,
  getKey: JWTVerifyGetKey = keysFor(provider),
): Promise<ProviderResult> {
  const spec = PROVIDERS[provider];
  const audiences = spec.audiences();
  if (audiences.length === 0) return { ok: false, reason: 'not_configured' };

  try {
    const { payload } = await jwtVerify(idToken, getKey, {
      issuer: spec.issuer,
      audience: audiences,
      algorithms: ['RS256', 'ES256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      return { ok: false, reason: 'invalid_token' };
    }
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    return {
      ok: true,
      identity: {
        provider,
        subject: payload.sub,
        email,
        emailVerified: isVerified(payload.email_verified),
      },
    };
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }
}

/** Apple sends `email_verified` as the STRING "true" in some responses and as
 * a boolean in others. Anything else is treated as unverified — this value
 * decides whether an identity may attach to an existing account, so it fails
 * closed. */
function isVerified(claim: unknown): boolean {
  return claim === true || claim === 'true';
}
