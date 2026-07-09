#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# GNM EC2 Restore Script
# Restores a complete snapshot onto a fresh Ubuntu 22.04+ instance.
#
# Usage:
#   1. Copy snapshot tarball to the new instance:
#      scp -i ~/.ssh/key.pem gnm-snapshot-*.tar.gz ubuntu@<NEW_IP>:/tmp/
#   2. Copy this script:
#      scp -i ~/.ssh/key.pem deploy/aws/restore-ec2.sh ubuntu@<NEW_IP>:/tmp/
#   3. Run on the new instance:
#      ssh -i ~/.ssh/key.pem ubuntu@<NEW_IP> "bash /tmp/restore-ec2.sh /tmp/gnm-snapshot-*.tar.gz"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SNAPSHOT_TAR="${1:-}"
if [ -z "${SNAPSHOT_TAR}" ]; then
  echo "Usage: bash restore-ec2.sh <snapshot-tarball>"
  echo "Example: bash restore-ec2.sh /tmp/gnm-snapshot-20250709-091800.tar.gz"
  exit 1
fi

if [ ! -f "${SNAPSHOT_TAR}" ]; then
  echo "ERROR: Snapshot tarball not found: ${SNAPSHOT_TAR}"
  exit 1
fi

RESTORE_DIR="/tmp/gnm-restore"
echo "=== GNM EC2 Restore ==="
echo "Snapshot: ${SNAPSHOT_TAR}"

# ── 1. Install Docker if not present ─────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "[1/12] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
  sudo systemctl enable docker
  sudo systemctl start docker
else
  echo "[1/12] Docker already installed: $(docker --version)"
fi

# ── 2. Extract snapshot ──────────────────────────────────────────────────────
echo "[2/12] Extracting snapshot..."
rm -rf "${RESTORE_DIR}"
mkdir -p "${RESTORE_DIR}"
tar xzf "${SNAPSHOT_TAR}" -C /tmp
# Find the extracted directory
EXTRACTED_DIR=$(find /tmp -maxdepth 1 -type d -name "gnm-snapshot-*" | sort | tail -1)
if [ -z "${EXTRACTED_DIR}" ]; then
  echo "ERROR: Could not find extracted snapshot directory"
  exit 1
fi
echo "  Extracted to: ${EXTRACTED_DIR}"

# ── 3. Clone repo + checkout correct branch ──────────────────────────────────
echo "[3/12] Cloning repo..."
if [ -d /home/ubuntu/intel ]; then
  echo "  /home/ubuntu/intel already exists, using existing"
else
  git clone https://github.com/pratikbaswana-boop/Global-News-Monitor.git /home/ubuntu/intel
fi
cd /home/ubuntu/intel
BRANCH=$(cat "${EXTRACTED_DIR}/git-branch.txt" 2>/dev/null || echo "main")
git fetch origin
git checkout "${BRANCH}" 2>/dev/null || true
git pull origin "${BRANCH}" 2>/dev/null || true
echo "  Branch: ${BRANCH}, Commit: $(git rev-parse --short HEAD)"

# ── 4. Copy config files ─────────────────────────────────────────────────────
echo "[4/12] Copying config..."
cp "${EXTRACTED_DIR}/config/.env.production" /home/ubuntu/intel/.env.production
cp "${EXTRACTED_DIR}/config/docker-compose.prod.yml" /home/ubuntu/intel/docker-compose.prod.yml 2>/dev/null || true
cp "${EXTRACTED_DIR}/config/Caddyfile" /home/ubuntu/intel/deploy/Caddyfile 2>/dev/null || true

# ── 5. Pull base images ──────────────────────────────────────────────────────
echo "[5/12] Pulling base Docker images..."
docker pull postgres:16
docker pull neo4j:5
docker pull caddy:2-alpine
docker pull chromadb/chroma:latest

# ── 6. Load custom images ────────────────────────────────────────────────────
echo "[6/12] Loading custom Docker images..."
docker load -i "${EXTRACTED_DIR}/images/api-server.tar"
docker load -i "${EXTRACTED_DIR}/images/frontend.tar"
docker load -i "${EXTRACTED_DIR}/images/migrate.tar" 2>/dev/null || true

