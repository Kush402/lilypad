import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  OAuthSignInRequestSchema,
  MagicLinkRequestSchema,
  MagicLinkVerifyRequestSchema,
  RefreshRequestSchema,
  SignUpRequestSchema,
  PasswordSignInRequestSchema,
  PasswordResetRequestSchema,
  PasswordResetConfirmSchema,
  type AuthSession,
  type AuthMethods,
} from '@lilypad/protocol';
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from '../auth/tokens.js';
import {
  RefreshTokenService,
  createDrizzleRefreshTokenStore,
  type RefreshFailure,
} from '../auth/refreshTokens.js';
import { AccountService, createDrizzleAccountStore } from '../auth/accounts.js';
import { verifyProviderToken, isProviderConfigured } from '../auth/providers.js';
import {
  createMagicLink,
  redeemMagicLink,
  createPasswordReset,
  redeemPasswordReset,
  createMailSender,
} from '../auth/magicLink.js';
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

  /**
   * The real owner of an inbox has just proved it, and found an account that
   * had been created for their address by someone who never proved anything —
   * the account pre-hijacking setup (register the victim's address with a
   * password, wait for them to sign in with Apple or a magic link, keep the
   * password). `AccountService` has already dropped that password; what is
   * left is to end the squatter's sessions, and to say so in the audit log.
   */
  async function reclaim(userId: string, ip: string, via: string): Promise<void> {
    await refreshTokens.revokeUser(userId);
    log.server.warn(
      { userId, via },
      'proven email claimed an account whose password was never verified — password cleared and sessions revoked',
    );
    await auditLog
      .sessionEnd({ userId, ip, metadata: { event: 'unproven_account_claimed', via } })
      .catch((err) => log.audit.error({ err }, 'failed to write account-claim audit log'));
  }

  function denySignIn(reply: FastifyReply, ip: string, reason: string): FastifyReply {
    void auditLog
      .loginFailed({ ip, metadata: { reason } })
      .catch((err) => log.audit.error({ err }, 'failed to write login_failed audit log'));
    return reply.code(401).send({ error: 'invalid_token' });
  }

  /**
   * What this server can actually do.
   *
   * Unauthenticated on purpose: a client needs it BEFORE it can sign in, and
   * it discloses only what an attacker learns anyway by sending one request to
   * each route. It exists because the alternative was the phone offering
   * "Email me a sign-in link" and "Forgot your password?" against a production
   * backend with no mail sender — two buttons whose only possible outcome was
   * a 503, on the first screen of the product.
   *
   * Password sign-in and sign-up are absent because they depend on nothing
   * external and are therefore always available.
   */
  app.get('/auth/methods', async (_req, reply) => {
    return reply.code(200).send({
      email: mailer !== null,
      apple: isProviderConfigured('apple'),
      google: isProviderConfigured('google'),
    } satisfies AuthMethods);
  });

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

      if (linked.claimedFromUnproven) await reclaim(linked.userId, req.ip, `oauth_${provider}`);
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
      const { token } = await createMagicLink(parsed.data.email);
      // A configured provider can still refuse the message — an unverified
      // sending domain and a revoked key both look like this. 202 would promise
      // a link that is not coming, and an unhandled throw would answer 500, so
      // this reports the same honest 503 as having no sender at all.
      try {
        await mailer.sendMagicLink(parsed.data.email, token);
      } catch (err) {
        req.log.error({ err }, 'magic-link send failed');
        return reply.code(503).send({
          error: 'magic_link_unavailable',
          message: 'email sign-in is not available on this server right now',
        });
      }
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
      const { userId, claimedFromUnproven } = await accounts.resolveEmail(email);
      if (claimedFromUnproven) await reclaim(userId, req.ip, 'magic_link');
      return reply.code(200).send(await issueSession(userId, req.ip));
    },
  );

  // ── password ([ADR-0012](../../../../docs/adr/0012-password-authentication.md)) ──
  //
  // The one sign-in method that needs no third-party availability, no client
  // secret, and no mail delivery — which is why the desktop, which can have
  // none of the three, gets an account identity at all.

  /**
   * Create an account from name + email + password.
   *
   * **The one route here that is not enumeration-safe.** A taken address gets
   * `409 email_in_use`, because the alternative — answer identically and mail
   * the existing owner — needs the sender M13 still owes. The tradeoff is
   * bounded: it is signup, not sign-in, and it is rate-limited to 5/minute, so
   * it is a far worse oracle than the sign-in route it deliberately does not
   * apply to. Revisit when mail delivery exists.
   */
  app.post(
    '/auth/signup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = SignUpRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const created = await accounts.signUpWithPassword(parsed.data);
      if (!created.ok) {
        return reply.code(409).send({
          error: created.reason,
          message: 'an account already exists for that email address',
        });
      }
      return reply.code(201).send(await issueSession(created.userId, req.ip));
    },
  );

  /**
   * Sign in with email + password.
   *
   * Unknown address, wrong password, and an account with no password set all
   * answer `invalid_credentials`, and all three cost the same wall-clock time
   * (`AccountService.verifyPasswordSignIn` verifies against a dummy hash on the
   * branches that have nothing to verify). Both halves are needed: a caller who
   * can tell them apart by status OR by timing has an account-existence oracle.
   *
   * Rate-limited harder than the OAuth route: this is the endpoint a
   * credential-stuffing run actually targets, and each attempt costs a scrypt.
   */
  app.post(
    '/auth/password',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = PasswordSignInRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const result = await accounts.verifyPasswordSignIn(parsed.data.email, parsed.data.password);
      if (!result.ok) {
        // The audit log records WHICH of the three it was, and the address it
        // was tried against. The response does not — that is the oracle rule.
        // Recording only "password_invalid" made a failed sign-in impossible to
        // investigate: nothing in the system could say whether the account had
        // even been found, which is the first question any support case asks.
        void auditLog
          .loginFailed({
            ip: req.ip,
            metadata: {
              reason: `password_${result.reason}`,
              email: parsed.data.email.trim().toLowerCase(),
            },
          })
          .catch((err) => log.audit.error({ err }, 'failed to write login_failed audit log'));
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      return reply.code(200).send(await issueSession(result.userId, req.ip));
    },
  );

  /**
   * Ask for a password-reset token. Answers 202 whether or not the address has
   * an account, for the same reason `/auth/magic-link/request` does.
   *
   * The token is minted without checking that the account exists — deliberately.
   * Looking first would make the two cases cost different work for no benefit:
   * the response is identical either way, and `/reset/confirm` already refuses
   * a token whose address has no account, so a stray 15-minute Redis key is the
   * entire downside.
   */
  app.post(
    '/auth/password/reset/request',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = PasswordResetRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      if (!mailer) {
        return reply.code(503).send({
          error: 'magic_link_unavailable',
          message: 'password reset by email is not available on this server yet',
        });
      }
      const { token } = await createPasswordReset(parsed.data.email);
      // Same reasoning as the magic-link route: a provider rejection must not
      // surface as 500, and must not be reported as a mail that is on its way.
      try {
        await mailer.sendPasswordReset(parsed.data.email, token);
      } catch (err) {
        req.log.error({ err }, 'password-reset send failed');
        return reply.code(503).send({
          error: 'magic_link_unavailable',
          message: 'password reset by email is not available on this server right now',
        });
      }
      return reply.code(202).send({ ok: true });
    },
  );

  /**
   * Spend a reset token on a new password, and sign in.
   *
   * Signing in here is not a shortcut: redeeming the token has just proved
   * inbox possession, which is exactly the proof `/auth/magic-link/verify`
   * accepts on its own. Demanding a second sign-in immediately afterwards would
   * prove nothing and strand a user who has just changed the credential.
   *
   * A token for an address with no account still burns and still fails — it
   * creates nothing, so this cannot become a nameless second signup route.
   */
  app.post(
    '/auth/password/reset/confirm',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = PasswordResetConfirmSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const email = await redeemPasswordReset(parsed.data.token);
      if (!email) return denySignIn(reply, req.ip, 'password_reset_invalid');
      const userId = await accounts.setPasswordForEmail(email, parsed.data.password);
      if (!userId) return denySignIn(reply, req.ip, 'password_reset_no_account');
      // Resetting a password is what a user does after being compromised, so
      // it MUST end every session that existed before it. Without this the
      // attacker's stolen refresh token survives the one remediation the
      // product offers, and keeps renewing itself for another 30 days.
      // Revoked before the new session is issued, so this one survives.
      await refreshTokens.revokeUser(userId);
      void auditLog
        .sessionEnd({ userId, ip: req.ip, metadata: { event: 'password_reset_revoked_sessions' } })
        .catch((err) => log.audit.error({ err }, 'failed to write password-reset audit log'));
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
