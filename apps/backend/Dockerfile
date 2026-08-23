# Lilypad backend — production image.
#
# Multi-stage so the runtime layer carries no compiler, no dev dependencies and
# no source: only `dist/` and production `node_modules`. Nothing here is
# architecture-specific, so it builds for whatever `docker buildx` is told to
# target. `deploy.yml` targets linux/amd64 only, because that is what production
# is — and because cross-building arm64 under QEMU took longer than an incident
# can wait.
#
# Node 22 (repo requires >=20) on Alpine. `--frozen-lockfile` so an image can
# never silently resolve different dependency versions than CI tested.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable

# Only manifests first, so a source-only change reuses this whole layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
# The mobile/desktop/admin manifests are irrelevant to the server but must be
# present verbatim, or `--frozen-lockfile` rejects the lockfile as out of date.
# `--filter @lilypad/backend...` is what keeps React Native and Tauri out of
# the image — copying these manifests costs a few KB and installs nothing.
COPY apps/mobile/package.json apps/mobile/
COPY apps/desktop/package.json apps/desktop/
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --filter @lilypad/backend...

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
# Every workspace tsconfig extends this; without it tsc fails with TS5083.
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN pnpm --filter @lilypad/protocol build \
 && pnpm --filter @lilypad/shared build \
 && pnpm --filter @lilypad/backend build

# Re-resolve without dev dependencies. Done after the build, since tsc itself
# is a dev dependency.
# CI=true so pnpm purges the dev-dependency modules non-interactively instead
# of prompting for confirmation, which no build has a terminal to answer.
RUN CI=true pnpm install --frozen-lockfile --prod --filter @lilypad/backend...

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# Which commit is actually serving. Without this, "is the fix deployed?" has no
# answer from outside the VM — the image tag lives in a shell variable that
# nothing records, and /health reported a version string edited by hand. The
# deploy workflow passes the SHA it built; a local build gets `unknown`, which
# is honest rather than misleading.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
# Never run as root: a container escape should not start with uid 0. `node` is
# an unprivileged user Alpine's Node image already provides.
USER node

COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=node:node /repo/packages/protocol/package.json ./packages/protocol/
COPY --from=build --chown=node:node /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=node:node /repo/apps/backend/dist ./apps/backend/dist
COPY --from=build --chown=node:node /repo/apps/backend/drizzle ./apps/backend/drizzle
COPY --from=build --chown=node:node /repo/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=build --chown=node:node /repo/apps/backend/package.json ./apps/backend/

EXPOSE 8080

# Uses the app's own /health, which reports Postgres and Redis reachability —
# so an unhealthy dependency marks the container unhealthy rather than letting
# it accept traffic it cannot serve.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BACKEND_PORT||8080)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

WORKDIR /repo/apps/backend
CMD ["node", "dist/index.js"]
