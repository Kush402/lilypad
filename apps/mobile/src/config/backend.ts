/**
 * Where Lilypad's control plane lives.
 *
 * **This is not a secret**, for the same reason the OAuth client ids in
 * `oauth.ts` are not: it ships in every binary and appears in any network
 * trace. What protects the backend is that every route authorizes on a proven
 * token, never on the caller knowing an address.
 *
 * ## Why this constant has to exist
 *
 * Until now the app shipped no backend address at all — every one it knew came
 * from a scanned QR or a stored pair, which is why sign-in could only ever be
 * reached FROM the scanner and "Your devices" stayed hidden until a laptop was
 * paired. That ordering is backwards for a consumer product: an account is the
 * first thing a user makes, and it cannot be made against a server whose
 * address is only revealed by a computer they have not set up yet.
 *
 * ## Precedence
 *
 * A scanned or stored pair's `apiBaseUrl` still wins for anything to do with
 * THAT laptop. This is only the address used before any laptop is known —
 * sign-in, signup, and the account's own device list. Self-hosting therefore
 * keeps working exactly as before: point the QR at your server and the phone
 * follows it.
 */

/**
 * The deployment this build talks to.
 *
 * Currently the tunnel in `infra/cloudflared/lilypad.yml`, which is the address
 * the backend already advertises in its own QR payloads. It moves to a real
 * production host with the deployment milestone (M13,
 * [ADR-0009](../../../../docs/adr/0009-control-plane-deployment.md)); nothing
 * else in the app needs to change when it does.
 */
export const DEFAULT_API_BASE_URL = 'https://lilypad.takedia.com';

/** Normalised, trailing slash removed — the form every caller wants. */
export function defaultApiBaseUrl(): string {
  return DEFAULT_API_BASE_URL.replace(/\/$/, '');
}
