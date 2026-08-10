# Tier 2 — static-data tests. Require a seeded DB (run `bun run seed`, or point
# DB_PATH at a pre-seeded fixture). Assertions lean on shape + stable GTFS IDs
# rather than volatile values (schedules roll forward, so exact times aren't
# asserted). Cache-Control is checked here specifically because it's the one
# thing a forgotten cacheHeaders.ts prefix silently drops, and in-process
# bun:test never sees real HTTP response headers.

# --- pair query returns the documented shape, with Cache-Control -------------
# Times Sq-42 St(127) -> 34 St-Penn Station(128), one stop down the 1 line.
# The 1 runs 24/7, so the default rolling window always has departures.
GET {{base}}/schedule?from=127&to=128&feed=subway&limit=5
HTTP 200
[Asserts]
header "Cache-Control" exists
jsonpath "$.feed_id" == "subway"
jsonpath "$.from_stop_id" == "127"
jsonpath "$.to_stop_id" == "128"
jsonpath "$.source" == "scheduled"
jsonpath "$.service_dates" isCollection
jsonpath "$.departures" isCollection
jsonpath "$.departures" count <= 5
jsonpath "$.departures[0].trip_id" isString
jsonpath "$.departures[0].departure_timestamp" isInteger
jsonpath "$.departures[0].destination.stop_id" == "128"
jsonpath "$.departures[0].destination.duration_seconds" > 0
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
GET {{base}}/schedule?from=44&to=237&feed=lirr&limit=3
HTTP 200
[Asserts]
jsonpath "$.from_stop_name" contains "Deer Park"
jsonpath "$.to_stop_name" contains "Penn"
jsonpath "$.departures[0].destination.stop_name" contains "Penn"
jsonpath "$.departures[0].destination.duration_seconds" > 0

# --- date pins to a single service date, not the default 3-day window -------
GET {{base}}/schedule?from=127&to=128&feed=subway&date=20260101&limit=1
HTTP 200
[Asserts]
jsonpath "$.service_dates" count == 1
jsonpath "$.service_dates[0]" == "20260101"

# --- invalid param -> 400 INVALID_PARAM envelope ------------------------------
GET {{base}}/schedule?from=127&to=128&feed=subway&date=not-a-date
HTTP 400
[Asserts]
jsonpath "$.code" == "INVALID_PARAM"
jsonpath "$.error" contains "date"

# --- a missing destination is a 400 that names /arrivals, not a board --------
GET {{base}}/schedule?from=127&feed=subway
HTTP 400
[Asserts]
jsonpath "$.code" == "INVALID_PARAM"
jsonpath "$.error" contains "/arrivals"

# --- unknown origin/destination -> 404 NOT_FOUND envelope ---------------------
GET {{base}}/schedule?from=44&to=zzzzz&feed=lirr
HTTP 404
[Asserts]
jsonpath "$.code" == "NOT_FOUND"
jsonpath "$.error" contains "Destination stop"

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
