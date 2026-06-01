# Readiness probe. Run with `--retry` so the runner blocks until the server is
# actually serving data. Important: /health returns 200 the moment the port
# binds, but the seeding gate (src/index.ts) makes every OTHER route return
# 503 SEEDING until the background seed of all feeds completes. So we probe a
# real route here — a 200 means the port is up AND seeding has finished.
GET {{base}}/routes?feed=subway
HTTP 200
