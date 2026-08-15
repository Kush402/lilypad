---
status: In Progress
owner: @kushsharma024
last-verified: 2026-08-15
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

| Host                      | Purpose                   | Status                                                                    |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| `lilypad.takedia.com`     | Local-development tunnel  | **Live** — preserved. Stays the dev tunnel; moving it is M13's, not P4's. |
| `lilypadhome.takedia.com` | Marketing site (P4)       | Planned — the site is built (`apps/site`); DNS and hosting are M13's      |
| `api.takedia.com`         | REST **and** `/ws/signal` | Planned                                                                   |
| `turn.takedia.com`        | TURN/STUN relay           | Planned                                                                   |
| `dl.takedia.com`          | Downloads                 | Planned                                                                   |
| `status.takedia.com`      | Status page               | Planned                                                                   |

The site and the development tunnel are **deliberately different hostnames**.
`lilypad.takedia.com` keeps serving the dev backend that off-LAN and cellular
testing depends on ([RUNBOOK](RUNBOOK.md)), and the product site answers
on `lilypadhome.takedia.com`. Nothing has to move for the site to ship.

Signaling shares `api.takedia.com` rather than taking its own host. A separate
`signal.` subdomain buys independent scaling that matters only once REST and
WebSocket need separate machines — which is Stage 3, not now. Splitting later is
a DNS record and a config value, not a rewrite.

## Options considered (re-verified 2026-08-15)

Every component, priced against its alternatives rather than chosen by
popularity. Figures are list prices as published on the dates shown; the
**ratios** are the durable part, not the absolute numbers.

| Need                   | Chosen                                   | Free tier / price                             | Rejected, and why                                                                                                                                                                         |
| ---------------------- | ---------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Static website**     | Cloudflare Pages                         | **Unlimited bandwidth**, 500 builds/mo, $0    | Netlify/Vercel meter bandwidth on the free tier; a marketing page that goes viral should not produce a bill.                                                                              |
| **API/auth/signaling** | Oracle Always Free → Hetzner CX          | $0 → ~€4–5/mo                                 | **Fly.io / Railway: no free tier.** **Render free sleeps** — a sleeping backend drops every WebSocket, so presence and signaling break outright. Disqualifying, not merely slow.          |
| **PostgreSQL**         | On the VM (Neon as fallback)             | $0 on the VM · Neon free 0.5 GB, 100 CU-hours | Neon scales to zero after 5 min and resumes in ~1s — a cold start on sign-in. Supabase free **pauses entirely after 1 week idle** (tightened Feb 2026) and needs a manual unpause.        |
| **Redis**              | On the VM                                | $0                                            | Upstash/managed: paying for durability we deliberately do not want. Every key here is single-use and short-TTL; a nonce that survives a restart is a replay window.                       |
| **TURN/coturn**        | Self-hosted on a bandwidth-inclusive VPS | 20 TB included on Hetzner CX22, €1/TB over    | **Cloudflare Realtime TURN: $0.05/GB after 1,000 GB free** — the free grant is real and useful, but at 14.7 TB/mo that is ~$735 against ~€9 self-hosted. Twilio ~$0.40/GB is worse again. |
| **DNS/TLS**            | Cloudflare free + Tunnel                 | $0                                            | Caddy/Let's Encrypt works but needs open inbound ports and a renewal that can fail at 3am. The tunnel opens no ports at all.                                                              |
| **Email**              | Resend (SES as the scale path)           | Resend 3,000/mo free · SES $0.10 per 1,000    | Self-hosted SMTP: deliverability is a reputation problem that cannot be self-hosted cheaply. SES is ~10× cheaper per message but costs setup time that only pays off past ~50k/mo.        |
| **Monitoring**         | Sentry free tier                         | 5,000 errors/mo, 1 user, 30-day retention, $0 | Self-hosting Sentry costs far more in ops than the subscription. Paid starts ~$26/mo and is not needed until error volume justifies it.                                                   |
| **CI/CD**              | GitHub Actions                           | Free for public repos; 2,000 min/mo private   | Already wired (`.github/workflows/deploy.yml`); no second vendor earns its place.                                                                                                         |

Egress is the deciding number, because TURN is the only bandwidth-heavy piece:

