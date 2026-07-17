import { pino, type Logger } from 'pino';

/**
 * Shared pino logger factory. In development it pretty-prints if
 * `pino-pretty` is present; in production it emits structured JSON.
 */
export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  const isDev = (process.env.NODE_ENV ?? 'development') === 'development';
  return pino({
    name,
    level,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export type { Logger };
