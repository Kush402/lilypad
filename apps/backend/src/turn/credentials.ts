import { createHmac } from 'node:crypto';
import type { IceServer } from '@lilypad/protocol';
import { env } from '../config.js';

/**
 * Time-limited TURN credentials (coturn `use-auth-secret` / REST-API scheme).
 *
 *   username   = "<unixExpiry>[:<label>]"
 *   credential = base64( HMAC-SHA1( staticAuthSecret, username ) )
 *
 * coturn recomputes the same HMAC from its `static-auth-secret` and accepts the
 * credential until `unixExpiry`. No long-lived shared password ever leaves the
 * server, and credentials die on their own — a big upgrade over a static user.
 */
export interface TurnCredential {
  username: string;
  credential: string;
  /** Unix seconds after which coturn rejects this credential. */
  expiresAt: number;
  ttlSeconds: number;
}

export interface TurnCredentialOptions {
  secret?: string;
  ttlSeconds?: number;
  /** Bound into the username for traceability (e.g. sessionId). */
  label?: string;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: number;
}

// 5 minutes — comfortably longer than real WebRTC ICE gathering/negotiation
// (typically seconds), while shrinking the leak-exposure window ~12x versus
// the previous 1h default. A leaked credential (e.g. via Finding 3's
// plaintext-signaling gap) is a bearer secret for TURN relay allocation,
// unbound to the session beyond its own expiry — the leak-exposure window,
// not setup latency, is the property that actually matters here. Rotating a
// fresh credential on `renegotiate` for long-running sessions is a real
// follow-up (docs/audit/m3/backend-security.md Finding 7's redesign item 2)
// not implemented yet — this alone still cuts blast radius substantially.
export const DEFAULT_TTL_SECONDS = 300;

export function generateTurnCredential(opts: TurnCredentialOptions = {}): TurnCredential {
  const secret = opts.secret ?? env.TURN_SECRET;
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const nowMs = opts.now ?? Date.now();
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = opts.label ? `${expiresAt}:${opts.label}` : `${expiresAt}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt, ttlSeconds };
}

/**
 * Public STUN fallback so srflx candidates work on real internet paths even
 * when the configured STUN/TURN is a localhost dev coturn (useless off-LAN,
 * e.g. when pairing rides the quick tunnel). Harmless on LAN — host
 * candidates still win the ICE race there. Symmetric-NAT cases still need a
 * deployed TURN relay; this covers the majority that don't.
 */
const PUBLIC_STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

/**
 * ICE servers advertised to a peer in `pair-approved`: STUN first (host/srflx),
 * then TURN over UDP + TCP with a fresh time-limited credential.
 */
export function buildIceServers(opts: TurnCredentialOptions = {}): {
  iceServers: IceServer[];
  credential: TurnCredential;
} {
  const cred = generateTurnCredential(opts);
  const iceServers: IceServer[] = [
    { urls: env.STUN_URL },
    { urls: PUBLIC_STUN_URLS },
    {
      urls: env.TURN_URL,
      username: cred.username,
      credential: cred.credential,
    },
  ];
  // A publicly-reachable TURN relay (when configured) is what actually makes
  // cellular↔home-NAT work: the LAN coturn above is unreachable off-LAN, so
  // without this a direct STUN path is the only option and it can't survive a
  // cellular NAT rebind. Advertised in addition to (not instead of) the local
  // coturn, which still wins on-LAN. Only emitted when all three are set.
  if (env.PUBLIC_TURN_URL && env.PUBLIC_TURN_USERNAME && env.PUBLIC_TURN_CREDENTIAL) {
    // Comma-separated so one env var can advertise every transport variant
    // the provider offers (e.g. UDP 80 + UDP 443 + TCP 443). Cellular
    // carriers commonly block or degrade UDP on port 80 — advertising a
    // single `turn:...:80` left phones with no usable relay on such paths,
    // silently downgrading them to fragile direct pairs. Both clients
    // accept a string[] here (`IceServerSchema.urls` is string|string[]).
    const urls = env.PUBLIC_TURN_URL.split(',')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    iceServers.push({
      urls: urls.length === 1 ? urls[0]! : urls,
      username: env.PUBLIC_TURN_USERNAME,
      credential: env.PUBLIC_TURN_CREDENTIAL,
    });
  }
  return { iceServers, credential: cred };
}
