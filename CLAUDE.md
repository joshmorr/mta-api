# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

REST API over the MTA's GTFS static and realtime feeds for NYC subway, LIRR, and Metro-North. Clients get plain JSON — no protobuf, no GTFS knowledge required. No external database, no API keys.

**Stack:** Bun runtime, Hono (with `@hono/zod-openapi`), `bun:sqlite`, `protobufjs`, `fflate`.

## Commands

```sh
bun install          # install dependencies
bun run dev          # start with hot reload (auto-seeds DB if empty)
bun run start        # start without hot reload
bun run seed         # download + import all GTFS static feeds (~2-3 min)
bun run build        # bundle to dist/
bun run lint         # eslint
bun run lint:fix     # eslint --fix
bun test             # run all tests (bun:test)
bun test src/test/utils/csv.test.ts   # run a single test file
```

Type-check: `bunx tsc --noEmit` (no build script wired up for this).

## Architecture

### Two data layers

1. **Static GTFS** — SQLite (`bun:sqlite`). Stops, routes, trips, stop_times, calendar tables. Populated by downloading ZIP files from MTA S3, unzipping with `fflate`, parsing CSV, and bulk-inserting. Auto-refreshes on intervals (subway hourly, rail daily). All tables are keyed by `(feed_id, ...)` because the MTA reuses IDs across feeds.

2. **Realtime GTFS-RT** — In-memory cache (`src/cache/rtCache.ts`). Binary protobuf decoded via `protobufjs` from `src/proto/gtfs-realtime.proto`. Fetched on demand with a 20s TTL. Promise deduplication prevents parallel upstream fetches for the same feed path. Stale cache is served with `stale: true` when upstream fails.

### Feed scoping

The MTA has overlapping IDs across subway/LIRR/MNR (e.g. `stop_id=1` exists in all three). Every query that resolves a specific entity requires a `feed` param (`subway`, `lirr`, `mnr`). Collection endpoints default to cross-feed.

### Route → RT feed mapping

Subway routes map to specific RT feed paths (e.g. A/C/E → `nyct/gtfs-ace`). This mapping lives in `src/services/feed.service.ts` as `SUBWAY_ROUTE_TO_FEED`. LIRR and MNR each have a single feed path.

### Key patterns

- Routes use `OpenAPIHono` + `createRoute()` with Zod schemas in `src/schemas/api.ts`. Response types in `src/types/api.ts` are the original TypeScript interfaces (still used by services). Status codes in handlers must use `as const` (e.g. `c.json(data, 200 as const)`) for type narrowing.
- OpenAPI spec served at `GET /doc`, Swagger UI at `GET /ui`.
- Subway stops have a parent/platform hierarchy (parent station → N/S platforms). LIRR and MNR use a flat stop model.
- Tests use `bun:test` and live in `src/test/`, mirroring the source structure.
- The `data/` directory (SQLite DB) is gitignored and created automatically on first run.
