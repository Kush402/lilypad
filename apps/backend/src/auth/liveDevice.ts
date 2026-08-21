import type { FastifyReply, FastifyRequest } from 'fastify';
import { accountExists, deviceOwnershipById } from './ownership.js';

/**
 * Deny a request whose CALLING device has been revoked.
 *
 * `authorize.ts` answers whether an actor may touch a RESOURCE, and it lets a
 * revoked device still be managed by its owner on purpose — "I lost my laptop"
 * must not also mean "and now you cannot clean up after it". That is about the
 * target. Nothing was asking the other question: whether the caller is still
 * allowed to be a caller at all.
 *
 * It mattered because access tokens are verified by signature alone (ADR-0001),
 * so a device revoked one second ago keeps a working token for up to ten
 * minutes. Measured against production: with a token minted seconds before the
 * revoke, a revoked phone could still `GET /devices` (every machine on the
 * account, with names and platforms), `PATCH /devices/:id` (rename any of them
 * — including renaming the thief's own device to look like the owner's), and
 * list which phones are trusted for a laptop. The acting surfaces were already
 * closed: ringing answered 404 and the presence claim was refused, because both
 * of those resolve the device row rather than trusting the token.
 *
 * Worse than any of those, `/devices/enrollment-code/approve` takes a device
 * token, so a revoked phone had a ten-minute window to approve a NEW laptop
 * onto the account. Revocation with a persistence mechanism attached is not
 * revocation.
 *
 * The website says a removed device "loses access straight away … It does not
 * wait for a token to expire." This is what makes that sentence true.
 *
 * One indexed lookup, on routes that already read the database to authorize.
 * Deliberately NOT in `requireAuth`, which stays DB-free so that signaling and
 * reconnect keep working through a Postgres outage.
 */
export async function rejectRevokedActor(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.sent) return; // an earlier preHandler already answered
  const actor = req.actor;
  // An unauthenticated request on an `optionalAuth` route. There is no actor
  // to disqualify.
  if (!actor) return;

  const deviceId = actor.deviceId;
  if (!deviceId) {
    // An ACCOUNT session. There is no device to revoke, but the account itself
    // can have been deleted, and the token outlives the row by up to its full
    // ten minutes. Without this, `DELETE /account` would answer 200 while the
    // caller's own token still opened `POST /devices/enroll` — which would
    // then write a `user_id` no `users` row matches and fail as a 500, telling
    // the user their deleted account was a server error.
    if (await accountExists(actor.userId)) return;
    await reply.code(401).send({
      error: 'unauthorized',
      message: 'this account no longer exists',
    });
    return;
  }

  const device = await deviceOwnershipById(deviceId);
  // Unknown covers the account having been deleted out from under the token.
  if (device === null || device.state === 'revoked') {
    await reply.code(401).send({
      error: 'device_revoked',
      message: 'this device was removed from the account',
    });
  }
}
