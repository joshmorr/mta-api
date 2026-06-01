---
name: mta-api-client
description: Integrate a client application with THIS project's MTA REST API — the Hono/Bun service in this repo that wraps NYC subway, LIRR, and Metro-North GTFS data as plain JSON. Use this skill whenever the user is writing code that CONSUMES these endpoints (`/stops`, `/routes`, `/arrivals`, `/vehicles`, `/alerts`, `/health`) from a frontend, mobile app, backend, or script — e.g. "show next arrivals at my stop", "build a stop search box", "fetch service alerts for the A train", "wire up a departures board", "call the arrivals endpoint", "generate a typed client from the OpenAPI spec". Trigger even when the user names a feature ("departures widget", "nearby stations map") rather than an endpoint, as long as they're calling this service rather than the raw MTA feeds. Do NOT use this for parsing raw GTFS protobuf/ZIP feeds directly, or for building or modifying the API server itself — this skill is only for code that calls the running service over HTTP.
---

# MTA API Client Integration

This skill helps you write **client code that consumes this repo's REST API**. The API turns the MTA's GTFS static + realtime feeds into plain JSON — clients need no protobuf, no GTFS knowledge, and no API key.

The source of truth for the exact request/response surface is the **live OpenAPI spec** the server serves at `GET {BASE_URL}/doc` (Swagger UI at `/ui`). When the surface might have changed, fetch `/doc` rather than trusting any static copy — see "Generating a typed client" below. This file captures the conventions and gotchas the raw spec doesn't make obvious.

`{BASE_URL}` is whatever host the API runs on. Local default: `http://localhost:3000`. Make it a configurable constant in the client — never hardcode it in more than one place.

## The five things that trip up every client

These are non-obvious and cause most integration bugs. Internalize them before writing fetch calls.

1. **`feed` is mandatory for any single-entity lookup, and IDs are NOT globally unique.** The MTA reuses IDs across services — `stop_id=1` exists in subway, LIRR, *and* MNR. Every endpoint that resolves one entity (`/stops/:id`, `/routes/:id`, `/arrivals`, `/vehicles`) requires `?feed=subway|lirr|mnr`. Collection endpoints (`/stops`, `/routes`) default to cross-feed and take `feed` only as an optional filter. Carry the `feed_id` from a list response through to detail/arrival calls — don't reconstruct it.

2. **Subway has a parent-station / directional-platform split; arrivals key off the platform ID.** A subway station (e.g. `127`, Times Sq) has child platforms `127N` (uptown/northbound) and `127S` (downtown/southbound). `/stops` returns the parent's `platforms` as an array of those IDs; `/stops/:id` returns them with human directions. **`/arrivals?stop=` wants the directional platform ID** (`127N`), not the parent — passing `127` returns nothing useful. LIRR and MNR are flat (no platform split), so the stop ID is used directly.

3. **Realtime responses can be stale, and that's a normal success (200), not an error.** `/arrivals`, `/vehicles`, and `/alerts` read a 20s in-memory cache of the upstream feed. If the MTA upstream is failing, the API serves the last good data with `"stale": true` and a `"feed_error"` string — still HTTP 200. Render the data but surface the staleness (e.g. a "data may be delayed" badge). Only treat `503` as truly unavailable.

4. **All timestamps are Unix seconds as numbers**, not ISO strings or milliseconds. `arrival_time`, `generated_at`, `timestamp`, alert `active_periods` — all seconds. Multiply by 1000 before `new Date()`. `arrival_in_seconds` is a convenience countdown already computed relative to feed generation; prefer it for "arrives in N min" UI over recomputing from `arrival_time`.

5. **Cold starts return 503 `SEEDING`.** On first boot the server downloads + imports GTFS static data (minutes). Every endpoint except `/health` returns `{"error":"...","code":"SEEDING"}` with status 503 until ready. A client should treat 503 `SEEDING` as "retry shortly," distinct from a hard failure.

## Error envelope

Every error — validation, not-found, rate-limit, upstream, seeding — is the same shape:

```json
{ "error": "human readable message", "code": "MACHINE_CODE" }
```

Branch on `code`, show `error`. Codes you'll encounter:

