import { Redis } from 'ioredis';
import { env } from './config.js';
import { log } from './logging.js';

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
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}
