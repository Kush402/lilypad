import type { FastifyInstance } from 'fastify';
import type { HealthReport } from '@lilypad/shared';
import { pingPostgres } from '../db/client.js';
import { pingRedis } from '../redis.js';

const VERSION = '0.1.0';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    const [postgres, redis] = await Promise.all([pingPostgres(), pingRedis()]);
    const allUp = postgres && redis;

    const report: HealthReport = {
      status: allUp ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      checks: {
        postgres: postgres ? 'up' : 'down',
        redis: redis ? 'up' : 'down',
      },
      version: VERSION,
    };

    return reply.code(allUp ? 200 : 503).send(report);
  });
}
