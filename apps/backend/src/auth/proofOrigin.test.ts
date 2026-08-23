import { describe, it, expect } from 'vitest';
import { parseProofHosts, allowedProofHosts, isProofOriginAllowed } from './proofOrigin.js';

/**
 * The check that makes a v2 device proof worth signing.
 *
 * Binding the server into the signature only helps if the server then refuses
 * signatures naming anyone else — so the interesting cases here are all
 * refusals, and the most important one is what happens when the server has no
 * idea who it is.
 */

describe('parseProofHosts', () => {
  it('reads a comma-separated list, trimming and lowercasing', () => {
    expect(parseProofHosts(' API.Example.com , lan.local:8080 ')).toEqual([
      'api.example.com',
      'lan.local:8080',
    ]);
  });

  it('drops blanks rather than inventing an unmatchable host', () => {
    expect(parseProofHosts('a.example,,  ,b.example')).toEqual(['a.example', 'b.example']);
    expect(parseProofHosts('')).toEqual([]);
    expect(parseProofHosts(undefined)).toEqual([]);
  });
});

describe('allowedProofHosts', () => {
  it('takes the host out of the URLs the server advertises', () => {
    const hosts = allowedProofHosts({
      publicBaseUrl: 'https://api.takedia.com',
      advertisedApiBaseUrl: 'https://tunnel.example.com',
    });
    expect([...hosts].sort()).toEqual(['api.takedia.com', 'tunnel.example.com']);
  });

  it('keeps the port, because :8080 and :443 are different servers', () => {
    const hosts = allowedProofHosts({ publicBaseUrl: 'http://192.168.1.50:8080' });
    expect(hosts.has('192.168.1.50:8080')).toBe(true);
    expect(hosts.has('192.168.1.50')).toBe(false);
  });

  it('accepts the extra list as bare hosts or as URLs', () => {
    const hosts = allowedProofHosts({
      extraHosts: 'lan.local:8080, https://second-name.example',
    });
    expect([...hosts].sort()).toEqual(['lan.local:8080', 'second-name.example']);
  });

  it('ignores an unparseable entry instead of storing something unmatchable', () => {
    const hosts = allowedProofHosts({ publicBaseUrl: 'not a url', advertisedApiBaseUrl: null });
    expect(hosts.size).toBe(0);
  });

  it('is a set, so the usual case of one URL twice is one host', () => {
    const hosts = allowedProofHosts({
      publicBaseUrl: 'https://api.takedia.com',
      advertisedApiBaseUrl: 'https://api.takedia.com/',
      extraHosts: 'API.TAKEDIA.COM',
    });
    expect([...hosts]).toEqual(['api.takedia.com']);
  });
});

describe('isProofOriginAllowed', () => {
  const allowed = allowedProofHosts({ publicBaseUrl: 'https://api.takedia.com' });

  it('accepts the server’s own host', () => {
    expect(isProofOriginAllowed('api.takedia.com', allowed)).toBe(true);
    expect(isProofOriginAllowed('API.Takedia.com', allowed)).toBe(true);
  });

  it('refuses a host that is not this server — the whole point', () => {
    expect(isProofOriginAllowed('evil.example', allowed)).toBe(false);
    // Suffix and prefix games on the real name.
    expect(isProofOriginAllowed('api.takedia.com.evil.example', allowed)).toBe(false);
    expect(isProofOriginAllowed('evil-api.takedia.com', allowed)).toBe(false);
    expect(isProofOriginAllowed('api.takedia.com:8080', allowed)).toBe(false);
  });

  it('fails closed when the server cannot say who it is', () => {
    // An empty set means PUBLIC_BASE_URL was unset and nothing was configured.
    // Accepting anything here would make the signature name a server without
    // anyone checking it — the exact hole v2 exists to close.
    expect(isProofOriginAllowed('api.takedia.com', new Set())).toBe(false);
  });
});
