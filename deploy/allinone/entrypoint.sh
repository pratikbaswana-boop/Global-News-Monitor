#!/usr/bin/env bash
# Initialize persistent state on first boot, then exec supervisord.
# Idempotent — safe to re-run after a restart.

set -euo pipefail
shopt -s nullglob

log() { echo "[entrypoint] $*"; }

# ── 0. Mandatory env ────────────────────────────────────────────────────────
: "${DATA_DIR:?must be set}"
: "${PGUSER:?must be set}"
: "${PGDATABASE:?must be set}"
: "${PGDATA:?must be set}"
: "${NEO4J_DATA:?must be set}"
: "${CHROMA_PATH:?must be set}"

# Generated/derived secrets
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-}"

# Persist any auto-generated secrets so they survive container restarts
SECRETS_FILE="${DATA_DIR}/.secrets.env"

# ── 1. Create data layout ───────────────────────────────────────────────────
mkdir -p "${DATA_DIR}" "${PGDATA}" "${NEO4J_DATA}" "${CHROMA_PATH}"

# Auto-generate any missing secrets ONCE and persist them
if [[ -f "${SECRETS_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${SECRETS_FILE}"
fi

gen_pw() {
    # 32 chars, alnum, SIGPIPE-safe (no tr | head pipe)
    head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32 || true
}

if [[ -z "${POSTGRES_PASSWORD}" ]]; then
    POSTGRES_PASSWORD="$(gen_pw)"
fi
if [[ -z "${NEO4J_PASSWORD}" ]]; then
    NEO4J_PASSWORD="$(gen_pw)"
fi

# Persist
{
    echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"
    echo "NEO4J_PASSWORD=${NEO4J_PASSWORD}"
} > "${SECRETS_FILE}"
chmod 600 "${SECRETS_FILE}"

# Export for the api-server (supervisord inherits)
export POSTGRES_PASSWORD NEO4J_PASSWORD
export DATABASE_URL="postgres://${PGUSER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${PGDATABASE}"
export NEO4J_URI="${NEO4J_URI:-bolt://127.0.0.1:7687}"
export NEO4J_USER="${NEO4J_USER:-neo4j}"

# Legacy alias: any code path that still reads AI_INTEGRATIONS_OPENAI_API_KEY
# gets the same OPENAI_API_KEY value.
if [[ -n "${OPENAI_API_KEY:-}" && -z "${AI_INTEGRATIONS_OPENAI_API_KEY:-}" ]]; then
    export AI_INTEGRATIONS_OPENAI_API_KEY="${OPENAI_API_KEY}"
fi

# ── 2. Initialise Postgres data dir on first boot ───────────────────────────
chown -R postgres:postgres "${PGDATA}"
if [[ ! -s "${PGDATA}/PG_VERSION" ]]; then
    log "Initialising Postgres data dir at ${PGDATA}"
    su - postgres -c "/usr/lib/postgresql/16/bin/initdb -D '${PGDATA}' --auth-host=scram-sha-256 --auth-local=trust --username=postgres"

    # Inject our tuning into the freshly-created postgresql.conf
    if [[ -f /etc/postgresql/16/main/conf.d/tune.conf ]]; then
        cat /etc/postgresql/16/main/conf.d/tune.conf >> "${PGDATA}/postgresql.conf"
    fi

    # Allow local password auth for the app user
    {
        echo "host all all 127.0.0.1/32 scram-sha-256"
        echo "host all all ::1/128      scram-sha-256"
    } >> "${PGDATA}/pg_hba.conf"

    # Boot a one-shot postgres to create the app role + db (uses the conf inside PGDATA)
    log "Bootstrapping role '${PGUSER}' and DB '${PGDATABASE}'"
    su - postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D '${PGDATA}' -l /tmp/pg-bootstrap.log start"
    until su - postgres -c "/usr/lib/postgresql/16/bin/pg_isready -h 127.0.0.1 -p 5432" >/dev/null 2>&1; do sleep 1; done
    su - postgres -c "psql -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE ${PGUSER} WITH LOGIN SUPERUSER PASSWORD '${POSTGRES_PASSWORD}';
CREATE DATABASE ${PGDATABASE} OWNER ${PGUSER};
SQL"
    su - postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D '${PGDATA}' stop -m fast"
fi

# ── 3. Initialise Neo4j data dir + password on first boot ───────────────────
mkdir -p "${NEO4J_DATA}/data" "${NEO4J_DATA}/logs" "${NEO4J_DATA}/run" "${NEO4J_DATA}/import" "${NEO4J_DATA}/plugins"
chown -R neo4j:neo4j "${NEO4J_DATA}"

# Symlink Neo4j's default dirs to the persistent volume so packaged config works
rm -rf /var/lib/neo4j/data /var/lib/neo4j/logs /var/lib/neo4j/import /var/lib/neo4j/plugins /var/lib/neo4j/run
ln -sf "${NEO4J_DATA}/data"    /var/lib/neo4j/data
ln -sf "${NEO4J_DATA}/logs"    /var/lib/neo4j/logs
ln -sf "${NEO4J_DATA}/import"  /var/lib/neo4j/import
ln -sf "${NEO4J_DATA}/plugins" /var/lib/neo4j/plugins
ln -sf "${NEO4J_DATA}/run"     /var/lib/neo4j/run

# Set Neo4j initial password on first boot (the db itself is created on first start)
if [[ ! -f "${NEO4J_DATA}/.password-set" ]]; then
    log "Setting Neo4j initial password"
    su - neo4j -s /bin/bash -c "/usr/bin/neo4j-admin dbms set-initial-password '${NEO4J_PASSWORD}'" || true
    touch "${NEO4J_DATA}/.password-set"
fi
export NEO4J_PASSWORD

# ── 4. Start Postgres briefly to run migrations before supervisord ─────────
chown -R postgres:postgres "${PGDATA}"
su - postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D '${PGDATA}' -l /tmp/pg-migrate.log start"
until su - postgres -c "/usr/lib/postgresql/16/bin/pg_isready -h 127.0.0.1 -p 5432" >/dev/null 2>&1; do sleep 1; done

log "Running drizzle migrations"
(cd /app/migrate/lib/db && DATABASE_URL="${DATABASE_URL}" /app/migrate/node_modules/.bin/drizzle-kit push --config ./drizzle.config.ts) || log "Migrations exited non-zero (ok on schema-no-change)"

su - postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D '${PGDATA}' stop -m fast"

# ── 5. Ensure runtime dirs nginx + supervisord need ─────────────────────────
mkdir -p /var/log/nginx /var/lib/nginx /run/nginx
chown -R www-data:www-data /var/log/nginx /var/lib/nginx

# ── 6. Hand off ─────────────────────────────────────────────────────────────
log "Boot complete — handing off to supervisord"
exec "$@"
