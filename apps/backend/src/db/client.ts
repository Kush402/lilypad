import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { env } from '../config.js';
import * as schema from './schema.js';

/**
 * Postgres connection pool + Drizzle client. One pool per process.
 */
export const queryClient = postgres(env.DATABASE_URL, { max: 10 });

export const db = drizzle(queryClient, { schema });

/**
 * How long a liveness probe may take before it is treated as a failure.
 *
 * Observed during a deliberate Redis outage on production: `/health` stopped
 * ANSWERING rather than answering "degraded". The probes had no deadline, so a
 * dependency that was hung rather than refusing left the request hanging with
 * it — and a monitor cannot tell a hung health endpoint from an unreachable
 * host. `/health` must always answer, quickly, even when it has bad news; a
 * probe that has not returned in two seconds has told us what we needed.
 */
const PROBE_TIMEOUT_MS = 2000;

/** Resolve to `false` rather than hang, whatever the dependency is doing. */
export async function withProbeTimeout(probe: Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
    // Do not hold the event loop open for a probe nobody is waiting on.
    timer.unref?.();
  });
  try {
    return await Promise.race([probe.catch(() => false), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Lightweight liveness probe used by GET /health. */
export async function pingPostgres(): Promise<boolean> {
  return withProbeTimeout(
    (async () => {
      await db.execute(sql`SELECT 1`);
      return true;
    })(),
  );
}

export { schema };
