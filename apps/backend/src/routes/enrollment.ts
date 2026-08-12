import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  DeviceEnrollRequestSchema,
  DeviceTokenRequestSchema,
  DesktopEnrollmentCodeRequestSchema,
  DesktopEnrollmentApproveSchema,
  type DeviceChallenge,
  type DeviceSession,
} from '@lilypad/protocol';
import {
  createDeviceChallenge,
  consumeDeviceChallenge,
  verifyDeviceSignature,
} from '../auth/deviceIdentity.js';
import { DeviceRegistry, createDrizzleDeviceIdentityStore } from '../auth/deviceRegistry.js';
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from '../auth/tokens.js';
import { requireAuth, requireDevice, actorOf, deviceActorOf } from '../auth/requireAuth.js';
import {
  createDesktopEnrollmentCode,
  consumeDesktopEnrollmentCode,
} from '../auth/desktopEnrollment.js';
import { AuditLogService, createDrizzleAuditLogStore } from '../services/auditLog.js';
import { log } from '../logging.js';

/**
 * Device identity ([ADR-0002](../../../../docs/adr/0002-device-identity.md)).
 *
 * Enrollment needs an account token — it is the moment a machine gains an
 * owner, so an owner must be present to gain. Everything after that needs only
 * the key: a device renews by signing a fresh challenge, so its durable
 * credential is a non-exportable private key rather than a stored bearer
 * string. That is why there is no device refresh token.
 *
 * Both proof-carrying routes burn the challenge BEFORE checking the signature.
 * The other order leaves a failed attempt's nonce spendable, which hands an
 * attacker unlimited tries against one challenge.
 */
