/**
 * Decide whether a request to GET /metrics may proceed. Extracted as a pure
 * function (mirroring `trustProxy.ts`/`allowedOrigins.ts`'s pattern) so the
 * decision is unit-testable without building a real server or fighting the
 * config module's load-time env caching.
 *
 * `requiredToken` is `undefined` whenever `METRICS_BEARER_TOKEN` isn't
 * configured (optional in dev, so `curl localhost:8080/metrics` keeps
 * working with no setup) — in that case every request is authorized, since
 * there's nothing to check against. See
 * `docs/audit/m3/backend-security.md` Finding 13.
 */
export function isAuthorizedMetricsRequest(
  authHeader: string | undefined,
  requiredToken: string | undefined,
): boolean {
  if (!requiredToken) return true;
  return authHeader === `Bearer ${requiredToken}`;
}
