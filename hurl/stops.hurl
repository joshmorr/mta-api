# Tier 2 — static-data tests. Require a seeded DB (run `bun run seed`, or point
# DB_PATH at a pre-seeded fixture). Assertions lean on shape + stable GTFS IDs
# rather than volatile values. Demonstrates Hurl's capture-and-chain flow.

# --- list / search returns the documented shape ------------------------------
GET {{base}}/stops?feed=subway&limit=5
HTTP 200
[Asserts]
jsonpath "$.stops" isCollection
jsonpath "$.stops" count <= 5
jsonpath "$.stops[0].feed_id" == "subway"
jsonpath "$.stops[0].stop_id" isString
jsonpath "$.stops[0].stop_name" isString
[Captures]
first_id: jsonpath "$.stops[0].stop_id"

# --- chain: fetch the detail for the stop we just listed ---------------------
GET {{base}}/stops/{{first_id}}?feed=subway
HTTP 200
[Asserts]
jsonpath "$.stop_id" exists
jsonpath "$.feed_id" == "subway"
jsonpath "$.platforms" isCollection

# --- known stable ID: subway stop 127 is Times Sq-42 St ----------------------
GET {{base}}/stops/127?feed=subway
HTTP 200
[Asserts]
jsonpath "$.stop_name" contains "Times Sq"

# --- unknown stop with a valid feed -> 404 NOT_FOUND -------------------------
GET {{base}}/stops/zzzzz?feed=subway
HTTP 404
[Asserts]
jsonpath "$.code" == "NOT_FOUND"

# --- routes list is populated after seeding ----------------------------------
GET {{base}}/routes?feed=subway
HTTP 200
[Asserts]
jsonpath "$.routes" isCollection
jsonpath "$.routes" count > 0
jsonpath "$.routes[0].route_id" isString
