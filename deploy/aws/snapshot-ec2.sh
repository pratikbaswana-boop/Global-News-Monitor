#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# GNM EC2 Snapshot Script
# Creates a complete backup of the EC2 instance: DB dumps, Docker volumes,
# config files, and Docker images. Produces a single tarball that can be
# used to restore on a fresh instance.
#
# Usage:
#   ssh -i ~/.ssh/gnm-v2-key.pem ubuntu@<IP> "bash -s" < deploy/aws/snapshot-ec2.sh
#
# Or copy to the server and run:
#   scp -i ~/.ssh/gnm-v2-key.pem deploy/aws/snapshot-ec2.sh ubuntu@<IP>:/tmp/
#   ssh -i ~/.ssh/gnm-v2-key.pem ubuntu@<IP> "bash /tmp/snapshot-ec2.sh"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/tmp/gnm-snapshot-${STAMP}"
TARBALL="/tmp/gnm-snapshot-${STAMP}.tar.gz"

echo "=== GNM EC2 Snapshot — ${STAMP} ==="
mkdir -p "${BACKUP_DIR}"

# ── 1. Config files ──────────────────────────────────────────────────────────
echo "[1/7] Copying config files..."
mkdir -p "${BACKUP_DIR}/config"
cp /home/ubuntu/intel/.env.production "${BACKUP_DIR}/config/" 2>/dev/null || true
cp /home/ubuntu/intel/docker-compose.prod.yml "${BACKUP_DIR}/config/" 2>/dev/null || true
cp /home/ubuntu/intel/deploy/Caddyfile "${BACKUP_DIR}/config/" 2>/dev/null || true
cp -r /home/ubuntu/intel/deploy/aws "${BACKUP_DIR}/config/aws-deploy" 2>/dev/null || true
cp /home/ubuntu/intel/deploy/aws/ec2-user-data.sh "${BACKUP_DIR}/config/" 2>/dev/null || true

# Git info
cd /home/ubuntu/intel
git rev-parse HEAD > "${BACKUP_DIR}/config/git-commit.txt" 2>/dev/null || true
git branch --show-current > "${BACKUP_DIR}/config/git-branch.txt" 2>/dev/null || true
git remote -v > "${BACKUP_DIR}/config/git-remote.txt" 2>/dev/null || true

# ── 2. Postgres dump ─────────────────────────────────────────────────────────
echo "[2/7] Dumping Postgres..."
docker exec gnm_postgres_prod pg_dump -U gnm -d gnm -F c -b -v \
  > "${BACKUP_DIR}/postgres-gnm.dump" 2>/dev/null
PG_SIZE=$(du -sh "${BACKUP_DIR}/postgres-gnm.dump" | cut -f1)
echo "  Postgres dump: ${PG_SIZE}"

# ── 3. Neo4j dump ────────────────────────────────────────────────────────────
echo "[3/7] Dumping Neo4j..."
docker exec gnm_neo4j_prod neo4j-admin database dump neo4j --to-path=/data/dumps 2>/dev/null || true
docker exec gnm_neo4j_prod neo4j-admin database dump system --to-path=/data/dumps 2>/dev/null || true
docker cp gnm_neo4j_prod:/data/dumps "${BACKUP_DIR}/neo4j-dumps" 2>/dev/null || true
NEO_SIZE=$(du -sh "${BACKUP_DIR}/neo4j-dumps" 2>/dev/null | cut -f1 || echo "empty")
echo "  Neo4j dump: ${NEO_SIZE}"

# ── 4. ChromaDB data ─────────────────────────────────────────────────────────
echo "[4/7] Copying ChromaDB data..."
docker stop gnm_chromadb_prod 2>/dev/null || true
docker run --rm -v intel_chroma_data:/data -v "${BACKUP_DIR}/chroma-data:/backup" \
  alpine tar czf /backup/chroma-data.tar.gz -C /data . 2>/dev/null || true
docker start gnm_chromadb_prod 2>/dev/null || true
CHROMA_SIZE=$(du -sh "${BACKUP_DIR}/chroma-data" 2>/dev/null | cut -f1 || echo "empty")
echo "  ChromaDB: ${CHROMA_SIZE}"

# ── 5. Caddy data (TLS certs + config) ───────────────────────────────────────
echo "[5/7] Copying Caddy TLS certs + config..."
docker run --rm -v intel_caddy_data:/data -v "${BACKUP_DIR}/caddy-data:/backup" \
  alpine tar czf /backup/caddy-data.tar.gz -C /data . 2>/dev/null || true
