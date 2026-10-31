#!/usr/bin/env bash
set -Eeuo pipefail

PORT="${PORT:-3000}"
export PORT
export NODE_URL="${NODE_URL:-http://127.0.0.1:${PORT}/api/analyze}"
export PHARMA_BIND="${PHARMA_BIND:-127.0.0.1}"

export RELAY_TOKEN="${RELAY_TOKEN:-${PHARMA_TOKEN:-}}"
export PHARMA_TOKEN="${PHARMA_TOKEN:-${RELAY_TOKEN:-}}"
export INTERNAL_RELAY_TOKEN="${INTERNAL_RELAY_TOKEN:-${PHARMA_NODE_TOKEN:-}}"
export PHARMA_NODE_TOKEN="${PHARMA_NODE_TOKEN:-${INTERNAL_RELAY_TOKEN:-}}"

node /app/server.js &
node_pid=$!

(
  cd /app/serveur_c
  exec ./serveur
) &
relay_pid=$!

stop_children() {
  trap - TERM INT
  kill "$node_pid" "$relay_pid" 2>/dev/null || true
  wait "$node_pid" 2>/dev/null || true
  wait "$relay_pid" 2>/dev/null || true
}

trap 'stop_children; exit 143' TERM
trap 'stop_children; exit 130' INT

set +e
wait -n -p exited_pid "$node_pid" "$relay_pid"
status=$?
set -e

if [[ "$exited_pid" == "$node_pid" ]]; then
  kill "$relay_pid" 2>/dev/null || true
else
  kill "$node_pid" 2>/dev/null || true
fi
wait "$node_pid" 2>/dev/null || true
wait "$relay_pid" 2>/dev/null || true

echo "A service process exited (status ${status}); stopping the container." >&2
exit "$status"
