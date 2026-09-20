import type { FastifyInstance } from 'fastify';
import {
  ASK_MAX_REQUEST_BYTES,
  AskSystemOneRequestSchema,
  type AskSystemOneReply,
} from '@lilypad/protocol';
import { requireDevice, deviceActorOf } from '../auth/requireAuth.js';
import { rejectRevokedActor } from '../auth/liveDevice.js';
import { hostedAskAccessFor } from '../services/entitlement.js';
import { claimHostedAskTask } from '../services/askAllowance.js';
import { askSystemOne, hostedAskConfigured } from '../services/askSystemOne.js';
import { log } from '../logging.js';

/**
 * Ask, running on Lilypad's own System One account
 * ([ADR-0020](../../../../docs/adr/0020-lilypad-runs-computer-use-on-its-own-account.md)).
 *
 * This is the narrow exception to [ADR-0007](../../../../docs/adr/0007-cloud-is-control-plane-only.md):
 * one route, text only, never a pixel, only for a person who chose *Lilypad*
 * rather than their own key, and refused without a subscription. Everything
 * else about Ask still goes straight from the Mac to whoever the customer
 * configured, and needs nothing here.
 *
 * ### The order of the gates, and why it is that order
 *
 *  1. **Is the caller a device?** `requireDevice`, not `requireAuth`: a
 *     signed-in phone session is not a Mac, and identity comes only from the
 *     token (ADR-0002). Nothing in the body decides whose allowance is spent.
 *  2. **Is the device still live?** `rejectRevokedActor`, as every other
 *     device-acting route — a revoked Mac must stop spending immediately, not
 *     when its token happens to expire.
 *  3. **Can this deployment serve the tier at all?** Before entitlement, so
 *     an unconfigured server says so instead of telling a paying customer
 *     they are not entitled.
 *  4. **Is the account entitled?** Pro or Team, evaluated by the same reader
 *     as the billing screen. Fails closed.
 *  5. **Is there allowance left?** Counted per account per UTC day, and
 *     counted per *task* — see `askAllowance.ts`. Fails closed if Redis
 *     cannot answer: an allowance that cannot be enforced is not one.
 *  6. **Only then** is anything forwarded to TypeSafe.
 *
 * Entitlement before allowance matters commercially as well as logically: a
 * free account must never be able to consume a paid account's counters, and
 * must never learn what the counters are.
 *
 * ### What is kept
 *
 * Two integers per account per day, in Redis, expiring at midnight. The body
 * of a request is parsed, forwarded and dropped. It is not written to a
 * database, not attached to a log line, and not included in any error — see
 * `askSystemOne.ts`, which is the only function that ever holds both the
 * screen reading and the credential.
 */
export async function askRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/ask/v1/systemone',
    {
      preHandler: [requireDevice, rejectRevokedActor],
      // Fastify's default is 1 MiB — three orders of magnitude more than a
      // step needs, and exactly the room a screenshot would want. Refused
      // before the body is parsed, let alone validated.
      bodyLimit: ASK_MAX_REQUEST_BYTES,
      // A generous per-minute ceiling on top of the daily allowance: twelve
      // steps a task, a few tasks a minute at human speed. This is the guard
      // against a loop, not against use.
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const actor = deviceActorOf(req);

      if (!hostedAskConfigured()) {
        return reply.code(503).send({
          error: 'unconfigured',
          message: 'Lilypad’s own account is not available on this server.',
        });
      }

      const body = AskSystemOneRequestSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

      const access = await hostedAskAccessFor(actor.userId);
      if (access !== 'entitled') {
        // 402 rather than 403: the caller authenticated fine and the thing
        // they are missing can be bought. A deleted account gets the same
        // answer, because "no such account" is not a sentence to hand back
        // to a valid token — the device routes already deal with that.
        return reply.code(402).send({
          error: 'not_entitled',
          message: 'Running tasks on Lilypad’s own account needs an active Pro or Team plan.',
        });
      }

      let claim: Awaited<ReturnType<typeof claimHostedAskTask>>;
      try {
        claim = await claimHostedAskTask(actor.userId, body.data.taskId);
      } catch (err) {
        // Fail CLOSED. Redis being unreachable means the day's count cannot
        // be read or advanced, and serving anyway would make the allowance
        // unbounded for exactly as long as the outage lasts — which is the
        // window an attacker would create on purpose.
        log.server.error({ err }, 'hosted ask allowance unavailable');
        return reply.code(503).send({
          error: 'allowance_unavailable',
          message: 'Lilypad could not check today’s allowance. Try again in a moment.',
        });
      }

      if (!claim.ok) {
        return reply.code(429).send({
          error: claim.reason,
          message:
            claim.reason === 'daily_limit'
              ? `That is all ${claim.allowance.limit} of today’s tasks on Lilypad’s account.`
              : 'That task took more steps than Lilypad will run.',
          allowance: claim.allowance,
        });
      }

      const upstream = await askSystemOne(body.data);
      if (!upstream.ok) {
        if (upstream.reason === 'unconfigured') {
          return reply.code(503).send({ error: 'unconfigured' });
        }
        // Deliberately no body echo and no upstream text. `detail` is one of
        // this file's own words ("refused", "timeout"), never TypeSafe's.
        log.server.warn(
          { status: upstream.status, detail: upstream.detail },
          'hosted ask upstream failed',
        );
        return reply.code(502).send({
          error: 'upstream',
          message: 'Lilypad’s model did not answer. Try again in a moment.',
        });
      }

      const answer: AskSystemOneReply = {
        model: upstream.model,
        answers: upstream.answers,
        allowance: claim.allowance,
      };
      return reply.code(200).send(answer);
    },
  );
}
