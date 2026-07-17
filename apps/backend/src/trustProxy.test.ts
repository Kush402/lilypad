import { describe, it, expect } from 'vitest';
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

  it('parses a bare integer as a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
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
});
