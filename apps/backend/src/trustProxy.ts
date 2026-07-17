/**
 * Parse the `TRUST_PROXY` env string into the shape Fastify's `trustProxy`
 * option expects. Extracted as its own pure function so the parsing logic —
 * "is this a hop count, or an address/CIDR allowlist?" — is unit-testable
 * without spinning up a Fastify instance.
 *
 * See `packages/shared/src/env.ts`'s `TRUST_PROXY` doc comment for why the
 * default (empty string → `false`) deliberately does NOT trust any proxy:
 * blindly trusting `X-Forwarded-For` lets any client spoof its own source IP
 * and dodge per-IP rate limiting unless the operator says exactly how many
 * hops (or which addresses) are real, trusted proxies.
 */
export function parseTrustProxy(raw: string): boolean | number | string {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // An IP, CIDR, or comma-separated list of either — Fastify (via the
  // `proxy-addr` package) parses this form natively.
  return trimmed;
}
