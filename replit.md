# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Project: Global News Intelligence Dashboard

**Preview path**: `/` (root artifact)  
**Auth**: GUID password gate — `e6cdcecb-f7f7-4e93-ad93-d10e1f45d4fc` stored in `sessionStorage["intel_access_granted"]`

### Features

- **Market Impact tab** — India-focused intraday stocks plus metals: NIFTY 50, SENSEX, Reliance Industries, TCS, HDFC Bank, Gold, Silver
  - Timeframes: `intraday` (4h resolution) and `next-session` (18h resolution)
  - Bull/Bear validation UI with signal breakdown
  - Track Record system: auto-snapshot + auto-resolve predictions via DB
- **Track Record tab** — accuracy donut, confidence breakdown, per-asset stats
- **Event Forecast tab** — AI-generated geopolitical predictions
- **Story Clusters tab** — article grouping by geopolitical theme
- **Relationship Map tab** — actor/entity network graph
- **PWA** — `manifest.json`, service worker at `/sw.js`, installable from browser
- **Push Notifications** — web-push (VAPID), bell toggle in Intelligence header
  - DB table: `push_subscriptions` (endpoint, p256dh, auth)
  - VAPID keys: read from `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` env vars, or auto-generate + persist to `.vapid-keys.json`
  - Routes: `GET /api/push/vapid-key`, `POST /api/push/subscribe`, `DELETE /api/push/unsubscribe`
  - Sends notification when top non-neutral asset's **direction changes** OR **>6 hours** since last notification for that asset (throttled via `_lastNotifiedAsset` in-memory map)
  - Notification body includes price impact estimate and deadline date
- **Prediction persistence** — geopolitical predictions stored in `prediction_snapshots` table
  - Throttled: one snapshot per template per 24h
  - `resolveAfter` computed from timeframe text (1-2 weeks → 10.5d, 1 month → 30d, 3 months → 90d, 6+ months → 180d)
  - Auto-expires past-deadline snapshots on each predictions fetch
  - `templateAccuracy` returned per prediction based on historical resolved rows
- **Deadline dates** — both Event Forecast and Market Impact cards show exact deadline date (amber "due: Jun 2")

### DB Tables

- `market_snapshots` — market direction prediction snapshots for track record
- `prediction_snapshots` — geopolitical event prediction snapshots with full reasoning, deadline, and accuracy tracking
- `push_subscriptions` — web push subscription registry
