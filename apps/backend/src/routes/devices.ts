import type { FastifyInstance } from 'fastify';
import {
  DevicePairsQuerySchema as ListQuerySchema,
  PairIdParamsSchema as PairParamsSchema,
  PairAutoApprovePatchSchema as PatchBodySchema,
} from '@lilypad/protocol';
import { TrustService, createDrizzleTrustStore } from '../services/trust.js';
import { AuditLogService, createDrizzleAuditLogStore } from '../services/auditLog.js';
import { log } from '../logging.js';

/**
 * Trusted-pair management (M5.4) — consumed by the desktop's dashboard
 * (Trusted Devices pane). Pre-M5-keys these are as unauthenticated as the
 * rest of the pairing surface (deviceIds are self-asserted); the M5 device
 * identity upgrade gates them behind a key signature without changing their
 * shape. Rate-limited like the other unauthenticated mutating endpoints.
 */
export async function deviceRoutes(app: FastifyInstance): Promise<void> {
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
   * the connect gate fails closed from now on. */
  app.delete(
    '/devices/pairs/:pairId',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const params = PairParamsSchema.safeParse(req.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      await trust.revoke(params.data.pairId);
      void auditLog
        .sessionEnd({ metadata: { event: 'device_revoked', pairId: params.data.pairId } })
        .catch((err) => log.audit.error({ err }, 'failed to write device_revoked audit log'));
      return reply.code(200).send({ ok: true });
    },
  );
}
