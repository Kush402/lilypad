import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { parseTrustProxy } from './trustProxy.js';
import { parseAllowedOrigins } from './allowedOrigins.js';
import { healthRoutes } from './routes/health.js';
import { pairingRoutes } from './routes/pairing.js';
import { signalingRoutes } from './routes/signaling.js';
import { deviceRoutes } from './routes/devices.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : true,
    // Governs both `request.ip` (rate limiting, connection-count guards) and
    // which `X-Forwarded-*` headers Fastify believes — see `TRUST_PROXY`'s
    // doc comment in `packages/shared/src/env.ts` for why this isn't a bare
    // `true`.
    trustProxy: parseTrustProxy(config.env.TRUST_PROXY),
  });

  // Mobile + admin call the API from other origins; allow all in dev, an
  // explicit allowlist in production (never a blanket `true` — see
  // docs/audit/m3/backend-security.md Finding 14).
  await app.register(cors, {
    origin: config.isDev ? true : parseAllowedOrigins(config.env.ALLOWED_ORIGINS),
  });

  // Abuse control (tightened per-route + real limits in M6).
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  // Cap signaling frame size: SDP/ICE are a few KB; anything approaching this
  // is abuse. Without a cap, one giant frame forces a full string alloc +
  // JSON.parse that stalls the event loop (DoS).
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // Routes
  await app.register(healthRoutes);
  await app.register(pairingRoutes);
  await app.register(signalingRoutes);
  await app.register(deviceRoutes);

  return app;
}
