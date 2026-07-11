## What this is

REST API over the MTA's GTFS static and realtime feeds for NYC subway, LIRR, and Metro-North. Clients get plain JSON — no protobuf, no GTFS knowledge required. No external database, no API keys.

**Stack:** Bun runtime, Hono (with `@hono/zod-openapi` and `@hono/swagger-ui`), `bun:sqlite`, `protobufjs`, `fflate` (unzip), `papaparse` (CSV).

## Commands

```sh
bun install          # install dependencies
bun run dev          # start with hot reload (auto-seeds DB if empty)
bun run start        # start without hot reload
bun run seed         # download + import all GTFS static feeds (~2-3 min)
bun run build        # bundle to dist/
bun run openapi:dump # regenerate committed openapi.json (run after route/schema changes)
bun run lint         # oxlint
bun run lint:fix     # oxlint --fix
bun test             # run all tests (bun:test)
bun run test:coverage # run tests with coverage
bun test test/utils/csv.test.ts   # run a single test file
bun run test:hurl    # black-box HTTP tests (boots a real server; needs `hurl`)
bun run test:hurl:all # ^ plus realtime smoke (hits live MTA feeds)
```

Type-check: `bunx tsc --noEmit` (no build script wired up for this).

`hurl` is a separate binary (not a package dep) — install from <https://hurl.dev>. The `test/e2e/` suites test the real HTTP surface (status codes, `{error,code}` envelope, headers) that in-process `bun:test` can't reach; see `test/e2e/README.md`.

### Environment variables

Copy `.env.example` to `.env`. All have defaults so the server starts without one.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `DB_PATH` | `./data/mta.db` | Use `:memory:` for ephemeral dev |
| `RT_CACHE_TTL_MS` | `20000` | RT feed cache TTL |
| `RT_FETCH_TIMEOUT_MS` | `10000` | Upstream RT fetch timeout (abort) |
| `STATIC_FETCH_TIMEOUT_MS` | `60000` | Upstream static GTFS zip fetch timeout (abort); used by `bun run seed` and CI |
| `RATE_LIMIT_MAX` | `100` | Requests per window per client IP (per-instance) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit fixed-window length |

## Architecture

### Two data layers

1. **Static GTFS** — SQLite (`bun:sqlite`). Stops, routes, trips, stop_times, calendar tables. The server itself never writes to this DB — it only reads a prebuilt one: CI (`.github/workflows/build-db.yml`) runs the build (download ZIPs from MTA S3, unzip with `fflate`, parse CSV with `papaparse`, bulk-insert) and publishes the resulting `mta.db` to a bucket; each instance downloads it on boot (`start.sh` → `scripts/fetch-db.ts`). Locally, `bun run seed` runs the same build logic (still in `static.service.ts`) directly against your dev DB. All tables are keyed by `(feed_id, ...)` because the MTA reuses IDs across feeds.

2. **Realtime GTFS-RT** — In-memory cache (`src/cache/rtCache.ts`). Binary protobuf decoded via `protobufjs` from `src/proto/gtfs-realtime.proto`. Fetched on demand with a 20s TTL. Promise deduplication prevents parallel upstream fetches for the same feed path. Stale cache is served with `stale: true` when upstream fails.

### Feed scoping

The MTA has overlapping IDs across subway/LIRR/MNR (e.g. `stop_id=1` exists in all three). Every query that resolves a specific entity requires a `feed` param (`subway`, `lirr`, `mnr`). Collection endpoints default to cross-feed.

### Route → RT feed mapping

Subway routes map to specific RT feed paths (e.g. A/C/E → `nyct/gtfs-ace`). This mapping lives in `src/services/feed.service.ts` as `SUBWAY_ROUTE_TO_FEED`. LIRR and MNR each have a single feed path.

### Key patterns

- Routes use `OpenAPIHono` + `createRoute()` with Zod schemas in `src/schemas/api.ts`. Response types in `src/types/api.ts` are the original TypeScript interfaces (still used by services). Status codes in handlers must use `as const` (e.g. `c.json(data, 200 as const)`) for type narrowing.
- OpenAPI spec served at `GET /doc`, Swagger UI at `GET /ui`. The doc metadata lives in `src/openapi.ts` (`openApiDocConfig`), shared by `index.ts` and the static dump. `bun run openapi:dump` writes the committed `openapi.json` (the codegen artifact) via `buildOpenApiDocument()`, which mounts the routers without booting the server and normalizes Hono `:param` path keys to OpenAPI `{param}`. Regenerate it after any route or schema change.
- Subway stops have a parent/platform hierarchy (parent station → N/S platforms). LIRR and MNR use a flat stop model.
- Tests use `bun:test` and live in `test/`, mirroring the source structure. `bunfig.toml` preloads `test/setup.ts` before every test run — it sets `DB_PATH=:memory:` and runs migrations so tests never touch the real DB.
- Test helpers: `test/helpers/seed.ts` exports `resetDb()`, `seedSubway()`, `seedLirr()`, `seedMnr()` for fixture setup. `test/helpers/app.ts` exports `makeTestApp(router, mountPath)` to mount a single router for isolated route tests.
- The `data/` directory (SQLite DB) is gitignored and created automatically on first run.

### Adding schema changes

Schema DDL lives in `src/db/schema.ts` as `CREATE TABLE IF NOT EXISTS` statements. `runMigrations()` in `src/db/client.ts` runs them on startup. For breaking column changes, add detection logic to `runMigrations()` alongside the existing `hasColumn` check (see the `feed_id` migration as an example).

## Git

Commit messages always use the [Conventional Commits](https://www.conventionalcommits.org/) spec:

```
<type>(<scope>): <description>

[optional body]
```

Common types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `perf`, `ci`. Scope is optional but encouraged (e.g. `alerts`, `stops`, `seed`, `rt`). Keep the subject line under 72 characters, imperative mood, no trailing period.
