#!/usr/bin/env sh
# Boot the API, wait for readiness, run Hurl suites, then tear down.
#
# Usage:
#   scripts/hurl.sh [hurl-file ...]
#
# Defaults to the Tier-1 contract suite against the dev DB (./data/mta.db).
# That DB is reused if already seeded (fast); if empty it auto-seeds once on
# startup (~2-3 min) and the readiness probe waits it out. Use :memory: for a
# clean seed every run, or point DB_PATH at any pre-seeded fixture:
#   DB_PATH=:memory: scripts/hurl.sh hurl/contract.hurl hurl/stops.hurl
#
# Set BASE_URL to run the suites against an already-running server (e.g. a
# deploy) instead of booting one locally. DB_PATH/PORT are ignored in that mode:
#   BASE_URL=https://my-deploy.example scripts/hurl.sh hurl/contract.hurl
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/hurl/local.env"
PORT="${PORT:-3000}"
DB_PATH="${DB_PATH:-./data/mta.db}"
BASE_URL="${BASE_URL:-}"

# Default suite if none passed.
if [ "$#" -eq 0 ]; then
  set -- "$ROOT/hurl/contract.hurl"
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

# Generous window: a cold seed downloads + imports all feeds (~2-3 min). When
# the DB is already seeded (or the target is a live deploy) this returns on the
# first try. $HURL_VARS is unquoted on purpose so it splits into its two args.
echo "[hurl] waiting for readiness (seeding gate must lift)"
hurl --retry 240 --retry-interval 1000 \
  $HURL_VARS \
  "$ROOT/hurl/_wait_ready.hurl" >/dev/null

echo "[hurl] running suites: $*"
hurl --test $HURL_VARS "$@"
