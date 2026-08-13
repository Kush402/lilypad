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
 * Fastify preHandler for a route that must serve both an enrolled device and a
 * pre-accounts one: it establishes `req.actor` when a token is present and
 * never demands one. The route then decides with `auth/authorize.ts`, which
 * requires a matching actor for an OWNED resource and keeps the legacy path
 * only where nothing owns the row.
 *
 * A present-but-invalid token is still a 401. Silently downgrading an expired
 * token to the anonymous lane would turn "your session lapsed" into "that
 * device does not exist", and a client that cannot tell those apart cannot
 * know to re-authenticate.
 */
export async function optionalAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(req.headers.authorization);
  if (!token) return;
  const actor = await verifyAccessToken(token);
  if (!actor) {
    await reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  req.actor = actor;
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

/** The actor an `optionalAuth` route may or may not have. Null is a normal
 * answer here, not a wiring bug — see `auth/authorize.ts`'s unowned lane. */
export function optionalActorOf(req: FastifyRequest): Actor | null {
  return req.actor ?? null;
}

/** The actor's device id, for routes gated by `requireDevice`. */
export function deviceActorOf(req: FastifyRequest): Actor & { deviceId: string } {
  const actor = actorOf(req);
  if (!actor.deviceId) throw new Error('route handler ran without requireDevice');
  return { ...actor, deviceId: actor.deviceId };
}
