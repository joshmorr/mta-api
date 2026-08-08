# Tier 2 — static-data tests. Require a seeded DB (run `bun run seed`, or point
# DB_PATH at a pre-seeded fixture). Assertions lean on shape + stable GTFS IDs
# rather than volatile values (schedules roll forward, so exact times aren't
# asserted). Cache-Control is checked here specifically because it's the one
# thing a forgotten cacheHeaders.ts prefix silently drops, and in-process
# bun:test never sees real HTTP response headers.

# --- board query returns the documented shape, with Cache-Control ------------
GET {{base}}/schedule?stop=127&feed=subway&limit=5
HTTP 200
[Asserts]
header "Cache-Control" exists
jsonpath "$.feed_id" == "subway"
jsonpath "$.stop_id" == "127"
jsonpath "$.source" == "scheduled"
jsonpath "$.service_dates" isCollection
jsonpath "$.departures" isCollection
jsonpath "$.departures" count <= 5
jsonpath "$.departures[0].trip_id" isString
jsonpath "$.departures[0].departure_timestamp" isInteger
[Captures]
first_trip_id: jsonpath "$.departures[0].trip_id"

# --- chain: resolve the trip_id we just read off /schedule -------------------
GET {{base}}/trips/{{first_trip_id}}?feed=subway
HTTP 200
[Asserts]
header "Cache-Control" exists
jsonpath "$.resolved_trip_id" isString
jsonpath "$.matched_by" matches "^(exact|rt_trip_id_suffix)$"
jsonpath "$.stops" isCollection
jsonpath "$.stops" count > 0
jsonpath "$.origin.stop_id" isString
jsonpath "$.destination.stop_id" isString

# --- known stable A->B: LIRR Deer Park(44) -> Penn Station(237) --------------
GET {{base}}/schedule?stop=44&feed=lirr&to=237&limit=3
HTTP 200
[Asserts]
jsonpath "$.stop_name" contains "Deer Park"
jsonpath "$.to_stop_name" contains "Penn"
jsonpath "$.departures[0].destination.stop_name" contains "Penn"
jsonpath "$.departures[0].destination.duration_seconds" > 0

# --- date pins to a single service date, not the default 3-day window -------
GET {{base}}/schedule?stop=127&feed=subway&date=20260101&limit=1
HTTP 200
[Asserts]
jsonpath "$.service_dates" count == 1
jsonpath "$.service_dates[0]" == "20260101"

# --- invalid param -> 400 INVALID_PARAM envelope ------------------------------
GET {{base}}/schedule?stop=127&feed=subway&date=not-a-date
HTTP 400
[Asserts]
jsonpath "$.code" == "INVALID_PARAM"
jsonpath "$.error" contains "date"

# --- unknown trip -> 404 NOT_FOUND envelope -----------------------------------
GET {{base}}/trips/zzzzz-not-a-real-trip?feed=lirr
HTTP 404
[Asserts]
jsonpath "$.code" == "NOT_FOUND"

# --- MNR trip resolution is a 404 with a feed-specific reason, not a crash ---
GET {{base}}/trips/some-realtime-id?feed=mnr
HTTP 404
[Asserts]
jsonpath "$.code" == "NOT_FOUND"
jsonpath "$.error" contains "Metro-North"
