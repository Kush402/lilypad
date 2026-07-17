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
});
