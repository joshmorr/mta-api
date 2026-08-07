# mta-api

A REST API over the MTA's GTFS static and realtime feeds. Handles protobuf parsing, feed routing, ZIP extraction, schedule-aware filtering, and stop lookups. Clients receive plain JSON with no knowledge of the underlying MTA feed structure.

**Stack:** [Bun](https://bun.sh) · [Hono](https://hono.dev) · `bun:sqlite` · `protobufjs`  
**No external database. No required API keys.**

---

## Supported feeds

| Feed | Static schedule | Realtime |
|------|:---:|:---:|
| 🚊 Subway | ✅ | ✅ |
| 🚆 LIRR | ✅ | ✅ |
| 🚆 Metro-North | ✅ | ✅ |
| 🚌 Bus | Coming soon | Coming soon |

---

## Quick start

```sh
bun install
bun run seed    # download and import all static GTFS feeds into SQLite (~2–3 min)
bun run dev     # start with hot reload
```

`bun run dev` / `bun run start` require a seeded database — run `bun run seed` first. If the database is empty, the server exits immediately with an error.

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
| `RT_CACHE_TTL_MS` | `10000` | Realtime cache TTL in milliseconds for the vehicle feeds |
| `ALERTS_RT_CACHE_TTL_MS` | `30000` | Realtime cache TTL in milliseconds for the service alerts feed only, which publishes far less often (see [Realtime GTFS-RT](#realtime-gtfs-rt-in-memory-10s-ttl)) |
| `RT_FETCH_TIMEOUT_MS` | `10000` | Upstream realtime fetch timeout in milliseconds |
| `STATIC_FETCH_TIMEOUT_MS` | `60000` | Upstream static GTFS ZIP fetch timeout in milliseconds (used by `bun run seed` and CI) |
| `DB_URL` | _(unset)_ | Bucket base URL to download a prebuilt `mta.db` from on boot (see Deployment). When unset, no download happens |
| `DB_FETCH_TIMEOUT_MS` | `120000` | Timeout for the boot-time DB download |
| `LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |

---

## Deployment

Production runs on [Fly.io](https://fly.io) (`fly.toml`, `Dockerfile`). Instances
are **read-only**: they don't build the DB themselves. Instead:

1. A scheduled GitHub Actions job (`.github/workflows/build-db.yml`) runs the
   heavy GTFS build once — it seeds a DB from the feeds, compacts it with
   `VACUUM INTO`, and publishes a gzipped `mta.db` (plus a version marker and
   checksum) to a Tigris bucket.
2. It then rolling-restarts the Fly app.
3. On boot, each machine's `start.sh` runs `scripts/fetch-db.ts`, which downloads
   the prebuilt DB into its volume (skipping the transfer when the local copy's
   version already matches) before the server starts.

This keeps the machines small and their boots fast, and confines the expensive
2.4M-row import to CI. Instances just set `DB_URL=<bucket>` and are otherwise
read-only — there's no in-instance sync path. Local dev builds the same DB by
running `bun run seed` directly.

One-time setup: `fly storage create` (Tigris bucket, public-read), mirror the
`AWS_*` credentials into GitHub Secrets, and add a `FLY_API_TOKEN` secret plus
`TIGRIS_BUCKET` / `FLY_APP` repo Variables.

---

## API

All responses are `application/json`. Errors follow a consistent shape:

```json
{ "error": "human-readable message", "code": "MACHINE_CODE" }
```

`code` is a stable enum for client branching (`error` is for humans and may change):

| `code` | Status | Meaning |
|--------|--------|---------|
| `INVALID_PARAM` | 400 | A query/path parameter failed validation |
| `NOT_FOUND` | 404 | The requested entity or route does not exist |
| `FEED_ERROR` | 503 | Upstream realtime feed unavailable and no cache to serve |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL` | 500 | Unexpected server error |

### OpenAPI spec

The full OpenAPI 3.0 spec is committed at [`openapi.json`](./openapi.json) and is the artifact to feed into client generators (`openapi-typescript`, `orval`, `openapi-generator`, …) when building a typed client. The running server also serves it live at `GET /doc`, with Swagger UI at `GET /ui`.

Regenerate the committed file after changing any route or schema:

```sh
bun run openapi:dump
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

```json
{
  "feed_id": "subway",
  "route_id": "A",
  "name": "A",
  "long_name": "Eighth Avenue Local",
  "color": "0039A6"
}
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

API status and per-feed static data counts, read from an in-memory cache refreshed once at startup — `/health` never queries SQLite, so it always responds immediately.

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

## MCP server

The same data is exposed as [Model Context Protocol](https://modelcontextprotocol.io) tools, so an LLM agent — Claude Code, Claude Desktop, or any MCP client — can query MTA schedules and realtime feeds directly.

Tools call the service layer in process. They are not a client of the REST API and take no network hop, so everything below works exactly as the HTTP endpoints do.

### Connecting

**Locally, over stdio.** The client launches the server as a subprocess; nothing needs to be running first. Requires a seeded database (`bun run seed`).

```json
{
  "mcpServers": {
    "mta": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/mta-api/src/mcp/stdio.ts"]
    }
  }
}
```

Put that in `.mcp.json` (Claude Code) or `claude_desktop_config.json` (Claude Desktop). This repo already ships a [`.mcp.json`](./.mcp.json), so the tools are available when working in it. To check the server by hand:

```sh
bun run mcp   # speaks JSON-RPC on stdin/stdout; ^D to exit
```

**Remotely, over HTTP.** The running server serves streamable HTTP at `POST /mcp`, so a deployed instance is connectable with no local checkout:

```json
{
  "mcpServers": {
    "mta": { "url": "http://localhost:3000/mcp" }
  }
}
```

Either transport can be inspected with the official tool:

```sh
npx @modelcontextprotocol/inspector          # then point it at http://localhost:3000/mcp
npx @modelcontextprotocol/inspector bun run src/mcp/stdio.ts
```

### Tools

All seven are read-only and non-destructive.

| Tool | Returns | Live feed |
|------|---------|:---:|
| `mta_search_stops` | Stops by name, by proximity, or unfiltered | |
| `mta_get_stop` | One stop with its platforms and their directions | |
| `mta_list_routes` | All routes, optionally for one system | |
| `mta_get_route` | One route's names and colour | |
| `mta_get_arrivals` | Upcoming arrivals at a stop, soonest first | ✅ |
| `mta_get_vehicles` | Trains currently active on a route | ✅ |
| `mta_get_alerts` | Active service alerts, filterable by route or stop | ✅ |

The [feed scoping](#feed-scoping) rule applies: `mta_get_stop`, `mta_get_route`, `mta_get_arrivals`, and `mta_get_vehicles` all require `feed`, and each tool's description explains why. `mta_get_alerts` is the exception — alerts for all three systems arrive on one upstream feed, so it filters by route or stop instead.

Realtime tools degrade the way the HTTP endpoints do: when an upstream feed cannot be reached, cached data is returned with `stale: true` and a `feed_error`, rather than the call failing.

---

## Data sources

### Static GTFS (SQLite)

| Feed | Source |
|------|--------|
| Subway | `https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip` |
| LIRR | `https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip` |
| Metro-North | `https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip` |

The supplemented subway feed includes service changes for the next 7 days and is preferred over the base feed.

These feeds are the origin of all schedule data, but the running API doesn't fetch them directly. In production a scheduled CI job builds the SQLite DB from them daily and instances download the result (see [Deployment](#deployment)). For local dev, `bun run seed` builds the same DB directly from these feeds.

### Realtime GTFS-RT (in-memory, 10s TTL)

Fetched on demand, cached per feed path, with promise deduplication to prevent concurrent requests from triggering parallel upstream fetches.

The vehicle feeds below share one TTL (`RT_CACHE_TTL_MS`, default 10s), which sits above the publish period of eight of the ten so nearly every fetch returns new data. Service alerts are the exception: they republish on the order of minutes at ~570KB, roughly 6x the largest vehicle feed, so they get their own TTL (`ALERTS_RT_CACHE_TTL_MS`, default 30s).

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

This project is not affiliated with, endorsed by, or licensed by the MTA.
