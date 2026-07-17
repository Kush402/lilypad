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
    const port = process.env.PORT ?? '8080';
    process.env.PUBLIC_BASE_URL ??= `http://${ip}:${port}`;
    process.env.SIGNALING_URL ??= `ws://${ip}:${port}/ws/signal`;
  }
}

export const env: Env = loadEnv();

export const config = {
  env,
  isDev: env.NODE_ENV === 'development',
  pairingTokenTtlSeconds: env.PAIRING_TOKEN_TTL_SECONDS,
} as const;

// NOTE: ICE servers are never advertised as a static object. Every peer gets
// fresh, time-limited TURN credentials minted per session by
// `turn/credentials.ts` (`buildIceServers`) — the coturn shared secret must
// never leave the server. A previous `config.iceServers` that embedded
// `env.TURN_SECRET` as a client credential was removed (it leaked the master
// secret to every client that read it).
