import { describe, it, expect, beforeAll, vi } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey, JWTVerifyGetKey } from 'jose';
import type * as ProvidersModule from './providers.js';

/**
 * These tests verify the rules that stop a *valid* token from somewhere else
 * being accepted here — audience, issuer, algorithm. Signature checking is
 * jose's job and is not re-tested; what is tested is that we asked jose the
 * right questions.
 *
 * The provider audiences are read from env at call time, so they are set
 * before the module is imported. `verifyProviderToken` takes an injectable key
 * resolver precisely so this can run against a local keypair instead of the
 * network.
 */

process.env.APPLE_CLIENT_IDS = 'com.lilypad.ios,com.lilypad.services';
process.env.GOOGLE_CLIENT_IDS = 'google-ios-client-id';

type Providers = typeof ProvidersModule;
let providers: Providers;
let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  providers = await import('./providers.js');
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  getKey = () => Promise.resolve(pair.publicKey);
});

interface TokenOptions {
  issuer?: string;
  audience?: string;
  subject?: string;
  expiresIn?: string;
  claims?: Record<string, unknown>;
  alg?: 'RS256';
}

function mint(options: TokenOptions = {}): Promise<string> {
  return new SignJWT(options.claims ?? {})
    .setProtectedHeader({ alg: options.alg ?? 'RS256' })
    .setSubject(options.subject ?? 'provider-subject-1')
    .setIssuer(options.issuer ?? 'https://appleid.apple.com')
    .setAudience(options.audience ?? 'com.lilypad.ios')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '10m')
    .sign(privateKey);
}

describe('verifyProviderToken', () => {
  it('accepts a well-formed Apple token and extracts the identity', async () => {
    const token = await mint({ claims: { email: 'Ada@Example.com', email_verified: true } });
    const result = await providers.verifyProviderToken('apple', token, getKey);
    expect(result).toEqual({
      ok: true,
      identity: {
        provider: 'apple',
        subject: 'provider-subject-1',
        email: 'ada@example.com', // normalized — addresses are matched case-insensitively
        emailVerified: true,
      },
    });
  });

  it('accepts every configured audience for a provider', async () => {
    const token = await mint({ audience: 'com.lilypad.services' });
    expect((await providers.verifyProviderToken('apple', token, getKey)).ok).toBe(true);
  });

  // The check that stops an ID token minted for a DIFFERENT app being replayed
  // here to sign its bearer into Lilypad.
  it('rejects a token minted for another app', async () => {
    const token = await mint({ audience: 'com.someone-else.app' });
    expect(await providers.verifyProviderToken('apple', token, getKey)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });

  it('rejects a token from the wrong issuer', async () => {
    const token = await mint({ issuer: 'https://evil.example.com' });
    expect(await providers.verifyProviderToken('apple', token, getKey)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });

  it('rejects an expired token', async () => {
    const token = await mint({ expiresIn: '-1s' });
    expect(await providers.verifyProviderToken('apple', token, getKey)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });

  it('rejects an Apple token presented as a Google one', async () => {
    const token = await mint({ issuer: 'https://appleid.apple.com' });
    expect(await providers.verifyProviderToken('google', token, getKey)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });

  it('accepts both spellings of the Google issuer', async () => {
    for (const issuer of ['https://accounts.google.com', 'accounts.google.com']) {
      const token = await mint({ issuer, audience: 'google-ios-client-id' });
      expect((await providers.verifyProviderToken('google', token, getKey)).ok).toBe(true);
    }
  });

  // Apple sends this as a string in some responses and a boolean in others.
  it.each([
    [true, true],
    ['true', true],
    [false, false],
    ['false', false],
    [undefined, false],
    ['yes', false],
  ])('reads email_verified %j as %j', async (claim, expected) => {
    const token = await mint({
      claims: {
        email: 'ada@example.com',
        ...(claim === undefined ? {} : { email_verified: claim }),
      },
    });
    const result = await providers.verifyProviderToken('apple', token, getKey);
    expect(result.ok && result.identity.emailVerified).toBe(expected);
  });

  it('tolerates a token with no email at all (Apple omits it after first sign-in)', async () => {
    const token = await mint();
    const result = await providers.verifyProviderToken('apple', token, getKey);
    expect(result.ok && result.identity.email).toBeNull();
  });

  // `config.env` is memoized at first load, so this needs a genuinely fresh
  // module graph rather than a mutated `process.env`.
  it('reports an unconfigured provider distinctly from a bad token', async () => {
    process.env.GOOGLE_CLIENT_IDS = '';
    vi.resetModules();
    try {
      const fresh: Providers = await import('./providers.js');
      const token = await mint({ issuer: 'https://accounts.google.com' });
      expect(await fresh.verifyProviderToken('google', token, getKey)).toEqual({
        ok: false,
        reason: 'not_configured',
      });
      expect(fresh.isProviderConfigured('google')).toBe(false);
      expect(fresh.isProviderConfigured('apple')).toBe(true);
    } finally {
      process.env.GOOGLE_CLIENT_IDS = 'google-ios-client-id';
      vi.resetModules();
    }
  });
});
