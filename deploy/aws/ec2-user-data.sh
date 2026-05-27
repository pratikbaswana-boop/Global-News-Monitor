#!/bin/bash
# AWS EC2 User Data — bootstraps the full GNM stack on first launch
# Designed for Ubuntu 22.04+ on t3.large or larger
set -euo pipefail
exec > >(tee /var/log/gnm-bootstrap.log) 2>&1

echo "=== GNM AWS Bootstrap === $(date)"

# ── 1. System deps ──────────────────────────────────────────────────────────
apt-get update -y
apt-get install -y --no-install-recommends git curl ca-certificates \
  apt-transport-https gnupg lsb-release jq unzip

# ── 2. Docker ─────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker ubuntu
fi

# Ensure Docker Compose plugin is available
docker compose version || {
  apt-get install -y docker-compose-plugin
}

# ── 3. Clone repo ───────────────────────────────────────────────────────────
REPO_URL="${GNM_REPO_URL:-https://github.com/pratikbaswana/Global-News-Monitor.git}"
REPO_DIR="/opt/gnm"
mkdir -p "$REPO_DIR"

if [ -d "$REPO_DIR/.git" ]; then
  cd "$REPO_DIR"
  git pull --ff-only
else
  git clone "$REPO_URL" "$REPO_DIR"
  cd "$REPO_DIR"
fi

# ── 4. Write env file from AWS Secrets Manager or env vars ────────────────────
ENV_FILE="$REPO_DIR/.env.production"

# If GNM_SECRET_ARN is set, pull secrets from AWS Secrets Manager
if [ -n "${GNM_SECRET_ARN:-}" ]; then
  echo "Fetching secrets from $GNM_SECRET_ARN ..."
  aws secretsmanager get-secret-value \
    --secret-id "$GNM_SECRET_ARN" \
    --query SecretString --output text > /tmp/gnm-secrets.json

  jq -r 'to_entries | .[] | "\(.key)=\(.value)"' /tmp/gnm-secrets.json > "$ENV_FILE"
  rm -f /tmp/gnm-secrets.json
else
  # Otherwise generate a starter env file (user must have passed vars via EC2 user-data)
  cat > "$ENV_FILE" <<EOF
# ── Required ─────────────────────────────────────────────
DOMAIN=${GNM_DOMAIN:-$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)}
ADMIN_SECRET=${GNM_ADMIN_SECRET:-$(openssl rand -hex 32)}
POSTGRES_PASSWORD=${GNM_POSTGRES_PASSWORD:-$(openssl rand -hex 16)}
NEO4J_PASSWORD=${GNM_NEO4J_PASSWORD:-$(openssl rand -hex 16)}

# ── LLM ──────────────────────────────────────────────────
OPENAI_API_KEY=${OPENAI_API_KEY:-}
LLM_PROVIDER=${LLM_PROVIDER:-openai}
LLM_MODEL_CHAT=${LLM_MODEL_CHAT:-gpt-4o-mini}
LLM_MODEL_EMBED=${LLM_MODEL_EMBED:-text-embedding-3-small}

# ── News (optional but recommended) ──────────────────────
NEWSAPI_KEY=${NEWSAPI_KEY:-}
GNEWS_KEY=${GNEWS_KEY:-}
GUARDIAN_KEY=${GUARDIAN_KEY:-}
ACLED_API_KEY=${ACLED_API_KEY:-}
ACLED_EMAIL=${ACLED_EMAIL:-}

# ── Push (optional) ──────────────────────────────────────
VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY:-}
VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY:-}
NOTIFICATION_WEBHOOK_URL=${NOTIFICATION_WEBHOOK_URL:-}

# ── Defaults ─────────────────────────────────────────────
POSTGRES_USER=gnm
POSTGRES_DB=gnm
NEO4J_USER=neo4j
LOG_LEVEL=info
NEWS_FETCH_INTERVAL_HOURS=1
EOF
fi

# Ensure DOMAIN is set (fallback to public IP if no domain)
if ! grep -q "^DOMAIN=" "$ENV_FILE"; then
  PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
  echo "DOMAIN=$PUBLIC_IP" >> "$ENV_FILE"
fi

# ── 5. Build & start ────────────────────────────────────────────────────────
echo "Building Docker images..."
docker compose -f "$REPO_DIR/docker-compose.prod.yml" --env-file "$ENV_FILE" build

echo "Starting services..."
docker compose -f "$REPO_DIR/docker-compose.prod.yml" --env-file "$ENV_FILE" up -d

# ── 6. Run DB migrations ────────────────────────────────────────────────────
echo "Running DB migrations..."
sleep 15 # let postgres finish init
docker compose -f "$REPO_DIR/docker-compose.prod.yml" --env-file "$ENV_FILE" --profile migrate run --rm migrate || true

# ── 7. Health check ───────────────────────────────────────────────────────────
echo "Health check..."
for i in {1..30}; do
  if curl -sf http://localhost:80/api/news/summary >/dev/null 2>&1; then
    echo "=== GNM is live on $(curl -s http://169.254.169.254/latest/meta-data/public-ipv4) === $(date)"
    exit 0
  fi
  echo "Waiting for API... ($i/30)"
  sleep 5
done

echo "WARNING: API did not become healthy within 150s. Check logs:"
echo "  docker compose -f $REPO_DIR/docker-compose.prod.yml logs api-server"
exit 1
