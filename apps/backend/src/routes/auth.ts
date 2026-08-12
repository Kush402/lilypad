import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  OAuthSignInRequestSchema,
  MagicLinkRequestSchema,
  MagicLinkVerifyRequestSchema,
  RefreshRequestSchema,
  type AuthSession,
} from '@lilypad/protocol';
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from '../auth/tokens.js';
import {
  RefreshTokenService,
  createDrizzleRefreshTokenStore,
  type RefreshFailure,
} from '../auth/refreshTokens.js';
import { AccountService, createDrizzleAccountStore } from '../auth/accounts.js';
import { verifyProviderToken, isProviderConfigured } from '../auth/providers.js';
import { createMagicLink, redeemMagicLink, createMailSender } from '../auth/magicLink.js';
import { AuditLogService, createDrizzleAuditLogStore } from '../services/auditLog.js';
import { log } from '../logging.js';

/**
 * Account authentication ([ADR-0001](../../../../docs/adr/0001-account-authentication.md)).
 *
 * These are the only routes that are reachable WITHOUT a token, because they
 * are how a caller gets one. Everything they hand back is scoped to the
 * identity the caller actually proved.
 *
 * Two rules apply to every handler here:
 *
 * - **Failures are indistinguishable to the client.** Expired, forged,
 *   replayed, and unknown all answer `invalid_token`. The audit log records
 *   which it really was; the response does not, because a caller that can tell
 *   "wrong" from "expired" from "already used" has an oracle for probing.
 * - **Sign-in attempts are audited, successes and failures alike.** These are
 *   the `login` / `login_failed` events the threat model promised and that had
 *   no trigger to fire on until now.
 *
 * Rate limits are tighter than the global limiter: each route either performs
 * public-key work, writes Redis state, or sends mail on an unauthenticated
 * caller's say-so — the same reasoning as `/pairing/create`.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const refreshTokens = new RefreshTokenService(createDrizzleRefreshTokenStore());
  const accounts = new AccountService(createDrizzleAccountStore());
  const auditLog = new AuditLogService(createDrizzleAuditLogStore());
  const mailer = createMailSender();

  /** Mint the access+refresh pair a successful sign-in returns. */
  async function issueSession(userId: string, ip: string): Promise<AuthSession> {
    // Sign-in is account-level: no device is bound yet. A device binds itself
    // by enrolling with this session (ADR-0002), which mints a second,
    // device-scoped token — and from then on renews with its key, not with a
    // refresh token.
    const [accessToken, refresh] = await Promise.all([
      signAccessToken({ userId, deviceId: null }),
      refreshTokens.issue(userId),
    ]);
    void auditLog
      .login({ userId, ip })
      .catch((err) => log.audit.error({ err }, 'failed to write login audit log'));
    return {
      accessToken,
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: refresh.token,
      userId,
    };
  }

  function denySignIn(reply: FastifyReply, ip: string, reason: string): FastifyReply {
    void auditLog
      .loginFailed({ ip, metadata: { reason } })
      .catch((err) => log.audit.error({ err }, 'failed to write login_failed audit log'));
    return reply.code(401).send({ error: 'invalid_token' });
  }

  /**
   * Sign in with an Apple or Google ID token the client already obtained.
   * Verification (signature, issuer, audience, algorithm) happens in
   * `auth/providers.ts`; the account linking rules in `auth/accounts.ts`.
   */
  app.post(
    '/auth/oauth',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = OAuthSignInRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { provider, idToken } = parsed.data;
      if (!isProviderConfigured(provider)) {
        // Not a client error and not a secret: an operator has not configured
        // this provider's client ids. Saying so plainly beats a 401 that sends
        // the client into a pointless retry loop.
        return reply.code(503).send({
          error: 'provider_not_configured',
          message: `${provider} sign-in is not configured on this server`,
        });
      }

      const verified = await verifyProviderToken(provider, idToken);
      if (!verified.ok) return denySignIn(reply, req.ip, `${provider}_${verified.reason}`);

      const linked = await accounts.resolveProviderIdentity(verified.identity);
      if (!linked.ok) {
        // These two are actionable by the USER (grant email access / verify
        // your address), so unlike a bad token they are reported specifically.
        // Neither reveals whether an account exists.
        void auditLog
          .loginFailed({ ip: req.ip, metadata: { reason: linked.reason, provider } })
          .catch((err) => log.audit.error({ err }, 'failed to write login_failed audit log'));
        return reply.code(403).send({
          error: linked.reason,
          message:
            linked.reason === 'email_required'
              ? 'this sign-in did not include an email address, so no account could be created'
              : 'this provider has not verified the email address on this account',
        });
      }

      return reply.code(200).send(await issueSession(linked.userId, req.ip));
    },
  );

  /**
   * Request a sign-in link.
   *
   * Answers 202 whether or not the address has an account, and whether or not
   * a link was actually sent. That is deliberate: a response that differed
   * would turn this endpoint into an account-enumeration oracle, which is
   * exactly what an attacker wants before a phishing run.
   */
  app.post(
    '/auth/magic-link/request',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = MagicLinkRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      if (!mailer) {
        // No delivery mechanism is configured (production, pre-M13). An honest
        // 503 beats a 202 for a link that will never arrive.
        return reply.code(503).send({
          error: 'magic_link_unavailable',
          message: 'email sign-in is not available on this server yet',
        });
      }
      const { token, link } = await createMagicLink(parsed.data.email);
      await mailer.sendMagicLink(parsed.data.email, link, token);
      return reply.code(202).send({ ok: true });
    },
  );

  /** Redeem a magic-link token. Single-use: the token is burned by `GETDEL`,
   * so a replay finds nothing. Possession of the inbox IS the proof, so no
   * separate email-verification step exists or is needed. */
  app.post(
    '/auth/magic-link/verify',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = MagicLinkVerifyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const email = await redeemMagicLink(parsed.data.token);
      if (!email) return denySignIn(reply, req.ip, 'magic_link_invalid');
      const userId = await accounts.resolveEmail(email);
      return reply.code(200).send(await issueSession(userId, req.ip));
    },
  );

  /**
   * Exchange a refresh token for a fresh pair. The presented token is retired
   * by the exchange; presenting it again revokes the whole family, because a
   * retired token in the attacker's hands and in the client's hands look
   * identical from here.
   */
  app.post(
    '/auth/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = RefreshRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const rotated = await refreshTokens.rotate(parsed.data.refreshToken);
      if (!rotated.ok) {
        logRefreshFailure(rotated.reason);
        return denySignIn(reply, req.ip, `refresh_${rotated.reason}`);
      }
      const accessToken = await signAccessToken({ userId: rotated.userId, deviceId: null });
      const session: AuthSession = {
        accessToken,
        expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: rotated.token,
        userId: rotated.userId,
      };
      return reply.code(200).send(session);
    },
  );

  function logRefreshFailure(reason: RefreshFailure): void {
    if (reason === 'reused') {
      // The one refresh failure that is a security EVENT rather than an
      // expiry: a retired token was presented, so the family has just been
      // revoked and someone is about to be signed out unexpectedly.
      log.server.warn('refresh token reuse detected — revoked every refresh token for that user');
    }
  }
}
