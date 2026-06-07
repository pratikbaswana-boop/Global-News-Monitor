#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# RUN THIS ON THE EXISTING INSTANCE (65.0.93.40) to snapshot DBs to S3.
# The new instance's bootstrap will pull these and restore.
#
# Impact on existing prod:
#   - postgres: NONE  (pg_dump is online, no locks)
#   - neo4j:    BRIEF (~30-60s) — neo4j has to be stopped to dump cleanly
#   - chromadb: NONE  (we tar the persistent dir while running; if there's a
#                      write during tar it'll be picked up on next snapshot)
#
# If you want zero impact on neo4j, replace the neo4j section with an online
# backup (Neo4j Enterprise only) or skip neo4j (the graph rebuilds from
# postgres on first scheduler cycle in ~5-15 min).
#
# Usage:
#   ssh -i ~/gnm-key.pem ubuntu@65.0.93.40
#   bash existing-snapshot-to-s3.sh s3://your-bucket/gnm-snapshots/2026-05-27/
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

S3_URI="${1:-}"
if [ -z "$S3_URI" ]; then
  echo "usage: $0 s3://bucket/prefix/"
  exit 1
fi

cd /opt/gnm

WORK=/tmp/gnm-snap-$(date -u +%Y%m%dT%H%M%S)
mkdir -p "$WORK"

echo "[1/3] Postgres dump (online, no impact)…"
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres \
  pg_dump -U gnm -d gnm --format=custom --no-owner --no-acl > "$WORK/postgres.dump"
echo "    $(du -h "$WORK/postgres.dump" | cut -f1)"

echo "[2/3] Neo4j dump (requires brief stop, ~30-60s of downtime)…"
docker compose -f docker-compose.prod.yml --env-file .env.production stop neo4j
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  -v gnm_neo4j_data:/data \
  -v "$WORK":/dump \
  neo4j:5 \
  neo4j-admin database dump --to-path=/dump neo4j
mv "$WORK"/neo4j.dump "$WORK/neo4j.dump"
docker compose -f docker-compose.prod.yml --env-file .env.production start neo4j
echo "    $(du -h "$WORK/neo4j.dump" | cut -f1)"

echo "[3/3] Chroma archive (online — may include in-flight writes)…"
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T chromadb \
  tar czf - -C /chroma/chroma . > "$WORK/chroma.tar.gz"
echo "    $(du -h "$WORK/chroma.tar.gz" | cut -f1)"

echo "Uploading to $S3_URI"
# Requires the existing instance's IAM role / awscli credentials to have s3:PutObject
aws s3 cp "$WORK/postgres.dump"  "${S3_URI%/}/postgres.dump"
aws s3 cp "$WORK/neo4j.dump"     "${S3_URI%/}/neo4j.dump"
aws s3 cp "$WORK/chroma.tar.gz"  "${S3_URI%/}/chroma.tar.gz"

# Don't leave dumps on disk (they can be large)
rm -rf "$WORK"

echo "Done. Set SNAPSHOT_S3_URI=${S3_URI} in the new instance's bootstrap script."
