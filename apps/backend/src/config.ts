import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadEnv, type Env } from '@lilypad/shared';

// Load the repo-root .env so every app shares one source of truth.
// (Root is two levels up from apps/backend/src at runtime via cwd; we resolve
// relative to this file to be robust to the working directory.)
loadDotenv({ path: resolve(process.cwd(), '.env') });
loadDotenv({ path: resolve(process.cwd(), '../../.env') });

/** First non-internal IPv4 address, or null (e.g. no network at all). */
function detectLanIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

// Dev convenience: the QR hands the phone `PUBLIC_BASE_URL`/`SIGNALING_URL`,
// which must be an address the PHONE can reach — never localhost, and a
// hard-pinned LAN IP in .env goes stale the moment the laptop changes
// networks (observed in bring-up: pairing silently dead after a subnet
// change). When the operator hasn't pinned them explicitly, derive both from
// the machine's current LAN IP at boot. Production always pins explicitly
// (loadEnv's production guard already requires https/wss there).
if (!process.env.PUBLIC_BASE_URL || !process.env.SIGNALING_URL) {
  const ip = detectLanIp();
  if (ip) {
    const port = process.env.BACKEND_PORT ?? '8080';
    process.env.PUBLIC_BASE_URL ??= `http://${ip}:${port}`;
    process.env.SIGNALING_URL ??= `ws://${ip}:${port}/ws/signal`;
  }
}

// A v2 device proof names the server it is for, and the server refuses any host
// it does not answer to (`auth/proofOrigin.ts`, ADR-0002). The allow-set comes
// from what this server ADVERTISES — and outside production that is the LAN
// address derived above, while the thing actually connecting is usually
// `localhost`: the desktop's development default is `http://localhost:8080`,
// and the end-to-end suite drives `http://127.0.0.1:8099`.
//
// The result was every device proof refused, with `device proof named a host
// this server does not answer to` as the only clue — proved on 2026-08-23, when
// CI could run the eleven device-identity tests for the first time and six of
// them failed here.
//
// So loopback is added to the SAME escape hatch an operator would use, rather
// than through a second mechanism. Production is untouched: it pins
// `PUBLIC_BASE_URL` explicitly, `loadEnv` already refuses a non-HTTPS one
// there, and this block is skipped entirely.
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.BACKEND_PORT ?? '8080';
  process.env.DEVICE_PROOF_HOSTS = [
    process.env.DEVICE_PROOF_HOSTS,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
  ]
    .filter(Boolean)
    .join(',');
}

export const env: Env = loadEnv();

export const config = {
  env,
  isDev: env.NODE_ENV === 'development',
  /**
   * Not the negation of `isDev`. `NODE_ENV` has three values, and `test` is
   * neither — so the two flags disagree about it deliberately.
   *
   * `isDev` gates things that must stay OFF anywhere but a developer's own
   * machine: pretty logs, and `cors({ origin: true })`. `test` gets the strict
   * behaviour there.
   *
   * `isProduction` gates the opposite kind of decision — refusing to serve
   * because a real deployment is missing real configuration. Under
   * `NODE_ENV=test` there is no Resend key and there never will be, so the
   * old `isDev ? consoleMailSender : null` answered 503 to every sign-in and
   * the eleven device-identity end-to-end tests failed the moment CI could
   * actually run them (2026-08-23, first green Actions run after the repository
   * went public).
   */
  isProduction: env.NODE_ENV === 'production',
  pairingTokenTtlSeconds: env.PAIRING_TOKEN_TTL_SECONDS,
} as const;

// NOTE: ICE servers are never advertised as a static object. Every peer gets
// fresh, time-limited TURN credentials minted per session by
// `turn/credentials.ts` (`buildIceServers`) — the coturn shared secret must
// never leave the server. A previous `config.iceServers` that embedded
// `env.TURN_SECRET` as a client credential was removed (it leaked the master
// secret to every client that read it).
