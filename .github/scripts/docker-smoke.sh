#!/usr/bin/env bash
set -euo pipefail
name="switchboard-smoke-${GITHUB_RUN_ID:-local}"
volume="$name-data"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true; }
trap cleanup EXIT
start() {
  docker run -d --name "$name" -v "$volume:/data" switchboard:smoke >/dev/null
  for attempt in {1..60}; do
    if docker exec "$name" wget -qO- http://127.0.0.1:8770/healthz >/dev/null 2>&1; then return; fi
    sleep 1
  done
  docker logs "$name"
  exit 1
}
start
docker exec "$name" sh -c 'test -s /data/switchboard.db && test "$(id -u)" = 0 && test "$(stat -c %U /data/switchboard.db)" = node'
docker exec "$name" sh -c 'echo persistent > /data/smoke-marker'
docker rm -f "$name" >/dev/null
start
docker exec "$name" sh -c 'test "$(cat /data/smoke-marker)" = persistent && test -s /data/switchboard.db'
