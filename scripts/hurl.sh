#!/usr/bin/env sh
# Boot the API, wait for readiness, run Hurl suites, then tear down.
#
# Usage:
#   scripts/hurl.sh [hurl-file ...]
#
# Defaults to the Tier-1 contract suite against the dev DB (./data/mta.db).
# The server no longer auto-seeds — that DB must already be seeded (run
# `bun run seed` once) or the server exits immediately on an empty DB. Point
# DB_PATH at any pre-seeded fixture:
#   DB_PATH=/path/to/seeded.db scripts/hurl.sh test/e2e/contract.hurl test/e2e/stops.hurl
#
# Set BASE_URL to run the suites against an already-running server (e.g. a
# deploy) instead of booting one locally. DB_PATH/PORT are ignored in that mode:
#   BASE_URL=https://my-deploy.example scripts/hurl.sh test/e2e/contract.hurl
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/test/e2e/local.env"
PORT="${PORT:-3000}"
DB_PATH="${DB_PATH:-./data/mta.db}"
BASE_URL="${BASE_URL:-}"

# Default suite if none passed.
if [ "$#" -eq 0 ]; then
  set -- "$ROOT/test/e2e/contract.hurl"
fi

if ! command -v hurl >/dev/null 2>&1; then
  echo "error: hurl is not installed. See https://hurl.dev/docs/installation.html" >&2
  exit 127
fi

# Remote target: skip the local server boot and point {{base}} at BASE_URL.
# Otherwise boot the server ourselves and tear it down on exit.
if [ -n "$BASE_URL" ]; then
  HURL_VARS="--variable base=$BASE_URL"
  echo "[hurl] targeting remote $BASE_URL (skipping local server boot)"
else
  HURL_VARS="--variables-file $ENV_FILE"
  echo "[hurl] starting server (DB_PATH=$DB_PATH, PORT=$PORT)"
  DB_PATH="$DB_PATH" PORT="$PORT" bun run "$ROOT/src/index.ts" &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
fi

# $HURL_VARS is unquoted on purpose so it splits into its two args.
echo "[hurl] waiting for readiness"
hurl --retry 240 --retry-interval 1000 \
  $HURL_VARS \
  "$ROOT/test/e2e/_wait_ready.hurl" >/dev/null

echo "[hurl] running suites: $*"
hurl --test $HURL_VARS "$@"
