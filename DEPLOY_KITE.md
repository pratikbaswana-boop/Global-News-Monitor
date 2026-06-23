# Kite Connect Broker Integration — EC2 Deployment Guide

## Prerequisites

1. **Zerodha Kite Connect App**
   - Sign up at https://kite.trade/
   - Create an app (₹500/month for live data + historical)
   - Note down your `API Key` and `API Secret`

2. **Static IP Whitelisting (Required for orders)**
   - Kite requires a static IP for order placement
   - If using AWS EC2: assign an **Elastic IP** to your instance
   - In Zerodha dashboard → Apps → Your App → Whitelist your Elastic IP
   - Your current EC2 IP: `43.205.207.167`

## 1. One-time EC2 Setup

### 1a. Assign Elastic IP (if not already)

```bash
# If your instance does not have an Elastic IP, create one and associate:
aws ec2 allocate-address --region ap-south-1
# Note the AllocationId, then associate:
aws ec2 associate-address --instance-id i-0d4ba18fd6f8bf59f --allocation-id eipalloc-xxxxxxxx
```

### 1b. Update Security Group

Ensure your security group allows the Kite WebSocket port (443 outbound is sufficient — Kite endpoints are HTTPS/WSS).

```bash
# Verify outbound is open (default on AWS)
aws ec2 describe-security-groups --group-ids sg-xxxxxxxxx --region ap-south-1
```

## 2. Deploy with Kite Config

### Option A: Fresh deploy

```bash
# 1. Set env vars
export KITE_API_KEY="your_kite_api_key"
export KITE_API_SECRET="your_kite_api_secret"

# 2. Create env file
cp .env.production.example .env.production
# Edit and add:
#   KITE_API_KEY=your_key
#   KITE_API_SECRET=your_secret

# 3. Run deploy script
./deploy/aws/deploy-to-ec2.sh
```

### Option B: Update existing EC2 instance

```bash
# SSH into your EC2
ssh -i ~/.ssh/gnm-v2-key.pem ubuntu@43.205.207.167

# Update env file
cd /opt/gnm
echo "KITE_API_KEY=your_key" >> .env.production
echo "KITE_API_SECRET=your_secret" >> .env.production

# Rebuild and restart
docker compose -f docker-compose.prod.yml --env-file .env.production build api-server
docker compose -f docker-compose.prod.yml --env-file .env.production up -d api-server

# Run DB migrations (critical — new tables added)
docker compose -f docker-compose.prod.yml --env-file .env.production --profile migrate run --rm migrate

# Verify
watch -n 2 'docker compose -f docker-compose.prod.yml ps'
```

## 3. DB Migration (Critical)

The broker integration adds 6 new tables. Run this after deploying:

```bash
ssh -i ~/.ssh/gnm-v2-key.pem ubuntu@43.205.207.167
cd /opt/gnm
docker compose -f docker-compose.prod.yml --env-file .env.production --profile migrate run --rm migrate
```

## 4. Verify Installation

```bash
# 1. Check API server logs for Kite startup messages
docker compose -f docker-compose.prod.yml logs api-server | grep -i "kite\|broker\|token"

# 2. Check the broker login URL endpoint
curl http://43.205.207.167/api/broker/login-url
# Should return: { "loginUrl": "https://kite.zerodha.com/connect/login?api_key=...", "apiKey": "..." }

# 3. Check token refresh scheduler started
# In logs you should see: "token-refresh-scheduler: starting"
```

## 5. User Onboarding Flow

1. User visits your app, logs in with Firebase
2. User clicks "Connect Zerodha" → frontend calls `GET /api/broker/login-url`
3. User logs in on Kite, gets redirected to your callback
4. Your backend calls `POST /api/broker/callback` with `requestToken` + `userId`
5. Backend exchanges token, stores it, connects WebSocket
6. User configures trade preferences at `GET/POST /api/broker/trade-preferences`
7. User toggles `autoTradeEnabled` via `POST /api/broker/settings`

## 6. Architecture on EC2

```
Internet (HTTPS)
       │
    ┌──┴───┐
    │ Caddy│ ← port 80/443
    └──┬───┘
       │
  ┌────┴────┐
  │api-server │ :3000  ← Kite REST calls + WebSocket (outbound 443)
  └────┬────┘
       │
   ┌───┼───┐
   │   │   │
┌──┴┐ ┌┴─┐ ┌──┐
│pg │ │neo│ │ch│
└───┘ └──┘ └──┘
```

- **Kite REST API**: api-server → HTTPS → kite.zerodha.com
- **Kite WebSocket**: api-server → WSS → ws.kite.trade (for order postbacks)
- **Order placement**: Requires static IP whitelisted with Zerodha

## 7. Monitoring

```bash
# Live order status from DB
docker exec gnm_postgres_prod psql -U gnm -d gnm \
  -c "SELECT tradingsymbol, transaction_type, status, placed_at FROM broker_orders ORDER BY placed_at DESC LIMIT 5;"

# Active auto-trade users
docker exec gnm_postgres_prod psql -U gnm -d gnm \
  -c "SELECT user_id, auto_trade_enabled, broker_name FROM broker_accounts WHERE is_active = true;"

# Signal executions today
docker exec gnm_postgres_prod psql -U gnm -d gnm \
  -c "SELECT asset_symbol, direction, quantity, status, executed_at FROM signal_executions WHERE executed_at > CURRENT_DATE ORDER BY executed_at DESC LIMIT 5;"

# Check for token expiry warnings in logs
docker compose -f docker-compose.prod.yml logs api-server | grep -i "expired\|token-refresh"
```

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Orders rejected with "IP not whitelisted" | EC2 IP changed or not whitelisted | Assign Elastic IP, whitelist in Kite dashboard |
| "Kite API key not configured" | Env var missing | Add `KITE_API_KEY` and `KITE_API_SECRET` to `.env.production`, restart |
| Token refresh failing | `refreshToken` is null or `KITE_API_SECRET` wrong | Check env vars, user must re-auth if refresh token expired |
| Auto-trade not firing | Asset not enabled in trade preferences | User must enable asset via `POST /broker/trade-preferences` |
| WebSocket not receiving order updates | Network / Kite outage | Check `kite-websocket` logs, verify access token valid |

## 9. Cost

| Component | Monthly Cost |
|-----------|-------------|
| AWS EC2 t3.xlarge (4vCPU/16GB) | ~$35 |
| Elastic IP (attached) | Free |
| Kite Connect subscription | ₹500 (~$6) |
| **Total** | **~$41/month** |
