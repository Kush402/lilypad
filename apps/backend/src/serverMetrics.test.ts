import { describe, it, expect } from 'vitest';
import { SlidingCounter, LatencyRing, serverMetrics, observeResponse } from './serverMetrics.js';

describe('SlidingCounter', () => {
  it('drops what falls out of the window', () => {
    let now = 0;
    const c = new SlidingCounter(5, () => now);
    c.add();
    expect(c.value()).toBe(1);
    now += 4 * 60_000; // still inside a 5-minute window
    c.add();
    expect(c.value()).toBe(2);
    now += 2 * 60_000; // the first sample is now older than the window
    expect(c.value()).toBe(1);
    now += 10 * 60_000;
    expect(c.value()).toBe(0);
  });

  it('holds nothing once its window has passed', () => {
    let now = 0;
    const c = new SlidingCounter(2, () => now);
    for (let i = 0; i < 100; i++) {
      now += 60_000;
      c.add();
    }
    // Two minutes of buckets, not a hundred — an idle-but-long-lived process
    // must not accumulate memory here.
    expect(c.value()).toBe(2);
  });
});

describe('LatencyRing', () => {
  it('is null until it has seen anything', () => {
    expect(new LatencyRing(4).quantile(0.95)).toBeNull();
  });

  it('reports a percentile that a mean would hide', () => {
    const r = new LatencyRing(100);
    for (let i = 0; i < 95; i++) r.observe(10);
    for (let i = 0; i < 5; i++) r.observe(9000);
    expect(r.quantile(0.5)).toBe(10);
    expect(r.quantile(0.95)).toBe(10);
    expect(r.quantile(0.99)).toBe(9000);
  });

  it('keeps only the most recent samples', () => {
    const r = new LatencyRing(3);
    r.observe(1000);
    r.observe(1);
    r.observe(1);
    r.observe(1); // evicts the 1000
    expect(r.quantile(1)).toBe(1);
  });
});

describe('observeResponse', () => {
  it('counts 401 and 403 as auth failures as well as 4xx', () => {
    const before = serverMetrics.snapshot();
    observeResponse(401, 5);
    observeResponse(403, 5);
    observeResponse(400, 5);
    const after = serverMetrics.snapshot();
    expect(after.authFailures).toBe((before.authFailures as number) + 2);
    expect(after.denied4xx).toBe((before.denied4xx as number) + 3);
    expect(after.errors5xx).toBe(before.errors5xx);
  });

  it('counts 429 separately, so a rate-limit storm is distinguishable', () => {
    const before = serverMetrics.snapshot();
    observeResponse(429, 1);
    expect(serverMetrics.snapshot().rateLimited).toBe((before.rateLimited as number) + 1);
  });

  it('counts 5xx as errors and not as denials', () => {
    const before = serverMetrics.snapshot();
    observeResponse(503, 1);
    const after = serverMetrics.snapshot();
    expect(after.errors5xx).toBe((before.errors5xx as number) + 1);
    expect(after.denied4xx).toBe(before.denied4xx);
  });
});
