## ── Build stage ─────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build

# pnpm setup
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /repo

# Copy workspace manifests first for cached install
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY artifacts/api-server/package.json     artifacts/api-server/
COPY artifacts/api-server/build.mjs        artifacts/api-server/
COPY artifacts/api-server/tsconfig.json    artifacts/api-server/
COPY lib/api-zod/package.json              lib/api-zod/
COPY lib/api-client-react/package.json     lib/api-client-react/
COPY lib/api-spec/package.json             lib/api-spec/
COPY lib/db/package.json                   lib/db/
COPY lib/integrations-openai-ai-server/package.json lib/integrations-openai-ai-server/
COPY scripts/package.json                  scripts/

# Skip the minimum release age check during install (we are on a frozen lockfile)
ENV CI=true

RUN pnpm install --filter "@workspace/api-server..." --frozen-lockfile --config.minimum-release-age=0

# Copy sources
COPY lib  lib
COPY artifacts/api-server/src artifacts/api-server/src

# Build
RUN pnpm --filter @workspace/api-server run build


## ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

# Tini for clean signal handling, ca-certificates for outbound HTTPS
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Copy only the built bundle (esbuild output is self-contained)
COPY --from=build /repo/artifacts/api-server/dist /app/dist

# Drop privileges
USER node

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "/app/dist/index.mjs"]
