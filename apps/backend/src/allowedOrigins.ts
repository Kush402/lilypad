/**
 * Parse the `ALLOWED_ORIGINS` env string into the shape `@fastify/cors`'s
 * `origin` option expects. Extracted as its own pure function so the parsing
 * is unit-testable without spinning up a Fastify instance, mirroring
 * `trustProxy.ts`'s exact pattern.
 *
 * See `packages/shared/src/env.ts`'s `ALLOWED_ORIGINS` doc comment for why
 * the default (empty string → `false`, no cross-origin browser client
 * allowed) is deliberately safe rather than a placeholder to flip to `true`
 * under deploy pressure. See docs/audit/m3/backend-security.md Finding 14.
 */
export function parseAllowedOrigins(raw: string): boolean | string[] {
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return origins.length > 0 ? origins : false;
}
