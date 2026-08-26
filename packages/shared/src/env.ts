import { z } from 'zod';

/**
 * Typed, validated environment for server-side apps. Call `loadEnv()` once at
 * startup; it throws a readable error listing every missing/invalid variable
 * instead of failing later with `undefined`.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  BACKEND_HOST: z.string().default('0.0.0.0'),
  BACKEND_PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
  SIGNALING_URL: z.string().default('ws://localhost:8080/ws/signal'),

  DATABASE_URL: z
    .string()
    .default('postgres://lilypad:lilypad_dev_password@localhost:5432/lilypad'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Capped at 5 minutes — generous for any real QR-scan UX, but bounded so a
  // misconfigured deployment can't silently turn the documented "60s
  // single-use" guarantee (docs/threat-model.md) into an hours-long exposure
  // window. See docs/audit/m3/backend-security.md Finding 12.
  PAIRING_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(300).default(60),

  // How far to trust `X-Forwarded-For`/`X-Forwarded-Proto` when the backend
  // sits behind a reverse proxy or load balancer — passed straight through
  // to Fastify's `trustProxy` option (see `apps/backend/src/server.ts`).
  // Empty/unset means "don't trust any proxy," matching today's behavior for
  // a directly-exposed dev server. A bare integer means "trust this many
  // hops"; anything else (an IP, CIDR, or comma-separated list of either) is
  // passed through as Fastify's address-allowlist form. Deliberately NOT a
  // bare `true` default even in production: blindly trusting every hop lets
  // any client spoof its own source IP via the header and dodge per-IP rate
  // limiting, so an operator must explicitly say how many hops (or which
  // addresses) are actually trusted proxies.
  TRUST_PROXY: z.string().default(''),

  // Zero-config internet reach: when "1", the backend spawns a Cloudflare
  // quick tunnel (requires the `cloudflared` binary) and advertises the
  // tunnel's https/wss URLs in QR payloads instead of the LAN URLs — the
  // phone can then pair and signal from anywhere with no deployed backend.
  // Media still negotiates its own path via ICE (public STUN, or TURN when
  // deployed); the tunnel carries signaling only. Dev/solo-user feature —
  // production deployments pin PUBLIC_BASE_URL/SIGNALING_URL instead.
  TUNNEL: z.enum(['0', '1']).default('0'),

  // ICE config advertised to clients (used from M2).
  STUN_URL: z.string().default('stun:localhost:3478'),
  TURN_URL: z.string().default('turn:localhost:3478'),
  // No `.min()` here: the length floor is a PRODUCTION-only rule (see
  // `productionSafetyProblems` below), not a shape constraint — zod
  // validates `.default()` values against the full chain, so a schema-level
  // `.min(32)` would reject the (intentionally short, dev-only) default
  // above even outside production. See
  // docs/audit/m3/backend-security.md Finding 11.
  TURN_SECRET: z.string().default('lilypad_dev_turn_secret'),
  TURN_REALM: z.string().default('lilypad.local'),

  // A publicly-reachable TURN relay, advertised to both peers IN ADDITION to
  // the (LAN) coturn above. The local coturn is unreachable off-LAN, so
  // cellular↔home-NAT sessions have no relay to fall back to when a direct
  // STUN path can't be sustained — the connection forms briefly, then dies on
  // the first NAT rebind. Set these three (e.g. a free Metered/Twilio relay,
  // or your own deployed coturn's public address + a static credential) to
  // give off-LAN peers a working relay. Empty = not advertised (LAN/same-Wi-Fi
  // only). This is the un-deployed-dev bridge for M6's "deploy TURN" item.
  PUBLIC_TURN_URL: z.string().default(''),
  PUBLIC_TURN_USERNAME: z.string().default(''),
  PUBLIC_TURN_CREDENTIAL: z.string().default(''),

  // Server-controlled `iceTransportPolicy` handed to both peers via
  // `session-start` (relay-only vs normal ICE). Default OFF ('all' / normal
  // ICE): forcing relay onto the free/shared relay above would break
  // sessions that today succeed via a direct srflx path. Flip to true only
  // once a dedicated TURN relay is deployed for this — see
  // infra/coturn-prod/README.md. `z.enum(['true','false'])` rather than
  // `z.coerce.boolean()`: the latter treats the STRING "false" as truthy,
  // which would silently force relay for anyone who set `FORCE_RELAY=false`.
  FORCE_RELAY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Whether `/connect/request` refuses an account without a remote-access
  // subscription (ADR-0016).
  //
  // **This cannot be turned on yet, and the reason is architectural rather
  // than commercial.** `/connect/request` is on the path of EVERY session,
  // including one between a phone and a laptop on the same Wi-Fi
  // (NETWORKING.md §1: the control plane is a hard dependency today, and the
  // LAN control path is target architecture, not built). Enforcing here would
  // therefore charge for LAN, which ADR-0013 forbids in its first
  // non-negotiable and which the website now promises in as many words.
  //
  // It exists switched off because the alternative is discovering the shape of
  // the check on the day the purchase path ships. Turn it on when a LAN
  // session no longer reaches the cloud at all, and not before.
  //
  // Same `z.enum` treatment as FORCE_RELAY, for the same reason: coerced
  // booleans read the STRING "false" as true, and this one refusing sessions
  // by accident is the worst outage the product can have.
  ENFORCE_REMOTE_ENTITLEMENT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Comma-separated allowlist of origins permitted to make cross-origin
  // browser requests in production (e.g. a deployed `apps/admin` SPA).
  // Empty means "no cross-origin browser client is allowed yet" — a
  // deliberately safe default, not a placeholder to flip to `true` under
  // deploy pressure. See docs/audit/m3/backend-security.md Finding 14.
  ALLOWED_ORIGINS: z.string().default(''),

  // Extra hosts a device proof may name, comma-separated, beyond the ones this
  // server already advertises (`PUBLIC_BASE_URL` and the live advertised URL).
  //
  // A v2 device proof signs the host it is for, and the server refuses hosts
  // that are not its own — that refusal is what stops a hostile server
  // relaying a challenge and replaying the signature. Deployments reached at a
  // name the server does not advertise (a LAN address in development, a second
  // hostname in front of one origin) list it here. Empty is the normal case
  // and is NOT a fallback to "anything": an unlisted host is refused.
  //
  // Deliberately not `ALLOWED_ORIGINS`, which is a browser CORS allowlist. The
  // two answer different questions and sharing one value would mean widening
  // an authentication check to admit a web client.
  DEVICE_PROOF_HOSTS: z.string().default(''),

  // Refuse a device proof that does not name the server it is for — i.e. drop
  // the v1 message entirely ([ADR-0002](../../../docs/adr/0002-device-identity.md)).
  //
  // v2 is only worth what the weakest accepted form is worth: while v1 is
  // still accepted, an attacker holding a relayed v1 signature can simply
  // present that instead. Requiring v2 is what actually closes it.
  //
  // Off by default, and that is a deployment-ordering fact rather than a
  // preference: a client that has not been updated cannot produce a v2 proof
  // at all, so turning this on before those builds are installed signs every
  // existing device out permanently. Deploy the server, ship the clients,
  // confirm `devices.app_version`, then flip this. See docs/operations.md.
  REQUIRE_DEVICE_PROOF_ORIGIN: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // Static bearer token gating GET /metrics in production (an unauthenticated
  // metrics endpoint hands an attacker load/timing recon for free — see
  // docs/audit/m3/backend-security.md Finding 13). Optional in dev so
  // `curl localhost:8080/metrics` keeps working with no setup.
  METRICS_BEARER_TOKEN: z.string().min(16).optional(),

  // ── Outbound mail (magic-link sign-in, password reset) ────────────────────
  // Both must be present for mail to be sent at all. Absent, `createMailSender`
  // returns null and the two routes answer 503 rather than accepting a sign-in
  // whose email will never arrive — an honest failure beats a silent one.
  // Optional in the schema because development deliberately runs without them,
  // logging the code to the server instead.
  RESEND_API_KEY: z.string().optional(),
  // Envelope sender, e.g. `Lilypad <no-reply@takedia.com>`. Must be on a domain
  // verified in Resend, or Resend rejects every send.
  MAIL_FROM: z.string().optional(),

  // ── M8 auth (docs/adr/0001-account-authentication.md, 0002-device-identity.md)
  // Signing key for Lilypad's OWN access tokens. Symmetric (HS256) on purpose:
  // only this backend ever verifies these tokens, so an asymmetric key would
  // add key distribution for no property we need. Provider ID tokens are a
  // different matter and are verified against the provider's public JWKS.
  // No `.min()` here for the same reason as TURN_SECRET — the length floor is
  // a production-only rule enforced in `productionSafetyProblems`, and a
  // schema-level minimum would reject the (deliberately short) dev default.
  AUTH_TOKEN_SECRET: z.string().default('lilypad_dev_auth_token_secret'),

  // Accepted `aud` values for Apple/Google ID tokens, comma-separated. A
  // single provider issues a DIFFERENT client id per platform (iOS bundle id,
  // Android client id, web client id, Apple Services ID), and the audience
  // check is what stops an ID token minted for someone else's app from
  // signing its bearer into Lilypad — so this must be a list, not one value.
  // Empty = that provider is not configured; its routes answer 503 rather
  // than pretending to work.
  APPLE_CLIENT_IDS: z.string().default(''),
  GOOGLE_CLIENT_IDS: z.string().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Dev defaults that must never survive into a production boot — they are
 * public knowledge (committed to the repo), so booting prod with any of them
 * is a silent-insecure-default. Enforced below. */
