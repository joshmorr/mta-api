# Tier 1 — contract tests. Deterministic regardless of WHICH data is seeded:
# validation errors, 404s, the consistent { error, code } envelope, and
# middleware-added headers. Requires a server backed by a pre-seeded DB (the
# runner waits for readiness first).

# --- /health is always available and rate-limit exempt -----------------------
GET {{base}}/health
HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
header "X-RateLimit-Limit" not exists
jsonpath "$.status" == "ok"
jsonpath "$.totals.stop_count" isInteger
jsonpath "$.static_feeds.subway" exists

# --- validation: bad feed enum on a path param -> 400 INVALID_PARAM ----------
GET {{base}}/stops/127?feed=bogus
HTTP 400
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.code" == "INVALID_PARAM"
jsonpath "$.error" isString

# --- validation: missing required `feed` on arrivals -> 400 ------------------
GET {{base}}/arrivals?stop=127N
HTTP 400
[Asserts]
jsonpath "$.code" == "INVALID_PARAM"

# --- validation: non-numeric lat -> 400 with field-prefixed message ----------
GET {{base}}/stops?lat=abc&lon=-73.99
HTTP 400
[Asserts]
jsonpath "$.code" == "INVALID_PARAM"
jsonpath "$.error" contains "lat"

# --- validation: radius over the max -> 400 ----------------------------------
GET {{base}}/stops?lat=40.75&lon=-73.99&radius=99999
HTTP 400
[Asserts]
jsonpath "$.code" == "INVALID_PARAM"

# --- missing required `feed` on vehicles -> 400 ------------------------------
GET {{base}}/vehicles?route=A
HTTP 400
[Asserts]
jsonpath "$.code" == "INVALID_PARAM"

# --- unknown path -> 404 NOT_FOUND envelope ----------------------------------
GET {{base}}/does-not-exist
HTTP 404
[Asserts]
jsonpath "$.code" == "NOT_FOUND"

# --- rate-limit headers present on non-health routes -------------------------
GET {{base}}/routes
HTTP *
[Asserts]
header "X-RateLimit-Limit" == "100"
header "X-RateLimit-Remaining" exists
header "X-RateLimit-Reset" exists

# --- Server-Timing header from the timing() middleware -----------------------
GET {{base}}/routes
HTTP *
[Asserts]
header "Server-Timing" exists

# --- OpenAPI doc is served and well-formed -----------------------------------
GET {{base}}/doc
HTTP 200
[Asserts]
jsonpath "$.openapi" == "3.0.0"
jsonpath "$.info.title" == "MTA API"
jsonpath "$.paths" exists
