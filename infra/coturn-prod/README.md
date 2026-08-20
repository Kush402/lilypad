# Lilypad production TURN (coturn)

The fix for cellular instability. The app was relaying media through a **free
public TURN** (`metered.ca`) that DNS-round-robins to different servers and
whose free tier can't sustain a 1–3 Mbps desktop stream — so the relayed path
collapsed every ~30s and the session fell into the connect→reconnect→recovering
loop. This gives you **one dedicated relay on TLS:443** that you control:
a single stable hop that survives cellular NAT rebinds and DPI.

> **This is deployed.** `turn.takedia.com` has been live since 2026-08-19 on a
> second Oracle Always Free VM, at **$0** — so ignore the "cheap VPS ~$5/mo"
> framing below, which predates it. The live box also runs coturn **natively
> under systemd rather than via the compose file here**, because Docker's daemon
> costs ~120 MB on a 1 GB instance that exists only to forward packets;
> `turnserver.conf` in this directory is still used verbatim. See
> [docs/deployment.md § TURN](../../docs/deployment.md#turn-deployed-2026-08-19)
> for what was actually done and what was actually verified. The steps below
> remain the correct recipe for standing up a _second_ relay.

---

## What you need

- A cheap VPS with a **public IPv4** (Linode/DO/Hetzner, ~$5/mo, 1 GB RAM is
  plenty). Pick a region near you for lowest latency.
- A **domain/subdomain** you can add an A record to (e.g. `turn.example.com`).
- Docker + Docker Compose on the VPS.

## 1. DNS

Add an **A record**: `turn.example.com → <VPS public IP>`. Wait for it to
resolve (`dig +short turn.example.com`).

## 2. Firewall — open these ports on the VPS

| Port        | Proto     | Why                                        |
| ----------- | --------- | ------------------------------------------ |
| 3478        | UDP + TCP | STUN/TURN                                  |
| 443         | TCP       | TURN over TLS (the cellular-reliable path) |
| 49160–49260 | UDP       | relay port range                           |

Linode/DO cloud firewall or `ufw`:

```bash
ufw allow 3478/tcp && ufw allow 3478/udp
ufw allow 443/tcp
ufw allow 49160:49260/udp
```

## 3. Get the code + config onto the box

Copy this `infra/coturn-prod/` directory to the VPS (scp/git). Then:

```bash
cd coturn-prod
cp .env.example .env
# edit .env: TURN_PUBLIC_IP, TURN_DOMAIN, TURN_SECRET (openssl rand -hex 32)
```

**Save the `TURN_SECRET`** — the backend must use the exact same value.

## 4. TLS certificate (Let's Encrypt)

TURN on 443 needs a real cert. On the VPS:

```bash
apt install -y certbot
certbot certonly --standalone -d turn.example.com   # uses port 80 briefly
```

This writes `/etc/letsencrypt/live/turn.example.com/{fullchain,privkey}.pem`,
which the compose file mounts. coturn runs unprivileged inside the image, so
let it read the keys (re-run after each renewal, or add as a certbot deploy
hook):

```bash
chmod -R a+rX /etc/letsencrypt/live /etc/letsencrypt/archive
```

> No domain yet / want to smoke-test first? You can start **without** TLS:
> comment out the `cert`/`pkey`/`tls-listening-port` lines in `turnserver.conf`
> and test with just `turn:<IP>:3478`. Cellular reliability really wants TLS:443
> though, so treat that as the finish line, not the start.

## 5. Launch

```bash
docker compose up -d
docker compose logs -f     # expect "0: : (log) IPv4. ... Relay ... listener opened"
```

## 6. Verify it actually relays

From your laptop (not the VPS), use Trickle-ICE:
https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

- URI: `turns:turn.example.com:443?transport=tcp`
- username: `9999999999` (any future unix time), for a quick check set
  `credential` using the REST scheme, **or** just confirm you get a `relay`
  candidate. The definitive check is a `relay` candidate line appearing.

A `relay` candidate = success. No relay candidate = firewall/cert/secret issue.

## 7. Wire it into Lilypad

Tell me the domain and I'll set, in the backend `.env`:

```
PUBLIC_TURN_URL=turns:turn.example.com:443?transport=tcp,turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
PUBLIC_TURN_USERNAME=   # (unused with use-auth-secret; the backend mints creds)
PUBLIC_TURN_CREDENTIAL= #  from TURN_SECRET — I'll switch this path to the HMAC scheme
TURN_SECRET=<same value you put in coturn/.env>
```

(There's a small backend tweak so the public relay uses the same time-limited
HMAC credentials as the local coturn instead of a static username/credential —
I'll handle that when you give me the domain.)

## Renewals

certbot auto-renews. Add a deploy hook so coturn picks up the new cert:

```bash
echo 'chmod -R a+rX /etc/letsencrypt/live /etc/letsencrypt/archive; docker restart $(docker ps -q -f name=coturn)' \
  > /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
```
