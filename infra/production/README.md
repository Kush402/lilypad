# Production host layout

The one VM that serves `api.takedia.com`. Read this before changing
`docker-compose.yml` or the deploy workflow — two of the three facts below are
things a deploy already broke by not knowing them.

## The tunnel does not use a dashboard token

`docker-compose.yml` declares cloudflared as
`tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}`, which is the
remotely-managed form. **Production does not run it that way.** This tunnel was
created from the CLI against the existing origin certificate, so its
credentials and its ingress rules live on the box:

- `/opt/lilypad/tunnel-credentials.json` — the tunnel's credentials
- `/opt/lilypad/cloudflared/config.yml` — ingress (`api.takedia.com` →
  `http://backend:8080`, then a `404` terminator)
- `/opt/lilypad/cloudflared-local.yml` — a compose override that swaps the
  command and mounts the two files above. A copy is vendored here as
  `cloudflared-local.yml` so it survives losing the VM.

`CLOUDFLARE_TUNNEL_TOKEN` is therefore **not** in `.env.production`, and a
`docker compose up` that omits the override recreates cloudflared with
`--token ""`. It then crash-loops and every Lilypad hostname answers Cloudflare
error 1033. That is not hypothetical: it happened on 2026-08-20 and cost seven
minutes of total outage.

Any full-stack compose command on this host must be:

```sh
sudo docker compose --env-file /opt/lilypad/.env.production \
  -f infra/production/docker-compose.yml \
  -f /opt/lilypad/cloudflared-local.yml <command>
```

`deploy.yml` adds the override automatically when the file is present, and
touches only the `backend` service — a deploy has no business restarting the
database or the tunnel.

## `sudo` scrubs the environment

`BACKEND_IMAGE=x sudo docker compose ...` silently loses `BACKEND_IMAGE`;
compose then falls back to the value in `.env.production` and quietly deploys
the wrong image while reporting success. Write `sudo BACKEND_IMAGE=x docker
compose ...` instead — sudo accepts assignments after itself.

## There is no git checkout here

`/opt/lilypad` is not a repository and does not need to be. The deploy copies
`infra/production/docker-compose.yml` for the commit being deployed; nothing
else on the host comes from the repo. This is deliberate — a second checkout is
a second thing that drifts.

## Which commit is serving

`GET /health` reports `revision`, baked into the image at build time from the
deploying commit's SHA. `unknown` means the image was built by hand rather than
by `deploy.yml`.

## Files that live only on the host

| Path                                     | What                          | Backed up?                                       |
| ---------------------------------------- | ----------------------------- | ------------------------------------------------ |
| `/opt/lilypad/.env.production`           | every production secret       | **No** — recreate from `.env.production.example` |
| `/opt/lilypad/tunnel-credentials.json`   | Cloudflare tunnel credentials | **No** — reissue from the Cloudflare dashboard   |
| `/opt/lilypad/cloudflared/config.yml`    | tunnel ingress                | Vendored here                                    |
| `/opt/lilypad/cloudflared-local.yml`     | compose override              | Vendored here                                    |
| `/opt/lilypad/infra/production/backups/` | nightly `pg_dump`             | On the same disk as the database it protects     |
| `/usr/local/bin/lilypad-status`          | watchdog probe                | `infra/monitoring/lilypad-status`                |
