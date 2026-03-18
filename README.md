# mta-api

A REST API over the MTA's GTFS static and realtime feeds. Handles protobuf parsing, feed routing, ZIP extraction, schedule-aware filtering, and stop lookups. Clients receive plain JSON with no knowledge of the underlying MTA feed structure.

**Stack:** [Bun](https://bun.sh) · [Hono](https://hono.dev) · `bun:sqlite` · `protobufjs`  
**No external database. No required API keys.**

---

## Quick start

```sh
bun install
bun run seed    # download and import all static GTFS feeds into SQLite (~2–3 min)
bun run dev     # start with hot reload
```

On first `bun run dev` or `bun run start`, if the database is empty the server will automatically seed before it starts accepting requests.

```
http://localhost:3000
```

---

## Configuration

All options are environment variables. Defaults work out of the box.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | HTTP listen host |
| `DB_PATH` | `./data/mta.db` | SQLite database path |
| `RT_CACHE_TTL_MS` | `20000` | Realtime feed cache TTL in milliseconds |
| `SUBWAY_SYNC_INTERVAL_MS` | `3600000` | Subway static feed refresh interval (1 hour) |
| `RAIL_SYNC_INTERVAL_MS` | `86400000` | LIRR/MNR static feed refresh interval (24 hours) |

---

## API

All responses are `application/json`. Errors follow a consistent shape:

```json
{ "error": "human-readable message", "code": "MACHINE_CODE" }
```

### Feed scoping

The MTA reuses raw GTFS IDs across subway, LIRR, and Metro-North (e.g. `stop_id=1` and `route_id=1` exist in multiple feeds). Collection endpoints (`GET /stops`, `GET /routes`) are cross-feed by default and accept an optional `?feed=` filter. All other endpoints require `?feed=` because IDs are only unique within a feed.

---

### `GET /stops`

List or search stops.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | — | Name search (partial, case-insensitive) |
| `lat` + `lon` | number | — | Proximity search centre |
| `radius` | number | `400` | Radius in metres (max 1600) |
| `feed` | string | all | Filter to `subway`, `lirr`, or `mnr` |
| `limit` | number | `20` | Max results (max 50) |

```
GET /stops?q=times+sq
GET /stops?lat=40.7553&lon=-73.9873&radius=400
GET /stops?feed=lirr&limit=50
```

```json
{
  "stops": [
    {
      "feed_id": "subway",
      "stop_id": "127",
      "stop_name": "Times Sq-42 St",
      "lat": 40.75529,
      "lon": -73.98726,
      "platforms": ["127N", "127S"]
    }
  ]
}
```

> `platforms` is populated for subway parent stations only. LIRR and MNR stops use a flat model — the stop ID itself is used in arrival queries.

---

### `GET /stops/:stop_id`

Get a single stop. Accepts parent station IDs or platform IDs. `feed` is required.

```
GET /stops/127?feed=subway
GET /stops/127N?feed=subway
GET /stops/1?feed=lirr
```

```json
{
  "feed_id": "subway",
  "stop_id": "127",
  "stop_name": "Times Sq-42 St",
  "lat": 40.75529,
  "lon": -73.98726,
  "platforms": [
    { "stop_id": "127N", "direction": "Uptown / Northbound" },
    { "stop_id": "127S", "direction": "Downtown / Southbound" }
  ]
}
```

---

### `GET /arrivals`

Live arrivals at a stop, sourced from GTFS-RT feeds filtered against the active service calendar. `stop` and `feed` are required.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stop` | string | **required** | Platform or parent station ID, e.g. `127N` |
| `feed` | string | **required** | One of `subway`, `lirr`, `mnr` |
| `limit` | number | `5` | Max arrivals (max 50) |
| `routes` | string | all | Comma-separated route filter, e.g. `1,2,3` |

```
GET /arrivals?stop=127N&feed=subway
GET /arrivals?stop=127N&feed=subway&limit=3&routes=1,2
GET /arrivals?stop=1&feed=lirr
```

```json
{
  "feed_id": "lirr",
  "stop_id": "1",
  "stop_name": "Albertson",
  "generated_at": 1773605400,
  "stale": false,
  "arrivals": [
    {
      "feed_id": "lirr",
      "route_id": "3",
      "trip_id": "GO103_25_6558",
      "arrival_time": 1773606240,
      "arrival_in_seconds": 840,
      "status": "IN_TRANSIT_TO"
    }
  ]
}
```

When the upstream RT fetch fails but a cached feed is available, the response is served with `stale: true` and `feed_error` describing the reason.

---

### `GET /routes`

List all routes.

| Param | Type | Description |
|-------|------|-------------|
| `feed` | string | Filter to `subway`, `lirr`, or `mnr` |

```
GET /routes
GET /routes?feed=lirr
```

```json
{
  "routes": [
    {
      "feed_id": "subway",
      "route_id": "A",
      "name": "A",
      "long_name": "Eighth Avenue Local",
      "color": "0039A6",
      "type": "subway"
    }
  ]
}
```

---

### `GET /routes/:route_id`

Get a single route. `feed` is required.

```
GET /routes/A?feed=subway
GET /routes/1?feed=lirr
```

---

### `GET /vehicles`

Live vehicle positions for a route. `route` and `feed` are required.

| Param | Type | Description |
|-------|------|-------------|
| `route` | string | **required** | Route ID, e.g. `L` |
| `feed` | string | **required** | One of `subway`, `lirr`, `mnr` |

```
GET /vehicles?route=L&feed=subway
```

```json
{
  "feed_id": "subway",
  "route_id": "L",
  "generated_at": 1773605400,
  "vehicles": [
    {
      "feed_id": "subway",
      "trip_id": "...",
      "current_stop_id": "L06N",
      "status": "STOPPED_AT",
      "timestamp": 1773605390
    }
  ]
}
```

---

### `GET /alerts`

Active service alerts from the MTA's combined alerts feed.

| Param | Type | Description |
|-------|------|-------------|
| `routes` | string | Comma-separated route filter |
| `stop_id` | string | Filter alerts affecting a specific stop |

```
GET /alerts
GET /alerts?routes=A,C,E
```

```json
{
  "generated_at": 1773605400,
  "stale": false,
  "alerts": [
    {
      "id": "lmm:planned_work:12345",
      "routes_affected": ["A", "C"],
      "stops_affected": ["A27", "A28"],
      "header": "Weekend service change on A/C",
      "description": "Trains run via F line...",
      "active_periods": [
        { "start": 1773605400, "end": 1773691800 }
      ]
    }
  ]
}
```

---

### `GET /health`

API status and per-feed static data counts.

```json
{
  "status": "ok",
  "totals": { "stop_count": 1729, "route_count": 48 },
  "static_feeds": {
    "subway": { "last_synced": 1773602000, "stop_count": 1488, "route_count": 29 },
    "lirr":   { "last_synced": 1773602000, "stop_count": 127,  "route_count": 13 },
    "mnr":    { "last_synced": 1773602000, "stop_count": 114,  "route_count": 6  }
  }
}
```

---

## Data sources

### Static GTFS (SQLite)

| Feed | Source | Refresh |
|------|--------|---------|
| Subway | `https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip` | Hourly |
| LIRR | `https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip` | Daily |
| Metro-North | `https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip` | Daily |

The supplemented subway feed includes service changes for the next 7 days and is preferred over the base feed.

### Realtime GTFS-RT (in-memory, 20s TTL)

Fetched on demand, cached per feed path, with promise deduplication to prevent concurrent requests from triggering parallel upstream fetches.

**No API key required.** Binary protobuf, decoded via `protobufjs`.

| Lines | Feed path |
|-------|-----------|
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
| All alerts | `camsys/all-alerts` |

---

## Project structure

```
src/
  index.ts              # App entry, route registration, startup sequence
  config.ts             # Env var config
  routes/               # Hono route handlers
  services/             # Business logic (RT feed, static feed, alerts, feed routing)
  db/
    client.ts           # bun:sqlite connection, migrations, schema helpers
    schema.ts           # CREATE TABLE DDL
    queries/            # Typed query functions per domain
  cache/
    rtCache.ts          # In-memory RT feed cache with TTL + promise deduplication
  proto/
    gtfs-realtime.proto # Standard GTFS-RT proto definition
  types/
    gtfs.ts             # GTFS and FeedId types
    api.ts              # Request/response types
scripts/
  seed.ts               # One-off: download + import all static feeds
data/
  feeds/                # Static GTFS ZIPs (subway, lirr, mnr)
  mta.db                # SQLite database (git-ignored)
```

