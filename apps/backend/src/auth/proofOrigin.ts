import { proofOriginOf } from '@lilypad/protocol';

/**
 * Which servers a device proof may name
 * ([ADR-0002](../../../../docs/adr/0002-device-identity.md), L-30).
 *
 * A v2 proof signs the host the client thinks it is talking to. That is only
 * worth anything if the server refuses hosts that are not its own — otherwise
 * a relay would simply forward the client's honest `evil.example` proof and
 * the check would pass.
 *
 * The set is built from configuration and runtime state the server controls,
 * never from the request. In particular it is NOT the `Host` header: an
 * attacker replaying a stolen proof can choose what `Host` they send, so a
 * check against it would validate the very thing it is meant to catch.
 *
 * What belongs in it is exactly the set of addresses this server hands out and
 * expects to be reached at:
 *
 *  - `PUBLIC_BASE_URL` — what production pins, and what the QR carries.
 *  - the live advertised URL — the same thing, except while a dev tunnel is up
 *    and `setAdvertisedUrls` has overridden it.
 *  - `DEVICE_PROOF_HOSTS` — an explicit escape hatch for a deployment reached
 *    at a name the server does not advertise (a LAN address during
 *    development, a second hostname in front of one origin).
 *
 * Pure, and separate from the route, for the reason `parseAllowedOrigins` and
 * `trustProxy` are: the decision is small, security-bearing, and worth being
 * able to test without a server.
 */

/** Parse a comma-separated host list. Blank entries and stray whitespace are
 * dropped rather than becoming a host nobody can ever match. */
export function parseProofHosts(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Every host a proof may legitimately name.
 *
 * Entries that are URLs contribute their host; entries that are already bare
 * hosts pass through. Anything unparseable is dropped, because a value nobody
 * can match is worse than absent: it looks configured.
 */
export function allowedProofHosts(sources: {
  publicBaseUrl?: string | null;
  advertisedApiBaseUrl?: string | null;
  extraHosts?: string | null;
}): Set<string> {
  const hosts = new Set<string>();
  for (const url of [sources.publicBaseUrl, sources.advertisedApiBaseUrl]) {
    const host = url ? proofOriginOf(url) : null;
    if (host) hosts.add(host);
  }
  for (const entry of parseProofHosts(sources.extraHosts)) {
    // Accept either spelling, so an operator who writes a URL is not silently
    // configuring nothing.
    hosts.add(proofOriginOf(entry) ?? entry);
  }
  return hosts;
}

/**
 * May a proof naming `origin` be verified here?
 *
 * Case-insensitive because DNS is. An empty allow-set answers `false` for
 * every origin: a server that cannot say who it is must not accept proofs
 * that claim to know, and failing closed here costs a v2 client one clear
 * rejection instead of silently accepting relayed proofs forever.
 */
export function isProofOriginAllowed(origin: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(origin.trim().toLowerCase());
}
