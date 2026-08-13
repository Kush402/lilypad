---
status: In Progress
owner: @kushsharma024
last-verified: 2026-08-13
summary: How the control plane is deployed, what it costs, how it scales, and how to recover it.
---

# Deploying the Lilypad control plane

**Status: the artifacts exist and are verified locally. Nothing is deployed to a
public host yet** — provisioning needs cloud accounts that only the owner can
create. See [What is not done](#what-is-not-done) before treating any of this as
production.

## The one idea that determines every cost in this document

**Lilypad is not a cloud remote-desktop service, and the deployment must never
quietly turn it into one.**

| Traffic                                       | Path                            | Touches our servers |
| --------------------------------------------- | ------------------------------- | ------------------- |
| Screen video, input, clipboard                | Peer-to-peer (LAN or WAN)       | **No**              |
| Screen video when P2P is blocked              | TURN relay                      | Yes — the only case |
| Accounts, pairing, signaling                  | Control plane                   | Yes, kilobytes      |
| A session between two devices on the same LAN | Local, never leaves the network | **No**              |

A session is a few KB of signaling to set up and then **zero** server bandwidth
for its entire life. That is why 1,000 users cost roughly what 100 users cost,
and why the only line item that scales with usage is TURN.

## Architecture

One VM runs four containers. That is the whole control plane.

```
                    Cloudflare (TLS, DDoS, DNS)
                              │
                    Cloudflare Tunnel (outbound only)
                              │
  ┌───────────────────────────┴──────────────────────────┐
  │  VM                                                  │
  │  cloudflared ─→ backend :8080 ─→ postgres            │
  │                       └────────→ redis               │
  └──────────────────────────────────────────────────────┘

  turn.takedia.com → separate host, public IP, UDP  (infra/coturn-prod)
```

**Why a Cloudflare Tunnel and not a reverse proxy:** the VM opens **no inbound
ports at all** — cloudflared dials out. No firewall rule to get wrong, no
certificate renewal to expire at 3am, free TLS and DDoS absorption. The same
mechanism already serves `lilypad.takedia.com` and is proven in this repo.

**Why TURN is not on that VM:** a tunnel carries HTTP and WebSockets only. TURN
needs UDP on a public IP with a wide port range, and its bandwidth profile is
nothing like the control plane's. It stays in [`infra/coturn-prod`](../infra/coturn-prod/README.md).

**Redis is not optional.** Eleven modules depend on it for pairing tokens,
device challenges, magic links, desktop-enrollment codes and live room-routing
state. It is single-use, short-TTL data with persistence deliberately off — a
nonce that survives a restart is a replay window, not a recovered value.

## Domains

| Host                  | Purpose                   | Status                                                                                                                                            |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lilypad.takedia.com` | Local-development tunnel  | **Live** — preserved, and **contended**: P4 was specified against this name while it serves the dev tunnel. Resolve before pointing DNS anywhere. |
| `api.takedia.com`     | REST **and** `/ws/signal` | Planned                                                                                                                                           |
| `turn.takedia.com`    | TURN/STUN relay           | Planned                                                                                                                                           |
| `takedia.com`         | Marketing site            | Planned                                                                                                                                           |
| `dl.takedia.com`      | Downloads                 | Planned                                                                                                                                           |
| `status.takedia.com`  | Status page               | Planned                                                                                                                                           |

Signaling shares `api.takedia.com` rather than taking its own host. A separate
`signal.` subdomain buys independent scaling that matters only once REST and
WebSocket need separate machines — which is Stage 3, not now. Splitting later is
a DNS record and a config value, not a rewrite.

## Options considered (August 2026)

| Need     | Chosen                          | Rejected                                                                                                                                                                   |
| -------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compute  | Oracle Always Free → Hetzner CX | **Fly.io / Railway: no free tier** (removed 2024/2023). **Render free sleeps** — a sleeping backend drops every WebSocket, so presence and signaling break. Disqualifying. |
| Postgres | On the VM (Neon as fallback)    | Neon free is 0.5 GB / 100 CU-hours and scale-to-zero adds cold starts; fine as a fallback, unnecessary when the VM already exists.                                         |
| Redis    | On the VM                       | Upstash/managed: pure cost for data that is deliberately non-durable.                                                                                                      |
| TLS/CDN  | Cloudflare free                 | Caddy/Let's Encrypt: works, but needs open ports and renewal that can fail.                                                                                                |
| TURN     | coturn on a cheap VPS           | Managed TURN (Twilio/Metered): per-GB pricing is the one thing that scales badly.                                                                                          |

Egress is the deciding number, because TURN is the only bandwidth-heavy piece:

| Provider           | Egress cost    | 1 TB of relay |
| ------------------ | -------------- | ------------- |
| Hetzner CX22       | 20 TB included | **€0**        |
| Oracle Always Free | 10 TB/mo free  | **$0**        |
| Fly.io             | $0.02/GB       | $20           |
| AWS                | ~$0.09/GB      | ~$90          |

That single column is why TURN belongs on a fixed-price VPS and not on a
per-GB cloud.

## Stages

### Stage 0 — $0, early testers

Oracle Cloud Always Free (2 OCPU / 12 GB ARM as of June 2026, 200 GB disk,
10 TB/mo egress) runs all four containers **and** coturn. Cloudflare free tier
for DNS, TLS and CDN. GitHub Actions free tier for CI.

**Recurring cost: $0.** Caveats stated plainly: Oracle ARM capacity is
frequently unavailable in popular regions, Oracle reclaims idle Always Free
resources, and there is no SLA. Acceptable for testers, not for paying users.

### Stage 1 — first reliable production (~€9/month)

- Control plane: **Hetzner CX22**, ~€4.35/mo — 2 vCPU, 4 GB, 40 GB, 20 TB traffic
- TURN: a second **CX22**, ~€4.35/mo, so a relay flood cannot starve the API
- Backups: Hetzner snapshots, ~€0.60/mo

**~€9.30/month total.** Everything else stays free.

### Stage 2 — thousands of users

**Unchanged:** one backend process, one Postgres, one Redis. Signaling is idle
for the whole life of a session; the work is a few KB at setup.

**Changes:** TURN gets a second region, Postgres gets a real backup target
(object storage), and the VM steps up to CX32 if measurement says so.

### Stage 3 — large scale, and not before

Introduce each of these only when a specific measurement demands it:

| Add                 | Trigger                                                         |
| ------------------- | --------------------------------------------------------------- |
| Multiple backends   | One instance saturates CPU or WS connections                    |
| Redis pub/sub relay | The moment there are 2+ instances — rooms are per-process today |
| Load balancer       | With multiple instances                                         |
| Regional TURN       | Relay latency hurts users far from the single region            |
| Postgres replicas   | Read load, not user count                                       |
| Real observability  | When logs stop being enough to answer "why is it slow"          |

The in-memory room registry is what makes multi-instance a real change. It is a
contained one — `SignalingHub`'s executor methods — because the hub is already
decomposed. **Nothing before Stage 3 requires it.**

## Cost model

Assumptions, none of them guarantees: 2 devices per user; 1 hour of session per
active user per day; **15% of sessions fall back to TURN** (typical for
consumer NAT — LAN and direct P2P carry the rest); 2 Mbps relayed video;
10% of registered users active daily.

| Users   | Compute | Database | TURN bandwidth      | Storage | Email | Monitoring | **Total/mo** |
| ------- | ------- | -------- | ------------------- | ------- | ----- | ---------- | ------------ |
| 0       | $0      | $0       | $0                  | $0      | $0    | $0         | **$0**       |
| 100     | $0      | $0       | ~0.1 TB — free tier | $0      | $0    | $0         | **$0**       |
| 1,000   | €4.35   | on VM    | ~1 TB — included    | €0.60   | $0    | $0         | **~€9**      |
| 10,000  | €15     | €15      | ~10 TB — included   | €3      | ~$10  | $0         | **~€60**     |
| 100,000 | €120    | €80      | ~100 TB — 3 regions | €25     | ~$80  | ~$50       | **~€500**    |

The TURN row is the only one that tracks usage rather than user count. If the
relay fraction were 50% instead of 15%, the 100k row roughly triples — which is
why `docs/networking.md`'s preference order (**LAN → P2P → TURN**) is a cost
control, not only a latency one.

## Deploying

Secrets live on the server in `.env.production` (gitignored; verified) and in
GitHub Actions secrets. **Never in the repo.**

```bash
# First time, on the VM
git clone https://github.com/kushsharma024/lilypad && cd lilypad
cp infra/production/.env.production.example .env.production
$EDITOR .env.production          # generate every secret with: openssl rand -hex 32
docker compose -f infra/production/docker-compose.yml up -d
```

Thereafter, `.github/workflows/deploy.yml` (manual dispatch, or a `v*` tag):

**gate** (test · typecheck · lint · build · docs · format · audit) → **image**
(multi-arch, pushed to GHCR) → **deploy** (migrate, then `up -d`) →
**health-check** (30 attempts × 5s) → **roll back on failure**.

The gate is re-run rather than trusted from an earlier commit, because a deploy
that trusts a stale green check is how untested code reaches production.

## Recovery

| Failure                | Effect                                                                                                                        | Recovery                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Backend crashes        | `restart: unless-stopped` restarts it. Live P2P sessions **keep running** — media is not on this path.                        | Automatic                               |
| Postgres down          | Sign-in and enrollment fail. **Existing sessions and reconnects survive** — device tokens verify by signature, not a DB read. | Restore from backup                     |
| Redis down             | No new pairings. Existing P2P sessions keep running.                                                                          | Restart; data is disposable by design   |
| VM lost entirely       | Control plane down; LAN sessions unaffected                                                                                   | Re-provision, restore Postgres, `up -d` |
| Bad deploy             | Health check fails                                                                                                            | Workflow rolls back automatically       |
| Cloudflare tunnel down | API unreachable                                                                                                               | cloudflared restarts; LAN unaffected    |

Backups: `pg_dump` to `infra/production/backups` on a cron, retained 7 days.
**An untested backup is not a backup** — restore into a scratch database and
confirm row counts before believing it.

## What is not done

Stated explicitly so nothing here reads as more finished than it is.

- **Nothing is deployed.** No VM, no `api.takedia.com`, no TURN host. Every
  artifact below was verified locally only.
- **Route authorization (SEC-3, SEC-4, SEC-7) is closed** as of M9. Every
  pairing and trust route, and the presence `register`, are gated by ownership
  ([ADR-0010](adr/0010-explicit-device-linking.md)). A device an account owns
  demands a matching device token; a device nobody owns keeps its pre-accounts
  behaviour, and that lane disappears when P1 makes enrolment mandatory in
  both clients. **Until then, a public deployment is reachable by unenrolled
  devices on the legacy lane** — which is the pre-M8 posture, not a regression,
  but it is the reason to finish P1 before opening this to strangers.
- ~~Legacy null-secret pairs (SEC-5) are not purged.~~ Migration `0005` revokes
  them and the connect gate refuses a null hash.
- The `sessions` table is still never written.
- No backup cron is installed; the procedure above is written, not automated.
- No staging environment exists yet — the workflow supports it, nothing runs it.
- No crash reporting or metrics scraping.

### Verified locally

- The production image builds for `linux/amd64` and `linux/arm64`.
- It boots under real production configuration and reports
  `{"status":"ok","checks":{"postgres":"up","redis":"up"}}`, with Docker
  reporting the container `healthy`.
- `loadEnv()` **refuses to boot** with dev defaults, a passwordless Redis,
  short secrets, a missing metrics token, or non-HTTPS public URLs.
- `/metrics` answers 401 without a bearer token and 200 with one.
- CORS fails closed: an unlisted origin receives no `Access-Control-Allow-Origin`.
- The WebSocket upgrade returns 101 through the container.
