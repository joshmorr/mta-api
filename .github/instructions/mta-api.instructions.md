---
description: "Use when writing any code in this project — routes, services, DB queries, caching, GTFS parsing, or config. Covers stack conventions, architecture patterns, error shapes, and MTA feed integration rules."
applyTo: "src/**/*.ts"
---

# MTA API — Project Conventions

## Stack

- **Runtime**: Bun (not Node.js — use `bun:sqlite`, `Bun.serve`, etc. where applicable)
- **Framework**: Hono
- **Database**: `bun:sqlite` — no ORMs, no external DB
- **Protobuf**: `protobufjs` against `src/proto/gtfs-realtime.proto`
- **ZIP parsing**: `fflate` (lightweight, works in Bun)

## File Structure

```
src/
  index.ts          # Hono app entry, route registration, startup sequence
  config.ts         # Typed env var access — the ONLY place process.env is read
  routes/           # One file per endpoint group (stops, arrivals, routes, vehicles, alerts)
  services/         # staticFeed.ts, realtimeFeed.ts, alertsFeed.ts, feedRouter.ts
  db/               # client.ts (connection + init), schema.ts (CREATE TABLE statements)
  cache/            # rtCache.ts (in-memory Map with TTL + promise dedup)
  proto/            # gtfs-realtime.proto
  types/            # gtfs.ts, api.ts
scripts/
  seed.ts           # One-off script, not imported by the app
```

## Config

- All environment variables are read **only** in `src/config.ts` and exported as a typed object
- Never use `process.env` directly in route or service files
- Provide `.env.example` at the repo root

```typescript
// src/config.ts — pattern to follow
export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? './data/mta.db',
  rtCacheTtlMs: Number(process.env.RT_CACHE_TTL_MS ?? 20_000),
  subwaySyncIntervalMs: Number(process.env.SUBWAY_SYNC_INTERVAL_MS ?? 3_600_000),
  railSyncIntervalMs: Number(process.env.RAIL_SYNC_INTERVAL_MS ?? 86_400_000),
};
```

## Error Responses

Always use this shape — no exceptions:

```json
{ "error": "human-readable message", "code": "MACHINE_CODE" }
```

HTTP status conventions:
- `404` — stop or route not found
- `400` — invalid/missing query params
- `503` — MTA feed fetch failure (add `Retry-After: 30` header) or DB not yet seeded
- `500` — unexpected error (caught by global error handler)

## RT Cache (`src/cache/rtCache.ts`)

- `Map<string, { feedMessage: FeedMessage; fetchedAt: number }>`
- TTL: 20 seconds (from config)
- **Promise deduplication required**: use a `pending: Map<string, Promise<FeedMessage>>` to coalesce concurrent requests for the same feed path
- On fetch failure: serve stale cache if available, set `stale: true` and `feed_error` in response; return 503 only if no cache exists

## Database

- Schema lives in `src/db/schema.ts` as `CREATE TABLE IF NOT EXISTS` strings
- All migrations run on startup via `client.ts`
- `stop_times` has ~1.5M rows for subway — always batch inserts (500–1000 rows) inside a **single transaction**
- Never insert row-by-row for bulk data

```typescript
// correct pattern for bulk insert
const stmt = db.prepare(`INSERT OR REPLACE INTO stop_times (...) VALUES (...)`);
db.transaction(() => {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    for (const row of rows.slice(i, i + BATCH_SIZE)) stmt.run(row);
  }
})();
```

## Static Feed Sync

- Subway: `https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip` — refresh hourly
- LIRR: `https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip` — refresh every 24h
- Metro-North: `https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip` — refresh every 24h
- Parse CSV files with a simple line-split parser (no csv library dependency needed)
- Wrap each feed sync in a transaction for atomicity

## Realtime Feed Parsing

- Base URL: `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/`
- No API key required
- Decode with `protobufjs` using `src/proto/gtfs-realtime.proto`
- Route → feed path mapping lives in `src/services/feedRouter.ts` as a hard-coded `Record<string, string>`

## Arrivals Endpoint Logic

1. Parent station ID → resolve to platform stop IDs (e.g. `127` → `["127N", "127S"]`)
2. Look up serving routes via `stop_times → trips → routes`
3. Map each `route_id` to its RT feed path via `feedRouter`
4. Fetch or serve cached `FeedMessage` for each feed
5. Filter `trip_update` entities by `stop_time_update[].stop_id`
6. Collect `arrival.time` values > `Date.now() / 1000`, sort ascending, apply limit

## Startup Sequence

1. Run schema migrations (`CREATE TABLE IF NOT EXISTS`)
2. If DB is empty → seed synchronously before accepting requests
3. If DB is stale → trigger background refresh immediately
4. Register `setInterval` jobs for ongoing static feed refresh
5. Start Hono server

## Middleware (register in `index.ts`)

```typescript
app.use('*', logger());
app.use('*', timing());   // Adds Server-Timing header
app.onError((err, c) => c.json({ error: 'Internal server error', code: 'INTERNAL' }, 500));
app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));
```

## General Rules

- TypeScript strict mode — no `any`, use the types in `src/types/`
- No `console.log` in production paths — use a structured logger or `console.error` for errors
- Do not add authentication, rate limiting, or bus RT feeds (out of scope for v1)
