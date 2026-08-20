import { Redis } from 'ioredis';
import { env } from './config.js';
import { log } from './logging.js';
import { withProbeTimeout } from './db/client.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: false,
});

// ioredis emits 'error' on the client during connection flaps. Without a
// listener, Node treats an EventEmitter 'error' as unhandled and crashes the
// process — a Redis blip must degrade (health goes 503), not take the server
// down. ioredis reconnects on its own; we just log.
redis.on('error', (err: Error) => {
  log.server.warn({ err: err.message }, 'redis client error (will retry)');
});

export async function pingRedis(): Promise<boolean> {
  // Bounded for the same reason as pingPostgres: ioredis queues commands
  // while it reconnects, so a PING issued during an outage can sit unanswered
  // far longer than a health check may take. See `withProbeTimeout`.
  return withProbeTimeout(redis.ping().then((pong) => pong === 'PONG'));
}
