import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { generateTurnCredential, buildIceServers, DEFAULT_TTL_SECONDS } from './credentials.js';

const SECRET = 'unit-test-secret';
const NOW = 1_700_000_000_000; // fixed ms for determinism

describe('TURN credentials (coturn use-auth-secret)', () => {
  it('produces a time-limited HMAC-SHA1 credential coturn can re-derive', () => {
    const c = generateTurnCredential({
      secret: SECRET,
      ttlSeconds: 3600,
      now: NOW,
      label: 'sess-1',
    });
    const expectedExpiry = Math.floor(NOW / 1000) + 3600;
    expect(c.username).toBe(`${expectedExpiry}:sess-1`);
    expect(c.expiresAt).toBe(expectedExpiry);

    // coturn recomputes exactly this from static-auth-secret.
    const expected = createHmac('sha1', SECRET).update(c.username).digest('base64');
    expect(c.credential).toBe(expected);
  });

  it('omits the label when none is given', () => {
    const c = generateTurnCredential({ secret: SECRET, ttlSeconds: 60, now: NOW });
    expect(c.username).toBe(`${Math.floor(NOW / 1000) + 60}`);
  });

  it('expiry advances with the ttl', () => {
    const a = generateTurnCredential({ secret: SECRET, ttlSeconds: 60, now: NOW });
    const b = generateTurnCredential({ secret: SECRET, ttlSeconds: 120, now: NOW });
    expect(b.expiresAt - a.expiresAt).toBe(60);
  });

  // Shrinks the leak-exposure window a leaked credential creates (e.g. via
  // Finding 3's plaintext-signaling gap) — see
  // docs/audit/m3/backend-security.md Finding 7.
  it('defaults to a 5-minute TTL, not the old 1-hour default', () => {
    const c = generateTurnCredential({ secret: SECRET, now: NOW });
    expect(c.ttlSeconds).toBe(300);
    expect(DEFAULT_TTL_SECONDS).toBe(300);
  });

  it('buildIceServers returns STUN first + an authenticated TURN server', () => {
    const { iceServers, credential } = buildIceServers({
      secret: SECRET,
      now: NOW,
      label: 'sess-2',
    });
    expect(iceServers.length).toBeGreaterThanOrEqual(2);

    const stun = iceServers.find((s) => String(s.urls).startsWith('stun'));
    const turn = iceServers.find((s) => String(s.urls).startsWith('turn'));
    expect(stun).toBeDefined();
    expect(turn?.username).toBe(credential.username);
    expect(turn?.credential).toBe(credential.credential);
  });

  it('always includes public STUN fallback for off-LAN paths', () => {
    const { iceServers } = buildIceServers({ secret: SECRET, now: NOW });
    const flat = iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(flat).toContain('stun:stun.l.google.com:19302');
  });

  it('advertises a public TURN relay only when all three vars are configured', async () => {
    const { env } = await import('../config.js');
    const orig = {
      url: env.PUBLIC_TURN_URL,
      user: env.PUBLIC_TURN_USERNAME,
      cred: env.PUBLIC_TURN_CREDENTIAL,
    };
    try {
      // Not configured → no public TURN entry.
      (env as { PUBLIC_TURN_URL: string }).PUBLIC_TURN_URL = '';
      let servers = buildIceServers({ secret: SECRET, now: NOW }).iceServers;
      expect(servers.find((s) => s.urls === 'turn:relay.example:3478')).toBeUndefined();

      // All three set → advertised with the static credential.
      (env as { PUBLIC_TURN_URL: string }).PUBLIC_TURN_URL = 'turn:relay.example:3478';
      (env as { PUBLIC_TURN_USERNAME: string }).PUBLIC_TURN_USERNAME = 'user1';
      (env as { PUBLIC_TURN_CREDENTIAL: string }).PUBLIC_TURN_CREDENTIAL = 'pass1';
      servers = buildIceServers({ secret: SECRET, now: NOW }).iceServers;
      const relay = servers.find((s) => s.urls === 'turn:relay.example:3478');
      expect(relay).toMatchObject({ username: 'user1', credential: 'pass1' });

      // Comma-separated URL list → one entry advertising every transport
      // variant (cellular carriers often block UDP:80; TCP 443 survives).
      (env as { PUBLIC_TURN_URL: string }).PUBLIC_TURN_URL =
        'turn:relay.example:80, turn:relay.example:443?transport=tcp ,';
      servers = buildIceServers({ secret: SECRET, now: NOW }).iceServers;
      const multi = servers.find((s) => Array.isArray(s.urls) && s.username === 'user1');
      expect(multi).toMatchObject({
        urls: ['turn:relay.example:80', 'turn:relay.example:443?transport=tcp'],
        username: 'user1',
        credential: 'pass1',
      });
    } finally {
      (env as { PUBLIC_TURN_URL: string }).PUBLIC_TURN_URL = orig.url;
      (env as { PUBLIC_TURN_USERNAME: string }).PUBLIC_TURN_USERNAME = orig.user;
      (env as { PUBLIC_TURN_CREDENTIAL: string }).PUBLIC_TURN_CREDENTIAL = orig.cred;
    }
  });

  it('advertises the public TURN relay with the generated HMAC credential when static creds are absent (self-hosted coturn, shared TURN_SECRET)', async () => {
    const { env } = await import('../config.js');
    const orig = {
      url: env.PUBLIC_TURN_URL,
      user: env.PUBLIC_TURN_USERNAME,
      cred: env.PUBLIC_TURN_CREDENTIAL,
    };
    try {
      (env as { PUBLIC_TURN_URL: string }).PUBLIC_TURN_URL = 'turn:relay.example:3478';
      (env as { PUBLIC_TURN_USERNAME: string }).PUBLIC_TURN_USERNAME = '';
      (env as { PUBLIC_TURN_CREDENTIAL: string }).PUBLIC_TURN_CREDENTIAL = '';

      const { iceServers, credential } = buildIceServers({ secret: SECRET, now: NOW });
      const relay = iceServers.find((s) => s.urls === 'turn:relay.example:3478');
      expect(relay).toMatchObject({
        username: credential.username,
        credential: credential.credential,
      });
    } finally {
      (env as { PUBLIC_TURN_URL: string }).PUBLIC_TURN_URL = orig.url;
      (env as { PUBLIC_TURN_USERNAME: string }).PUBLIC_TURN_USERNAME = orig.user;
      (env as { PUBLIC_TURN_CREDENTIAL: string }).PUBLIC_TURN_CREDENTIAL = orig.cred;
    }
  });
});
