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
