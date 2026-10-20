#!/usr/bin/env bash
# Builds the server image, starts a container and runs the conformance suite against it
# (docs/sync-plan.md, раздел 6, Э2). Run from anywhere: `npm run sync:conformance:docker`.
#
# Exit codes: the exit code of the suite; 3 when Docker is not available (the check is then
# "unavailable", not "passed"); 4 when the container does not come up.
#
# Tests that need the clock or the data directory of a server (cleanup, 30 days, 24 hours,
# restarts, "the server is blind") start their own server in the test process even here: a
# container's clock cannot be moved. They cover the server of this repository, not the container.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "UNAVAILABLE: Docker is not installed or its daemon is not running." >&2
  exit 3
fi

image="amby-sync-server:conformance"
name="amby-sync-conformance-$$"
port="${AMBY_SYNC_PORT:-18080}"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker build -f server/Dockerfile -t "$image" .

# The same two test settings as a server started by the suite itself (Target::in_process).
docker run -d --name "$name" -p "127.0.0.1:${port}:8080" \
  -e AMBY_SYNC_MAX_JSON_BYTES=2097152 \
  -e AMBY_SYNC_SSE_KEEPALIVE_SECS=1 \
  "$image" >/dev/null

up=0
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/v1/info" || true)"
  if [ "$code" != "000" ] && [ -n "$code" ]; then up=1; break; fi
  sleep 1
done
if [ "$up" != "1" ]; then
  echo "The container did not answer on port ${port}:" >&2
  docker logs "$name" >&2 || true
  exit 4
fi

AMBY_SYNC_URL="http://127.0.0.1:${port}" \
AMBY_SYNC_ADMIN_CMD="docker exec ${name} amby-sync-server" \
  cargo test --manifest-path Cargo.toml -p amby-sync-conformance --no-fail-fast "$@"