const INSECURE_DEV_DEFAULTS: Partial<Record<keyof Env, string>> = {
  TURN_SECRET: 'lilypad_dev_turn_secret',
  DATABASE_URL: 'postgres://lilypad:lilypad_dev_password@localhost:5432/lilypad',
  AUTH_TOKEN_SECRET: 'lilypad_dev_auth_token_secret',
};

/** Does this URL carry a password in its userinfo? An unparseable URL can't
 * be verified safe, so it's treated as missing auth rather than silently
 * passed. Generic WHATWG authority parsing (`user:pass@host:port`) works for
 * any scheme with `//`, not just http(s) — `redis://:secret@host:port`
 * parses `password` the same way `https://` would. */
function hasPassword(url: string): boolean {
  try {
    return new URL(url).password.length > 0;
  } catch {
    return false;
  }
}

/** Every reason `env` is unsafe to boot in production, or an empty array if
 * it's clean. Collected together (rather than throwing on the first) so an
 * operator fixing a fresh deploy sees every problem in one pass instead of
 * playing whack-a-mole across repeated restarts. */
function productionSafetyProblems(env: Env): string[] {
  const problems: string[] = [];

  const leaked = (Object.keys(INSECURE_DEV_DEFAULTS) as (keyof Env)[]).filter(
    (k) => env[k] === INSECURE_DEV_DEFAULTS[k],
  );
  if (leaked.length > 0) {
    problems.push(
      `default dev secret(s) still in use: ${leaked.join(', ')} — set strong, unique values`,
    );
  }

  // A length floor is a much stronger, more general guarantee than
  // literal-matching the known dev default above — an operator setting
  // TURN_SECRET=changeme sails past that check while still shipping a
  // trivially weak secret. See docs/audit/m3/backend-security.md Finding 11.
  if (env.TURN_SECRET.length < 32) {
    problems.push(
      'TURN_SECRET must be at least 32 characters — generate with e.g. `openssl rand -hex 32`',
    );
  }

  // Same reasoning as TURN_SECRET, with a larger blast radius: this key signs
  // every access token, so anyone who can guess it can mint a token for any
  // account and any device — the whole authorization model reduces to it.
  if (env.AUTH_TOKEN_SECRET.length < 32) {
    problems.push(
      'AUTH_TOKEN_SECRET must be at least 32 characters — generate with e.g. `openssl rand -hex 32`',
    );
  }

  // An unauthenticated /metrics hands an attacker load/timing recon for
  // free (see docs/audit/m3/backend-security.md Finding 13); optional in
  // dev so `curl localhost:8080/metrics` keeps working with no setup.
  if (!env.METRICS_BEARER_TOKEN) {
    problems.push(
      'METRICS_BEARER_TOKEN is not set — /metrics must not be publicly reachable unauthenticated in production',
    );
  }

  // Transport encryption: WebRTC media/DTLS-SRTP is encrypted regardless,
  // but plaintext signaling/pairing carries the pairing handshake and every
  // SDP/ICE exchange in the clear — a trivially sniffable downgrade from the
  // product's actual security model. See
  // docs/audit/m3/reconnect-lifecycle.md's sibling backend-security audit.
  if (!env.PUBLIC_BASE_URL.startsWith('https://')) {
    problems.push(
      `PUBLIC_BASE_URL (${env.PUBLIC_BASE_URL}) is not HTTPS — plaintext HTTP must not be a ` +
        `production default`,
    );
  }
  if (!env.SIGNALING_URL.startsWith('wss://')) {
    problems.push(
      `SIGNALING_URL (${env.SIGNALING_URL}) is not WSS — plaintext WebSocket signaling must not ` +
        `be a production default`,
    );
  }

  // Rate limiting, the WebSocket connection-count guard and every per-IP
  // decision key off `request.ip`. Behind a proxy with TRUST_PROXY unset,
  // `request.ip` is the PROXY's address, so every client in the world collapses
  // into a single bucket: one user exhausting any limit locks out all of them,
  // and the per-IP connection cap stops meaning anything. Measured on the
  // deployed stack before this check existed — a second machine, with a
  // different public IP and no prior requests, was served 429 immediately
  // because a laptop had just used up the shared allowance.
  //
  // A directly-exposed origin genuinely wants no proxy trust, so this does not
  // demand a proxy — it demands that the operator SAY which it is. `false` is
  // an accepted answer; silence is not, because silence is what produced the
  // broken configuration.
  if (env.TRUST_PROXY.trim() === '') {
    problems.push(
      'TRUST_PROXY is not set — behind a proxy this collapses every client into one rate-limit ' +
        'bucket (set the number of trusted hops, e.g. 1 for a single tunnel/CDN in front); ' +
        'set it to `false` if this origin is exposed directly with no proxy',
    );
  }

  // Redis holds pairing-token and (as of the room-resurrection work) live
  // room-routing state — an unauthenticated instance reachable by anything
  // that can reach its port is a full session-hijack surface, not just a
  // cache-poisoning risk.
  if (!hasPassword(env.REDIS_URL)) {
    problems.push(
      `REDIS_URL has no password — Redis must require auth in production ` +
        `(e.g. redis://:secret@host:6379)`,
    );
  }

  return problems;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  // Fail loudly rather than boot production with an insecure configuration.
  if (parsed.data.NODE_ENV === 'production') {
    const problems = productionSafetyProblems(parsed.data);
    if (problems.length > 0) {
      const list = problems.map((p) => `  • ${p}`).join('\n');
      throw new Error(`Refusing to start in production with an insecure configuration:\n${list}`);
    }
  }

  cached = parsed.data;
  return cached;
}

/** Test helper: clear the memoized env so a fresh source can be loaded. */
export function resetEnvCache(): void {
  cached = undefined;
}
