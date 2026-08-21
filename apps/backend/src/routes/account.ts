import type { FastifyInstance } from 'fastify';
import { AccountDeleteRequestSchema } from '@lilypad/protocol';
import { requireAuth, actorOf } from '../auth/requireAuth.js';
import { rejectRevokedActor } from '../auth/liveDevice.js';
import { accountEmail, confirmsDeletion, purgeAccount } from '../services/accountDeletion.js';
import { AuditLogService, createDrizzleAuditLogStore } from '../services/auditLog.js';
import type { SignalingHub } from '../signaling/hub.js';
import { log } from '../logging.js';

/**
 * Account lifecycle — today, exactly one route: ending it.
 *
 * A product that stores a person's machines, their addresses and their
 * movements has to have a way out, and Lilypad had none: the only way to
 * remove an account was for someone with a database shell to do it. That is
 * not a customer-facing product, and it is what this closes.
 */
export async function accountRoutes(
  app: FastifyInstance,
  deps: { hub: SignalingHub },
): Promise<void> {
  const { hub } = deps;
  const auditLog = new AuditLogService(createDrizzleAuditLogStore());

  /**
   * Delete the signed-in account and everything it owns.
   *
   * `requireAuth`, not `requireDevice`: this is an ACCOUNT action, and the
   * account session that exists between signing in and enrolling a device is
   * exactly when a user is most likely to want it. `rejectRevokedActor` still
   * applies, so a device that was removed from the account cannot delete the
   * account it was removed from.
   *
   * The typed address is an accident guard and nothing more — see
   * `AccountDeleteRequestSchema`. It is checked against the account the TOKEN
   * names, never against a value from the body, so it cannot be used to aim
   * the delete at somebody else.
   *
   * Order matters. The rooms are closed AFTER the delete, not before: a
   * disconnect the database might still roll back would tell the user their
   * account was gone before it was. Which rooms to close comes from
   * `purgeAccount`'s own return value rather than a read taken a moment
   * earlier, so a device that enrolled in between is still disconnected.
   */
  app.delete(
    '/account',
    {
      preHandler: [requireAuth, rejectRevokedActor],
      // Ten times tighter than the global limiter. There is no legitimate
      // reason to call this twice, and brute-forcing the confirmation is
      // pointless anyway — the caller already knows the address.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const body = AccountDeleteRequestSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

      const actor = actorOf(req);
      const email = await accountEmail(actor.userId);
      // A valid token for an account that no longer exists. `rejectRevokedActor`
      // normally catches this first; reaching here means the account went away
      // between the two reads, and the answer is the same either way.
      if (email === null) return reply.code(404).send({ error: 'not_found' });

      if (!confirmsDeletion(body.data.confirmEmail, email)) {
        return reply.code(400).send({
          error: 'confirmation_mismatch',
          message: 'type the email address on this account to confirm deletion',
        });
      }

      const removed = await purgeAccount(actor.userId);
      if (removed === null) return reply.code(404).send({ error: 'not_found' });

      // Every live session belonging to a machine that just stopped existing.
      // 'revoked' and not a new reason: the phone's "your access was revoked"
      // alert is exactly the right thing for the user to see, and inventing a
      // reason string neither client handles would show them nothing.
      let ended = 0;
      for (const fingerprint of removed) {
        ended += hub.endRoomsForDevice(fingerprint, 'revoked');
      }
      log.server.info(
        { devices: removed.length, endedSessions: ended },
        'account deleted at the owner request',
      );

      // Written AFTER the delete and deliberately anonymous. `user_id` cannot
      // reference a row that no longer exists, and re-recording the address
      // here would keep the one piece of personal data the delete just removed
      // — for two days, in the table whose whole point is that it holds as
      // little as it can. What an operator needs is that it happened and how
      // much went with it.
      void auditLog
        .sessionEnd({
          metadata: {
            event: 'account_deleted',
            devicesRemoved: removed.length,
            endedSessions: ended,
          },
        })
        .catch((err) => log.audit.error({ err }, 'failed to write account_deleted audit log'));

      return reply.code(200).send({ ok: true, devicesRemoved: removed.length });
    },
  );
}
