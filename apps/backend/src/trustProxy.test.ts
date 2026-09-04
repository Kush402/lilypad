import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { parseTrustProxy } from './trustProxy.js';

describe('parseTrustProxy', () => {
  it('defaults an empty string to false — trust no proxy', () => {
    expect(parseTrustProxy('')).toBe(false);
  });

  it('trims whitespace before treating it as empty', () => {
    expect(parseTrustProxy('   ')).toBe(false);
  });

  it('parses "true"/"false" as booleans', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('migrates the documented one-hop setting to address-bound local proxies', () => {
    expect(parseTrustProxy('1')).toBe('loopback, linklocal, uniquelocal');
  });

  it('treats a zero hop count as trusting no proxy', () => {
    expect(parseTrustProxy('0')).toBe(false);
  });

  it('rejects larger hop counts instead of trusting a caller-controlled chain', () => {
    expect(() => parseTrustProxy('2')).toThrow(/numeric TRUST_PROXY/);
  });

  it('passes a single IP through as an allowlist string', () => {
    expect(parseTrustProxy('10.0.0.5')).toBe('10.0.0.5');
  });

  it('passes a CIDR through as an allowlist string', () => {
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });

  it('passes a comma-separated list through untouched', () => {
    expect(parseTrustProxy('10.0.0.1,10.0.0.2')).toBe('10.0.0.1,10.0.0.2');
  });

  it('accepts forwarding from a local connector but ignores it from a public caller', async () => {
    const app = Fastify({ trustProxy: parseTrustProxy('1') });
    app.get('/', async (request) => ({ ip: request.ip }));

    const throughConnector = await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '172.20.0.2',
      headers: { 'x-forwarded-for': '203.0.113.8' },
    });
    expect(throughConnector.json()).toEqual({ ip: '203.0.113.8' });

    const direct = await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '198.51.100.4',
      headers: { 'x-forwarded-for': '203.0.113.8' },
    });
    expect(direct.json()).toEqual({ ip: '198.51.100.4' });

    await app.close();
  });
});
