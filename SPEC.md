# MTA Transit API — Design Specification

**Stack:** Bun + Hono  
**Version:** 1.0  
**Last Updated:** 2026-03-10

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Project Structure](#project-structure)
4. [Data Sources](#data-sources)
5. [Database Design](#database-design)
6. [Caching Strategy](#caching-strategy)
7. [API Endpoints](#api-endpoints)
8. [Data Pipeline](#data-pipeline)
9. [Error Handling](#error-handling)
10. [Configuration](#configuration)
11. [Deployment](#deployment)
12. [Build Order](#build-order)

---

## Overview

A REST API that wraps the MTA's raw GTFS static and GTFS-RT (realtime) feeds into clean, queryable JSON endpoints. The API handles protobuf parsing, feed routing, ZIP extraction, caching, and stop lookups internally — clients receive plain JSON with no knowledge of the underlying MTA feed structure.

### Goals

- Sub-100ms response times for arrival queries via RT feed caching
- No external database — `bun:sqlite` for static data, in-memory Map for RT cache
- Single deployable binary via `bun build`
- No required API keys (subway, rail, and alerts feeds are open)

### Out of Scope (v1)

- Bus real-time (requires separate MTA Bus Time API key)
- Trip planning / routing
- Historical data storage
- Authentication / rate limiting per user

---

## Architecture

```
┌─────────────┐     JSON      ┌─────────────────────────────────────┐
│   Clients   │ ◄──────────── │           Hono Router               │
└─────────────┘               │  /stops  /arrivals  /alerts  /routes │
                              └──────────────┬──────────────────────┘
                                             │
                        ┌────────────────────┼─────────────────────┐
                        │                    │                      │
               ┌────────▼───────┐   ┌────────▼───────┐   ┌────────▼───────┐
               │  Static Layer  │   │  Realtime Layer │   │  Alerts Layer  │
               │  bun:sqlite    │   │  In-memory cache│   │  In-memory cache│
               └────────┬───────┘   └────────┬────────┘   └────────┬───────┘
                        │                    │                      │
               ┌────────▼───────┐   ┌────────▼────────┐   ┌────────▼───────┐
               │  MTA Static    │   │   MTA GTFS-RT   │   │  MTA Alerts    │
               │  ZIP feeds     │   │  Protobuf feeds │   │  Protobuf feed │
               │  (S3 / hourly) │   │  (~30s updates) │   │  (~30s updates)│
               └────────────────┘   └─────────────────┘   └────────────────┘
```

---

## Project Structure

```
mta-api/
├── src/
│   ├── index.ts                  # Hono app entry point, route registration
│   ├── routes/
│   │   ├── stops.ts              # GET /stops, GET /stops/:id
│   │   ├── arrivals.ts           # GET /stops/:id/arrivals
│   │   ├── routes.ts             # GET /routes, GET /routes/:id
│   │   ├── vehicles.ts           # GET /routes/:id/vehicles
│   │   └── alerts.ts             # GET /alerts
│   ├── services/
│   │   ├── staticFeed.ts         # Download, unzip, parse, seed static GTFS
│   │   ├── realtimeFeed.ts       # Fetch + parse GTFS-RT protobuf feeds
│   │   ├── alertsFeed.ts         # Fetch + parse service alerts feed
│   │   └── feedRouter.ts         # Maps route_id → RT feed URL
│   ├── db/
│   │   ├── client.ts             # bun:sqlite connection + init
│   │   └── schema.ts             # CREATE TABLE statements
│   ├── cache/
│   │   └── rtCache.ts            # In-memory RT feed cache with TTL
│   ├── proto/
│   │   └── gtfs-realtime.proto   # GTFS-RT proto definition file
│   └── types/
│       ├── gtfs.ts               # TypeScript types for GTFS structures
│       └── api.ts                # Request/response types for endpoints
├── scripts/
│   └── seed.ts                   # One-off script to load static GTFS into DB
├── bunfig.toml
├── package.json
└── tsconfig.json
```

---

## Data Sources

### Static GTFS Feeds

Downloaded as ZIP archives, extracted in memory, parsed as CSV. Loaded into `bun:sqlite` on startup and refreshed on a cron schedule.

| Feed | URL | Refresh |
|------|-----|---------|
| Subway (supplemented) | `https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip` | Hourly |
| LIRR | `https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip` | Daily |
| Metro-North | `https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip` | Daily |

> Use the **supplemented** subway feed (not the base feed) — it includes service changes for the next 7 days and refreshes hourly.

### Realtime GTFS-RT Feeds

Binary protobuf, fetched on demand and cached in memory.

**Base URL:** `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/`

| Lines | Path |
|-------|------|
| 1 2 3 4 5 6 GS | `nyct/gtfs` |
| A C E H FS | `nyct/gtfs-ace` |
| B D F M | `nyct/gtfs-bdfm` |
| G | `nyct/gtfs-g` |
| J Z | `nyct/gtfs-jz` |
| L | `nyct/gtfs-l` |
| N Q R W | `nyct/gtfs-nqrw` |
| Staten Island Railway | `nyct/gtfs-si` |
| LIRR | `lirr/gtfs-lirr` |
| Metro-North | `mnr/gtfs-mnr` |
| All Alerts | `camsys/all-alerts` |

---

## Database Design

Using `bun:sqlite` (built-in, zero dependencies). All static GTFS data lives here.

```sql
-- Core lookup tables loaded from static GTFS ZIPs

CREATE TABLE stops (
  stop_id       TEXT PRIMARY KEY,
  stop_name     TEXT NOT NULL,
  stop_lat      REAL,
  stop_lon      REAL,
  location_type INTEGER  -- 0 = stop/platform, 1 = parent station
);

CREATE TABLE routes (
  route_id         TEXT PRIMARY KEY,
  route_short_name TEXT,   -- e.g. "A", "1", "LIRR"
  route_long_name  TEXT,
  route_color      TEXT,
  route_type       INTEGER -- 1 = subway, 2 = rail
);

CREATE TABLE trips (
  trip_id      TEXT PRIMARY KEY,
  route_id     TEXT NOT NULL,
  service_id   TEXT,
  direction_id INTEGER,    -- 0 or 1
  shape_id     TEXT,
  FOREIGN KEY (route_id) REFERENCES routes(route_id)
);

CREATE TABLE stop_times (
  trip_id        TEXT NOT NULL,
  stop_id        TEXT NOT NULL,
  arrival_time   TEXT,     -- HH:MM:SS (may exceed 24:00:00 for overnight trips)
  departure_time TEXT,
  stop_sequence  INTEGER,
  PRIMARY KEY (trip_id, stop_id, stop_sequence),
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id),
  FOREIGN KEY (stop_id) REFERENCES stops(stop_id)
);

CREATE TABLE calendar (
  service_id TEXT PRIMARY KEY,
  monday     INTEGER, tuesday  INTEGER, wednesday INTEGER,
  thursday   INTEGER, friday   INTEGER, saturday  INTEGER, sunday INTEGER,
  start_date TEXT,
  end_date   TEXT
);

-- Indexes for common query patterns
CREATE INDEX idx_stop_times_stop_id ON stop_times(stop_id);
CREATE INDEX idx_stop_times_trip_id ON stop_times(trip_id);
CREATE INDEX idx_trips_route_id     ON trips(route_id);
CREATE INDEX idx_stops_name         ON stops(stop_name COLLATE NOCASE);
```

---

## Caching Strategy

### RT Feed Cache (`src/cache/rtCache.ts`)

A simple in-memory `Map` keyed by feed path. Each entry holds the parsed protobuf `FeedMessage` and a timestamp. Cache is considered stale after 20 seconds — within the MTA's ~30s update window while avoiding hammering the endpoint.

```typescript
interface CacheEntry {
  feedMessage: FeedMessage;
  fetchedAt: number;  // Date.now()
}

const TTL_MS = 20_000;
const cache = new Map<string, CacheEntry>();
```

**Promise deduplication:** multiple concurrent requests for the same stop should not trigger parallel fetches of the same feed. Use a pending-request map to coalesce them:

```typescript
const pending = new Map<string, Promise<FeedMessage>>();

async function getFeed(feedPath: string): Promise<FeedMessage> {
  const cached = cache.get(feedPath);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.feedMessage;

  if (pending.has(feedPath)) return pending.get(feedPath)!;

  const promise = fetchAndParse(feedPath).finally(() => pending.delete(feedPath));
  pending.set(feedPath, promise);
  return promise;
}
```

### Static Data Cache

No TTL cache needed — data is in SQLite. Background sync jobs handle periodic refresh by upserting new rows into the DB.

---

## API Endpoints

All responses are `application/json`. Errors follow a consistent shape:

```json
{ "error": "human-readable message", "code": "MACHINE_CODE" }
```

---

### `GET /stops`

Search or list stops.

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Name search (partial match, case-insensitive) |
| `lat` | number | Latitude for proximity search |
| `lon` | number | Longitude for proximity search |
| `radius` | number | Radius in meters (default: 400, max: 1600) |
| `limit` | number | Max results (default: 20, max: 50) |

**Response:**
```json
{
  "stops": [
    {
      "stop_id": "127",
      "stop_name": "Times Sq-42 St",
      "lat": 40.75529,
      "lon": -73.98726,
      "platforms": ["127N", "127S"]
    }
  ]
}
```

> `stop_id` is the parent station ID. `platforms` are the directional stop IDs used in arrival queries.

---

### `GET /stops/:stop_id`

Get a single stop by ID. Accepts both parent station ID and platform ID.

**Response:**
```json
{
  "stop_id": "127",
  "stop_name": "Times Sq-42 St",
  "lat": 40.75529,
  "lon": -73.98726,
  "platforms": [
    { "stop_id": "127N", "direction": "Uptown & The Bronx" },
    { "stop_id": "127S", "direction": "Downtown & Brooklyn" }
  ]
}
```

---

### `GET /stops/:stop_id/arrivals`

**The core endpoint.** Returns upcoming arrivals at a stop sourced from live RT feeds.

**Path param:** platform-level ID (e.g. `127N`) or parent station ID (returns both directions merged)

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | number | Max arrivals per direction (default: 5) |
| `routes` | string | Comma-separated route filter, e.g. `routes=1,2,3` |

**Response:**
```json
{
  "stop_id": "127N",
  "stop_name": "Times Sq-42 St",
  "direction": "Uptown",
  "generated_at": 1741622400,
  "stale": false,
  "arrivals": [
    {
      "route_id": "1",
      "trip_id": "123456_1..N01R",
      "arrival_time": 1741622460,
      "arrival_in_seconds": 60,
      "status": "IN_TRANSIT_TO"
    },
    {
      "route_id": "2",
      "trip_id": "123457_2..N01R",
      "arrival_time": 1741622520,
      "arrival_in_seconds": 120,
      "status": "INCOMING_AT"
    }
  ]
}
```

**Internal logic:**
1. If given a parent station ID, resolve to platform stop IDs (`127` → `["127N", "127S"]`)
2. Look up which routes serve this stop via `stop_times` → `trips` → `routes`
3. Determine which RT feed path each route maps to via `feedRouter`
4. Fetch or serve cached version of each required feed
5. Filter `trip_update` entities by `stop_id`, collect `arrival.time` values in the future
6. Sort ascending, apply limit, return

---

### `GET /routes`

List all routes.

**Query params:** `type` — filter by `subway`, `lirr`, or `mnr`

**Response:**
```json
{
  "routes": [
    {
      "route_id": "A",
      "name": "A",
      "long_name": "Eighth Avenue Local",
      "color": "#0039A6",
      "type": "subway"
    }
  ]
}
```

---

### `GET /routes/:route_id/vehicles`

Live vehicle positions for a route.

**Response:**
```json
{
  "route_id": "L",
  "generated_at": 1741622400,
  "vehicles": [
    {
      "trip_id": "...",
      "current_stop_id": "L06N",
      "status": "STOPPED_AT",
      "timestamp": 1741622390
    }
  ]
}
```

---

### `GET /alerts`

Active service alerts.

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `routes` | string | Comma-separated route filter |
| `stop_id` | string | Filter alerts affecting a specific stop |

**Response:**
```json
{
  "generated_at": 1741622400,
  "alerts": [
    {
      "id": "lmm:planned_work:12345",
      "routes_affected": ["A", "C"],
      "stops_affected": ["A27", "A28"],
      "header": "Weekend service change on A/C",
      "description": "Trains run via F line between Jay St and...",
      "active_periods": [
        { "start": 1741622400, "end": 1741708800 }
      ]
    }
  ]
}
```

---

### `GET /health`

Returns API status and last sync times for static feeds.

**Response:**
```json
{
  "status": "ok",
  "static_feeds": {
    "subway": { "last_synced": 1741622000, "stop_count": 496, "route_count": 26 },
    "lirr":   { "last_synced": 1741622000 },
    "mnr":    { "last_synced": 1741622000 }
  }
}
```

---

## Data Pipeline

### Startup Sequence

```
1. Initialize bun:sqlite, run schema migrations (CREATE TABLE IF NOT EXISTS)
2. Check if static data exists in DB
   a. Empty → download + parse all static feeds synchronously before accepting requests
   b. Stale (>1hr subway, >24hr LIRR/MNR) → trigger background refresh immediately
3. Register setInterval jobs for ongoing static feed refresh
4. Start Hono server on configured port
```

### Static Feed Sync (`src/services/staticFeed.ts`)

```typescript
async function syncSubwayFeed() {
  const zip = await fetch(SUBWAY_SUPPLEMENTED_URL).then(r => r.arrayBuffer());
  const files = unzip(zip);  // use fflate (lightweight, works in Bun)

  const stops     = parseCSV(files['stops.txt']);
  const routes    = parseCSV(files['routes.txt']);
  const trips     = parseCSV(files['trips.txt']);
  const stopTimes = parseCSV(files['stop_times.txt']);

  // Wrap in a transaction for atomicity — partial writes cause bad query results
  db.transaction(() => {
    upsertStops(stops);
    upsertRoutes(routes);
    upsertTrips(trips);
    upsertStopTimes(stopTimes);  // ~1.5M rows for subway — use batches of 500-1000
  })();
}
```

`stop_times.txt` for the subway has ~1.5M rows. Use `db.prepare(...).run(...)` in batches inside a single transaction — never row-by-row.

### RT Feed Parsing (`src/services/realtimeFeed.ts`)

Use `protobufjs` to decode the binary response against the GTFS-RT proto definition:

```typescript
import protobuf from 'protobufjs';

const root = await protobuf.load('src/proto/gtfs-realtime.proto');
const FeedMessage = root.lookupType('transit_realtime.FeedMessage');

async function fetchRT(feedPath: string): Promise<FeedMessage> {
  const url = `${MTA_RT_BASE}/${feedPath}`;
  const buffer = await fetch(url).then(r => r.arrayBuffer());
  return FeedMessage.decode(new Uint8Array(buffer)) as unknown as FeedMessage;
}
```

Download the proto file from: `https://gtfs.org/realtime/proto/gtfs-realtime.proto`

### Feed Router (`src/services/feedRouter.ts`)

Maps `route_id` → RT feed path. Hard-coded — this lookup table does not change:

```typescript
export const ROUTE_TO_FEED: Record<string, string> = {
  "1": "nyct/gtfs",      "2": "nyct/gtfs",      "3": "nyct/gtfs",
  "4": "nyct/gtfs",      "5": "nyct/gtfs",      "6": "nyct/gtfs",   "GS": "nyct/gtfs",
  "A": "nyct/gtfs-ace",  "C": "nyct/gtfs-ace",  "E": "nyct/gtfs-ace",
  "B": "nyct/gtfs-bdfm", "D": "nyct/gtfs-bdfm", "F": "nyct/gtfs-bdfm", "M": "nyct/gtfs-bdfm",
  "G": "nyct/gtfs-g",
  "J": "nyct/gtfs-jz",   "Z": "nyct/gtfs-jz",
  "L": "nyct/gtfs-l",
  "N": "nyct/gtfs-nqrw", "Q": "nyct/gtfs-nqrw", "R": "nyct/gtfs-nqrw", "W": "nyct/gtfs-nqrw",
  "SI":   "nyct/gtfs-si",
  "LIRR": "lirr/gtfs-lirr",
  "MNR":  "mnr/gtfs-mnr",
};
```

---

## Error Handling

### HTTP Status Codes

| Scenario | Status |
|----------|--------|
| Stop or route not found | 404 |
| Invalid / missing query params | 400 |
| MTA feed fetch failure | 503 with `Retry-After: 30` header |
| Static DB not yet seeded | 503 with descriptive message |
| Unexpected server error | 500 |

### Stale Cache Fallback

RT feed fetches can fail transiently. When a fetch fails, serve the most recent cached `FeedMessage` regardless of TTL, and signal this in the response:

```typescript
interface ArrivalResponse {
  arrivals: Arrival[];
  generated_at: number;
  stale?: boolean;       // true when serving expired cache due to feed error
  feed_error?: string;   // human-readable reason, only present when stale: true
}
```

If no cache exists and the fetch also fails, return 503.

### Global Middleware

```typescript
app.use('*', logger());    // request logging
app.use('*', timing());    // Server-Timing response header

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error', code: 'INTERNAL' }, 500);
});

app.notFound((c) =>
  c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404)
);
```

---

## Configuration

All config via environment variables. Provide a `.env.example` in the repo root:

```bash
# Server
PORT=3000
HOST=0.0.0.0

# Static feed refresh intervals (milliseconds)
SUBWAY_SYNC_INTERVAL_MS=3600000    # 1 hour
RAIL_SYNC_INTERVAL_MS=86400000     # 24 hours

# RT cache TTL
RT_CACHE_TTL_MS=20000              # 20 seconds

# SQLite file path (':memory:' for ephemeral dev, file path for prod)
DB_PATH=./data/mta.db

# Log level
LOG_LEVEL=info                     # debug | info | warn | error
```

Access via a typed config module (`src/config.ts`) — never read `process.env` directly in route/service files.

---

## Deployment

### Local Development

```bash
bun install
bun --watch run src/index.ts
```

### Production Build

```bash
bun build src/index.ts --outdir dist --target bun
# Single compiled output in dist/ — copy alongside data/ directory
```

### Docker

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

FROM base AS runner
COPY src/ ./src/
COPY bunfig.toml tsconfig.json ./
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
```

**Persistence note:** mount `./data` as a Docker volume so the SQLite DB survives container restarts. If the file is lost the API will re-seed from MTA feeds on next startup — expect a ~30–60s delay before the first request is served.

---

## Build Order

Recommended incremental implementation sequence:

1. **Scaffold** — Hono app, `src/config.ts`, `bun:sqlite` init, schema + migrations
2. **Static loader** — download subway ZIP, parse stops + routes into DB, smoke test with `GET /stops?q=atlantic`
3. **RT parser** — fetch L train feed, decode protobuf, log raw entity output to confirm parsing works
4. **Arrivals endpoint** — `/stops/:id/arrivals` wired to L train feed, verified against MYmta app
5. **Feed router + RT cache** — generalize to all subway lines, add 20s TTL cache with promise deduplication
6. **Remaining endpoints** — `/routes`, `/alerts`, `/routes/:id/vehicles`
7. **Background sync** — `setInterval` for static feed refresh, `/health` endpoint
8. **Error handling** — stale cache fallback on feed failure, 503 during initial seed
9. **Commuter rail** — add LIRR and Metro-North static + RT feeds
10. **Polish** — Docker image, `Server-Timing` headers, README with curl examples