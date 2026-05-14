# One-shot image for running DB migrations against the prod Postgres.
# Usage:
#   docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate

FROM node:24-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY lib/db/package.json     lib/db/
COPY lib/db/drizzle.config.ts lib/db/
COPY lib/db/tsconfig.json    lib/db/
COPY lib/db/src              lib/db/src

ENV CI=true
RUN pnpm install --filter "@workspace/db..." --frozen-lockfile --config.minimum-release-age=0

WORKDIR /repo/lib/db
CMD ["pnpm", "run", "push"]
