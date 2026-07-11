# Readiness probe. Run with `--retry` so the runner blocks until the server is
# actually accepting connections and responding. /health is a liveness probe
# that returns 200 ("ok") as soon as the process is up (the DB is expected to
# already be seeded — the server exits on boot otherwise).
GET {{base}}/health
HTTP 200
[Asserts]
jsonpath "$.status" == "ok"
