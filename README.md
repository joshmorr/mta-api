# mta-api

A REST API over the MTA's static and realtime GTFS feeds. Handles protobuf parsing, feed routing, ZIP extraction, schedule-aware filtering, and stop lookups. Clients receive plain JSON with no knowledge of the underlying MTA feed structure.

The same data is also served as [MCP](#mcp-server) tools over stdio or HTTP, so LLM agents can query it directly.

**Stack:** [Bun](https://bun.sh) · [Hono](https://hono.dev) · `bun:sqlite` · `protobufjs` · [`@modelcontextprotocol/sdk`](https://modelcontextprotocol.io)  
**No external database. No required API keys.**

---

## Supported feeds

| Feed | Static schedule | Realtime |
|------|:---:|:---:|
| 🚊 Subway | ✅ | ✅ |
| 🚆 LIRR | ✅ | ✅ |
| 🚆 Metro-North | ✅ | ✅ |
| 🚌 Bus | Coming soon | Coming soon |
> Alerts are system-wide

---

## Quick start

```sh
bun install
bun run seed    # download and import all static GTFS feeds into SQLite (~2–3 min)
bun run dev     # start with hot reload
```

`bun run dev` / `bun run start` require a seeded database — run `bun run seed` first. If the database is empty, the server exits immediately with an error.


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

Production runs on [Fly.io](https://fly.io) (`fly.toml`, `Dockerfile`).

**Application code** ships automatically: a push to `main` runs the usual checks
(`.github/workflows/ci.yml`), and only if they pass does the same workflow's
`deploy` job run `flyctl deploy`. Pull requests and feature branches run checks
only. The workflow also accepts a manual `workflow_dispatch` if you need to
redeploy `main` without a new commit.

**The database** is on its own schedule. Instances are **read-only**: they don't
build the DB themselves. Instead:

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
`TIGRIS_BUCKET` / `FLY_APP` repo Variables. The `FLY_API_TOKEN` secret and
`FLY_APP` variable are shared by both workflows — `ci.yml` deploys with them and
`build-db.yml` restarts with them.

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
  ],
  "transfers": [
    { "to_stop_id": "902", "to_stop_name": "Times Sq-42 St", "transfer_type": 2, "min_transfer_time": 180, "from_route_id": null, "to_route_id": null, "from_trip_id": null, "to_trip_id": null }
  ]
}
```

> `transfers` comes straight from GTFS `transfers.txt`. `from_route_id`/`to_route_id` are populated on MNR only; `from_trip_id`/`to_trip_id` on LIRR and MNR only (per-trip guaranteed transfers, so the same `to_stop_id` can repeat once per trip pair).

---

### `GET /arrivals`

Live arrivals at a stop, sourced from GTFS-RT feeds filtered against the active service calendar. `stop` and `feed` are required.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stop` | string | **required** | Platform or parent station ID, e.g. `127N` |
| `feed` | string | **required** | One of `subway`, `lirr`, `mnr` |
| `limit` | number | `5` | Max arrivals (max 50) |
| `routes` | string | all | Comma-separated route filter, e.g. `1,2,3` |
| `direction` | string | all | `NORTH` or `SOUTH`. Subway only — LIRR/MNR arrivals never carry a direction, so this excludes them entirely. |

```
GET /arrivals?stop=127N&feed=subway
GET /arrivals?stop=127N&feed=subway&limit=3&routes=1,2
GET /arrivals?stop=127&feed=subway&direction=NORTH
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
      "route_name": "Oyster Bay Branch",
      "route_long_name": "Oyster Bay Branch",
      "trip_id": "GO103_25_6558",
      "arrival_time": 1773606240,
      "arrival_in_seconds": 840,
      "departure_time": 1773606240,
      "departure_in_seconds": 840,
      "delay_seconds": null,
      "destination_stop_id": "5",
      "destination": "Oyster Bay",
      "direction": null,
      "direction_id": 0,
      "direction_source": "rt_direction_id",
      "train_number": "2306",
      "track": "3",
      "train_status": null,
      "status": "IN_TRANSIT_TO",
      "source": "realtime"
    }
  ]
}
```

`arrival_time` and `arrival_in_seconds` are `null` for departure-only updates (e.g. at origin terminals where a train originates rather than arrives). The arrival is still included and sorted by its departure time.

`destination`/`destination_stop_id` is the trip's true terminus — the last stop time update in the feed, not a static `trip_headsign` — resolved with zero truncation across all three feeds. For a subway platform ID this resolves to the parent station's name, not the platform.

Direction is feed-honest, not uniform, because the three systems don't publish the same signal: subway `direction` (`NORTH`/`SOUTH`, `direction_source: "stop_suffix"`) comes from the matched platform's `N`/`S` suffix and has 100% coverage; LIRR `direction_id` (`0`/`1`, `direction_source: "rt_direction_id"`) is branch-relative as published by the railroad, not a compass direction — `direction_id=1` on a train headed to Penn Station means inbound, not south; Metro-North publishes neither, because its direction *is* `destination`. Any field the feed doesn't publish for a given trip is `null`, including `status`, `delay_seconds`, and `train_number` (LIRR/MNR only).

`track` and `train_status` come from the MTA's railroad extension to GTFS-RT and are LIRR/MNR only — both are always `null` on subway, where the platform *is* the stop. `track` is the assigned track at this stop. `train_status` is the railroad's own trip state, passed through verbatim: `On-Time`, `Late`, `Delayed`, `Departed`, `Arriving`, `Arrived`, `Canceled`, `Bus`. In practice only Metro-North populates it; LIRR sends the field empty, which this API normalizes to `null`.

**`train_status` is the only cancellation signal Metro-North publishes** — it never sets the GTFS-RT `schedule_relationship=CANCELED`. Cancelled trains are still returned in `arrivals` rather than filtered out, so a client that cares must check the field: `arrivals.filter(a => a.train_status !== 'Canceled')`.

When the upstream RT fetch fails but a cached feed is available, the response is served with `stale: true` and `feed_error` describing the reason.

---

### `GET /schedule`

Scheduled trips **between two stations**, from the static GTFS timetable — not realtime, so it's unaffected by feed outages and isn't limited to the near future. `from`, `to`, and `feed` are all required; each departure carries a `destination` object with arrival time and ride duration.

No single-station mode — use [`/arrivals`](#get-arrivals) for "what's leaving now" (it sees live delays/reroutes/cancellations). Omitting `to` is a `400`.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `from` | string | **required** | Origin platform or parent station ID |
| `to` | string | **required** | Destination platform or parent station ID |
| `feed` | string | **required** | One of `subway`, `lirr`, `mnr` — both stops must belong to it |
| `after` | number | now | Unix seconds cursor — only departures at or after this instant. |
| `date` | string | none | Pin the query to a single `YYYYMMDD` service date instead of the default rolling `[yesterday, today, tomorrow]` window. |
| `limit` | number | `20` | Max departures (max 100). |
| `max_transfers` | number | feed max | Train changes to allow. Clamped down to what the feed supports (`lirr` 1; `subway` and `mnr` 0) and echoed back as `max_transfers`. Pass `0` for direct trips only. |

```
GET /schedule?from=44&to=237&feed=lirr&limit=5
GET /schedule?from=127&to=128&feed=subway&date=20260810
GET /schedule?from=171&to=27&feed=lirr           # no through train: change at Woodside
```

Direction is implied by the pair (no direction param). On the subway a parent station ID expands to its platforms on both ends: `from=127&to=128` matches southbound `127S` departures, `from=128&to=127` northbound `128N`.

```json
{
  "feed_id": "lirr",
  "from_stop_id": "44",
  "from_stop_name": "Deer Park",
  "to_stop_id": "237",
  "to_stop_name": "Penn Station",
  "service_dates": ["20260809", "20260810", "20260811"],
  "generated_at": 1786379015,
  "source": "scheduled",
  "max_transfers": 1,
  "departures": [
    {
      "feed_id": "lirr",
      "trip_id": "GO201_26_1951",
      "route_id": "4",
      "route_name": "Ronkonkoma Branch",
      "route_long_name": "Ronkonkoma Branch",
      "service_id": "EB24D2DC",
      "service_date": "20260810",
      "stop_id": "44",
      "stop_sequence": 4,
      "arrival_time": "12:35:00",
      "departure_time": "12:35:00",
      "arrival_timestamp": 1786379700,
      "departure_timestamp": 1786379700,
      "departure_in_seconds": 685,
      "headsign": "Penn Station",
      "train_number": "1951",
      "direction_id": 1,
      "track": null,
      "peak": false,
      "pickup_type": 0,
      "drop_off_type": 0,
      "destination": {
        "stop_id": "237",
        "stop_name": "Penn Station",
        "stop_sequence": 12,
        "arrival_time": "13:39:00",
        "arrival_timestamp": 1786383540,
        "duration_seconds": 3840
      },
      "transfers": 0,
      "legs": [
        {
          "leg_index": 0,
          "feed_id": "lirr",
          "trip_id": "GO201_26_1951",
          "route_id": "4",
          "route_name": "Ronkonkoma Branch",
          "route_long_name": "Ronkonkoma Branch",
          "service_id": "EB24D2DC",
          "service_date": "20260810",
          "direction_id": 1,
          "headsign": "Penn Station",
          "train_number": "1951",
          "peak": false,
          "origin": {
            "stop_id": "44",
            "stop_name": "Deer Park",
            "stop_sequence": 4,
            "arrival_time": "12:35:00",
            "arrival_timestamp": 1786379700,
            "departure_time": "12:35:00",
            "departure_timestamp": 1786379700,
            "track": null,
            "pickup_type": 0,
            "drop_off_type": 0
          },
          "destination": {
            "stop_id": "237",
            "stop_name": "Penn Station",
            "stop_sequence": 12,
            "arrival_time": "13:39:00",
            "arrival_timestamp": 1786383540,
            "departure_time": null,
            "departure_timestamp": null,
            "track": "17",
            "pickup_type": 0,
            "drop_off_type": 0
          },
          "duration_seconds": 3840,
          "transfer": null
        }
      ]
    }
  ],
  "next_after": 1786379701
}
```

#### Journeys with a transfer

Every result has a `legs` array (one per train ride) and a `transfers` count; a direct trip is `transfers: 0` with one leg mirroring the fields beside it.

On a transfer journey, the fields beside `legs` describe the first leg's boarding and `destination` describes arrival at `to`. The interchange hangs off the leg being transferred *onto*, as a `transfer` object (`stop_id`, `stop_name`, `arrival_timestamp`, `departure_timestamp`, `connection_seconds`, `min_transfer_time`, `guaranteed`).

Connections are searched between 3–60 minutes and never routed through Penn Station, Grand Central, Atlantic Terminal, Hunterspoint Avenue, or Long Island City (railroad termini, not real interchanges). Dominated transfer journeys are pruned; direct trips never are. Both legs must share a service date.

Planned timetable only — no live delays/reroutes/cancellations. Pagination is a Unix-seconds cursor (`after=<next_after>`; `null` once a page is short of `limit`). `date` pins one service date; omitted, it spans a rolling 3-day window (so late-night queries still catch overnight trips with GTFS times past `24:00:00`).

An empty `departures` array (`200`) means no trip connects the pair on those dates; a nonexistent stop is a `404` naming which side was the problem. `direction_id` is the raw GTFS value. `peak` is the railroad's fare-period flag for LIRR/MNR, `null` on subway or wherever the feed doesn't publish it.

---

### `GET /trips/:trip_id`

Resolves a `trip_id` — typically read off `/arrivals` or `/schedule` — to its full static, stop-by-stop schedule. `feed` is required.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `feed` | string | **required** | One of `subway`, `lirr`, `mnr` |
| `date` | string | first active date | `YYYYMMDD` service date to compute timestamps against. |

```
GET /trips/GO201_26_7977_1?feed=lirr
GET /trips/GO201_26_7977_1?feed=lirr&date=20260810
```

```json
{
  "feed_id": "lirr",
  "trip_id": "GO201_26_7977_1",
  "resolved_trip_id": "GO201_26_7977_1",
  "matched_by": "exact",
  "route_id": "4",
  "route_name": "Ronkonkoma Branch",
  "route_long_name": "Ronkonkoma Branch",
  "service_id": "1C6B8C2D",
  "service_date": "20260808",
  "direction_id": 1,
  "headsign": "Penn Station",
  "train_number": "7977",
  "peak": false,
  "source": "scheduled",
  "origin": {
    "stop_id": "179", "stop_name": "Ronkonkoma", "parent_station_id": null, "stop_sequence": 1,
    "arrival_time": "18:05:00", "departure_time": "18:05:00",
    "arrival_timestamp": 1786226700, "departure_timestamp": 1786226700,
    "track": null, "pickup_type": 0, "drop_off_type": 0
  },
  "destination": {
    "stop_id": "237", "stop_name": "Penn Station", "parent_station_id": null, "stop_sequence": 15,
    "arrival_time": "19:31:00", "departure_time": "19:31:00",
    "arrival_timestamp": 1786231860, "departure_timestamp": 1786231860,
    "track": null, "pickup_type": 0, "drop_off_type": 0
  },
  "stops": [
    { "...": "one entry per stop, same shape as origin/destination, in stop_sequence order (15 here)" }
  ]
}
```

LIRR trip IDs must match exactly. Subway realtime trip IDs are frequently a *suffix* of the static ID (an RT ID like `1..S03R` off `/arrivals` resolving to a static `086850_1..S03R`) and are matched via a fallback narrowed to the active service window — check `matched_by` (`"exact"` or `"rt_trip_id_suffix"`) and `resolved_trip_id` if it matters which happened. **Metro-North realtime trip IDs cannot be resolved to a static trip at all** — the two ID schemes are unrelated for that feed, so an MNR `trip_id` read off `/arrivals` always 404s here.

`date` defaults to the first of `[yesterday, today, tomorrow]` the trip's service is active on; if none of those three are, `service_date` is `null` and every stop's `*_timestamp` is `null` too — the raw `*_time` (`HH:MM:SS`) fields are still populated, since a static trip's schedule doesn't depend on which date you're asking about.

`origin`/`destination` are just `stops[0]`/`stops[stops.length - 1]`, surfaced at the top level for convenience.

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
GET /vehicles?route=4&feed=lirr
```

```json
{
  "feed_id": "lirr",
  "route_id": "4",
  "route_name": "Ronkonkoma Branch",
  "route_long_name": "Ronkonkoma Branch",
  "generated_at": 1773605400,
  "vehicles": [
    {
      "feed_id": "lirr",
      "trip_id": "...",
      "current_stop_id": "349",
      "status": "IN_TRANSIT_TO",
      "timestamp": 1773605390,
      "latitude": 40.749,
      "longitude": -73.99
    }
  ]
}
```

`latitude`/`longitude` are only populated for LIRR; Metro-North doesn't publish coordinates reliably and subway never does.

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
      ],
      "alert_type": "Planned - Reroute",
      "priority": 18,
      "human_readable_active_period": "Aug 22 - 24, Sat 1:15 AM to Mon 4:00 AM",
      "updated_at": 1773605100
    }
  ]
}
```

Each `informed_entity` entry is an independent selector — fields within one entry are ANDed together, entries across an alert are ORed. A missing `direction_id` means both directions are affected at that stop. `agency_id` and `direction_id` are only present when the MTA included them in the feed; not all alerts carry station-level detail.

`alert_type`, `priority`, `human_readable_active_period`, and `updated_at` come from the MTA's Mercury extension to GTFS-RT. They matter more than they might look: **the MTA never populates the standard GTFS-RT `cause` and `effect` fields**, so `alert_type` is the only machine-readable statement of what kind of disruption this is — `Delays`, `Cancellations`, `Detour`, `Station Notice`, `Planned - Substitute Buses`, and so on.

`priority` ranks severity from 1 (lowest) to 35 (`Suspended`) on the MTA's shared status list, so `alerts.sort((a, b) => b.priority - a.priority)` puts the worst disruption first. The upstream feed carries this per affected route/stop; this API reports the highest rank across an alert's informed entities.

`human_readable_active_period` is the MTA's own prose summary of `active_periods`, worth preferring over rendering the raw timestamps. Any of the four is `null` on an alert that doesn't carry the extension.


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

All nine are read-only and non-destructive.

| Tool | Returns | Live feed |
|------|---------|:---:|
| `mta_search_stops` | Stops by name, by proximity, or unfiltered | |
| `mta_get_stop` | One stop with its platforms, their directions, and its GTFS transfers | |
| `mta_list_routes` | All routes, optionally for one system | |
| `mta_get_route` | One route's names and colour | |
| `mta_get_schedule` | Scheduled journeys between two stations, from the static timetable, with per-leg detail and trip duration | |
| `mta_get_trip` | One trip's full stop-by-stop static schedule, resolved from a trip_id | |
| `mta_get_arrivals` | Upcoming arrivals at a stop, soonest first | ✅ |
| `mta_get_vehicles` | Trains currently active on a route | ✅ |
| `mta_get_alerts` | Active service alerts, filterable by route or stop | ✅ |

The [feed scoping](#feed-scoping) rule applies: `mta_get_stop`, `mta_get_route`, `mta_get_schedule`, `mta_get_trip`, `mta_get_arrivals`, and `mta_get_vehicles` all require `feed`, and each tool's description explains why. `mta_get_alerts` is the exception — alerts for all three systems arrive on one upstream feed, so it filters by route or stop instead.

`mta_get_schedule` and `mta_get_trip` read only the static timetable, like `mta_get_stop`/`mta_get_route` — they have no live-feed fallback behavior because they never touch a live feed. `mta_get_trip` cannot resolve a Metro-North realtime trip_id to a static one at all (the two ID schemes are unrelated for that feed); its description says so explicitly so an agent doesn't retry.

`mta_get_schedule` requires both `from` and `to`, mirroring the endpoint: it answers "how do I get from A to B, when does it run, how long does it take". An agent asking what's leaving a single station should call `mta_get_arrivals` instead, and both tool descriptions point at each other so the choice doesn't depend on guessing. Its description also spells out that LIRR results may include a change of train while subway and Metro-North are direct-only, so an agent reads an empty subway result as "not yet supported" rather than "no such trip".

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
