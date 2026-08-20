---
status: In Progress
owner: @kushsharma024
last-verified: 2026-08-16
summary: How the control plane is deployed, what it costs, how it scales, and how to recover it.
---

# Deploying the Lilypad control plane

**Status: the control plane is DEPLOYED and publicly verified** at
`https://api.takedia.com` (Oracle Always Free, 2026-08-16). **TURN is now also
deployed** — on a _second_ Always Free VM, never this one (2026-08-19). See
[What is deployed](#what-is-deployed-2026-08-16) and
[What is not done](#what-is-not-done) before treating any of this as finished.

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
nothing like the control plane's. It runs on its own VM, from
[`infra/coturn-prod`](../infra/coturn-prod/README.md) — see [TURN](#turn-deployed-2026-08-19).

**Redis is not optional.** Eleven modules depend on it for pairing tokens,
device challenges, magic links, desktop-enrollment codes and live room-routing
state. It is single-use, short-TTL data with persistence deliberately off — a
nonce that survives a restart is a replay window, not a recovered value.

## Domains

| Host                      | Purpose                   | Status                                                                    |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| `lilypad.takedia.com`     | Local-development tunnel  | **Live** — preserved. Stays the dev tunnel; moving it is M13's, not P4's. |
| `lilypadhome.takedia.com` | Marketing site (P4)       | Planned — the site is built (`apps/site`); DNS and hosting are M13's      |
| `api.takedia.com`         | REST **and** `/ws/signal` | **Live** — Oracle Always Free, tunnel `lilypad-prod` (2026-08-16)         |
| `turn.takedia.com`        | TURN/STUN relay           | **Live** — second Oracle Always Free VM, DNS-only (2026-08-19)            |
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
# First time, on the VM. NOTE: the host keeps no git checkout — see
# infra/production/README.md. This is the bootstrap; deploys after it copy in
# only the compose file.
mkdir -p /opt/lilypad && cd /opt/lilypad
cp <repo>/infra/production/.env.production.example .env.production
$EDITOR .env.production          # generate every secret with: openssl rand -hex 32
docker compose --env-file .env.production -f infra/production/docker-compose.yml up -d
```

Thereafter, `.github/workflows/deploy.yml` (manual dispatch, or a `v*` tag):

**preflight** (every required secret present, in seconds) → **gate** (test ·
typecheck · lint · build · docs · format · audit) → **image** (multi-arch,
pushed to GHCR, commit SHA baked in) → **deploy** (migrate, then replace only
the `backend` service) → **health-check** (`/health` must report BOTH `ok` and
the SHA just built) → **roll back on failure** (to the image recorded as
running before the deploy started).

The gate is re-run rather than trusted from an earlier commit, because a deploy
that trusts a stale green check is how untested code reaches production.

### It works, and here is how that was established (2026-08-20)

This workflow had never completed a single run before 2026-08-20; every
production deploy was performed by hand. Running it for real found four
defects, three of which no amount of reading would have shown:

1. It began `cd $DEPLOY_PATH && git fetch && git checkout <sha>`. `/opt/lilypad`
   is not a git repository, so the first line could never have succeeded.
2. `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH` and
   `vars.HEALTH_URL` were not configured at all.
3. `BACKEND_IMAGE=x sudo docker compose ...` — sudo scrubs the environment, so
   compose fell back to `.env.production` and redeployed the OLD image while
   every step reported success.
4. `docker compose up -d` recreated cloudflared from a definition that has
   never matched production, taking every hostname off the internet for seven
   minutes (see infra/production/README.md).

All four are fixed. Two consecutive green runs since, each verified by
`/health` reporting the exact commit deployed. **The health check verifying the
REVISION rather than mere liveness is what caught defect 3** — a `"status":"ok"`
check passes happily while the old container serves.

### Rollback, exercised (2026-08-20)

The rollback step was rewritten after the first real deploy and had never run,
which is the same trap the deploy itself was in. Exercised against production by
running `deploy.yml`'s rollback script verbatim on the host:

| Step                              | Result                                          |
| --------------------------------- | ----------------------------------------------- |
| Roll back to the recorded image   | serving the older revision in **8 s**           |
| Tunnel during the rollback        | stayed up (`200`); only the backend is touched  |
| Old code against the newer schema | fine — migration `0008` is additive, as claimed |
| Roll forward again                | serving the current revision in **7 s**         |

`.previous-image` is written before anything changes, and `docker image prune
-f` removes only dangling images, so the rollback target is still on disk when
it is needed. The rollback refuses to guess if that file is missing rather than
deploying something arbitrary.

### Which commit is running

```sh
curl -s https://api.takedia.com/health
# {"status":"ok",...,"revision":"f96f8c8133badacbea53b71e3af81f7ed38bbd96"}
```

`revision` is baked into the image by the Dockerfile's `GIT_SHA` build arg.
`unknown` means the image was built by hand rather than by the workflow.

## Recovery

| Failure                | Effect                                                                                                                        | Recovery                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Backend crashes        | `restart: unless-stopped` restarts it. Live P2P sessions **keep running** — media is not on this path.                        | Automatic                               |
| Postgres down          | Sign-in and enrollment fail. **Existing sessions and reconnects survive** — device tokens verify by signature, not a DB read. | Restore from backup                     |
| Redis down             | No new pairings. Existing P2P sessions keep running.                                                                          | Restart; data is disposable by design   |
| VM lost entirely       | Control plane down; LAN sessions unaffected                                                                                   | Re-provision, restore Postgres, `up -d` |
| Bad deploy             | Health check fails                                                                                                            | Workflow rolls back automatically       |
| Cloudflare tunnel down | API unreachable                                                                                                               | cloudflared restarts; LAN unaffected    |

### Backups

`infra/monitoring/backup.sh`, installed at `/opt/lilypad/backup.sh` and run from
cron at 03:17 UTC. `pg_dump | gzip`, retained 7 days locally and 7 days on the
relay VM.

Two things it does that the original did not, both found on 2026-08-20:

**It verifies before publishing.** The original wrote `pg_dump | gzip` straight
to the final filename. A dump that dies halfway still leaves a valid gzip file
with a plausible name and a fresh mtime — so every age-based check, including
the watchdog's, reports a healthy backup. The dump is now written under a
temporary name, checked for pg_dump's `PostgreSQL database dump complete`
marker, and only then moved into place. The move is atomic, so nothing ever
reads a partial file under the real name.

**It keeps a copy on another machine.** Backups previously lived on the same
disk as the database they protect, which is no help in the scenario a backup
exists for. Each verified dump is now piped over SSH to the relay VM, where
`infra/monitoring/lilypad-backup-sink` re-checks the gzip and the completion
marker on arrival before filing it.

The key that does this is generated **on** the production host, never leaves it,
and is pinned by a forced command on the relay to the sink script — so
production can deposit a dump and cannot read one back, list them, or get a
shell. That direction is deliberate: production is the more exposed of the two
machines, and a copy an attacker can delete is not a backup. Verified: sending
anything that is not a dump answers `REJECTED: not a valid gzip stream`.

The sink caps input at 64 MiB, so a compromised or looping sender cannot fill
the relay's disk and take TURN down with it.

**An untested backup is not a backup.** Verified 2026-08-20 by pulling the
OFF-HOST copy to a third machine, checking its integrity there, and restoring it
into a scratch database on production: 0 errors, 7 tables, 1 user, 270 audit
rows, 9 migration rows, and `users.email_verified_at` (migration 0007) present.
Scratch database dropped.

The watchdog alerts on the local dump and the off-host copy **separately**: they
fail independently, and a local backup can keep succeeding for weeks while the
copy to the other machine silently stops.

### Crash recovery, measured (2026-08-20)

The table above described what _should_ happen. Each row below was induced
deliberately against production with `sudo kill -9 <host pid>` — the container's
own namespace refuses SIGKILL to pid 1, so `docker exec kill -9 1` proves
nothing and has to be done from the host.

| Killed   | API impact                 | Back to 200 | Restarted |
| -------- | -------------------------- | ----------- | --------- |
| Redis    | `/health` 503 `degraded`   | < 15 s      | yes       |
| Postgres | none observed — stayed 200 | 7 s         | yes       |
| Backend  | 502                        | 9 s         | yes       |

Afterwards: 1 user, 1 refresh token, 262 audit rows. Nothing lost.

One correction worth recording, because it looked alarming and was not: a
container killed with `docker kill` does **not** come back, and that is correct
— Docker treats it as an operator stopping the container, not as a crash. Only
a real crash triggers `restart: unless-stopped`.

### Dependency audit exceptions

`pnpm audit --audit-level high` is a **blocking** gate in both `ci.yml` and
`deploy.yml`. Two advisories are suppressed in `package.json`'s
`pnpm.auditConfig.ignoreGhsas`, and the reason is recorded here because an
unexplained suppression is indistinguishable from one added to make CI green:

| Advisory                                                      | Package              | Why it is suppressed                                                                                                                                                                        |
| ------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GHSA-w3rx-r6r6-pgpr` — ICNS parser infinite loop (high)      | `image-size` ≤ 2.0.2 | **No patched version exists.** Reached only through `metro`, React Native's build-time bundler, and never at runtime on any device. Triggering it needs a malicious image inside this repo. |
| `GHSA-5p2g-fcmc-qvqq` — JXL/HEIF parser infinite loops (high) | `image-size` ≤ 2.0.2 | Same package, same path, same reasoning.                                                                                                                                                    |

Both are denial-of-service in an image parser, both are build-time only, and
neither ships. Re-check when `image-size` publishes a fix, or when React Native
moves off it: `pnpm -r why image-size`.

### Monitoring

`.github/workflows/watchdog.yml`, every ten minutes: `/health` (and which
dependency is down), `/metrics` (5xx rate, auth-failure and rate-limit spikes,
p95 latency), the download page, a real STUN Binding Request to the relay, and
per-VM disk, memory, container health, backup age, coturn state and pending
reboots. Alerts open a GitHub issue — one per incident, with follow-up
comments, closing itself on recovery.

Proven against a real fault on 2026-08-20: with Redis deliberately killed it
reported "health is degraded; down: redis", "container lilypad-prod-redis-1:
state is exited", and "container lilypad-prod-backend-1: healthcheck failing".
Its first-ever run found a genuine one nobody had noticed: the relay VM had a
pending reboot for applied security updates.

The host probe runs behind a **forced command** in `authorized_keys`, so the
monitoring key can run `/usr/local/bin/lilypad-status` and nothing else.
Verified: `ssh -i monitor_key <turn host> 'cat /etc/shadow'` returns the status
JSON, not the file.

## What the owner must provide (2026-08-15)

Deployment is blocked on accounts, not on work. Everything below needs a human
with a payment method and an identity; none of it can be created from this repo.

| #   | What to create                                                                               | Why it is needed                                                                                                                                                                                                                                                                 | Cost        | What to hand over                                         |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| 1   | **A VM** — Oracle Always Free (2 OCPU/12 GB ARM, Frankfurt or Singapore) **or** Hetzner CX22 | Runs backend + Postgres + Redis. Nothing else can be deployed until this exists.                                                                                                                                                                                                 | $0 / ~€4–5  | SSH host + key                                            |
| 2   | **A second VM for coturn** (skip at Stage 0 — co-locate)                                     | TURN needs UDP on a public IP; a tunnel cannot carry it. Separate so a relay flood cannot starve the API.                                                                                                                                                                        | ~€4–5       | SSH host + key, public IP                                 |
| 3   | **Cloudflare API token** (Pages: Edit; DNS: Edit on `takedia.com`)                           | Deploy `apps/site`; create `api.` / `turn.` / `dl.` records. The tunnel credential already on this machine authorizes tunnels only.                                                                                                                                              | $0          | `CLOUDFLARE_API_TOKEN`                                    |
| 4   | **Resend account + verified sending domain** — _and code_                                    | `POST /auth/magic-link/request` and password reset answer **503 in production**. Not only a missing key: `createMailSender()` returns `null` outside development, so no provider is wired at all. The account unblocks writing that sender; it does not by itself turn email on. | $0 to 3k/mo | `RESEND_API_KEY`, from-address                            |
| 5   | **Sentry project (optional)**                                                                | Nothing reports crashes today.                                                                                                                                                                                                                                                   | $0          | DSN                                                       |
| 6   | **GitHub Actions secrets**                                                                   | `deploy.yml` exists and has never run.                                                                                                                                                                                                                                           | $0          | `SSH_HOST`, `SSH_KEY`, `GHCR` scope on the existing token |
| 7   | **Stripe account**                                                                           | Only for [ADR-0013](adr/0013-connectivity-is-the-paid-boundary.md)'s paid tier. Not needed to launch the free tier.                                                                                                                                                              | —           | Publishable + secret keys                                 |
| 8   | **Prices for `pro` / `team`**                                                                | Not an account — a decision. `$XXXX` everywhere until it is made.                                                                                                                                                                                                                | —           | Two numbers                                               |
| 9   | **Apple Developer Program membership**                                                       | A free personal team cannot sign Sign in with Apple, which the App Store requires wherever Google sign-in is offered. Blocks installing the real entitlements on a phone **today**, not only TestFlight/App Store.                                                               | $99/yr      | Team enrolled; the Mac signed in to it                    |

Items 1, 3 and 4 are the minimum for a public deployment. Items 7–8 are only for
charging money, which [ADR-0013](adr/0013-connectivity-is-the-paid-boundary.md)
does not require before the free tier ships.

Item 9 is the only one that blocks **local** work: Xcode refuses the build with
_"Personal development teams … do not support the Sign In with Apple
capability"_, so the on-device builds made for testing so far have had to drop
[`LilypadMobile.entitlements`](../apps/mobile/ios/LilypadMobile/LilypadMobile.entitlements)
at the command line. Apple sign-in is therefore **unverified on hardware**;
everything else in the app is unaffected.

## What is deployed (2026-08-16)

Stage 0, on an Oracle Always Free VM (IP recorded in the Oracle console, deliberately not in this public repo). **Recurring cost: $0.**

**The shape is not the one Stage 0 above assumes.** That text specifies
"2 OCPU / 12 GB ARM"; what exists is `VM.Standard.E2.1.Micro` — **1 OCPU
(2 threads, AMD EPYC 7551), 1 GB RAM, 0.48 Gbps, 45 GB, Phoenix AD-3**. Twelve
times less memory, so it was audited under the live workload before being
trusted (2026-08-16):

| Measure              | Result                                         |
| -------------------- | ---------------------------------------------- |
| All four containers  | **175 MiB** of 952 MB — 464 MB still available |
| Swap (added, 2 GB)   | 3 MB used                                      |
| OOM kills / restarts | **0 / 0**, across two hours and a reboot       |
| CPU steal            | **0.0%** — this shape is not throttled         |
| Disk                 | 13% used, 51.9 MB/s write                      |
| Reboot recovery      | unattended, ~90 s, full audit re-passed        |

**CPU is the binding resource, not memory.** `scrypt` (N=32768, r=8) costs
**321 ms and 32 MiB per hash**, measured in the container — so sign-ins
serialise at roughly **3 per second per core**, confirmed end-to-end: five
concurrent sign-ins took 2081 ms, exactly five times the single-request 416 ms.
Memory is bounded by construction, because libuv's default 4-thread pool caps
concurrent scrypt at 4 (**128 MiB peak**) however heavy the load; a 20-request
burst never moved backend memory off ~90 MiB, since the **rate limiter binds
first** (16 of 20 got HTTP 429). A sign-in storm therefore queues rather than
exhausts the box.

### The risk that is structural, not a misconfiguration

[Oracle reclaims idle Always Free compute](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm):
over any **7-day period**, CPU 95th-percentile below 20% **and** network below
20% marks an instance idle and eligible to be reclaimed. (The memory criterion
applies to A1 shapes only, so it does not help an E2.) This instance measures
**~3% CPU, load 0.08**, near-zero network.

That is the architecture working exactly as designed. A session is a few KB of
signaling and then zero server bandwidth ([ADR-0009](adr/0009-control-plane-deployment.md)) —
so **the control plane's defining virtue is precisely what makes it look
abandoned to Oracle's reclaimer.** No tuning resolves it; it is a conflict
between this workload and the free tier's terms. Accepted deliberately for the
$0 launch, with deployment scripted so re-provisioning is cheap. The documented
escape is Stage 1's Hetzner CX22 (~€4.35, 4 GB, no idle policy).

**TURN must not be co-located here** (owner's decision, 2026-08-16, and the
measurements agree): 1 GB and 0.48 Gbps shared with the API is precisely the
relay-starves-the-API scenario ADR-0009 separated TURN to avoid.

### Operating system

Ubuntu **20.04.6 LTS**, past its April 2025 standard-support end. The 19
security updates pending at audit time **were applied 2026-08-16** and 0 remain;
`unattended-upgrades` is active. Future CVE fixes for 20.04 need **Ubuntu Pro
`esm-infra`**, which is available on this machine but **not attached** — it
needs a token from the owner's Ubuntu One account (free for up to 5 machines).

| Piece       | State                                                               |
| ----------- | ------------------------------------------------------------------- |
| backend     | ✅ `lilypad-backend:prod`, healthy                                  |
| postgres    | ✅ 7 tables, migrated by `deploy.yml`'s own command                 |
| redis       | ✅ password-required, persistence off                               |
| cloudflared | ✅ tunnel `lilypad-prod`, serving `api.takedia.com`                 |
| coturn      | ❌ **not on this VM, by decision** — see below                      |
| backups     | ✅ nightly 03:17 UTC `pg_dump`, 7-day retention, **restore-tested** |

Two deviations from the text above, both deliberate and neither architectural:

1. **The image was cross-built and shipped over SSH**, not pulled from GHCR.
   `deploy.yml` has never run, so `ghcr.io/kushsharma024/lilypad-backend` does
   not exist yet, and the repo is private. `docker buildx --platform linux/amd64`
   → `docker save | ssh docker load` puts no credential on the box.
2. **The tunnel is locally-managed**, not token-managed. The compose file
   expects a dashboard-issued `CLOUDFLARE_TUNNEL_TOKEN`; this tunnel was created
   from the CLI with the existing origin certificate, so its ingress lives in
   `/opt/lilypad/cloudflared/config.yml`. A compose **override** supplies that —
   `infra/production/docker-compose.yml` itself is untouched. Same container,
   same hostname, same architecture.

### Verified against the live public endpoint

- `https://api.takedia.com/health` → 200, valid TLS, HTTP/2, both dependencies up.
- **`pnpm e2e:audit` against production: all checks pass** — signup, duplicate
  refusal, wrong-password parity, enrollment, the desktop's inability to enroll
  itself, linking by phone approval, single-use codes, the device list and its
  401 for anonymous callers, pairing, single-use QR tokens, connect
  authorization, revocation, and re-linking.
- `wss://api.takedia.com/ws/signal` upgrades through the tunnel and refuses an
  unauthorized `register` with `unauthorized_room` then close `4403`.
- `/metrics` 401 without a token, 200 with it. CORS closed to an unlisted origin.
- **Postgres, Redis and the backend have no public port at all** — only 22 is
  reachable. Confirmed by probing from off-host.
- **Reboot-tested:** `sudo reboot` → the full stack, tunnel included, returned
  unattended in ~90s and re-passed the whole audit.

### TURN (deployed 2026-08-19)

Runs on a **second Oracle Always Free instance**, provisioned end to end with
the OCI CLI. Same shape as the control plane (`VM.Standard.E2.1.Micro`, 1 OCPU /
1 GB, PHX-AD-3 — the tenancy's limit is 2 and one was spare), on **Ubuntu 24.04
LTS** rather than the control plane's end-of-life 20.04. Cost: **$0**.

The earlier finding stands and is why this is a separate box: with host
`iptables` opened on TCP 80 and a listener running, an external connection still
timed out, proving the block was Oracle's console-level **VCN security list**.
That is now solved without touching the control plane's exposure — the TURN
host's ports live in a **Network Security Group** attached to that one VNIC, not
in the shared subnet's security list. Both VMs sit in the same subnet and the
API's surface is unchanged.

| Layer           | Opened                                                       |
| --------------- | ------------------------------------------------------------ |
| OCI NSG         | UDP 3478, TCP 3478, TCP 443, UDP 49160-49260, TCP 22, TCP 80 |
| Host `iptables` | the same, inserted above the image's trailing `REJECT`       |

Both layers are required — the Oracle image ships an `iptables` chain that
rejects everything except SSH, so an NSG alone is silently insufficient.

**Four decisions worth keeping:**

- **coturn runs natively under systemd, not Docker.** The repo ships a compose
  file, but Docker's daemon costs ~120 MB on a 954 MB box whose only job is
  forwarding packets. `turnserver.conf` is still used **verbatim** from
  `infra/coturn-prod`; `/etc/coturn/certs` is a symlink to the Let's Encrypt
  live directory so the committed cert paths resolve unchanged.
- **`external-ip=<public>/<private>`.** Oracle gives the instance only its
  private address and 1:1-NATs the public one. A bare public IP would make
  coturn try to bind an address the host does not have.
- **HTTP-01, deliberately not DNS-01.** DNS-01 would have put a zone-wide
  Cloudflare token on a public-facing relay; port 80 with certbot's ephemeral
  standalone listener is the smaller exposure. Renewal is automatic, with a
  deploy hook that re-applies group permissions and restarts coturn.
- **The private key is `640 root:turnserver`, not world-readable.** The
  `infra/coturn-prod` README's `chmod -R a+rX` is the Docker-image workaround;
  running natively, group ownership does the same job without publishing the
  key to every account on the box. coturn also needs a systemd drop-in granting
  `CAP_NET_BIND_SERVICE`, since the unit runs unprivileged and 443 is reserved.

**Verified, not assumed.** Four forced relay-only WebRTC sessions from a
different machine: both peers built with `iceTransportPolicy: 'relay'`, so a
DataChannel that opens cannot have taken a direct path — every byte crossed the
relay. One run per transport (**UDP 3478, TCP 3478, TLS 443**) plus the exact
ICE-server list the backend sends, each carrying a payload end to end. The
credential for the last run was minted **inside the production backend
container**, which is what proves the two halves genuinely share `TURN_SECRET`
rather than merely being configured to look alike. Re-run unchanged after a
reboot, which also confirmed coturn auto-starts and the firewall rules persist.
Idle footprint 338 MB of 954 MB.

**Not verified:** a real Mac↔iPhone session failing over to this relay on a
hostile network, and sustained throughput under concurrent sessions. The relay
provably relays; the product's fall-back to it has not been watched on hardware.

**The reclamation risk applies here too, and harder.** A relay used by nobody is
idle by definition, so the same Always Free policy that threatens the control
plane threatens this box on the same terms — see
[the structural risk](#the-risk-that-is-structural-not-a-misconfiguration).
Egress is the other open question: Oracle's free allowance is generous but has
not been measured against real relayed sessions, and TURN is the one component
whose cost tracks usage rather than user count.

## What is not done

Stated explicitly so nothing here reads as more finished than it is.

- ~~Nothing is deployed.~~ Superseded: the control plane went live 2026-08-16
  and TURN 2026-08-19. This bullet predated both and is kept struck through
  because its replacement is the point — the blocker really was accounts, and
  once they existed the work was hours, not weeks.
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
- The `sessions` table is still never written. Consequence: there is no session
  history for support, and no basis for metering relayed minutes — the thing
  [ADR-0013](adr/0013-connectivity-is-the-paid-boundary.md) says is the paid
  boundary. Its three foreign keys are deliberately left unindexed while it
  stays empty.
- ~~No backup cron is installed.~~ It runs nightly, and the watchdog alerts if
  the newest dump is over 36 hours old or the directory is empty. Restore was
  exercised 2026-08-20.
- ~~Backups have no off-host copy.~~ Each verified dump is now copied to the
  relay VM (see below). Still true, and the residual risk: **both machines are
  Always Free instances in the same Oracle tenancy and region.** A disk failure,
  a bad migration, or losing one VM is covered; losing the tenancy is not.
- No staging environment exists yet — the workflow supports it, nothing runs it.
- **The website is not deployed by CI.** `site.yml` builds and tests but cannot
  publish: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are not set. It
  used to report SUCCESS anyway, which is how the live page kept saying "Not
  yet released publicly" through three green runs while the fix sat on `main`.
  It now fails on a push to `main`, so the signal means what it says. **Whoever
  updates the site is doing it by hand, and the live page can lag `main`
  silently until those two secrets exist.**
- ~~No crash reporting or metrics scraping.~~ Metrics are scraped by the
  watchdog every ten minutes. Crash reporting (Sentry or equivalent) is still
  absent: an unhandled exception is visible only as a 5xx rate and a line in
  `docker logs`, with no stack trace retained past the container's 30 MB log cap.
- **`audit_logs` has no retention policy.** It records IP addresses and the
  email addresses failed sign-ins were attempted against, and it grows forever.
  How long that data should be kept is a policy question, not an engineering
  one, and the privacy policy that would answer it is not written — so nothing
  is deleted rather than a number being invented. Both foreign keys are now
  indexed, so a future prune (and account deletion) will not table-scan.
- **A deploy is not zero-downtime.** Replacing the backend container is a hard
  cutover; measured recovery is ~9 seconds of 502. Live P2P sessions are
  unaffected (media never crosses this path), but signaling and sign-in are
  down for those seconds.
- **Revocation is single-process.** `hub.endRoomsForDevice` kills live rooms on
  the instance that handled the request. With one backend that is complete;
  with two it would not be, and horizontal scaling
  ([ADR-0004](adr/0004-signaling-horizontal-scaling.md)) has to solve it before
  a second instance exists.

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

### Verified against production (2026-08-20)

Adversarial and load checks run against the live public endpoint, not a local
build. Numbers are single-vantage samples from one Mac over the public internet
through the Cloudflare edge to the Oracle VM in `phx`, stated so they can be
reproduced rather than believed.

**Rate limiting binds to the real client IP and is not spoofable.** Against a
5/minute route, eight requests each carrying a _different forged source_:

| Forged header      | Result                                        |
| ------------------ | --------------------------------------------- |
| `X-Forwarded-For`  | 5 × 503 then 429 — identical to no header     |
| `X-Real-IP`        | 5 × 503 then 429 — identical to no header     |
| `CF-Connecting-IP` | 403 from Cloudflare; never reaches the origin |

**Latency**, cold path separated from warm because a first connection pays for
TLS and a tunnel hop:

| Measurement                                | Result                                         |
| ------------------------------------------ | ---------------------------------------------- |
| First request (fresh TLS + tunnel)         | 911 ms                                         |
| `GET /health` × 60                         | min 37, p50 68, p95 196, p99 1555 ms           |
| `GET` an unrouted path × 20                | p50 90, p95 158 ms                             |
| `POST /auth/password`, unknown account × 8 | p50 430, max 880 ms (32 MiB scrypt, by design) |
| WebSocket `/ws/signal` open × 5            | p50 178, p95 427 ms                            |

**Concurrency** on one OCPU — latency grows, nothing collapses:

| Simultaneous | Wall   | Per-request p50 |
| ------------ | ------ | --------------- |
| 1            | 44 ms  | 41 ms           |
| 5            | 71 ms  | 48 ms           |
| 10           | 247 ms | 85 ms           |

**Sustained capacity is NOT VERIFIED.** The per-IP rate limit (120/min) makes a
real load test impossible from a handful of addresses — which is the limiter
working correctly, not an obstacle to route around. A capacity figure needs a
distributed generator, and no number is stated here until one runs.

**The relay carries a long session.** A forced-relay WebRTC DataChannel
(`iceTransportPolicy: 'relay'` on both peers, so no direct path is possible)
ran 842 seconds on a 300-second TURN credential: 56 messages sent, 55 echoed,
ICE never left `connected`. coturn's REST credential expiry gates new
allocations, not existing ones — measured, because reading
`turn/credentials.ts` suggests the opposite.

**The relay survives a reboot.** Patched to kernel `6.17.0-1020-oracle` and
rebooted: SSH back in 43 s, coturn `active` and `enabled`, STUN Binding Success
in 9 ms, and a fresh forced-relay session opened and echoed.

**Every authorization boundary holds, tested with a real owned device.** An
earlier probe claimed another device's presence seat and succeeded, which
proved nothing: `authorize.ts` has a deliberate unowned lane for device rows
with no account, and production had zero devices, so every id was unowned.
Distinguishing "open by design" from "broken" needed a row that IS owned, so
the whole linking ceremony was driven against production over the API — signup,
phone enrolment with a real Ed25519 challenge signature, enrolment code, phone
approval — and then:

| Attempt                                                    | Result                      |
| ---------------------------------------------------------- | --------------------------- |
| A laptop enrolling ITSELF with an account token            | 403 (ADR-0010 holds)        |
| Approving an enrolment code with an account, not a device  | 403 `device_token_required` |
| An unapproved laptop asking for a device token             | 403 `device_not_enrolled`   |
| Replaying a spent enrolment code                           | 404                         |
| Replaying a spent challenge nonce                          | 401                         |
| Anonymous socket claiming the OWNED laptop's presence seat | rejected                    |
| Same, carrying a forged bearer token                       | rejected                    |
| The owner's own phone trying to act AS the laptop          | rejected                    |
| The laptop itself claiming its own seat                    | accepted                    |

The last two together are the property worth having: owning a device is not the
same as being it. Approval also returns the connect secret, so linking makes the
laptop reachable rather than merely owned — the F2 bug, confirmed fixed on the
live system.

Also confirmed: a forged JWT and an `alg: none` JWT are both 401; eight
malformed-input classes (broken JSON, 400-deep nesting, a 200 KB field,
prototype pollution, SQL in an email) all answer 4xx and never 5xx, with
Postgres healthy afterwards; a socket that never registers is closed after
~10 s with code 4408; a frame over the 64 KB cap closes the socket with 1009.

**Cascade deletion is complete.** Deleting the three audit accounts removed 4
devices and 2 trust pairs, leaving 0 orphans. `audit_logs` rows survive by
design (`ON DELETE SET NULL`), which is what makes the missing retention policy
above matter.

**Signaling authenticates by `Authorization` header**, not a query parameter.
Not a defect — but it means a browser could never authenticate to this socket,
since browsers cannot set headers on a WebSocket handshake. Nothing is broken
today; anyone building a web client hits this immediately.

**The published updater artifact verifies.** `latest.json` for v0.1.1, both
platform entries: minisign key id matches the `updater.pubkey` compiled into
the shipped app, and the Ed25519 signature over the BLAKE2b-512 prehash of the
21,106,156-byte tarball validates.

**Re-verified 2026-08-15 against the production image, on the current commit**,
because the checks above predate the M9/P-series work and a stale green is worth
nothing:

- Migrations applied by the **exact command `deploy.yml` runs**
  (`docker compose run --rm backend node dist/db/migrate.js`) against an empty
  volume → 7 tables. The image ships no auto-migrate, which is why the deploy
  runs this as its own step before the new container serves.
- `pnpm e2e:audit` against that container: **all checks pass** — signup,
  enrollment, the desktop's inability to enroll itself, linking by phone
  approval, single-use codes, the account device list, its 401 for anonymous
  callers, pairing, single-use QR tokens, connect authorization, revocation and
  re-linking.
- `/metrics` 401 → 200 with the token; CORS closed to an unlisted origin and
  open to the configured one; `/ws/signal` upgrades and refuses an unauthorized
  `register` with `unauthorized_room` then close `4403`.
- `/auth/magic-link/request` and `/auth/password/reset/request` both answer
  **503** — correct and expected, for owner item 4's reason. Password sign-up
  and sign-in are unaffected, so account creation works without email.

Still local-only. Nothing above was run on a public host, because none exists.

## Second audit pass (2026-08-20)

A deeper pass over the same system, after the first one had closed its findings.
Everything below was proven before it was fixed, and verified after.

### Revocation did not survive contact with its own threat

`DELETE /devices/:deviceId` is the answer to "I lost my laptop". Run against
production, against a real account with a real enrolled phone and an
approved laptop:

| Step                                      | Before the fix                       |
| ----------------------------------------- | ------------------------------------ |
| Revoke the phone from the laptop          | `200 {"ok":true}`                    |
| Phone asks for a device token             | `403 device_revoked` ✅              |
| Phone refreshes its **account** session   | `200` — the session on it never died |
| Phone re-enrols its own unchanged keypair | `200` — `revoked_at` cleared         |
| Phone asks for a device token again       | `200` — fully restored               |

Three separate pieces of correct-looking code. Revoke does not touch
`refresh_tokens`; an account session is enough to call `POST /devices/enroll`;
and `DeviceRegistry.claim()` clears `revoked_at` on purpose, because
re-enrolling is how someone restores a device they got back.

The account session is the crown jewel, not the device key — holding one lets
you enrol a `kind: "mobile"` device you control and approve anything from it. So
revocation now revokes the account's refresh tokens, and it is awaited: a route
that answers 200 while the credential that undoes it is still live is worse than
one that fails, because the user believes it worked.

Whole-account rather than per-device because `refresh_tokens` has no device
column and cannot have one — a client signs in _before_ it enrols, so at issue
time there is no device to bind to. It costs nothing today: **nothing in either
client ever presents a refresh token.**

Which was the other half of it. The desktop kept one in the login keychain for
thirty days and never used it — there is no `/auth/refresh` call in that crate.
A dormant bearer credential, on the machine whose theft is the entire reason the
Revoke button exists. It now stores an email and a user id, which is all the UI
ever read.

Recovery is unchanged: the owner signs in on the phone and re-enrols. A thief
cannot, because signing in needs the password.

### Revocation, the two rounds it took after that

Deploying the refresh-token fix and re-running the same probe against
production found the rest of it.

**Round two — the ten-minute window was permanent, not ten minutes.**
`/auth/refresh` correctly answered 401, and the account access token minted
before the revoke re-enrolled the phone anyway. Ten minutes of stale access is
the documented trade (ADR-0001), and it is survivable everywhere its worst case
is ten more minutes of access. `/devices/enroll` is not such a route: enrolling
clears `revoked_at`, so a stale credential does not buy ten minutes, it buys the
device back for good.

Closed by a comparison rather than a lookup — the token already carries `iat`
and the row already carries `revoked_at`, so re-enrolling a revoked device now
requires a credential minted after the revocation. The owner signs in again and
recovers; a thief cannot, because signing in needs the password. The approval
path passes no timestamp on purpose: a desktop is restored by a _different_
device approving its code, and that second device is the proof.

**Round four — the guard was a check-then-act.** Rounds two and three both read
the device row and then acted on what they read, with a database round trip in
between. A revoke landing in that gap would have been read as "not revoked" and
the write would have cleared it. Microseconds wide and not realistically
reachable, but the codebase already had the right answer twice over —
`RefreshTokenService.markRotatedIfLive` and `AccountDeviceStore.revoke` both put
their condition in the WHERE clause and treat the SELECT as advice. Re-enrolment
now does the same, and the regression test drives a revocation into the gap; it
fails if the guard is removed.

**Round three — a revoked device stopped being a target but not a caller.**
The website says a removed device "loses access straight away … It does not wait
for a token to expire." Measured against production with a token minted seconds
before the revoke:

| Route                                              | Before        | After    |
| -------------------------------------------------- | ------------- | -------- |
| `GET /devices` (every machine on the account)      | **200**       | 401      |
| `PATCH /devices/:id` (rename any of them)          | **200**       | 401      |
| `GET /devices/pairs` (which phones reach a laptop) | **200**       | 401      |
| `POST /devices/enrollment-code/approve`            | **reachable** | 401      |
| `POST /connect/request` (ring the Mac)             | 404           | 404      |
| WebSocket presence claim                           | rejected      | rejected |

The two that were already closed are the two that resolve the device row rather
than trusting the token. Everything else trusted the signature.

`authorize.ts` lets a revoked device still be _managed_ by its owner, and
should — "I lost my laptop" must not also mean "and now you cannot clean up
after it". But that is about the target. Nothing was asking whether the caller
was still allowed to be a caller, and the worst consequence was not the
information disclosure: `/devices/enrollment-code/approve` takes a device token,
so a revoked phone had a ten-minute window to approve a **new** laptop onto the
account. Revocation with a persistence mechanism attached is not revocation.

`rejectRevokedActor` is one indexed lookup, on routes that already read the
database to authorize, and deliberately not in `requireAuth` — that stays
DB-free so signaling and reconnect survive a Postgres outage.

### Redis had no ceiling

Measured on the host: `maxmemory 0`, `maxmemory-policy noeviction`, 952 MB of
RAM shared by four containers, steady state 1.2 MB. Unlimited does not mean
Redis stops somewhere sensible — it means the OOM killer eventually picks
whatever has the largest RSS, which is Postgres, not the process at fault.

Now `--maxmemory 128mb --maxmemory-policy volatile-ttl`. `volatile-ttl` because
these keys are not equally valuable and their TTLs already say so: a device
challenge lives 120s and its client just retries, while a room-auth record lives
six hours and losing it hard-rejects the reconnect of a session whose media is
still flowing. Nearest-to-expiring goes first, which under a flood is the flood.

That converts a crash into a silent eviction, so the watchdog now alerts on
`evicted_keys > 0` (critical — someone has already been told to pair again
mid-session), on crossing 75% of the cap, and on `maxmemory` reading back as 0,
which is this fix checking that it is still applied.

### The compose file's default image was not ours

`${BACKEND_IMAGE:-ghcr.io/kushsharma024/lilypad-backend:latest}`. The repo is
`Kush402/lilypad`, so the image is `ghcr.io/kush402/…`, and `kushsharma024` is
a live GitHub account somebody holds. Unreachable in practice — the deploy
always passes an exact SHA — but a fallback that could pull a stranger's image
is worse than no fallback. Now `${BACKEND_IMAGE:?…}`, verified to stop
`docker compose config` with its own sentence.

### Apple: both apps take the local network without saying why

Apple's [TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
gates local network access on iOS 14+ and **macOS 15+**, and lists both
operations an ICE host candidate to a phone on the same Wi-Fi performs:
"Making an outgoing TCP connection: yes", "Sending a UDP unicast: yes". On
[`NSLocalNetworkUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocalnetworkusagedescription)
Apple writes: _"Any app that uses the local network, directly or indirectly,
should include this description … as well as direct unicast or multicast
connections to local hosts."_

Neither app declared it. The macOS bundle had **no** usage descriptions at all;
iOS declared only the camera. Both now do, and both have a test pinning it,
because nothing else in either codebase imports those files.

`NSBonjourServices` is deliberately absent: the phone dials an address the
desktop advertised over signaling, which is unicast, and TN3179 asks for that
key only for registering or browsing Bonjour services.

Two things this does **not** fix, both recorded rather than guessed at:

- TN3179: _"it may deny the operation immediately, before the user has responded
  to the alert."_ Whether Lilypad's first LAN session on macOS 15+/iOS silently
  falls back to the relay is **NOT VERIFIED** — it needs the two devices.
- Nothing in either UI tells the user which of the three paths a session took.
  The website makes three distinct promises about that, and the product cannot
  currently confirm any of them.

### The webview had no CSP and shipped a global IPC handle

Both were M3 audit findings, still open. `withGlobalTauri: true` put raw
`invoke` — screen capture, input injection — on `window` for any script in any
Lilypad window, and it was reach for nothing: every call site already imports
from `@tauri-apps/api`. Verified gone from the built binary.

The CSP was the part worth being careful about, because an unverifiable CSP is a
blank window for every customer. It was verified rather than argued: build,
launch, and confirm the bubble renders — `index.html` is an empty
`<div id="root">` plus a module script, so a rendered bubble means scripts ran
and styles applied under the policy. `img-src data:` is load-bearing; the
pairing QR is a data URL.

### Backups: the schedule had never actually run offsite

The off-host copy existed, but every copy in it had been made by hand. The 03:17
cron had last run _before_ the offsite sink was built, so the automated path was
untested and would have stayed untested for another 36 hours — the watchdog's
alert threshold.

Proven by scheduling a one-off cron entry two minutes out and watching it fire:

```
Aug 20 17:41:01 CRON[1627491]: (root) CMD (/opt/lilypad/backup.sh …)
2026-08-20T17:41:02Z local: lilypad-20260820T174101Z.sql.gz (13920 bytes)
stored lilypad-20260820T174103Z.sql.gz (13920 bytes)
2026-08-20T17:41:02Z offsite: copied
```

Byte-identical on the far host. The temporary entry was removed and the crontab
restored to its two original lines.

### A test that asserted on the host's spare capacity

Three of `input_worker`'s eight tests failed inside `pnpm verify` and all eight
passed alone. Twelve hardcoded two-second deadlines, against a run that builds
two Rust targets and seven JavaScript suites at once. `wait_for` returns the
moment its condition holds, so the budget was free to raise — the file still
finishes in about 1.4 seconds. A suite that only passes on an idle laptop makes
`main` randomly red, and that teaches people to re-run instead of read.
