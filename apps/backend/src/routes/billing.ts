import type { FastifyInstance } from 'fastify';
import {
  AppleNotificationV2Schema,
  AppleTransactionSubmitSchema,
} from '@lilypad/protocol';
import { requireAuth, actorOf } from '../auth/requireAuth.js';
import { rejectRevokedActor } from '../auth/liveDevice.js';
import {
  appleBillingConfigured,
  applyNotificationPayload,
  applySignedTransaction,
  billingStatusFor,
} from '../services/appleBilling.js';
import { log } from '../logging.js';

/**
 * StoreKit verification and App Store Server Notifications
 * ([ADR-0016](../../../../docs/adr/0016-storekit-and-the-price.md)).
 */
export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/billing/status',
    {
      preHandler: [requireAuth, rejectRevokedActor],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const status = await billingStatusFor(actorOf(req).userId);
      if (status === null) return reply.code(404).send({ error: 'not_found' });
      return reply.code(200).send(status);
    },
  );

  app.post(
    '/billing/apple/transactions',
    {
      preHandler: [requireAuth, rejectRevokedActor],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      if (!appleBillingConfigured()) {
        return reply.code(503).send({
          error: 'billing_unconfigured',
          message: 'purchases are not available on this server yet',
        });
      }
      const body = AppleTransactionSubmitSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

      const result = await applySignedTransaction(actorOf(req).userId, body.data.signedTransaction);
      if (!result.ok) {
        if (result.error === 'already_linked') {
          return reply.code(409).send({
            error: 'already_linked',
            message:
              'that Apple subscription is already linked to a different Lilypad account',
          });
        }
        if (result.error === 'wrong_product') {
          return reply.code(400).send({ error: 'wrong_product' });
        }
        if (result.error === 'not_configured') {
          return reply.code(503).send({ error: 'billing_unconfigured' });
        }
        return reply.code(400).send({ error: 'invalid_transaction' });
      }
      return reply.code(200).send(result.status);
    },
  );

  /**
   * App Store Server Notifications V2.
   *
   * No Lilypad auth — Apple is the caller. Authenticity is the JWS. Always
   * answer 200 once the payload is well-formed enough to parse, so Apple does
   * not retry a notification we have already decided we cannot apply.
   */
  app.post(
    '/billing/apple/notifications',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      if (!appleBillingConfigured()) {
        // Tell Apple to retry later rather than drop the event forever.
        return reply.code(503).send({ error: 'billing_unconfigured' });
      }
      const body = AppleNotificationV2Schema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

      const result = await applyNotificationPayload(body.data.signedPayload);
      if (!result.handled && result.reason === 'invalid_payload') {
        return reply.code(400).send({ error: 'invalid_payload' });
      }
      log.server.info({ reason: result.reason }, 'ASSN processed');
      return reply.code(200).send({ ok: true });
    },
  );
}
