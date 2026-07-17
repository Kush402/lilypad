import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { env } from '../config.js';

/**
 * Apply generated SQL migrations. Run once after `db:generate`:
 *   pnpm --filter @lilypad/backend db:migrate
 */
async function main() {
  const migrationClient = postgres(env.DATABASE_URL, { max: 1 });
  const dbm = drizzle(migrationClient);
  await migrate(dbm, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  await migrationClient.end();
  console.log('✓ migrations applied');
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
