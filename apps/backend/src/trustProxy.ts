/**
 * Parse the `TRUST_PROXY` env string into the shape Fastify's `trustProxy`
 * option expects. Extracted as its own pure function so the parsing logic —
 * "is this disabled, the legacy one-hop setting, or an address/CIDR
 * allowlist?" — is unit-testable
 * without spinning up a Fastify instance.
 *
 * See `packages/shared/src/env.ts`'s `TRUST_PROXY` doc comment for why the
 * default (empty string → `false`) deliberately does NOT trust any proxy:
 * blindly trusting `X-Forwarded-For` lets any client spoof its own source IP
 * and dodge per-IP rate limiting unless the operator says which addresses are
 * real, trusted proxies.
 */
export function parseTrustProxy(raw: string): boolean | string {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === '0') return false;
  // Fastify 5.12.1 removed hop-count trust because `1` trusts forwarded
  // headers even when a client reaches the origin directly. Lilypad's only
  // documented numeric deployment is cloudflared beside the backend (Docker
  // private address) or the local quick-tunnel process (loopback), so retain
  // that configuration while binding trust to the connector's address.
  if (trimmed === '1') return 'loopback, linklocal, uniquelocal';
  if (/^\d+$/.test(trimmed)) {
    throw new Error(
      'numeric TRUST_PROXY hop counts above 1 are unsafe; configure trusted proxy IPs or CIDRs',
    );
  }
  // An IP, CIDR, or comma-separated list of either — Fastify (via the
  // `proxy-addr` package) parses this form natively.
  return trimmed;
}
