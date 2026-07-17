import type { FastifyInstance } from 'fastify';
import { PairingCreateRequestSchema, PairingRedeemRequestSchema } from '@lilypad/protocol';
import { createPairing, redeemPairing, PairingTokenError } from '../services/pairing.js';
import { AuditLogService, createDrizzleAuditLogStore } from '../services/auditLog.js';
import { log } from '../logging.js';

export async function pairingRoutes(app: FastifyInstance): Promise<void> {
  const auditLog = new AuditLogService(createDrizzleAuditLogStore());

  // Desktop mints a single-use QR token (60s TTL in Redis). Tighter than the
  // generic global limiter (`server.ts`) since this endpoint is fully
  // unauthenticated pre-M5 and mints real Redis-backed state on every call
  // — see docs/audit/m3/backend-security.md Finding 10. The budget must
  // still absorb LEGITIMATE churn: tokens expire every 60s, so a desktop
  // with its pairing window open refreshes ~1/min baseline, plus bursts of
  // manual regenerates — 5/min throttled real users (observed in bring-up).
  app.post(
    '/pairing/create',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = PairingCreateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const result = await createPairing(parsed.data);
      return reply.code(201).send(result);
    },
  );

  // Mobile redeems the token after scanning. Single-use: a replay fails.
  app.post('/pairing/redeem', async (req, reply) => {
    const parsed = PairingRedeemRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
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
  });
}