export async function enrollmentRoutes(app: FastifyInstance): Promise<void> {
  const registry = new DeviceRegistry(createDrizzleDeviceIdentityStore());
  const auditLog = new AuditLogService(createDrizzleAuditLogStore());

  /** Issue a nonce for a device to sign. Unauthenticated by necessity — a
   * device that has no token yet is the whole point. Rate-limited because it
   * mints Redis state on an anonymous caller's say-so, the same reasoning as
   * `/pairing/create`. */
  app.post(
    '/devices/challenge',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      const challenge: DeviceChallenge = await createDeviceChallenge();
      return reply.code(201).send(challenge);
    },
  );

  /**
   * Bind a device's public key to the signed-in account, and return a
   * device-scoped token. Also claims a pre-account row for this fingerprint if
   * one exists, so trust relationships created before accounts survive.
   */
  app.post(
    '/devices/enroll',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const parsed = DeviceEnrollRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { challenge, publicKey, signature, kind, fingerprint, name, platform } = parsed.data;
      const actor = actorOf(req);

      if (!(await proofHolds(challenge, publicKey, signature))) {
        return invalidSignature(reply, req.ip, { userId: actor.userId, step: 'enroll' });
      }

      const enrolled = await registry.enroll({
        userId: actor.userId,
        kind,
        fingerprint,
        publicKey,
        name,
        platform,
      });
      if (!enrolled.ok) {
        void auditLog
          .loginFailed({
            userId: actor.userId,
            ip: req.ip,
            metadata: { reason: enrolled.reason, step: 'enroll', kind },
          })
          .catch((err) => log.audit.error({ err }, 'failed to write login_failed audit log'));
        return reply.code(409).send({
          error: enrolled.reason,
          message:
            enrolled.reason === 'public_key_in_use'
              ? 'that key already identifies a different device'
              : 'this device is already enrolled on another account',
        });
      }

      return reply.code(200).send(await deviceSession(enrolled.deviceId, actor.userId, req.ip));
    },
  );

  /**
   * Exchange proof of key possession for a device access token — how a device
   * signs itself back in after a restart, with no user interaction and no
   * stored bearer credential.
   */
  app.post(
    '/devices/token',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = DeviceTokenRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { challenge, publicKey, signature } = parsed.data;

      if (!(await proofHolds(challenge, publicKey, signature))) {
        return invalidSignature(reply, req.ip, { step: 'device_token' });
      }

      const authenticated = await registry.authenticate(publicKey);
      if (!authenticated.ok) {
        void auditLog
          .loginFailed({ ip: req.ip, metadata: { reason: authenticated.reason } })
          .catch((err) => log.audit.error({ err }, 'failed to write login_failed audit log'));
        // 403 rather than 401: the caller's credential is valid, it is the
        // device that is not allowed — retrying with the same key will not
        // help, and a client that cannot tell these apart retries forever.
        return reply.code(403).send({
          error: authenticated.reason,
          message:
            authenticated.reason === 'device_revoked'
              ? 'this device was revoked — enroll it again to restore access'
              : 'this device is not enrolled on any account',
        });
      }

      return reply
        .code(200)
        .send(await deviceSession(authenticated.deviceId, authenticated.userId, req.ip));
    },
  );

  /**
   * A desktop asks for an enrollment code, proving it holds the keypair the
   * code will be bound to ([ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)).
   *
   * Unauthenticated by necessity — an unenrolled desktop has no token, which is
   * the entire reason this flow exists. What makes that safe is the binding: a
   * code can only ever enroll the key it was minted for, so intercepting one
   * does not let an attacker enroll their own machine.
   */
  app.post(
    '/devices/enrollment-code',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = DesktopEnrollmentCodeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { challenge, publicKey, signature, fingerprint, name, platform } = parsed.data;
      if (!(await proofHolds(challenge, publicKey, signature))) {
        return invalidSignature(reply, req.ip, { step: 'desktop_enrollment_code' });
      }
      const minted = await createDesktopEnrollmentCode({
        publicKey,
        fingerprint,
        name: name ?? null,
        platform: platform ?? null,
      });
      return reply.code(201).send(minted);
    },
  );

  /**
   * An already-enrolled phone approves a desktop onto ITS OWN account.
   *
   * `requireDevice`, not `requireAuth`: approving another machine onto an
   * account is exactly the kind of act that should need a device that was
   * itself enrolled, rather than any account session. The account the desktop
   * joins is the token's subject and nothing else — the request body carries
   * only the code.
   */
  app.post(
    '/devices/enrollment-code/approve',
    {
      preHandler: requireDevice,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const parsed = DesktopEnrollmentApproveSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const approver = deviceActorOf(req);
      const record = await consumeDesktopEnrollmentCode(parsed.data.code);
      if (!record) {
        // Unknown, expired, and already-used answer identically: a phone that
        // could tell them apart could probe for live codes.
        return reply
          .code(404)
          .send({ error: 'invalid_code', message: 'that code has expired — show a new one' });
      }

      const enrolled = await registry.enroll({
        userId: approver.userId,
        kind: 'desktop',
        fingerprint: record.fingerprint,
        publicKey: record.publicKey,
        name: record.name,
        platform: record.platform,
      });
      if (!enrolled.ok) {
        void auditLog
          .loginFailed({
            userId: approver.userId,
            ip: req.ip,
            metadata: { reason: enrolled.reason, step: 'desktop_enrollment_approve' },
          })
          .catch((err) => log.audit.error({ err }, 'failed to write login_failed audit log'));
        return reply.code(409).send({
          error: enrolled.reason,
          message:
            enrolled.reason === 'public_key_in_use'
              ? 'that key already identifies a different device'
              : 'that computer is already on another account',
        });
      }

      void auditLog
        .login({
          userId: approver.userId,
          deviceId: enrolled.deviceId,
          ip: req.ip,
          metadata: { subject: 'desktop', approvedBy: approver.deviceId },
        })
        .catch((err) => log.audit.error({ err }, 'failed to write login audit log'));

      // The desktop learns it succeeded by its next /devices/token call
      // starting to work — no extra endpoint, no push channel, no polling
      // protocol to specify.
      return reply.code(200).send({ ok: true, deviceId: enrolled.deviceId });
    },
  );

  /** Burn the challenge, then check the signature — in that order. */
  async function proofHolds(
    challenge: string,
    publicKey: string,
    signature: string,
  ): Promise<boolean> {
    if (!(await consumeDeviceChallenge(challenge))) return false;
    return verifyDeviceSignature(publicKey, challenge, signature);
  }

  function invalidSignature(
    reply: FastifyReply,
    ip: string,
    metadata: Record<string, unknown>,
  ): FastifyReply {
    void auditLog
      .loginFailed({ ip, metadata: { reason: 'invalid_signature', ...metadata } })
      .catch((err) => log.audit.error({ err }, 'failed to write login_failed audit log'));
    // One code for an unknown, expired, already-spent, or wrongly-signed
    // challenge alike — telling them apart would say which half to fix.
    return reply.code(401).send({ error: 'invalid_signature' });
  }

  async function deviceSession(
    deviceId: string,
    userId: string,
    ip: string,
  ): Promise<DeviceSession> {
    const accessToken = await signAccessToken({ userId, deviceId });
    void auditLog
      .login({ userId, deviceId, ip, metadata: { subject: 'device' } })
      .catch((err) => log.audit.error({ err }, 'failed to write login audit log'));
    return { accessToken, expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS, deviceId, userId };
  }
}
