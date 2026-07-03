# Readiness probe. Run with `--retry` so the runner blocks until the server is
# actually serving data. /health is a readiness probe: it returns 503 while the
# background seed of all feeds is still running and flips to 200 ("ok") only
# once the instance can serve real routes. A 200 here means seeding has finished.
GET {{base}}/health
HTTP 200
[Asserts]
jsonpath "$.status" == "ok"
