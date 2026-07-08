#!/bin/sh
set -e

# Fetch the prebuilt DB from object storage before the app opens it at import
# time. No-op (fast exit) when DB_URL is unset or the local cache is current.
# Exits non-zero only when there's no usable DB, which keeps the machine out of
# rotation rather than serving an empty DB. See scripts/fetch-db.ts.
if [ -n "$DB_URL" ]; then
  bun run scripts/fetch-db.ts
fi

exec bun run src/index.ts
