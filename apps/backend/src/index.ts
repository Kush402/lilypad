import { buildServer } from './server.js';
import { env } from './config.js';
import { redis } from './redis.js';
import { queryClient } from './db/client.js';

async function main() {
  const app = await buildServer();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // a second signal shouldn't race the first
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    // Watchdog: never hang forever if a socket/connection won't drain.
    const watchdog = setTimeout(() => {
      app.log.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    watchdog.unref();
    await app.close().catch((err) => app.log.error({ err }, 'app.close failed'));
    await redis.quit().catch(() => undefined);
    await queryClient.end({ timeout: 5 }).catch(() => undefined);
    clearTimeout(watchdog);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: env.BACKEND_HOST, port: env.BACKEND_PORT });
    app.log.info(`Lilypad backend listening on http://${env.BACKEND_HOST}:${env.BACKEND_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
