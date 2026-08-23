import type { FastifyInstance, FastifyReply } from 'fastify';
import { PairingCreateRequestSchema, PairingRedeemRequestSchema } from '@lilypad/protocol';
import { createPairing, redeemPairing, PairingTokenError } from '../services/pairing.js';
import { AuditLogService, createDrizzleAuditLogStore } from '../services/auditLog.js';
import { optionalAuth, optionalActorOf } from '../auth/requireAuth.js';
import { rejectRevokedActor } from '../auth/liveDevice.js';
import { actAsDevice } from '../auth/authorize.js';
import { deviceOwnershipByFingerprint } from '../auth/ownership.js';
import { log } from '../logging.js';

/**
 * The QR pairing ceremony. Both routes are gated on ACTING AS the device they
 * name (M9, [ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)):
 * a linked machine's pairing surface belongs to that machine, so minting a QR
 * "as" someone's laptop or redeeming one "as" someone's phone now requires
 * being it. A device no account owns is unowned and keeps the pre-accounts
 * path — see `auth/authorize.ts`.
 */
export async function pairingRoutes(app: FastifyInstance): Promise<void> {
  const auditLog = new AuditLogService(createDrizzleAuditLogStore());

  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

  // Desktop mints a single-use QR token (60s TTL in Redis). Tighter than the
  // generic global limiter (`server.ts`) since it mints real Redis-backed state
  // on every call — an unlinked desktop no longer reaches it at all, but a
  // linked one with the pairing window open still refreshes about once a minute
  // — see docs/audit/m3/backend-security.md Finding 10. The budget must
  // still absorb LEGITIMATE churn: tokens expire every 60s, so a desktop
  // with its pairing window open refreshes ~1/min baseline, plus bursts of
  // manual regenerates — 5/min throttled real users (observed in bring-up).
  app.post(
    '/pairing/create',
    {
      preHandler: [optionalAuth, rejectRevokedActor],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const parsed = PairingCreateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const desktop = await deviceOwnershipByFingerprint('desktop', parsed.data.deviceId);
      if (!actAsDevice(optionalActorOf(req), desktop).allow) return notFound(reply);
      const result = await createPairing(parsed.data);
      return reply.code(201).send(result);
    },
  );

  // Mobile redeems the token after scanning. Single-use: a replay fails.
  app.post(
    '/pairing/redeem',
    { preHandler: [optionalAuth, rejectRevokedActor] },
    async (req, reply) => {
      const parsed = PairingRedeemRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const mobile = await deviceOwnershipByFingerprint('mobile', parsed.data.deviceId);
      if (!actAsDevice(optionalActorOf(req), mobile).allow) return notFound(reply);
      try {
        const result = await redeemPairing(parsed.data);
        // Repudiation mitigation (docs/threat-model.md): a device just
        // completed pairing. Fire-and-forget — an audit-log blip must never
        // fail a redeem the mobile app is blocked on, matching the
        // `sessions.create`/`sessions.end` pattern in routes/signaling.ts.
        void auditLog
          .devicePaired({
            ip: req.ip,
            metadata: {
              roomId: result.roomId,
              mobileDeviceId: parsed.data.deviceId,
              desktopDeviceName: result.desktopDeviceName,
            },
          })
          .catch((err) => log.audit.error({ err }, 'failed to write device_paired audit log'));
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof PairingTokenError) {
          return reply.code(410).send({ error: 'token_invalid', message: err.message });
        }
        throw err;
      }
    },
  );
}
