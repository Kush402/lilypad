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
import { rejectRevokedActor } from '../auth/liveDevice.js';
import {
  createDesktopEnrollmentCode,
  consumeDesktopEnrollmentCode,
} from '../auth/desktopEnrollment.js';
import { TrustService, createDrizzleTrustStore } from '../services/trust.js';
import { AuditLogService, createDrizzleAuditLogStore } from '../services/auditLog.js';
import { advertisedUrls } from '../services/advertisedUrls.js';
import { allowedProofHosts, isProofOriginAllowed } from '../auth/proofOrigin.js';
import { config } from '../config.js';
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
 * **Every kind of device enrols the same way** — signing in on a machine is
 * what puts it on the account
 * ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)). The
 * enrollment-code routes further down are no longer how a Mac gains an owner;
 * they are how a Mac that cannot sign in gets adopted, and how one ceremony
 * both adopts and pairs.
 *
 * Both proof-carrying routes burn the challenge BEFORE checking the signature.
 * The other order leaves a failed attempt's nonce spendable, which hands an
 * attacker unlimited tries against one challenge.
 */
export async function enrollmentRoutes(app: FastifyInstance): Promise<void> {
  const registry = new DeviceRegistry(createDrizzleDeviceIdentityStore());
  const trust = new TrustService(createDrizzleTrustStore());
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
      preHandler: [requireAuth, rejectRevokedActor],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const parsed = DeviceEnrollRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const {
        challenge,
        publicKey,
        signature,
        kind,
        fingerprint,
        name,
        platform,
        appVersion,
        proofOrigin,
      } = parsed.data;
      const actor = actorOf(req);

      // A desktop used to be refused here — ownership was supposed to cost a
      // phone approving an enrollment code
      // ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
      // [ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)
      // reverses that, for two reasons.
      //
      // **It protected nothing.** The capability it meant to withhold is a
      // device token, and the same account password already mints one through
      // this very route with `kind: "mobile"` — install the phone app, sign
      // in, self-enrol. Every `requireDevice` route (list, rename, revoke,
      // approve an enrollment) was reachable that way the whole time. The
      // guard constrained one client, never the capability.
      //
      // **It made ownership mean two different things per platform.** A phone
      // joined the account at sign-in; a Mac did not, so a customer who signed
      // in on both saw one device in "Your devices" and reasonably read it as
      // a broken product.
      //
      // What is NOT reversed: ownership still buys no reach. `/connect/request`
      // authorizes on a `trusted_devices` row and a per-pair secret and never
      // consults `devices.user_id`, so a stolen password still cannot see a
      // screen — that costs the QR ceremony, which is where the
      // physical-possession factor actually lives.

      if (!(await proofHolds(challenge, publicKey, signature, proofOrigin))) {
        return invalidSignature(reply, req.ip, { userId: actor.userId, step: 'enroll' });
      }

      const enrolled = await registry.enroll({
        userId: actor.userId,
        kind,
        fingerprint,
        publicKey,
        name,
        platform,
        // Self-enrollment proves an account session and nothing more, and
        // enrolling clears `revoked_at`. Handing the registry the token's issue
        // time is what stops a phone that was revoked a minute ago from
        // undoing that with the credential it was already holding.
        credentialIssuedAt: actor.issuedAt,
      });
      if (!enrolled.ok) {
        void auditLog
          .loginFailed({
            userId: actor.userId,
            ip: req.ip,
            metadata: { reason: enrolled.reason, step: 'enroll', kind },
          })
          .catch((err) => log.audit.error({ err }, 'failed to write login_failed audit log'));
        if (enrolled.reason === 'device_revoked') {
          return reply.code(403).send({
            error: 'device_revoked',
            message: 'this device was removed from the account — sign in again on it to restore it',
          });
        }
        // Reachable on any device now that a Mac enrols itself (ADR-0015), and
        // the likeliest way to reach it is account switching: one machine, one
        // owner, and the second person to sign in is refused. The message has
        // to name the remedy, because there is exactly one and it is not
        // obvious — the FIRST account has to remove the device from "Your
        // devices", which is what frees the row.
        return reply.code(409).send({
          error: enrolled.reason,
          message:
            enrolled.reason === 'public_key_in_use'
              ? // This device's key is enrolled under a DIFFERENT wire id, which
                // means its local id and its key have drifted apart — the app's
                // data directory was cleared while the keychain entry survived.
                // There is no self-service fix today (see kanban L-153), so the
                // message names the situation rather than pretending otherwise.
                'this device’s saved key belongs to a different device record. Contact support@takedia.com — this needs a reset on our side.'
              : 'this device already belongs to a different Lilypad account. Remove it from that account first, then sign in again here.',
        });
      }

      return reply
        .code(200)
        .send(
          await deviceSession(
            enrolled.deviceId,
            actor.userId,
            enrolled.fingerprint,
            req.ip,
            appVersion,
          ),
        );
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
      const { challenge, publicKey, signature, appVersion, deviceName, proofOrigin } = parsed.data;

      if (!(await proofHolds(challenge, publicKey, signature, proofOrigin))) {
        return invalidSignature(reply, req.ip, { step: 'device_token' });
      }

      const authenticated = await registry.authenticate(publicKey);
      if (!authenticated.ok) {
        // Only `device_revoked` is a security event. `device_not_enrolled` is
        // the ordinary state of every laptop between install and linking, and
        // this route is how the desktop LEARNS it has been linked — the
        // comment on the approve route says so: "the desktop learns it
        // succeeded by its next /devices/token call starting to work". So the
        // product polls it on purpose, and auditing every poll writes a
        // `login_failed` row for a machine doing exactly what it should.
        //
        // Measured on the 0.1.3 customer run: 120 `login_failed` rows in the
        // three minutes between first launch and linking, all of them normal.
        // A revoked device coming back — the one thing here worth alerting on
        // — was indistinguishable from that noise.
        if (authenticated.reason === 'device_revoked') {
          void auditLog
            .loginFailed({ ip: req.ip, metadata: { reason: authenticated.reason } })
            .catch((err) => log.audit.error({ err }, 'failed to write login_failed audit log'));
        }
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
        .send(
          await deviceSession(
            authenticated.deviceId,
            authenticated.userId,
            authenticated.fingerprint,
            req.ip,
            appVersion,
            deviceName,
          ),
        );
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
      const { challenge, publicKey, signature, fingerprint, name, platform, proofOrigin } =
        parsed.data;
      if (!(await proofHolds(challenge, publicKey, signature, proofOrigin))) {
        return invalidSignature(reply, req.ip, { step: 'desktop_enrollment_code' });
      }
      const minted = await createDesktopEnrollmentCode({
        publicKey,
        fingerprint,
        name: name ?? null,
        platform: platform ?? null,
      });
      // The address the PHONE will use, not the one this desktop was
      // configured with — same seam `/pairing/create` uses, so a laptop
      // talking to localhost can still put a reachable URL in its QR.
      return reply.code(201).send({ ...minted, apiBaseUrl: advertisedUrls().apiBaseUrl });
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
      preHandler: [requireDevice, rejectRevokedActor],
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

      // Linking must make the laptop REACHABLE, not merely owned. Enrollment
      // writes `devices.user_id`; `/connect/request` authorizes on a
      // `trusted_devices` row and a per-pair secret and never consults
      // ownership. Without this the user completes the whole ceremony and then
      // cannot connect — one product step that silently needed two.
      const { pairSecret } = await trust.establishTrustForDeviceIds(
        enrolled.deviceId,
        approver.deviceId,
      );

      // The desktop learns it succeeded by its next /devices/token call
      // starting to work — no extra endpoint, no push channel, no polling
      // protocol to specify. The PHONE, though, needs the connect secret it
      // will present later, and this is its one delivery: it is never stored
      // in plaintext server-side and cannot be re-read.
      //
      // It also needs the laptop's WIRE id, and for a while it was handed the
      // uuid instead. `deviceId` here is `devices.id`; `/connect/request` and
      // `/devices/unpair` resolve `devices.fingerprint`. The phone stored the
      // uuid as the wire id, so both routes looked for a device that could not
      // exist: connect answered `404 not_trusted` about a live pair, and
      // Forget answered 200 while severing nothing. Both are returned now,
      // under names that say which is which.
      return reply.code(200).send({
        ok: true,
        deviceId: enrolled.deviceId,
        desktopDeviceId: record.fingerprint,
        name: record.name,
        platform: record.platform,
        pairSecret,
      });
    },
  );

  /**
   * Burn the challenge, then check the signature — in that order.
   *
   * `proofOrigin` is the host the client says it is talking to, and its
   * presence selects the v2 message (ADR-0002, L-30). Two checks, and the
   * order matters:
   *
   * 1. **Is that host one of ours?** If it is not, this is either a relay
   *    forwarding a proof a device made for someone else's server, or a
   *    deployment whose advertised address does not match what clients use.
   *    Both must be refused; the log line below is what tells them apart.
   * 2. **Do the bytes verify?** Only then, and over exactly the host claimed.
   *
   * Skipping (1) would make v2 pointless: a signature over `evil.example`
   * verifies perfectly well against the key that made it. The refusal is the
   * security property, not the signing.
   *
   * A request with no `proofOrigin` is checked against the v1 message, so
   * every client already installed keeps working. Both are accepted until the
   * fleet has moved — `devices.app_version` (L-25) is how that becomes a fact
   * rather than a guess.
   */
  async function proofHolds(
    challenge: string,
    publicKey: string,
    signature: string,
    proofOrigin?: string | null,
  ): Promise<boolean> {
    if (!(await consumeDeviceChallenge(challenge))) return false;
    if (proofOrigin == null && config.env.REQUIRE_DEVICE_PROOF_ORIGIN) {
      // v2 is only worth what the weakest accepted form is worth. While v1 is
      // still allowed, a relayed v1 signature can be presented instead of the
      // v2 one it could not forge — so refusing v1 is the step that actually
      // closes the relay, not adding v2.
      log.audit.warn(
        { step: 'device_proof' },
        'refused a proof that names no server (REQUIRE_DEVICE_PROOF_ORIGIN)',
      );
      return false;
    }
    if (proofOrigin != null) {
      const allowed = allowedProofHosts({
        publicBaseUrl: config.env.PUBLIC_BASE_URL,
        advertisedApiBaseUrl: advertisedUrls().apiBaseUrl,
        extraHosts: config.env.DEVICE_PROOF_HOSTS,
      });
      if (!isProofOriginAllowed(proofOrigin, allowed)) {
        // Warn, not error: a relayed proof is an attack and a mismatched
        // deployment is a misconfiguration, and this one line is what
        // distinguishes them. The client is told only `invalid_signature` —
        // naming which half was wrong tells an attacker which half to fix.
        log.audit.warn(
          { proofOrigin, allowed: [...allowed] },
          'device proof named a host this server does not answer to',
        );
        return false;
      }
    }
    return verifyDeviceSignature(publicKey, challenge, signature, proofOrigin);
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
    fingerprint: string,
    ip: string,
    appVersion?: string | null,
    deviceName?: string | null,
  ): Promise<DeviceSession> {
    const accessToken = await signAccessToken({ userId, deviceId });
    // Every path that hands out a device token comes through here, which makes
    // it the one place "this device was just seen" is true for all of them.
    // `DeviceRegistry.authenticate` marks the renew path; enrolment did not,
    // so a freshly enrolled phone read as never seen while its owner held it.
    // Fire-and-forget for the same reason as the audit write below: a
    // bookkeeping column must never fail the sign-in it describes.
    void registry
      .markSeen(deviceId, appVersion, deviceName)
      .catch((err) => log.audit.warn({ err }, 'failed to mark device as seen'));
    void auditLog
      .login({ userId, deviceId, ip, metadata: { subject: 'device' } })
      .catch((err) => log.audit.error({ err }, 'failed to write login audit log'));
    // `fingerprint` is the row's, never the caller's claim. A client whose
    // local id has drifted from the one its key is enrolled under adopts this
    // and becomes reachable again — see `DeviceSessionSchema`.
    return {
      accessToken,
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      deviceId,
      userId,
      fingerprint,
    };
  }
}
