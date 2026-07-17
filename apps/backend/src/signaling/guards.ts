/**
 * Transport-level abuse guards for the signaling WebSocket. Pure, injectable,
 * and unit-tested in isolation from Fastify so the route stays a thin adapter.
 *
 * These bound the three cheap-to-exploit vectors on an unauthenticated public
 * WS endpoint: too many concurrent sockets from one source, a socket flooding
 * frames, and a socket that connects but never registers (holding resources).
 */

/** Caps concurrent connections per remote address. */
export class IpConnectionLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxPerIp: number) {}

  /** Reserve a slot for `ip`. Returns false if the IP is at its cap. */
  acquire(ip: string): boolean {
    const n = this.counts.get(ip) ?? 0;
    if (n >= this.maxPerIp) return false;
    this.counts.set(ip, n + 1);
    return true;
  }

  release(ip: string): void {
    const n = this.counts.get(ip);
    if (n === undefined) return;
    if (n <= 1) this.counts.delete(ip);
    else this.counts.set(ip, n - 1);
  }

  /** Current concurrent connections for `ip` (0 if none). */
  count(ip: string): number {
    return this.counts.get(ip) ?? 0;
  }
}

/**
 * Per-socket token-bucket rate limiter. `capacity` tokens refill at
 * `refillPerSec`; each message spends one. A brief burst is allowed (real
 * clients batch heartbeats/ICE), sustained flooding is rejected.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  /** Spend one token. Returns false when the bucket is empty (over budget). */
  allow(): boolean {
    const t = this.now();
    const elapsedSec = (t - this.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefillMs = t;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * WS upgrades aren't subject to CORS at all (that's a browser/`fetch`-only
 * mechanism), so a *cross-host* `Origin` header on this endpoint is a signal
 * of unexpected browser-originated traffic. The Tauri desktop app sends no
 * Origin, but React Native's iOS WebSocket always sends one derived from the
 * request URL itself (`Origin: http://<host>` for `ws://<host>/...`), so a
 * same-host Origin is the native-client fingerprint and must be allowed.
 * See `docs/audit/m3/backend-security.md` Finding 8.
 */
export function isUnexpectedBrowserOrigin(
  originHeader: string | string[] | undefined,
  hostHeader: string | string[] | undefined,
): boolean {
  if (originHeader === undefined) return false;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!host) return true;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // malformed Origin — no legitimate client sends one
  }
}
