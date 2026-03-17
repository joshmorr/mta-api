#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${1:-${BASE_URL:-http://localhost:3000}}"

PASS_COUNT=0
FAIL_COUNT=0

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but was not found in PATH" >&2
  exit 1
fi

pass() {
  local name="$1"
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS  %s\n' "$name"
}

fail() {
  local name="$1"
  local message="$2"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL  %s\n' "$name"
  printf '      %s\n' "$message"
}

run_check() {
  local name="$1"
  local path="$2"
  local allowed_statuses="$3"
  local body_pattern="$4"

  local tmp_file
  tmp_file=$(mktemp)

  local status
  if ! status=$(curl -sS -L -o "$tmp_file" -w '%{http_code}' "$BASE_URL$path"); then
    rm -f "$tmp_file"
    fail "$name" "Request failed for $path"
    return
  fi

  local body
  body=$(cat "$tmp_file")
  rm -f "$tmp_file"

  case " $allowed_statuses " in
    *" $status "*) ;;
    *)
      fail "$name" "Expected HTTP $allowed_statuses, got $status for $path. Body: $body"
      return
      ;;
  esac

  if [[ -n "$body_pattern" ]] && ! grep -Eq "$body_pattern" <<<"$body"; then
    fail "$name" "Response body did not match $body_pattern for $path. Body: $body"
    return
  fi

  pass "$name"
}

printf 'Running smoke tests against %s\n' "$BASE_URL"

run_check 'health' '/health' '200' '"status"[[:space:]]*:[[:space:]]*"ok"'
run_check 'stops search' '/stops?q=times+sq' '200' '"stops"[[:space:]]*:'
run_check 'stops feed filter' '/stops?feed_id=lirr&limit=5' '200' '"stops"[[:space:]]*:'
run_check 'routes list' '/routes?type=subway' '200' '"routes"[[:space:]]*:'
run_check 'stop detail' '/feeds/subway/stops/127' '200' '"stop_id"[[:space:]]*:[[:space:]]*"127"'
run_check 'invalid feed validation' '/stops?feed_id=bad' '400' '"code"[[:space:]]*:[[:space:]]*"INVALID_PARAM"'
run_check 'missing stop 404' '/feeds/subway/stops/DOES_NOT_EXIST' '404' '"code"[[:space:]]*:[[:space:]]*"NOT_FOUND"'
run_check 'arrivals' '/feeds/subway/stops/127N/arrivals?limit=3&routes=1,2' '200 503' '"(arrivals|error)"[[:space:]]*:'
run_check 'vehicles' '/feeds/subway/routes/L/vehicles' '200 503' '"(vehicles|error)"[[:space:]]*:'
run_check 'alerts' '/alerts?routes=A,C,E' '200 503' '"(alerts|error)"[[:space:]]*:'

printf '\nSummary: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi