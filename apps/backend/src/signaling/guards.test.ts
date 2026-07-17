import { describe, it, expect } from 'vitest';
import { IpConnectionLimiter, TokenBucket, isUnexpectedBrowserOrigin } from './guards.js';

describe('IpConnectionLimiter', () => {
  it('caps concurrent connections per IP and releases slots', () => {
    const lim = new IpConnectionLimiter(2);
    expect(lim.acquire('1.1.1.1')).toBe(true);
    expect(lim.acquire('1.1.1.1')).toBe(true);
    expect(lim.acquire('1.1.1.1')).toBe(false); // at cap
    // A different IP is unaffected.
    expect(lim.acquire('2.2.2.2')).toBe(true);
    // Releasing frees a slot.
    lim.release('1.1.1.1');
    expect(lim.acquire('1.1.1.1')).toBe(true);
    expect(lim.count('1.1.1.1')).toBe(2);
  });

  it('never underflows on extra releases', () => {
    const lim = new IpConnectionLimiter(1);
    lim.release('9.9.9.9'); // no-op
    expect(lim.count('9.9.9.9')).toBe(0);
    expect(lim.acquire('9.9.9.9')).toBe(true);
  });
});

describe('TokenBucket', () => {
  it('allows a burst up to capacity then rejects', () => {
    const now = 0;
    const b = new TokenBucket(3, 1, () => now);
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false); // empty
  });

  it('refills over time at the configured rate', () => {
    let now = 0;
    const b = new TokenBucket(2, 10, () => now); // 10 tokens/sec
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false);
    now = 200; // 0.2s → +2 tokens (capped at 2)
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false);
  });

  it('caps refill at capacity (no unbounded accumulation)', () => {
    let now = 0;
    const b = new TokenBucket(5, 100, () => now);
    now = 10_000; // huge idle → would be 1000 tokens uncapped
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (b.allow()) allowed++;
    expect(allowed).toBe(5); // never exceeds capacity
  });
});

describe('isUnexpectedBrowserOrigin', () => {
  it('flags a cross-host Origin header (browser-originated traffic)', () => {
    expect(isUnexpectedBrowserOrigin('https://evil.example', 'backend.lilypad.dev')).toBe(true);
  });

  it('does not flag a request with no Origin header (the Tauri desktop client)', () => {
    expect(isUnexpectedBrowserOrigin(undefined, 'backend.lilypad.dev')).toBe(false);
  });

  it('does not flag a same-host Origin (React Native iOS derives one from the ws URL)', () => {
    expect(isUnexpectedBrowserOrigin('http://192.168.0.173:8080', '192.168.0.173:8080')).toBe(
      false,
    );
  });

  it('flags a same-hostname Origin on a different port', () => {
    expect(isUnexpectedBrowserOrigin('http://192.168.0.173:9999', '192.168.0.173:8080')).toBe(
      true,
    );
  });

  it('flags a malformed Origin', () => {
    expect(isUnexpectedBrowserOrigin('not a url', '192.168.0.173:8080')).toBe(true);
  });

  it('flags an Origin when the Host header is missing (cannot verify sameness)', () => {
    expect(isUnexpectedBrowserOrigin('http://192.168.0.173:8080', undefined)).toBe(true);
  });
});
