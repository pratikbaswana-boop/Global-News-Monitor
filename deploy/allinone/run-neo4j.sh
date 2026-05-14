#!/usr/bin/env bash
# Supervisord-friendly Neo4j runner.
# `neo4j-admin server console/start` forks a child JVM and the wrapper exits,
# which makes supervisord think it crashed. We start Neo4j (or pick up the
# already-running one) and tail the PID so we appear long-running.

set -u

NEO4J_HOME="${NEO4J_HOME:-/var/lib/neo4j}"
NEO4J_DATA="${NEO4J_DATA:-/data/neo4j}"
PID_FILE="${NEO4J_DATA}/run/neo4j.pid"

pid_alive() {
    local p="${1:-}"
    [ -n "$p" ] && kill -0 "$p" 2>/dev/null
}

# Drop stale PID file if the recorded process is dead
if [ -f "$PID_FILE" ]; then
    PREV_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if ! pid_alive "$PREV_PID"; then
        rm -f "$PID_FILE"
    fi
fi

# Start Neo4j only if not already running; tolerate "already running" exit
if [ -f "$PID_FILE" ] && pid_alive "$(cat "$PID_FILE" 2>/dev/null)"; then
    echo "neo4j: already running, attaching to existing process"
else
    /usr/bin/neo4j-admin server start || true
fi

# Wait up to 90s for PID file to be valid
for _ in $(seq 1 90); do
    if [ -f "$PID_FILE" ] && pid_alive "$(cat "$PID_FILE" 2>/dev/null)"; then
        break
    fi
    sleep 1
done

if [ ! -f "$PID_FILE" ]; then
    echo "neo4j: PID file never appeared at $PID_FILE" >&2
    exit 1
fi

PID="$(cat "$PID_FILE")"
if ! pid_alive "$PID"; then
    echo "neo4j: pid $PID from file is not alive" >&2
    exit 1
fi

echo "neo4j: tracking pid $PID"

# Block until that PID exits (supervisord stays happy meanwhile)
tail --pid="$PID" -f /dev/null

echo "neo4j: pid $PID exited"
exit 1
