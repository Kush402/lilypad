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
