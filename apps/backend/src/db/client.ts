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

/** Lightweight liveness probe used by GET /health. */
export async function pingPostgres(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

export { schema };