docker run --rm -v intel_caddy_config:/data -v "${BACKUP_DIR}/caddy-config:/backup" \
  alpine tar czf /backup/caddy-config.tar.gz -C /data . 2>/dev/null || true

# ── 6. Docker images ─────────────────────────────────────────────────────────
echo "[6/7] Saving Docker images..."
mkdir -p "${BACKUP_DIR}/images"
# Save custom-built images (not base images like postgres, neo4j, caddy, chromadb)
docker save gnm/api-server:latest -o "${BACKUP_DIR}/images/api-server.tar" 2>/dev/null || true
docker save gnm/frontend:latest -o "${BACKUP_DIR}/images/frontend.tar" 2>/dev/null || true
docker save gnm/migrate:latest -o "${BACKUP_DIR}/images/migrate.tar" 2>/dev/null || true
IMG_SIZE=$(du -sh "${BACKUP_DIR}/images" | cut -f1)
echo "  Images: ${IMG_SIZE}"

# ── 7. System info ───────────────────────────────────────────────────────────
echo "[7/7] Capturing system info..."
{
  echo "=== OS ==="
  cat /etc/os-release
  echo "=== Kernel ==="
  uname -a
  echo "=== Docker ==="
  docker version
  echo "=== Disk ==="
  df -h
  echo "=== Memory ==="
  free -h
  echo "=== CPU ==="
  nproc
  echo "=== Docker volumes ==="
  docker volume ls
  echo "=== Docker containers ==="
  docker ps -a
  echo "=== Docker images ==="
  docker images
  echo "=== Crontab ==="
  crontab -l 2>/dev/null || echo "no crontab"
  echo "=== Systemd services ==="
  systemctl list-unit-files --state=enabled 2>/dev/null | head -30
} > "${BACKUP_DIR}/system-info.txt" 2>&1

# ── Create manifest ──────────────────────────────────────────────────────────
cat > "${BACKUP_DIR}/MANIFEST.md" << EOF
# GNM EC2 Snapshot — ${STAMP}

## Contents
- config/          — .env.production, docker-compose.prod.yml, Caddyfile, deploy scripts
- postgres-gnm.dump — Postgres custom-format dump (restore with pg_restore)
- neo4j-dumps/     — Neo4j database dumps
- chroma-data/     — ChromaDB vector store data
- caddy-data/      — Caddy TLS certificates + ACME data
- caddy-config/    — Caddy autosave config
- images/          — Docker images (api-server, frontend, migrate)
- system-info.txt  — OS, Docker, disk, memory info
- git-commit.txt   — Current git commit hash
- git-branch.txt   — Current git branch

## Restore on a new instance
1. Install Docker: curl -fsSL https://get.docker.com | sh
2. Clone repo: git clone https://github.com/pratikbaswana-boop/Global-News-Monitor.git intel && cd intel
3. Checkout branch: git checkout \$(cat git-branch.txt)
4. Copy config: cp config/.env.production .env.production
5. Pull base images: docker pull postgres:16 neo4j:5 caddy:2-alpine chromadb/chroma:latest
6. Load custom images: docker load -i images/api-server.tar && docker load -i images/frontend.tar && docker load -i images/migrate.tar
7. Start Postgres: docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres
8. Restore Postgres: docker exec -i gnm_postgres_prod pg_restore -U gnm -d gnm --clean --if-exists < postgres-gnm.dump
9. Restore Neo4j: docker cp neo4j-dumps/. gnm_neo4j_prod:/data/dumps/ && docker exec gnm_neo4j_prod neo4j-admin database load neo4j --from-path=/data/dumps
10. Restore ChromaDB: docker run --rm -v intel_chroma_data:/data -v \$(pwd)/chroma-data:/backup alpine tar xzf /backup/chroma-data.tar.gz -C /data
11. Restore Caddy certs: docker run --rm -v intel_caddy_data:/data -v \$(pwd)/caddy-data:/backup alpine tar xzf /backup/caddy-data.tar.gz -C /data
12. Start everything: docker compose -f docker-compose.prod.yml --env-file .env.production up -d
EOF

# ── Create tarball ───────────────────────────────────────────────────────────
echo "Creating tarball..."
tar czf "${TARBALL}" -C /tmp "gnm-snapshot-${STAMP}"
TOTAL_SIZE=$(du -sh "${TARBALL}" | cut -f1)
echo ""
echo "=== Snapshot complete ==="
echo "Tarball: ${TARBALL}"
echo "Size: ${TOTAL_SIZE}"
echo ""
echo "Download with:"
echo "  scp -i ~/.ssh/gnm-v2-key.pem ubuntu@<IP>:${TARBALL} ./gnm-snapshot-${STAMP}.tar.gz"
