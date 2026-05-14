## ── Build stage ─────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /repo

# Workspace manifests
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY artifacts/global-news/package.json    artifacts/global-news/
COPY artifacts/global-news/tsconfig.json   artifacts/global-news/
COPY artifacts/global-news/vite.config.ts  artifacts/global-news/
COPY artifacts/global-news/components.json artifacts/global-news/
COPY artifacts/global-news/index.html      artifacts/global-news/
COPY lib/api-client-react/package.json     lib/api-client-react/
COPY lib/api-zod/package.json              lib/api-zod/
COPY lib/db/package.json                   lib/db/
COPY lib/integrations-openai-ai-server/package.json lib/integrations-openai-ai-server/
COPY lib/api-spec/package.json             lib/api-spec/
COPY artifacts/api-server/package.json     artifacts/api-server/
COPY scripts/package.json                  scripts/

ENV CI=true
RUN pnpm install --filter "@workspace/global-news..." --frozen-lockfile --config.minimum-release-age=0

# Sources
COPY lib lib
COPY artifacts/global-news/src    artifacts/global-news/src
COPY artifacts/global-news/public artifacts/global-news/public
COPY attached_assets              attached_assets

# Build args drive vite config
ARG VITE_PORT=80
ARG VITE_BASE_PATH=/
ENV PORT=$VITE_PORT BASE_PATH=$VITE_BASE_PATH NODE_ENV=production

RUN pnpm --filter @workspace/global-news run build


## ── Runtime stage: nginx serving the static dist ────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Replace default nginx config with one that handles SPA routing
RUN rm /etc/nginx/conf.d/default.conf
COPY artifacts/global-news/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /repo/artifacts/global-news/dist/public /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
