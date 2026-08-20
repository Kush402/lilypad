/**
 * Windowed request metrics.
 *
 * `/metrics` exposed five monotonic signaling counters and nothing about the
 * HTTP surface: no error rate, no latency, no view of authentication failures.
 * A watchdog polling that endpoint could tell whether the process was alive
 * and nothing else, which is the difference between "the API is up" and "the
 * API is working".
 *
 * Values are WINDOWED rather than monotonic on purpose. A monotonic counter
 * only becomes a rate if the reader remembers the previous scrape, and the
 * reader here is a scheduled job with no memory between runs. Answering "how
 * many 5xx in the last five minutes" server-side keeps the alerting rule where
 * a human can read it and needs no state anywhere else.
 */

/** One minute of buckets, so a 5-minute window costs 5 integers. */
const BUCKET_MS = 60_000;

/** A count over a sliding window of whole minutes. Old buckets are dropped
 * lazily on write and on read, so an idle process holds nothing. */
export class SlidingCounter {
  private readonly buckets = new Map<number, number>();

  constructor(
    private readonly windowMinutes: number,
    private readonly now: () => number = Date.now,
  ) {}

  add(n = 1): void {
    const bucket = Math.floor(this.now() / BUCKET_MS);
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + n);
    this.evict(bucket);
  }

  value(): number {
    const current = Math.floor(this.now() / BUCKET_MS);
    this.evict(current);
    let total = 0;
    for (const n of this.buckets.values()) total += n;
    return total;
  }

  private evict(current: number): void {
    const oldest = current - this.windowMinutes + 1;
    for (const bucket of this.buckets.keys()) {
      if (bucket < oldest) this.buckets.delete(bucket);
    }
  }
}

/**
 * Recent request durations, for a percentile that means something.
 *
 * A mean hides exactly the case worth alerting on: a handful of requests
 * taking ten seconds while the rest are fast. A fixed ring of the last N
 * samples gives a real p95 for a few KB and no dependency.
 */
export class LatencyRing {
  private readonly samples: number[];
  private next = 0;
  private filled = 0;

  constructor(private readonly capacity = 512) {
    this.samples = new Array<number>(capacity).fill(0);
  }

  observe(ms: number): void {
    this.samples[this.next] = ms;
    this.next = (this.next + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /** @param q quantile in [0,1]. Returns null until there is anything to rank. */
  quantile(q: number): number | null {
    if (this.filled === 0) return null;
    const sorted = this.samples.slice(0, this.filled).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return Math.round(sorted[idx]!);
  }
}

const WINDOW_MINUTES = 5;

export const serverMetrics = {
  requests: new SlidingCounter(WINDOW_MINUTES),
  errors5xx: new SlidingCounter(WINDOW_MINUTES),
  denied4xx: new SlidingCounter(WINDOW_MINUTES),
  /** 401/403 specifically: a spike here is a credential-stuffing run or a
   * client that has broken its own auth, and neither is visible in a plain
   * 4xx count next to ordinary validation errors. */
  authFailures: new SlidingCounter(WINDOW_MINUTES),
  /** 429s. A spike means either an attack or a rate limit set too low for
   * real use — both worth seeing before a customer reports it. */
  rateLimited: new SlidingCounter(WINDOW_MINUTES),
  latency: new LatencyRing(),

  snapshot(): Record<string, number | null> {
    return {
      windowMinutes: WINDOW_MINUTES,
      requests: serverMetrics.requests.value(),
      errors5xx: serverMetrics.errors5xx.value(),
      denied4xx: serverMetrics.denied4xx.value(),
      authFailures: serverMetrics.authFailures.value(),
      rateLimited: serverMetrics.rateLimited.value(),
      latencyP50Ms: serverMetrics.latency.quantile(0.5),
      latencyP95Ms: serverMetrics.latency.quantile(0.95),
      rssBytes: process.memoryUsage().rss,
      uptimeSeconds: Math.round(process.uptime()),
    };
  },
};

/** Record one finished request. Called from the server's `onResponse` hook. */
export function observeResponse(statusCode: number, durationMs: number): void {
  serverMetrics.requests.add();
  serverMetrics.latency.observe(durationMs);
  if (statusCode >= 500) serverMetrics.errors5xx.add();
  else if (statusCode >= 400) {
    serverMetrics.denied4xx.add();
    if (statusCode === 401 || statusCode === 403) serverMetrics.authFailures.add();
    if (statusCode === 429) serverMetrics.rateLimited.add();
  }
}
