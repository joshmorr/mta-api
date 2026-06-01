# Endpoint reference

Exact parameters, defaults/clamps, and response shapes for each endpoint. `{BASE_URL}` defaults to `http://localhost:3000` locally. The live OpenAPI spec at `GET {BASE_URL}/doc` is authoritative if anything here looks out of date.

Conventions:
- `feed` is always one of `subway`, `lirr`, `mnr`.
- All timestamps are **Unix seconds** (numbers).
- Errors are always `{ "error": string, "code": string }` — see SKILL.md for codes.

## Table of contents
- [GET /stops](#get-stops)
- [GET /stops/:stop_id](#get-stopsstop_id)
- [GET /routes](#get-routes)
- [GET /routes/:route_id](#get-routesroute_id)
- [GET /arrivals](#get-arrivals)
- [GET /vehicles](#get-vehicles)
- [GET /alerts](#get-alerts)
- [GET /health](#get-health)

---

## GET /stops

List or search stops. Three mutually-exclusive modes, chosen by which params you send:
- `lat` + `lon` present → **proximity** search within `radius` meters.
- `q` present (no lat/lon) → **name** search.
- none → **all** stops (first `limit`).

Query params:

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string | — | Name substring search |
| `lat` | number | — | Latitude; must pair with `lon` |
| `lon` | number | — | Longitude; must pair with `lat` |
| `feed` | enum | — | Optional filter; omit for cross-feed |
| `radius` | number | 400 | Meters, must be >0, max 1600 |
| `limit` | number | 20 | Positive int, silently clamped to 50 |

Response `200` — `StopListResponse`:

```json
{
  "stops": [
    {
      "feed_id": "subway",
      "stop_id": "127",
      "stop_name": "Times Sq-42 St",
      "lat": 40.75529,
      "lon": -73.987495,
      "platforms": ["127N", "127S"]
    }
  ]
}
```

- `platforms` is an array of directional platform IDs for subway parent stations; **empty `[]` for LIRR/MNR** (flat model). Use these IDs for `/arrivals`.

`curl "{BASE_URL}/stops?q=Times+Sq&feed=subway"`

---

## GET /stops/:stop_id

Full detail for one stop, including platform directions. For a subway child platform or parent, resolves to the **parent station**.

| Param | In | Required | Notes |
|---|---|---|---|
| `stop_id` | path | yes | e.g. `127` |
| `feed` | query | **yes** | Which service the ID belongs to |

Response `200` — `StopDetail`:

```json
{
  "feed_id": "subway",
  "stop_id": "127",
  "stop_name": "Times Sq-42 St",
  "lat": 40.75529,
  "lon": -73.987495,
  "platforms": [
    { "stop_id": "127N", "direction": "Uptown / Northbound" },
    { "stop_id": "127S", "direction": "Downtown / Southbound" }
  ]
}
```

`404 NOT_FOUND` if the ID doesn't exist in that `feed`. For LIRR/MNR, `platforms` is `[]`.

---

## GET /routes

| Param | Type | Default | Notes |
|---|---|---|---|
| `feed` | enum | — | Optional filter |

Response `200` — `RouteListResponse`:

```json
{
  "routes": [
    { "feed_id": "subway", "route_id": "A", "name": "A", "long_name": "8 Avenue Express", "color": "2850ad" }
  ]
}
```

`name` is the short name (the bullet letter/number for subway); `long_name` the descriptive name; `color` is a hex string without `#` (may be empty).

---

## GET /routes/:route_id

| Param | In | Required |
|---|---|---|
| `route_id` | path | yes (e.g. `A`) |
| `feed` | query | **yes** |

Response `200` — single `Route` object (same shape as a list element above). `404 NOT_FOUND` on miss.

---

## GET /arrivals

Upcoming arrivals at a stop from the realtime feed (20s cache).

| Param | Type | Default | Notes |
|---|---|---|---|
| `stop` | string | — | **Required.** Use the directional platform ID for subway (`127N`), the flat stop ID for LIRR/MNR |
| `feed` | enum | — | **Required** |
| `limit` | number | 5 | Positive int, clamped to 50 |
| `routes` | string | — | Comma-separated route filter, e.g. `A,C,E` |

Response `200` — `ArrivalResponse`:

```json
{
  "feed_id": "subway",
  "stop_id": "127S",
  "stop_name": "Times Sq-42 St",
  "direction": "Downtown / Southbound",
  "generated_at": 1717245600,
  "stale": false,
  "arrivals": [
    {
      "feed_id": "subway",
      "route_id": "2",
      "trip_id": "...",
      "arrival_time": 1717245720,
      "arrival_in_seconds": 120,
      "status": "IN_TRANSIT_TO"
    }
  ]
}
```

- `direction` and `feed_error` are optional. When upstream fails, `stale: true` + `feed_error` string, still HTTP 200.
- `status` ∈ `INCOMING_AT`, `STOPPED_AT`, `IN_TRANSIT_TO`.
- Prefer `arrival_in_seconds` for countdown UI.
- `404 NOT_FOUND` if the stop doesn't exist; `503 FEED_ERROR` if upstream down with no cache.

---

## GET /vehicles

Active vehicle positions for all current trips on a route.

| Param | Type | Required |
|---|---|---|
| `route` | string | **yes** (e.g. `A`) |
| `feed` | enum | **yes** |

Response `200` — `VehicleListResponse`:

```json
{
  "feed_id": "subway",
  "route_id": "A",
  "generated_at": 1717245600,
  "vehicles": [
    { "feed_id": "subway", "trip_id": "...", "current_stop_id": "A24N", "status": "STOPPED_AT", "timestamp": 1717245590 }
  ]
}
```

`404 NOT_FOUND` for unknown route; `503 FEED_ERROR` if upstream down.

---

## GET /alerts

Active service alerts, optionally filtered. No `feed` param — alerts span feeds.

| Param | Type | Notes |
|---|---|---|
| `routes` | string | Comma-separated route filter (`A,C`) |
| `stop_id` | string | Only alerts whose `informed_entities` touch this stop |
| `direction` | enum | `N`/`0` = northbound, `S`/`1` = southbound; only meaningful with `stop_id` |

Response `200` — `AlertListResponse`:

```json
{
  "generated_at": 1717245600,
  "stale": false,
  "alerts": [
    {
      "id": "lmm:alert:123",
      "informed_entities": [
        { "route_id": "A", "stop_id": "A24", "direction_id": 0 }
      ],
      "header": "Northbound A trains run with delays",
      "description": "Because of a signal problem...",
      "active_periods": [ { "start": 1717240000, "end": 1717250000 } ]
    }
  ]
}
```

- `informed_entities` is the impact selector array — each entry pairs an optional `route_id`, `stop_id`, and `direction_id` (`0`/`1`, omitted = both directions). Evaluate entries independently; don't assume a single route/stop per alert.
- `feed_error` optional; `stale` works like arrivals. `503 FEED_ERROR` only if the feed can't be reached and there's no cache.

---

## GET /health

No params, **not rate-limited**, never returns `SEEDING`. Use it for readiness probes and to detect whether static data is loaded.

Response `200` — `HealthResponse`:

```json
{
  "status": "ok",
  "totals": { "stop_count": 1234, "route_count": 56 },
  "static_feeds": {
    "subway": { "last_synced": 1717240000, "stop_count": 900, "route_count": 30 },
    "lirr":   { "last_synced": 1717200000, "stop_count": 240, "route_count": 12 },
    "mnr":    { "last_synced": 1717200000, "stop_count": 250, "route_count": 14 }
  }
}
```

`last_synced` is Unix seconds or `null` if that feed hasn't imported yet.
