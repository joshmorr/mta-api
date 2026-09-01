# Tier 3 — realtime smoke. Depends on the live MTA GTFS-RT feeds, so values are
# non-deterministic and upstream can be down. Assert loosely: a valid envelope
# either way, never exact arrival/vehicle data. Keep this OUT of required CI
# (run as an allowed-to-fail job).

# --- arrivals: 200 (data) or 503 (feed down), but always valid JSON ----------
GET {{base}}/arrivals?stop=127N&feed=subway
HTTP *
[Asserts]
status >= 200
status < 504
header "Content-Type" contains "application/json"

# --- vehicles: same contract ------------------------------------------------
GET {{base}}/vehicles?route=A&feed=subway
HTTP *
[Asserts]
status >= 200
status < 504
header "Content-Type" contains "application/json"

# --- arrivals route filter still validates request shape ---------------------
GET {{base}}/arrivals?stop=127N&feed=subway&routes=1,2,3&limit=3
HTTP *
[Asserts]
status >= 200
status < 504

# --- alerts: conditional GET round trip --------------------------------------
# The alerts feed publishes on the order of minutes, so two back-to-back polls
# land inside the same snapshot and the second must revalidate rather than
# re-send the (large) body. Skipped implicitly when upstream is down: the
# capture below only runs on a 200.
GET {{base}}/alerts
HTTP 200
[Asserts]
header "ETag" matches "^W/\".+\"$"
header "Cache-Control" contains "max-age=5"
[Captures]
alerts_etag: header "ETag"

# --- replaying that ETag yields a bodyless 304 -------------------------------
# Also guards the middleware ordering: `cacheHeaders` must still tag a 304, and
# the rate-limit headers must survive on it (contract.hurl asserts they exist on
# 200s; a 304 path that stripped them would be a silent regression).
GET {{base}}/alerts
If-None-Match: {{alerts_etag}}
HTTP 304
[Asserts]
header "ETag" == "{{alerts_etag}}"
header "Cache-Control" contains "max-age=5"
header "X-RateLimit-Limit" exists
header "X-RateLimit-Remaining" exists
bytes count == 0

# --- an ETag from a filtered view must not 304 the unfiltered one ------------
GET {{base}}/alerts?routes=A
If-None-Match: {{alerts_etag}}
HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
