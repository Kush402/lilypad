---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-12
summary: Running, observing, and recovering the backend.
---

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

### Releasing a client that sends `proofOrigin` (ADR-0002 v2 device proof)

**Backend first, clients second — in that order, with a check in between.**

A v2 proof names the host it is for, and a server that has not been updated
does not know to check the origin-bound message. It rejects such a proof as
`invalid_signature`, which on the client looks like "this device is not
enrolled" — an installed app that can no longer sign in at all.

1. Deploy the backend. It accepts **both** message forms, so every client
   already in the field is unaffected.
2. Confirm the server will accept the host the apps actually use:

   ```
   curl -s -H "authorization: Bearer $METRICS_BEARER_TOKEN" \
     https://<backend>/metrics | jq .deviceProofHosts
   ```

   The list must contain the host from `apps/mobile/src/config/backend.ts`
   (`DEFAULT_API_BASE_URL`) and the desktop's `DEFAULT_BACKEND_URL`. It is
   built from `PUBLIC_BASE_URL`, the live advertised URL, and
   `DEVICE_PROOF_HOSTS`.

3. Missing? Add it to `DEVICE_PROOF_HOSTS` (comma-separated hosts or URLs) and
   restart, then re-check. Do not ship clients until this list is right.
4. Only then cut the client builds.

A rejected origin logs at `warn` with the host it saw and the set it allowed:

    device proof named a host this server does not answer to

If that appears for a host you recognise, it is step 3 that was missed — not an
attack.

Requiring `proofOrigin` (dropping v1) is a **separate, later** change. Check
what the field is actually running first:

    select app_version, count(*) from devices where revoked_at is null
      group by 1 order by 2 desc;

## Backup & recovery

- **Postgres** is the only stateful store that matters: standard `pg_dump`
  / managed-snapshot cadence. It holds audit logs and (post-M5) accounts.
- **Redis** holds only 60-second pairing tokens and room records — safe to
  lose; users re-pair. No backups needed.
- **Backend crash/deploy**: safe at any time. Established sessions continue
  peer-to-peer; the hub resurrects room records from Redis on boot; clients
  reconnect signaling with backoff.

## How the product is doing

    pnpm stats

Read-only, against the production `DATABASE_URL`, and deliberately a script for
the same reason as the customer lookup below.

`/metrics` answers "is the server working". This answers the questions a
decision turns on, which nothing could answer without SSH and hand-written
joins:

- **Activation, not signups.** An account with no devices is somebody who
  filled in a form. An account with a paired laptop is somebody using the
  product. The gap between those two lines is the funnel.
- **Versions in the field** — written on every token exchange, so it is what
  customers are RUNNING, not what was released. "We shipped it" and "people
  have it" are different claims.
- **Failed sign-ins.** Normally ordinary: a desktop polls `/devices/token`
  between install and linking and each poll writes one. A RISE is the first
  sign of something broken that nobody has reported yet.

`session_start` / `session_end` count screens actually being watched.
`sessions_revoked` counts access being withdrawn. Those were one event type
until 2026-08-25, which made 11 real sessions read as 59.

## Diagnosing one customer

    pnpm support <email>

Read-only. Prints the account, every device on it (state, platform, **app
version**, last seen, and both device ids labelled), every pair and which
direction it runs, and the last fifteen audit events. Run it against the
production `DATABASE_URL`.

It answers the question every support conversation opens with without anyone
having to remember the joins — in particular that `devices.fingerprint` is the
wire id `/connect/request` resolves while `devices.id` is what the
account-scoped routes take. Getting those two the wrong way round is a bug this
product has already shipped once.

What it cannot tell you is whether a laptop is reachable **right now**:
presence rooms live in the signaling hub's memory and are never persisted. The
report gives the honest approximation instead — how many devices exchanged a
token in the last fifteen minutes — and labels it as one. Clients
re-authenticate on launch and roughly every nine minutes, so that is close to
"the app is running".

Deliberately a script, not an admin API. An endpoint that reads any user's
devices needs an admin auth model this product does not have, and getting that
wrong is worse than typing a command. `apps/admin` is still the M6 placeholder
it has always been — six cards that say "M6" and a `/health` probe — and is
deployed nowhere.

## Incident quick reference

| Symptom                                                  | First checks                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Pairing fails everywhere                                 | `/health` — Redis down? 429s in logs (rate limit)?                                  |
| Phones connect but no video over internet                | coturn reachability, `TURN_EXTERNAL_IP`, relay port range open, TURN secret matches |
| WS connects then drops ~30s                              | client heartbeats missing (`heartbeat timeout — reaping peer` in logs)              |
| `WS upgrade carried a browser Origin header — rejecting` | proxy rewrote `Host` — forward the original Host header                             |
| Backend refuses to boot in production                    | read the printed `productionSafetyProblems` list — it names each unsafe setting     |
