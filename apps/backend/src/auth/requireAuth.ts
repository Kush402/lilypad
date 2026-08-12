import type { FastifyReply, FastifyRequest } from 'fastify';
import { bearerToken, verifyAccessToken, type Actor } from './tokens.js';

/**
 * The single gate every authenticated route passes through.
 *
 * Its whole job is that handlers read `req.actor` and never a value from the
 * request body, query, or params. That is the property ADR-0002 exists to
 * create: once identity comes only from a signed token, knowing a device id,
 * pair id, room id, or session id stops being worth anything.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth`. Absent on unauthenticated routes. */
    actor?: Actor;
  }
}

/** Fastify preHandler: 401 unless the request carries a valid access token. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(req.headers.authorization);
  const actor = token ? await verifyAccessToken(token) : null;
  if (!actor) {
    await reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  req.actor = actor;
}

/**
 * Fastify preHandler: as `requireAuth`, but the token must additionally be
 * device-scoped. Account tokens are issued by sign-in and say only who the
 * human is; routes that act AS a device (pairing, signaling, connect) need to
 * know which machine is asking, and a device token is the only thing that
 * answers that.
 */
export async function requireDevice(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (!req.actor?.deviceId) {
    await reply.code(403).send({
      error: 'device_token_required',
      message: 'this endpoint needs a device access token, not an account session',
    });
  }
}

/**
 * Read the actor a preHandler established.
 *
 * Throws rather than returning null: reaching a handler without an actor means
 * the route was registered without its gate, which is a wiring bug that must
 * fail loudly in tests rather than silently degrade to unauthenticated
 * behaviour in production.
 */
export function actorOf(req: FastifyRequest): Actor {
  const actor = req.actor;
  if (!actor) throw new Error('route handler ran without requireAuth — check its preHandler');
  return actor;
}

/** The actor's device id, for routes gated by `requireDevice`. */
export function deviceActorOf(req: FastifyRequest): Actor & { deviceId: string } {
  const actor = actorOf(req);
  if (!actor.deviceId) throw new Error('route handler ran without requireDevice');
  return { ...actor, deviceId: actor.deviceId };
}
