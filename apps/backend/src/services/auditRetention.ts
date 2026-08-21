import { lt } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { auditLogs } from '../db/schema.js';
import { log } from '../logging.js';

/**
 * Audit-log retention — the policy `docs/threat-model.md` has carried as an
 * open item since M3, and the reason `audit_logs` was the one table in the
 * schema that grew forever (`docs/db-schema.md`).
 *
 * **Records are kept for 2 days and then deleted.** That is a product
 * decision, not a derived number, so it is stated once here and referenced
 * everywhere else rather than re-justified.
 *
 * Two days is short because of what these rows contain. `audit_logs` stores an
 * IP address, an account id, a device id and a free-form metadata blob for
 * every sign-in, pairing and session — which is a movement log of a person's
 * machines. It is worth keeping only for the job it was added to do: letting
 * an operator answer "what just happened?" during an incident, and letting a
 * user's own support case be diagnosed. Both of those are same-day questions.
 * Anything longer is a liability that buys nothing.
 *
 * The window is measured from `created_at`, so it is a pure function of the
 * row and the clock — a row's fate never depends on when the pruner last ran,
 * only on how old the row is. A pruner that misses an hour deletes an hour's
 * more rows next time and reaches exactly the same state.
 *
 * **Deleting an account does not shortcut this.** The schema anonymises those
 * rows (`ON DELETE SET NULL` on `user_id` and `device_id`) rather than
 * removing them, so a deletion cannot be used to erase the evidence of what
 * the account did on its way out — and the rows still expire on the same
 * 2-day clock as everyone else's. See `services/accountDeletion.ts`.
 */

/** The retention window, in days. The product decision itself. */
export const AUDIT_RETENTION_DAYS = 2;

export const AUDIT_RETENTION_MS = AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * How often the pruner runs. Hourly, not nightly: a nightly job means a row
 * can outlive the policy by up to a day, and "2 days, give or take a day" is
 * not a policy. Hourly bounds the overshoot to an hour and keeps each batch
 * to roughly an hour of traffic.
 */
export const AUDIT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** The oldest `created_at` a row may have and still be kept. */
export function auditCutoff(now: Date): Date {
  return new Date(now.getTime() - AUDIT_RETENTION_MS);
}

/** The one database operation retention needs. Injectable so the policy can
 * be tested without a Postgres, the same shape as `AuditLogStore`. */
export interface AuditRetentionStore {
  /** Delete every row created strictly before `cutoff`; return how many. */
  deleteOlderThan(cutoff: Date): Promise<number>;
}

export function createDrizzleAuditRetentionStore(
  database: Pick<typeof defaultDb, 'delete'> = defaultDb,
): AuditRetentionStore {
  return {
    async deleteOlderThan(cutoff) {
      // `returning` rather than a driver-specific row count: an hourly prune
      // deletes at most an hour of rows, so the list is small, and counting
      // this way works the same on every driver the tests and production use.
      const gone = await database
        .delete(auditLogs)
        .where(lt(auditLogs.createdAt, cutoff))
        .returning({ id: auditLogs.id });
      return gone.length;
    },
  };
}

/** Apply the policy once. Returns how many rows it removed. */
export async function pruneAuditLogs(
  store: AuditRetentionStore,
  now: Date = new Date(),
): Promise<number> {
  return store.deleteOlderThan(auditCutoff(now));
}

export interface AuditRetentionHandle {
  stop(): void;
}

/**
 * Run the prune now, and hourly thereafter.
 *
 * Started from `index.ts` rather than from `buildServer`, so that constructing
 * a server in a test does not start a timer that talks to a database. A failed
 * prune is logged and retried on the next tick — retention falling behind is
 * an operational problem, never a reason to take the API down.
 */
export function startAuditRetention(
  store: AuditRetentionStore,
  intervalMs: number = AUDIT_PRUNE_INTERVAL_MS,
): AuditRetentionHandle {
  const run = () => {
    void pruneAuditLogs(store)
      .then((removed) => {
        if (removed > 0) {
          log.audit.info(
            { removed, retentionDays: AUDIT_RETENTION_DAYS },
            'pruned audit logs past their retention window',
          );
        }
      })
      .catch((err: unknown) => {
        log.audit.error({ err }, 'audit-log prune failed — retrying on the next tick');
      });
  };
  run();
  const timer = setInterval(run, intervalMs);
  // Retention must never be the reason a process refuses to exit.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
