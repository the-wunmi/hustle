# syntax=docker/dockerfile:1.7
# One file, two images: `--target api` and `--target web`. docker-compose.yml builds both.

# Pinned to a digest so a rebuilt tag cannot change what runs. Bump deliberately.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# ── Shared: pnpm, and every dependency fetched once from the lockfile ─────────────────────────
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN corepack install
RUN --mount=type=cache,id=hustle-pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

# ── API and its world loop: TypeScript run by tsx, production dependencies only ─────────────
# A lockfile and manifests cut down to the API and the workspace packages it imports, so the
# install below can't pull in the web app's dependencies.
FROM fetch AS api-prune
COPY . .
RUN pnpm dlx turbo@2.11.10 prune @hustle/api --docker

FROM fetch AS api-deps
COPY --from=api-prune /app/out/json/ ./
COPY --from=api-prune /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
# Packages come from the store fetched above; --prefer-offline only reaches the registry for
# metadata the pruned lockfile asks about.
# pnpm fetch leaves every package of the full lockfile in node_modules/.pnpm; start clean so only
# the API's production dependencies remain.
RUN --mount=type=cache,id=hustle-pnpm-store,target=/pnpm/store \
    rm -rf node_modules && pnpm install --frozen-lockfile --prefer-offline --prod

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deps --chown=root:root /app ./
COPY --chown=root:root packages ./packages
COPY --chown=root:root apps/api ./apps/api
# Prebuilt contract wasm: on testnet the engine reads it only to price setup steps still pending.
COPY --chown=root:root contracts/out ./contracts/out
WORKDIR /app/apps/api
ENV PATH=/app/apps/api/node_modules/.bin:$PATH \
    PORT=4300
# Files stay root-owned and read-only to the process; it writes only to the database (and /tmp).
USER node
EXPOSE 4300
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4300/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Migrations are idempotent, so they run on every start before the server takes traffic.
CMD ["sh", "-c", "tsx ../../packages/db/src/migrate.ts && exec tsx src/server.ts"]

# ── Web: Next.js standalone build ────────────────────────────────────────────────────────────
FROM fetch AS web-build
COPY . .
RUN --mount=type=cache,id=hustle-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@hustle/web..." --filter hustle
# The API's address from the web container; Next fixes its rewrites at build time. Not secret.
ARG HUSTLE_API_ORIGIN=http://api:4300
ENV HUSTLE_API_ORIGIN=$HUSTLE_API_ORIGIN
RUN pnpm exec turbo run build --filter=@hustle/web

FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3300
WORKDIR /app
COPY --from=web-build --chown=root:root /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=root:root /app/apps/web/.next/static ./apps/web/.next/static
# Static files, including Pyodide and the re-run frame (copied in at build by scripts/copy-pyodide.mjs).
COPY --from=web-build --chown=root:root /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3300
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3300/how-it-works').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]

# ── Sandbox: runs agents' Python (Pyodide) in its own container with no network ───────────────
FROM fetch AS sandbox-deps
COPY . .
RUN --mount=type=cache,id=hustle-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@hustle/sandbox..." --filter hustle
# Fetch the Python wheels now, while the build has a network: the running container has none.
RUN pnpm --filter @hustle/sandbox wheels

FROM ${NODE_IMAGE} AS sandbox
ENV NODE_ENV=production
WORKDIR /app
COPY --from=sandbox-deps --chown=root:root /app ./
# The socket's directory: a named volume shared with the API is created from this, owned by node.
RUN mkdir -p /run/sandbox && chown node:node /run/sandbox
WORKDIR /app/packages/sandbox
ENV PATH=/app/node_modules/.bin:$PATH
USER node
CMD ["tsx", "src/serve.ts"]