# ── 7. Start Postgres ────────────────────────────────────────────────────────
echo "[7/12] Starting Postgres..."
docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres
echo "  Waiting for Postgres to be healthy..."
sleep 10
# Wait until healthy
for i in $(seq 1 30); do
  if docker exec gnm_postgres_prod pg_isready -U gnm 2>/dev/null; then
    echo "  Postgres is ready"
    break
  fi
  echo "  Waiting... ($i/30)"
  sleep 2
done

# ── 8. Restore Postgres ──────────────────────────────────────────────────────
echo "[8/12] Restoring Postgres database..."
docker exec -i gnm_postgres_prod pg_restore -U gnm -d gnm --clean --if-exists --no-owner \
  < "${EXTRACTED_DIR}/postgres-gnm.dump" 2>&1 || true
echo "  Postgres restored"

# ── 9. Start Neo4j + restore ─────────────────────────────────────────────────
echo "[9/12] Starting Neo4j + restoring..."
docker compose -f docker-compose.prod.yml --env-file .env.production up -d neo4j
sleep 15
if [ -d "${EXTRACTED_DIR}/neo4j-dumps" ]; then
  docker cp "${EXTRACTED_DIR}/neo4j-dumps/." gnm_neo4j_prod:/data/dumps/
  docker exec gnm_neo4j_prod neo4j-admin database load neo4j --from-path=/data/dumps --overwrite-destination 2>&1 || true
  docker exec gnm_neo4j_prod neo4j-admin database load system --from-path=/data/dumps --overwrite-destination 2>&1 || true
  echo "  Neo4j restored"
else
  echo "  No Neo4j dumps found, skipping"
fi

# ── 10. Restore ChromaDB ─────────────────────────────────────────────────────
echo "[10/12] Restoring ChromaDB..."
docker compose -f docker-compose.prod.yml --env-file .env.production up -d chromadb
sleep 5
if [ -f "${EXTRACTED_DIR}/chroma-data/chroma-data.tar.gz" ]; then
  docker run --rm -v intel_chroma_data:/data -v "${EXTRACTED_DIR}/chroma-data:/backup" \
    alpine tar xzf /backup/chroma-data.tar.gz -C /data
  docker restart gnm_chromadb_prod
  echo "  ChromaDB restored"
else
  echo "  No ChromaDB data found, skipping"
fi

# ── 11. Restore Caddy certs ──────────────────────────────────────────────────
echo "[11/12] Restoring Caddy TLS certs..."
if [ -f "${EXTRACTED_DIR}/caddy-data/caddy-data.tar.gz" ]; then
  docker run --rm -v intel_caddy_data:/data -v "${EXTRACTED_DIR}/caddy-data:/backup" \
    alpine tar xzf /backup/caddy-data.tar.gz -C /data
fi
if [ -f "${EXTRACTED_DIR}/caddy-config/caddy-config.tar.gz" ]; then
  docker run --rm -v intel_caddy_config:/data -v "${EXTRACTED_DIR}/caddy-config:/backup" \
    alpine tar xzf /backup/caddy-config.tar.gz -C /data
fi
echo "  Caddy certs restored"

# ── 12. Start everything ─────────────────────────────────────────────────────
echo "[12/12] Starting all services..."
docker compose -f docker-compose.prod.yml --env-file .env.production up -d

echo ""
echo "=== Restore complete ==="
echo "Services:"
docker compose -f docker-compose.prod.yml ps
echo ""
echo "Check logs:"
echo "  docker compose -f docker-compose.prod.yml logs -f api-server"
echo ""
echo "NOTE: If the domain DNS hasn't been pointed to this instance yet,"
echo "      Caddy will serve HTTP only until DNS propagates."
echo ""
echo "NOTE: The Kite access token in .env.production may have expired."
echo "      Update KITE_ACCESS_TOKEN if market data isn't flowing."
