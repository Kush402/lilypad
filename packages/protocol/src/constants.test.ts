import { describe, it, expect } from 'vitest';
import {
  RECONNECT_BACKOFF_MS,
  MAX_SIGNALING_RECONNECTS,
  reconnectBackoffMs,
  jitteredBackoffMs,
  BACKEND_REREGISTER_GRACE_MS,
} from './constants.js';

describe('reconnectBackoffMs', () => {
  it('follows the published schedule and holds at its last entry', () => {
    RECONNECT_BACKOFF_MS.forEach((ms, i) => expect(reconnectBackoffMs(i)).toBe(ms));
    expect(reconnectBackoffMs(99)).toBe(RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1]);
    expect(reconnectBackoffMs(-1)).toBe(RECONNECT_BACKOFF_MS[0]);
  });

  it('keeps the whole retry budget inside the backend reregister grace', () => {
    // The invariant the cross-tier comment in constants.ts describes: a client
    // must finish retrying before the backend reaps the seat it is trying to
    // reclaim. Asserted rather than described, so changing one number fails.
    let worstCase = 0;
    for (let i = 0; i < MAX_SIGNALING_RECONNECTS; i++) worstCase += reconnectBackoffMs(i);
    expect(worstCase).toBeLessThan(BACKEND_REREGISTER_GRACE_MS);
  });
});

describe('jitteredBackoffMs', () => {
  it('never exceeds the scheduled delay, so the budget above still holds', () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
        expect(jitteredBackoffMs(attempt, () => r)).toBeLessThanOrEqual(
          reconnectBackoffMs(attempt),
        );
      }
    }
  });

  it('never collapses to an immediate retry — the storm it exists to prevent', () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      expect(jitteredBackoffMs(attempt, () => 0)).toBe(reconnectBackoffMs(attempt) / 2);
    }
  });

  it('spreads a herd across the window instead of landing together', () => {
    const values = new Set(Array.from({ length: 200 }, () => jitteredBackoffMs(3)));
    // 200 clients backing off from one restart must not all pick one delay.
    expect(values.size).toBeGreaterThan(50);
  });
});