| HTTP | `code` | Meaning | Client should |
|---|---|---|---|
| 400 | (varies) | Bad/missing query or path param (Zod validation) | Fix the request; don't retry as-is |
| 404 | `NOT_FOUND` | Unknown stop/route, or wrong `feed` for the ID | Check `feed` matches the entity |
| 429 | `RATE_LIMITED` | >100 requests/60s from your IP | Back off until `X-RateLimit-Reset` |
| 503 | `SEEDING` | Server still importing static data | Retry after a short delay |
| 503 | `FEED_ERROR` | Upstream realtime feed unreachable, no cache to fall back on | Retry; show "temporarily unavailable" |
| 500 | `INTERNAL` | Unexpected server error | Surface generic error; report if persistent |

## Rate limits

100 requests per 60s, per client IP. `/health` is exempt. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix seconds). Don't poll `/arrivals` faster than the 20s cache TTL refreshes — there's no fresher data to get, and you'll burn your budget. A 20–30s polling interval for a live board is the sweet spot.

## Endpoints at a glance

| Method/Path | Purpose | Required | Common optional |
|---|---|---|---|
| `GET /stops` | list / search stops | — | `q`, `lat`+`lon`, `feed`, `radius`, `limit` |
| `GET /stops/:stop_id` | one stop + platforms | `feed` | — |
| `GET /routes` | list routes | — | `feed` |
| `GET /routes/:route_id` | one route | `feed` | — |
| `GET /arrivals` | upcoming arrivals at a stop | `stop`, `feed` | `limit`, `routes` |
| `GET /vehicles` | active vehicles on a route | `route`, `feed` | — |
| `GET /alerts` | service alerts | — | `routes`, `stop_id`, `direction` |
| `GET /health` | status + per-feed counts | — | — |

Full parameter rules, defaults/clamps, and response shapes are in **`references/endpoints.md`** — read it before writing the call. Quick notes:
- `/stops` is three modes by which params you pass: `lat`+`lon` → proximity (meters via `radius`, default 400, max 1600); `q` → name search; neither → all stops. `limit` defaults to 20, clamps to 50.
- `/arrivals` `limit` defaults to 5, clamps to 50. `routes` is comma-separated (`A,C,E`).
- `/alerts` `direction` is `N`/`0` (northbound) or `S`/`1` (southbound) and only matters alongside `stop_id`. Alerts carry `informed_entities` — an array of `(route_id, stop_id, direction_id)` selectors; an entry without `direction_id` affects both directions. Filter on the array, not a single top-level field.

## A typical flow

Most "what's coming at my stop" features are two calls:

1. Find the stop — `GET /stops?q=Times+Sq&feed=subway` (or `?lat=&lon=` for "near me"). Keep `feed_id` and the platform IDs from the result.
2. Get arrivals per direction — `GET /arrivals?stop=127N&feed=subway&limit=5`. Repeat for `127S` if showing both directions.

Routes and alerts are independent lookups you can fan out in parallel.

## Generating a typed client

This API ships a real OpenAPI 3.0 spec at `GET {BASE_URL}/doc`. Prefer generating types from it over hand-writing interfaces — it stays in sync with the server. For a TypeScript client:

```sh
# types only (lightweight, recommended for fetch-based clients)
npx openapi-typescript {BASE_URL}/doc -o src/mta-api.d.ts
```

Then write thin fetch wrappers using those types. A ready-to-adapt typed fetch client (with the error envelope handled, staleness surfaced, and the gotchas above baked in) lives in **`references/typescript-client.md`** — read it when the user wants more than a one-off `fetch`.

For curl probing and copy-paste examples, see the request column in `references/endpoints.md`.

## Quick examples

```sh
# Nearby subway stops (proximity)
curl "{BASE_URL}/stops?lat=40.7484&lon=-73.9967&feed=subway&radius=500"

# Next 5 downtown arrivals at Times Sq (note the directional platform id)
curl "{BASE_URL}/arrivals?stop=127S&feed=subway&limit=5"

# A/C alerts only
curl "{BASE_URL}/alerts?routes=A,C"
```

```ts
const BASE_URL = process.env.MTA_API_URL ?? "http://localhost:3000";

async function nextArrivals(platformId: string, feed: "subway" | "lirr" | "mnr") {
  const url = new URL(`${BASE_URL}/arrivals`);
  url.search = new URLSearchParams({ stop: platformId, feed, limit: "5" }).toString();

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(`${body.code}: ${body.error}`); // {error, code} envelope

  if (body.stale) console.warn("MTA data may be delayed:", body.feed_error);
  return body.arrivals; // each: { route_id, arrival_in_seconds, status, ... }
}
```
