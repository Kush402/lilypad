import { describe, it, expect } from 'vitest';
import { hashForLog, createLogHasher } from './logging.js';

describe('hashForLog', () => {
  it('is stable for the same value within one process', () => {
    expect(hashForLog('203.0.113.42')).toBe(hashForLog('203.0.113.42'));
    expect(hashForLog('user@example.com')).toBe(hashForLog('user@example.com'));
  });

  it('differs for different raw values', () => {
    expect(hashForLog('203.0.113.42')).not.toBe(hashForLog('198.51.100.7'));
    expect(hashForLog('a@example.com')).not.toBe(hashForLog('b@example.com'));
  });

  it('never leaks the raw value into the hashed output', () => {
    const raw = 'super-secret-user@example.com';
    const hashed = hashForLog(raw);
    expect(hashed).not.toContain(raw);
    expect(hashed.toLowerCase()).not.toContain(raw.toLowerCase());
    // Short hex correlator, not a re-encoding of the input.
    expect(hashed).toMatch(/^[0-9a-f]{12}$/);
  });

  it('differs across salts — the same raw value hashes differently under a different (e.g. post-restart) salt', () => {
    const salt1 = createLogHasher('salt-one');
    const salt2 = createLogHasher('salt-two');
    expect(salt1('203.0.113.42')).not.toBe(salt2('203.0.113.42'));
  });

  it('a hasher bound to the same salt is fully deterministic', () => {
    const a = createLogHasher('same-salt');
    const b = createLogHasher('same-salt');
    expect(a('203.0.113.42')).toBe(b('203.0.113.42'));
  });
});