| Provider                 | Egress cost                | 1 TB of relay | 14.7 TB (10k users) |
| ------------------------ | -------------------------- | ------------- | ------------------- |
| Hetzner CX22             | 20 TB included, then €1/TB | **€0**        | **€0**              |
| Oracle Always Free       | 10 TB/mo free              | **$0**        | ~$0 + overage       |
| Cloudflare Realtime TURN | 1 TB free, then $0.05/GB   | $0            | ~$685               |
| Fly.io                   | $0.02/GB                   | $20           | ~$294               |
| AWS                      | ~$0.09/GB                  | ~$90          | ~$1,323             |

That single column is why TURN belongs on a fixed-price VPS and not on a per-GB
cloud — a ~100× difference at 10k users, on the one line item that scales with
usage.

> **Two 2026 changes worth knowing before provisioning.**
>
> - **Oracle halved Always Free ARM** from 4 OCPU/24 GB to **2 OCPU/12 GB**,
>   effective 15 June 2026, and began terminating oversized instances from
>   **18 August 2026** — three days from this writing. Provision within the new
>   limit or the instance will be reclaimed. Capacity is also frequently
>   unavailable in popular regions; Frankfurt and Singapore provision more
>   reliably than US East.
> - **Hetzner raised cloud prices in April 2026.** Published figures for CX22
>   now range roughly **€4–5/mo** depending on source and location surcharge.
>   Confirm at checkout rather than trusting any number here.

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

## What the owner must provide (2026-08-15)

Deployment is blocked on accounts, not on work. Everything below needs a human
with a payment method and an identity; none of it can be created from this repo.

| #   | What to create                                                                               | Why it is needed                                                                                                                    | Cost        | What to hand over                                         |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| 1   | **A VM** — Oracle Always Free (2 OCPU/12 GB ARM, Frankfurt or Singapore) **or** Hetzner CX22 | Runs backend + Postgres + Redis. Nothing else can be deployed until this exists.                                                    | $0 / ~€4–5  | SSH host + key                                            |
| 2   | **A second VM for coturn** (skip at Stage 0 — co-locate)                                     | TURN needs UDP on a public IP; a tunnel cannot carry it. Separate so a relay flood cannot starve the API.                           | ~€4–5       | SSH host + key, public IP                                 |
| 3   | **Cloudflare API token** (Pages: Edit; DNS: Edit on `takedia.com`)                           | Deploy `apps/site`; create `api.` / `turn.` / `dl.` records. The tunnel credential already on this machine authorizes tunnels only. | $0          | `CLOUDFLARE_API_TOKEN`                                    |
| 4   | **Resend account + verified sending domain**                                                 | `POST /auth/magic-link/request` answers **503 in production** without a sender. Password reset is equally undeliverable.            | $0 to 3k/mo | `RESEND_API_KEY`, from-address                            |
| 5   | **Sentry project (optional)**                                                                | Nothing reports crashes today.                                                                                                      | $0          | DSN                                                       |
| 6   | **GitHub Actions secrets**                                                                   | `deploy.yml` exists and has never run.                                                                                              | $0          | `SSH_HOST`, `SSH_KEY`, `GHCR` scope on the existing token |
| 7   | **Stripe account**                                                                           | Only for [ADR-0013](adr/0013-connectivity-is-the-paid-boundary.md)'s paid tier. Not needed to launch the free tier.                 | —           | Publishable + secret keys                                 |
| 8   | **Prices for `pro` / `team`**                                                                | Not an account — a decision. `$XXXX` everywhere until it is made.                                                                   | —           | Two numbers                                               |

Items 1, 3 and 4 are the minimum for a public deployment. Items 7–8 are only for
charging money, which [ADR-0013](adr/0013-connectivity-is-the-paid-boundary.md)
does not require before the free tier ships.

## What is not done

Stated explicitly so nothing here reads as more finished than it is.

- **Nothing is deployed.** No VM, no `api.takedia.com`, no TURN host. Every
  artifact below was verified locally only. The blocker is accounts, not work —
  see [What the owner must provide](#what-the-owner-must-provide-2026-08-15).
- **A free tier of "LAN only" cannot ship yet.**
  [ADR-0013](adr/0013-connectivity-is-the-paid-boundary.md) makes LAN the free
  product, but a LAN session still needs the control plane to _establish_ (its
  media is already direct). Until the laptop can act as its own control plane
  ([NETWORKING.md §2](NETWORKING.md)), a free user cut off from the cloud is cut
  off from their laptop too.
- **No entitlement enforcement.** `users.tier` is read nowhere, there is no
  trial state, and no billing. Remote is currently available to everyone.
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
