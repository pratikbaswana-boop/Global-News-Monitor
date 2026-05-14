# Production Deployment

Single-server Docker stack: API server, frontend (nginx), Postgres, Neo4j, ChromaDB, and Caddy as HTTPS reverse proxy.

## What you need

- A Linux server (Ubuntu 22.04+ recommended). Minimum: 2 vCPU / 4 GB RAM / 40 GB SSD. Recommended: 4 vCPU / 8 GB / 80 GB for a long-running graph + corpus.
- A domain name pointing at the server's public IP (A record). Required for HTTPS.
- Docker Engine 24+ and the Docker Compose plugin.
- API keys: at least OpenAI (or Anthropic). News API keys are optional but recommended.

## One-time server bootstrap

```bash
# 1. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Get the code onto the server
git clone <your-repo-url> intel && cd intel

# 3. Configure secrets
cp .env.production.example .env.production
$EDITOR .env.production            # set DOMAIN, API keys, strong DB passwords

# 4. Build images
docker compose -f docker-compose.prod.yml --env-file .env.production build

# 5. Start everything
docker compose -f docker-compose.prod.yml --env-file .env.production up -d

# 6. Run DB migrations (one time, and again whenever schema changes)
docker compose -f docker-compose.prod.yml --env-file .env.production --profile migrate run --rm migrate
```

Once DNS is pointed at the box, Caddy will auto-issue a Let's Encrypt cert on the first HTTPS request. Visit `https://yourdomain.com`.

## Day-to-day operations

| Action | Command |
|---|---|
| View logs | `docker compose -f docker-compose.prod.yml logs -f api-server` |
| Restart API only | `docker compose -f docker-compose.prod.yml restart api-server` |
| Update code | `git pull && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build` |
| Run migrations | `docker compose -f docker-compose.prod.yml --env-file .env.production --profile migrate run --rm migrate` |
| Backup Postgres | `docker exec gnm_postgres_prod pg_dump -U gnm gnm > backup-$(date +%F).sql` |
| Backup Neo4j | `docker exec gnm_neo4j_prod neo4j-admin database dump neo4j --to-path=/data && docker cp gnm_neo4j_prod:/data/neo4j.dump ./` |
| Tail all logs | `docker compose -f docker-compose.prod.yml logs -f` |
| Stop everything | `docker compose -f docker-compose.prod.yml down` (keeps volumes) |
| Wipe and reset | `docker compose -f docker-compose.prod.yml down -v` ⚠️ deletes all data |

## Architecture

```
                    Internet (HTTPS)
                          │
                       ┌──┴───┐
                       │ Caddy │ ← auto-HTTPS via Let's Encrypt
                       └──┬───┘
              ┌───────────┴───────────┐
              │                       │
         /api/* ↓                 / ↓
       ┌──────────────┐      ┌──────────┐
       │  api-server  │      │ frontend │ (nginx + built SPA)
       │   :3000      │      │   :80    │
       └──────┬───────┘      └──────────┘
              │
   ┌──────────┼──────────┐
   │          │          │
┌─────┐  ┌───────┐  ┌─────────┐
│ pg  │  │ neo4j │  │ chroma  │
└─────┘  └───────┘  └─────────┘
```

Only Caddy exposes ports to the host (80, 443). Everything else talks over the internal `gnm` bridge network.

## Resource tuning

For a 4 GB VPS, the defaults work. Adjust `NEO4J_server_memory_*` in `docker-compose.prod.yml` if you go below or above:

| VPS RAM | Neo4j heap | Neo4j pagecache |
|---|---|---|
| 2 GB | 256 MB / 512 MB | 256 MB |
| 4 GB | 512 MB / 1 GB | 512 MB *(default)* |
| 8 GB | 1 GB / 2 GB | 1 GB |
| 16 GB | 2 GB / 4 GB | 2 GB |

## Cost guidance at full cadence

GPT-4o-mini at default cadence (5-min market cycle, 21 calls/tick during NSE hours, plus ingestion + reasoning):

- Market cycles: ~$0.50 / market day
- Event extraction: ~$1–3 / day depending on news volume
- Reasoning pipeline (every 6h, 4 agents × ~25 stories): ~$2 / day
- **Total LLM cost: ~$3–6 / day**

VPS cost: Hetzner CX31 (4 vCPU / 8 GB) ≈ $9/mo. DigitalOcean equivalent: ~$24/mo.

## Health checks

```bash
# All containers up?
docker compose -f docker-compose.prod.yml ps

# API responding?
curl https://yourdomain.com/api/news/summary

# Pipeline producing AI predictions?
curl -s https://yourdomain.com/api/intelligence/market-signals?timeframe=intraday \
  | grep -o '"dominantNarrative":"[^"]*"' | head -1
# Should show: "BEARISH consensus (6h:..., 24h:..., 72h:...)" (real AI)
# If it shows asset-named keyword narrative → fallback templates, check logs.

# Latest market regime detected?
docker exec gnm_postgres_prod psql -U gnm -d gnm \
  -c "SELECT regime, detected_at FROM market_regimes ORDER BY detected_at DESC LIMIT 1;"
```

## Troubleshooting

**`role "gnm" does not exist`** — your `DATABASE_URL` or container init didn't pick up the env vars. Confirm `.env.production` has `POSTGRES_PASSWORD`/`POSTGRES_USER` and recreate: `docker compose ... up -d --force-recreate postgres api-server`.

**429 rate limit** — your OpenAI/Anthropic tier is too low. Either upgrade the tier (add credit) or switch to `gpt-4o-mini` in `.env.production`.

**Predictions still look templated after a few minutes** — check `docker compose logs api-server | grep -E "qualifyingCommunities|market-scheduler"`. Story emergence needs ~5 min after first article ingestion; market scheduler needs Yahoo Finance to be reachable.

**Caddy can't issue cert** — DNS must resolve to your server *before* Caddy attempts ACME. Verify with `dig +short yourdomain.com`. Check Caddy logs: `docker compose logs caddy`.

## Updating to a new build

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production build api-server frontend
docker compose -f docker-compose.prod.yml --env-file .env.production up -d api-server frontend
# Run migrations only if schema changed:
docker compose -f docker-compose.prod.yml --env-file .env.production --profile migrate run --rm migrate
```

The Caddy, Postgres, Neo4j, and ChromaDB containers don't need to restart on code changes — leaving them alone preserves data with zero downtime for the data layer.
