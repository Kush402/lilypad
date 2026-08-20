import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { signAccessToken, verifyAccessToken, bearerToken } from './tokens.js';
import { config } from '../config.js';

const key = () => new TextEncoder().encode(config.env.AUTH_TOKEN_SECRET);

describe('access tokens', () => {
  it('round-trips an actor', async () => {
    const token = await signAccessToken({ userId: 'user-1', deviceId: 'device-1' });
    expect(await verifyAccessToken(token)).toMatchObject({
      userId: 'user-1',
      deviceId: 'device-1',
    });
  });

  it('carries a null deviceId for browser sessions', async () => {
    const token = await signAccessToken({ userId: 'user-1', deviceId: null });
    expect(await verifyAccessToken(token)).toMatchObject({ userId: 'user-1', deviceId: null });
  });

  it('reports when it was minted, which is what bounds a stale credential', async () => {
    // `/devices/enroll` compares this against the device row's `revoked_at`,
    // because enrolling clears that column: without it, a token minted before a
    // revocation could undo the revocation permanently.
    const before = Date.now();
    const token = await signAccessToken({ userId: 'user-1', deviceId: null });
    const actor = await verifyAccessToken(token);
    expect(actor?.issuedAt).toBeInstanceOf(Date);
    // `iat` has one-second resolution, so it can round down past `before`.
    expect(actor!.issuedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(actor!.issuedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('rejects a token whose payload was tampered with', async () => {
    const token = await signAccessToken({ userId: 'user-1', deviceId: null });
    const [header, payload, signature] = token.split('.');
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    forged.sub = 'user-2';
    const swapped = Buffer.from(JSON.stringify(forged)).toString('base64url');
    expect(await verifyAccessToken(`${header}.${swapped}.${signature}`)).toBeNull();
  });

  it('rejects a token signed with a different key', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('lilypad')
      .setAudience('lilypad-api')
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('a-completely-different-signing-secret'));
    expect(await verifyAccessToken(token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signAccessToken({ userId: 'user-1', deviceId: null }, -1);
    expect(await verifyAccessToken(token)).toBeNull();
  });

  it('rejects a token minted for a different audience', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('lilypad')
      .setAudience('some-other-api')
      .setExpirationTime('10m')
      .sign(key());
    expect(await verifyAccessToken(token)).toBeNull();
  });

  it('rejects a token from a different issuer', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('not-lilypad')
      .setAudience('lilypad-api')
      .setExpirationTime('10m')
      .sign(key());
    expect(await verifyAccessToken(token)).toBeNull();
  });

  // The classic JWT break: strip the signature and claim the token needs none.
  // Pinning `algorithms: ['HS256']` is what makes this fail.
  it('rejects an unsigned `alg: none` token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'user-1',
        iss: 'lilypad',
        aud: 'lilypad-api',
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');
    expect(await verifyAccessToken(`${header}.${payload}.`)).toBeNull();
  });

  it('rejects a token with no subject', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('lilypad')
      .setAudience('lilypad-api')
      .setExpirationTime('10m')
      .sign(key());
    expect(await verifyAccessToken(token)).toBeNull();
  });

  it('rejects a non-string device claim rather than coercing it', async () => {
    const token = await new SignJWT({ did: 42 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('lilypad')
      .setAudience('lilypad-api')
      .setExpirationTime('10m')
      .sign(key());
    expect(await verifyAccessToken(token)).toBeNull();
  });

  it.each(['', 'not a jwt', 'a.b.c'])('rejects malformed input %j', async (garbage) => {
    expect(await verifyAccessToken(garbage)).toBeNull();
  });
});

describe('bearerToken', () => {
  it.each([
    ['Bearer abc123', 'abc123'],
    ['bearer abc123', 'abc123'],
    ['BEARER   abc123', 'abc123'],
    ['  Bearer abc123  ', 'abc123'],
  ])('extracts from %j', (header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });

  it.each([undefined, '', 'abc123', 'Basic abc123', 'Bearer'])('returns null for %j', (header) => {
    expect(bearerToken(header)).toBeNull();
  });
});
