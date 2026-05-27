#!/bin/zsh
# Start Global News Monitor locally with Cloudflare tunnel
set -e

PROJECT_DIR="/Users/pratikbaswana/Downloads/Global-News-Monitorzip"
API_DIST="$PROJECT_DIR/artifacts/api-server/dist/index.mjs"
PROXY_SCRIPT="$PROJECT_DIR/proxy.py"
LOG_DIR="$PROJECT_DIR/.local/logs"
mkdir -p "$LOG_DIR"

echo "Starting Global News Monitor local stack..."

# Load env
export $(grep -v '^#' "$PROJECT_DIR/.env" | xargs)

# Start API server
if lsof -i :3000 > /dev/null 2>&1; then
  echo "API server already running on port 3000"
else
  echo "Starting API server on port 3000..."
  nohup /opt/homebrew/bin/node "$API_DIST" > "$LOG_DIR/api-server.log" 2>&1 &
  sleep 3
fi

# Start proxy server
if lsof -i :8080 > /dev/null 2>&1; then
  echo "Proxy server already running on port 8080"
else
  echo "Starting proxy server on port 8080..."
  nohup /usr/bin/python3 "$PROXY_SCRIPT" > "$LOG_DIR/proxy.log" 2>&1 &
  sleep 1
fi

# Start Cloudflare quick tunnel
TUNNEL_LOG="$LOG_DIR/tunnel.log"
echo "Starting Cloudflare tunnel..."
nohup /opt/homebrew/bin/cloudflared tunnel --url http://localhost:8080 > "$TUNNEL_LOG" 2>&1 &
sleep 5

URL=$(grep -o 'https://[^ ]*\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)
if [ -n "$URL" ]; then
  echo ""
  echo "============================================"
  echo "Your app is live at: $URL"
  echo "============================================"
else
  echo "Tunnel starting... check $TUNNEL_LOG for URL"
fi

echo ""
echo "Logs: $LOG_DIR"
echo "Stop all: pkill -f 'index.mjs|proxy.py|cloudflared tunnel'"
