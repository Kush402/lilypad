import type { FastifyInstance } from 'fastify';
import {
  DevicePairsQuerySchema as ListQuerySchema,
  PairIdParamsSchema as PairParamsSchema,
  PairAutoApprovePatchSchema as PatchBodySchema,
  UnpairRequestSchema,
} from '@lilypad/protocol';
import { TrustService, createDrizzleTrustStore } from '../services/trust.js';
import { AuditLogService, createDrizzleAuditLogStore } from '../services/auditLog.js';
import type { SignalingHub } from '../signaling/hub.js';
import { log } from '../logging.js';

/**
 * Trusted-pair management (M5.4) — consumed by the desktop's dashboard
 * (Trusted Devices pane). Pre-M5-keys these are as unauthenticated as the
 * rest of the pairing surface (deviceIds are self-asserted); the M5 device
 * identity upgrade gates them behind a key signature without changing their
 * shape. Rate-limited like the other unauthenticated mutating endpoints.
 */
export async function deviceRoutes(
  app: FastifyInstance,
  deps: { hub: SignalingHub },
): Promise<void> {
  const { hub } = deps;
  const trust = new TrustService(createDrizzleTrustStore());
  const auditLog = new AuditLogService(createDrizzleAuditLogStore());

  /** Every pair for a desktop, for its Trusted Devices list. */
  app.get('/devices/pairs', async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const pairs = await trust.listForDesktop(parsed.data.desktopDeviceId);
    return reply.code(200).send({ pairs });
  });

  /** Flip a pair's "connect without approval" (Always allow) setting. */
  app.patch(
    '/devices/pairs/:pairId',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const params = PairParamsSchema.safeParse(req.params);
      const body = PatchBodySchema.safeParse(req.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      await trust.setAutoApprove(params.data.pairId, body.data.autoApprove);
      return reply.code(200).send({ ok: true });
    },
  );

  /** Revoke a pair (desktop-side "Revoke"). The row is kept as audit trail;
   * the connect gate fails closed from now on. Also force-ends any live
   * session for this exact pair right now — revoke must not wait for the
   * phone to happen to disconnect on its own. */
  app.delete(
    '/devices/pairs/:pairId',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const params = PairParamsSchema.safeParse(req.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const fingerprints = await trust.revoke(params.data.pairId);
      if (fingerprints) {
        const ended = hub.endRoomsForDevicePair(
          fingerprints.desktopFingerprint,
          fingerprints.mobileFingerprint,
          'revoked',
        );
        if (ended > 0) {
          log.signaling.info({ pairId: params.data.pairId, ended }, 'revoke ended a live session');
        }
      }
      void auditLog
        .sessionEnd({ metadata: { event: 'device_revoked', pairId: params.data.pairId } })
        .catch((err) => log.audit.error({ err }, 'failed to write device_revoked audit log'));
      return reply.code(200).send({ ok: true });
    },
  );

  /** Mobile-initiated unpair — a phone "Forget" severs the pairing on the
   * backend too (so it leaves the laptop's Trusted Devices), the symmetric
   * counterpart to the desktop's own Revoke above. Idempotent: unknown or
   * already-revoked pairs still return ok. Ends any live session for the pair
   * with a NEUTRAL reason ('unpaired', not 'revoked') — the phone initiated
   * this itself, so it must not trip the mobile client's "your access was
   * revoked" alert, which is reserved for the desktop-initiated Revoke. */
  app.post(
    '/devices/unpair',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = UnpairRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { desktopDeviceId, mobileDeviceId } = parsed.data;
      const pair = await trust.findPair(desktopDeviceId, mobileDeviceId);
      if (pair && !pair.revoked) {
        await trust.revoke(pair.pairId);
        const ended = hub.endRoomsForDevicePair(desktopDeviceId, mobileDeviceId, 'unpaired');
        void auditLog
          .sessionEnd({
            metadata: {
              event: 'device_unpaired_by_mobile',
              pairId: pair.pairId,
              endedLiveSessions: ended,
            },
          })
          .catch((err) => log.audit.error({ err }, 'failed to write device_unpaired audit log'));
      }
      return reply.code(200).send({ ok: true });
    },
  );
}
