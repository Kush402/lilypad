# Operations Guide

How to run, observe, and recover the Lilypad backend + infra. (The desktop
and mobile apps are user-installed clients; this page is about the
server-side footprint.)

## Footprint

| Service  | Image / runtime      | Purpose                                               | State        |
| -------- | -------------------- | ----------------------------------------------------- | ------------ |
| backend  | Node 20+ (Fastify)   | REST pairing + WS signaling + TURN credential minting | stateless*   |
| Postgres | `postgres:16-alpine` | users/devices/sessions/audit logs                     | persistent   |
| Redis    | `redis:7-alpine`     | pairing tokens (60s TTL), room records                | ephemeral-ok |
| coturn   | `coturn/coturn:4.6`  | STUN/TURN relay for NAT traversal                     | stateless    |

\* Live rooms are held in memory but persisted to Redis; on restart the
backend resurrects non-terminal rooms (`hub.resurrect`), so a deploy does
not end established peer-to-peer sessions.

## Configuration

All configuration is environment variables, parsed and validated by
`packages/shared/src/env.ts` at boot. Copy `.env.example` and adjust.

Production boots run `productionSafetyProblems()` and **refuse to start** if:

- `PUBLIC_BASE_URL` is not `https://`
- `SIGNALING_URL` is not `wss://`
- dev-default secrets (`TURN_SECRET`, Postgres password) survive
- `METRICS_BEARER_TOKEN` is unset
- `ALLOWED_ORIGINS` is unset while a browser client (admin SPA) is expected

In development, `PUBLIC_BASE_URL`/`SIGNALING_URL` may be left unset — the
backend auto-detects the machine's LAN IP at boot so phone-scannable QR URLs
survive network changes. **Always pin them explicitly in production.**

## Health & metrics

- `GET /health` — liveness + dependency checks. Returns
  `{ status, uptimeSeconds, checks: { postgres, redis }, version }`; wire
  this to your load-balancer health check.
- `GET /metrics` — JSON counters (rooms, sessions started/ended, peers
  reaped, signaling errors). Requires `Authorization: Bearer
$METRICS_BEARER_TOKEN`. Scrape into your metrics system of choice.
- Backend logs are structured JSON (pino) on stdout — ship them with any
  log collector. Session lifecycle, pairing, reaping, and origin rejections
  all log with stable event shapes.

## Deployment

Reference dev topology is `infra/docker-compose.yml`. For a small production
deployment:

1. Postgres and Redis: managed instances or the compose services with a
   persistent volume for Postgres.
2. coturn: needs UDP 3478 + the relay port range (`TURN_MIN_PORT`–
   `TURN_MAX_PORT`) reachable from the internet, and `TURN_EXTERNAL_IP` set
   to the host's public IP. Keep `TURN_SECRET` long and random — TURN
   credentials are HMAC-derived from it per session.
3. Backend: any Node host behind TLS termination. WebSockets must be
   forwarded (`Upgrade` headers) on `/ws/signal`. The signaling origin guard
   compares the `Origin` header's host to the request `Host` — configure the
   proxy to pass the original `Host` through (`proxy_set_header Host $host`
   or equivalent), or native clients will be rejected as browser traffic.
   (`ALLOWED_ORIGINS` is separate: it gates REST CORS for browser clients.)
4. Migrations: `pnpm --filter @lilypad/backend db:migrate` against the
   production `DATABASE_URL` before first boot and on every schema change.

## Backup & recovery

- **Postgres** is the only stateful store that matters: standard `pg_dump`
  / managed-snapshot cadence. It holds audit logs and (post-M5) accounts.
- **Redis** holds only 60-second pairing tokens and room records — safe to
  lose; users re-pair. No backups needed.
- **Backend crash/deploy**: safe at any time. Established sessions continue
  peer-to-peer; the hub resurrects room records from Redis on boot; clients
  reconnect signaling with backoff.

## Incident quick reference

| Symptom                                                  | First checks                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Pairing fails everywhere                                 | `/health` — Redis down? 429s in logs (rate limit)?                                  |
| Phones connect but no video over internet                | coturn reachability, `TURN_EXTERNAL_IP`, relay port range open, TURN secret matches |
| WS connects then drops ~30s                              | client heartbeats missing (`heartbeat timeout — reaping peer` in logs)              |
| `WS upgrade carried a browser Origin header — rejecting` | proxy rewrote `Host` — forward the original Host header                             |
| Backend refuses to boot in production                    | read the printed `productionSafetyProblems` list — it names each unsafe setting     |
