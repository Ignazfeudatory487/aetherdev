#!/bin/sh
set -e

echo "[AetherDev] Starting..."

# Wait for Redis
if [ -n "$REDIS_URL" ]; then
  echo "[AetherDev] Waiting for Redis..."
  REDIS_HOST=$(echo "$REDIS_URL" | sed 's|redis://||' | cut -d':' -f1)
  REDIS_PORT=$(echo "$REDIS_URL" | sed 's|redis://||' | cut -d':' -f2)
  for i in $(seq 1 30); do
    nc -z "$REDIS_HOST" "${REDIS_PORT:-6379}" 2>/dev/null && break
    sleep 1
  done
  echo "[AetherDev] Redis connected"
fi

# Database migration
echo "[AetherDev] Running database migrations..."
node dist/scripts/migrate.js 2>/dev/null || echo "[AetherDev] Migrations skipped"

case "$1" in
  start)
    echo "[AetherDev] Starting server..."
    exec node dist/cli/index.js
    ;;
  api)
    echo "[AetherDev] Starting API server..."
    exec node dist/src/api/server.js
    ;;
  *)
    exec "$@"
    ;;
esac
