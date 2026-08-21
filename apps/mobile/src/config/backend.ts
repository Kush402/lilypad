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
 * The deployment this build talks to: **production**.
 *
 * This used to be `https://lilypad.takedia.com`, described here as temporary —
 * "it moves to a real production host with the deployment milestone (M13,
 * [ADR-0009](../../../../docs/adr/0009-control-plane-deployment.md))". M13
 * shipped, production went live at `api.takedia.com`, and this line did not
 * move with it.
 *
 * `lilypad.takedia.com` is not another name for production. It is the
 * **local-development tunnel** (`infra/cloudflared/lilypad.yml`,
 * docs/deployment.md § Domains), which forwards to `localhost:8080` on a
 * developer's Mac. Every iPhone build therefore created its account, signed in,
 * and listed its devices against whatever backend happened to be running on
 * that laptop — a deployment with none of the revocation, ownership or
 * deletion behaviour production has. Confirmed by comparing the two on
 * 2026-08-20: `api.takedia.com` reported revision `2435111a…`, the tunnel
 * reported no revision at all and five days of uptime.
 *
 * This is the same class of bug as the desktop's "v0.1.0 shipped pointing at a
 * developer's laptop", found and fixed on one client and missed on the other.
 * `backend.test.ts` is what stops it coming back.
 */
export const DEFAULT_API_BASE_URL = 'https://api.takedia.com';

/** Normalised, trailing slash removed — the form every caller wants. */
export function defaultApiBaseUrl(): string {
  return DEFAULT_API_BASE_URL.replace(/\/$/, '');
}
