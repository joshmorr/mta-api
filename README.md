# mta-api

A REST API over the MTA's GTFS static and realtime feeds. Handles protobuf parsing, feed routing, ZIP extraction, schedule-aware filtering, and stop lookups. Clients receive plain JSON with no knowledge of the underlying MTA feed structure.

**Stack:** [Bun](https://bun.sh) · [Hono](https://hono.dev) · `bun:sqlite` · `protobufjs`  
**No external database. No required API keys.**

---

## How it works

The API has two completely independent data layers that only meet at request time:

- **Static GTFS → SQLite.** Stops, routes, trips, schedules, and service calendars are downloaded as ZIP files from the MTA's S3 bucket, unzipped, parsed from CSV, and bulk-inserted into an embedded SQLite database. It refreshes on a timer (subway hourly, rail daily) and on startup if stale. SQLite is embedded and self-seeding — there is no external database to run.
- **Realtime GTFS-RT → in-memory cache.** Live arrivals, vehicle positions, and service alerts are fetched on demand as binary protobuf, decoded with `protobufjs`, and cached for 20 seconds. This never touches SQLite.

An arrivals request uses **both**: SQLite resolves *which* platforms and routes are relevant, then the realtime cache supplies the *live predictions*.

Because the MTA reuses raw GTFS IDs across its three systems (subway, LIRR, Metro-North), `feed_id` is part of the identity of every stored entity — which is why single-entity endpoints require a `?feed=` param. See [Feed scoping](#feed-scoping) below.

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
| `DB_PATH` | `./data/mta.db` | SQLite database path (use `:memory:` for ephemeral dev) |
| `RT_CACHE_TTL_MS` | `20000` | Realtime feed cache TTL in milliseconds |
| `RT_FETCH_TIMEOUT_MS` | `10000` | Upstream realtime fetch timeout (abort) |
| `STATIC_FETCH_TIMEOUT_MS` | `60000` | Upstream static GTFS ZIP fetch timeout (abort) |
| `SUBWAY_SYNC_INTERVAL_MS` | `3600000` | Subway static feed refresh interval (1 hour) |
| `RAIL_SYNC_INTERVAL_MS` | `86400000` | LIRR/MNR static feed refresh interval (24 hours) |

Copy `.env.example` to `.env` to override any of these. All have defaults, so the server starts without one.

---

## API

All responses are `application/json`. Errors follow a consistent shape:

```json
{ "error": "human-readable message", "code": "MACHINE_CODE" }
```

| Code | Status | Meaning |
|------|--------|---------|
| `INVALID_PARAM` | 400 | A query/path param failed validation |
| `NOT_FOUND` | 404 | The requested stop/route doesn't exist in that feed |
| `RATE_LIMITED` | 429 | Too many requests from this IP (see below) |
| `SEEDING` | 503 | The database is still seeding on first boot (every path except `/health`) |
| `FEED_ERROR` | 502 | An upstream realtime fetch failed and no cached copy was available |
| `INTERNAL` | 500 | Unexpected server error |

### Rate limiting

Requests are limited per client IP using an in-memory token bucket (100 requests / 60 seconds). Exceeding the limit returns `429 RATE_LIMITED`. `GET /health` is exempt.

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

| Param | Type | Default | Description |
|-------|------|---------|-------------|
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
| `routes` | string | Comma-separated route filter, e.g. `A,C,E` |
| `stop_id` | string | Filter alerts affecting a specific stop |
| `direction` | string | Filter by direction at the given stop: `N` or `0` = Northbound, `S` or `1` = Southbound. Only applies with `stop_id`. |

```
GET /alerts
GET /alerts?routes=A,C,E
GET /alerts?stop_id=711&direction=S
```

```json
{
  "generated_at": 1773605400,
  "stale": false,
  "alerts": [
    {
      "id": "lmm:planned_work:12345",
      "informed_entities": [
        { "agency_id": "MTASBWY", "route_id": "A", "stop_id": "A27", "direction_id": 1 },
        { "agency_id": "MTASBWY", "route_id": "A", "stop_id": "A28", "direction_id": 1 },
        { "agency_id": "MTASBWY", "route_id": "C", "stop_id": "A27", "direction_id": 1 }
      ],
      "header": "Weekend service change on A/C",
      "description": "Trains run via F line...",
      "active_periods": [
        { "start": 1773605400, "end": 1773691800 }
      ]
    }
  ]
}
```

Each `informed_entity` entry is an independent selector — fields within one entry are ANDed together, entries across an alert are ORed. A missing `direction_id` means both directions are affected at that stop. `agency_id` and `direction_id` are only present when the MTA included them in the feed; not all alerts carry station-level detail.


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

`/health` is exempt from both the rate limiter and the seeding guard, so it's always reachable.

---

### `GET /doc` · `GET /ui`

The OpenAPI 3.0 spec is generated from the route schemas and served as JSON at `GET /doc`. An interactive [Swagger UI](https://swagger.io/tools/swagger-ui/) is served at `GET /ui`.

```
GET /doc    # OpenAPI 3.0 spec (JSON)
GET /ui     # Swagger UI
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

When an upstream realtime fetch fails but a cached copy exists, the stale copy is served with `stale: true` rather than erroring — a `stale: true` response is a success with slightly old data, by design.

---

## Development

```sh
bun install          # install dependencies
bun run dev          # start with hot reload (auto-seeds DB if empty)
bun run start        # start without hot reload
bun run seed         # download + import all GTFS static feeds (~2–3 min)
bun run build        # bundle to dist/
bun run lint         # oxlint
bun run lint:fix     # oxlint --fix
bunx tsc --noEmit    # type-check
```

### Tests

```sh
bun test                              # all unit/integration tests (bun:test)
bun test --coverage                   # with coverage
bun test src/test/utils/csv.test.ts   # a single test file
bun run test:hurl                     # black-box HTTP tests (boots a real server; needs hurl)
bun run test:hurl:all                 # ^ plus realtime smoke (hits live MTA feeds)
```

Unit tests use `bun:test` and run against an in-memory database (`bunfig.toml` preloads a setup that forces `DB_PATH=:memory:`), so they never touch the real DB. The black-box suites in `hurl/` exercise the real HTTP surface — status codes, the `{ error, code }` envelope, and headers — that in-process tests can't reach. `hurl` is a separate binary (not an npm dependency); install it from <https://hurl.dev>.

---

## Project structure

```
src/
├── index.ts        App composition root: middleware, route mounting, /doc, /ui
├── startup.ts      Migrations, first-boot seeding, periodic sync intervals
├── config.ts       Env vars → typed config (with defaults)
├── routes/         HTTP layer — Zod/OpenAPI route defs + thin handlers (no logic)
├── services/       Business logic (static sync, realtime joins, alerts, feed mapping)
├── cache/          In-memory realtime protobuf cache (TTL, dedup, stale-serve)
├── db/             SQLite client, schema DDL, and prepared queries
├── schemas/        Zod request/response schemas (validation + OpenAPI)
├── types/          TS interfaces for response shapes + GTFS row types
├── utils/          CSV parsing, feed-param parsing, protobuf helpers, OpenAPI setup
├── middleware/     Rate limiter
└── proto/          GTFS-RT protobuf schema

scripts/   seed.ts (manual seed), hurl.sh (black-box test runner)
hurl/      .hurl black-box HTTP test suites
docs/      ARCHITECTURE.md, DATA_FLOW.md
data/      SQLite DB (gitignored, auto-created)
```

Layering is strict: `routes/ → services/ → db | cache`. Route handlers validate input and map errors to the `{ error, code }` envelope; business logic lives in services; SQL lives in `db/queries/`.
