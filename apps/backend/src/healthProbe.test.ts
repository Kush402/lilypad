import { describe, it, expect } from 'vitest';
import { withProbeTimeout } from './db/client.js';

/**
 * `/health` must always answer, even when a dependency is hung rather than
 * refusing. Observed on production during a deliberate Redis outage: the
 * endpoint stopped responding instead of reporting "degraded", and a monitor
 * cannot tell a hung health endpoint from an unreachable host.
 */
describe('withProbeTimeout', () => {
  it('passes a healthy probe straight through', async () => {
    expect(await withProbeTimeout(Promise.resolve(true))).toBe(true);
  });

  it('reports a rejecting dependency as down rather than throwing', async () => {
    expect(await withProbeTimeout(Promise.reject(new Error('ECONNREFUSED')))).toBe(false);
  });

  it('reports a HUNG dependency as down instead of hanging with it', async () => {
    const started = Date.now();
    // A promise that never settles — a socket that accepted and went quiet.
    const result = await withProbeTimeout(new Promise<boolean>(() => {}));
    expect(result).toBe(false);
    // Well under any sane HTTP client timeout, which is the whole point.
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
