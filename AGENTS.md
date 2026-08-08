## What this is

REST API over the MTA's GTFS static and realtime feeds for NYC subway, LIRR, and Metro-North. Clients get plain JSON — no protobuf, no GTFS knowledge required. No external database, no API keys.

**Stack:** Bun runtime, Hono (with `@hono/zod-openapi` and `@hono/swagger-ui`), `bun:sqlite`, `protobufjs`, `fflate` (unzip), `papaparse` (CSV).

## Commands

```sh
bun install          # install dependencies
bun run dev          # start with hot reload (auto-seeds DB if empty)
bun run start        # start without hot reload
bun run seed         # download + import all GTFS static feeds (~2-3 min)
bun run mcp          # MCP server over stdio (JSON-RPC on stdin/stdout)
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
| `RT_CACHE_TTL_MS` | `10000` | RT cache TTL for the vehicle feeds |
| `ALERTS_RT_CACHE_TTL_MS` | `30000` | RT cache TTL for the service alerts feed only (publishes far less often) |
| `RT_FETCH_TIMEOUT_MS` | `10000` | Upstream RT fetch timeout (abort) |
| `STATIC_FETCH_TIMEOUT_MS` | `60000` | Upstream static GTFS zip fetch timeout (abort); used by `bun run seed` and CI |
| `RATE_LIMIT_MAX` | `100` | Requests per window per client IP (per-instance) |
| `MCP_RATE_LIMIT_MAX` | `5 × RATE_LIMIT_MAX` | Ceiling for `POST /mcp`, which gets its own per-IP bucket (HTTP transport only) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit fixed-window length |

## Architecture

### Two data layers

1. **Static GTFS** — SQLite (`bun:sqlite`). Stops, routes, trips, stop_times, calendar tables. The server itself never writes to this DB — it only reads a prebuilt one: CI (`.github/workflows/build-db.yml`) runs the build (download ZIPs from MTA S3, unzip with `fflate`, parse CSV with `papaparse`, bulk-insert) and publishes the resulting `mta.db` to a bucket; each instance downloads it on boot (`start.sh` → `scripts/fetch-db.ts`). Locally, `bun run seed` runs the same build logic (still in `static.service.ts`) directly against your dev DB. All tables are keyed by `(feed_id, ...)` because the MTA reuses IDs across feeds.

2. **Realtime GTFS-RT** — In-memory cache (`src/cache/rtCache.ts`). Binary protobuf decoded via `protobufjs` from `src/proto/gtfs-realtime.proto`. Fetched on demand with a 10s TTL (alerts 30s — see `getRtCacheTtlMs` in `src/services/feed.service.ts`; both are env-tunable). Promise deduplication prevents parallel upstream fetches for the same feed path. Stale cache is served with `stale: true` when upstream fails.

### Feed scoping

The MTA has overlapping IDs across subway/LIRR/MNR (e.g. `stop_id=1` exists in all three). Every query that resolves a specific entity requires a `feed` param (`subway`, `lirr`, `mnr`). Collection endpoints default to cross-feed.

### Route → RT feed mapping

Subway routes map to specific RT feed paths (e.g. A/C/E → `nyct/gtfs-ace`). This mapping lives in `src/services/feed.service.ts` as `SUBWAY_ROUTE_TO_FEED`. LIRR and MNR each have a single feed path.

### Services are the shared layer

`src/services/` holds the business logic, and there are two presentations of it: the HTTP routers in `src/routes/` and the MCP tools in `src/mcp/`. Neither calls the other and neither goes over the network. A handler validates, calls a service, and wraps the result in its own envelope; services return data or `null` and throw, and know nothing about HTTP or MCP.

Put new logic in a service, not in a handler — a handler-only implementation is invisible to the MCP tools, which is exactly the state stops/routes/alerts were in before `src/mcp/` existed.

### MCP server

`src/mcp/tools.ts` registers nine read-only tools (the API's entity endpoints minus `/health`) via `registerMtaTools()`. `src/mcp/server.ts` exports the `buildMcpServer()` factory, used by both transports:

- **stdio** — `src/mcp/stdio.ts`, wired as the `mta-mcp` bin and `bun run mcp`. A client launches it as a subprocess.
- **HTTP** — `POST /mcp` in `src/index.ts`, via the SDK's web-standard fetch face (`createMcpHandler(...).fetch` takes a `Request` and returns a `Response`, so it drops straight into Hono).

Constraints worth knowing before editing:

- **`src/mcp/stdio.ts` must not import `src/index.ts`.** That runs `startup()` as an import side effect, which calls `process.exit(1)` on an empty DB — a tool client would just see the subprocess die. It runs `runMigrations()` itself and treats an empty DB as a stderr warning.
- **Nothing may write to stdout** on the stdio path; that is the JSON-RPC channel. Log to stderr.
- Tool *input* schemas live in `src/mcp/schemas.ts` and are written fresh — the request schemas in `src/schemas/api.ts` are full of `z.coerce` for query-string parsing, which would wrongly accept a string where MCP delivers a typed number. Response schemas *are* reused from `src/schemas/api.ts` as `outputSchema`.
- `src/schemas/api.ts` must import `z` from `@hono/zod-openapi`, not from `zod`. `.openapi()` is patched onto the prototype by that package; importing `zod` directly only works if some other module imported `@hono/zod-openapi` first.
- The MCP endpoint is deliberately absent from `openapi.json` — `/doc` describes the REST surface, and MCP clients discover capabilities by handshake. Adding a tool does not require `bun run openapi:dump`.

### Key patterns

- Routes use `OpenAPIHono` + `createRoute()` with Zod schemas in `src/schemas/api.ts`. Response types in `src/types/api.ts` are the original TypeScript interfaces (still used by services). Status codes in handlers must use `as const` (e.g. `c.json(data, 200 as const)`) for type narrowing.
- OpenAPI spec served at `GET /doc`, Swagger UI at `GET /ui`. The doc metadata lives in `src/openapi.ts` (`openApiDocConfig`), shared by `index.ts` and the static dump. `bun run openapi:dump` writes the committed `openapi.json` (the codegen artifact) via `buildOpenApiDocument()`, which mounts the routers without booting the server and normalizes Hono `:param` path keys to OpenAPI `{param}`. Regenerate it after any route or schema change.
- Subway stops have a parent/platform hierarchy (parent station → N/S platforms). LIRR and MNR use a flat stop model.
- Tests use `bun:test` and live in `test/`, mirroring the source structure. `bunfig.toml` preloads `test/setup.ts` before every test run — it sets `DB_PATH=:memory:` and runs migrations so tests never touch the real DB.
- Test helpers: `test/helpers/seed.ts` exports `resetDb()`, `seedSubway()`, `seedLirr()`, `seedMnr()` for fixture setup. `test/helpers/app.ts` exports `makeTestApp(router, mountPath)` to mount a single router for isolated route tests. `test/helpers/mcp.ts` exports `makeMcpClient()`, a JSON-RPC client over the MCP handler — build one per test file and close it in `afterAll`, since bun runs every file in one process and a shared handler gets closed out from under files that haven't finished.
- The RT cache (`src/cache/rtCache.ts`) is module-level and shared across every test file in a run, and entries expire against `Date.now`. Suites that stub the clock pin it to offsets from a common base, so a file that leaves an entry at a later offset poisons any file that pins earlier — that entry still looks fresh. Call `__resetRtCacheForTests()` in `beforeEach`/`afterAll` rather than relying on ever-increasing offsets.
- The `data/` directory (SQLite DB) is gitignored and created automatically on first run.

### Adding schema changes

Schema DDL lives in `src/db/schema.ts` as `CREATE TABLE IF NOT EXISTS` statements. `runMigrations()` in `src/db/client.ts` runs them on startup. For breaking column changes, add detection logic to `runMigrations()` alongside the existing `hasColumn` check (see the `feed_id` migration as an example).

Indexes live in the same file as `CREATE_INDEXES` and are created by `runMigrations()` too, so a new one is built on the next boot (~1.8s for a `stop_times` index; subsequent boots are free via `IF NOT EXISTS`).

Query planner statistics are a *build*-time concern, not a schema one: `bun run seed` calls `analyzeDb()` after every feed is imported, and `VACUUM INTO` carries `sqlite_stat1` into the published artifact. Don't move `ANALYZE` into `runMigrations()` — the server only reads a prebuilt DB, and analyzing a freshly-migrated empty one writes stats describing no rows. Without stats SQLite falls back on fixed guesses; that's what made the arrivals path walk all 2.47M subway `stop_times` rows instead of seeking (158ms → 10.8ms once fixed). If you add an index that a hot query depends on, check `EXPLAIN QUERY PLAN` against a *seeded* DB — plans on the small test fixtures don't reflect the real ones.

## Git

Commit messages always use the [Conventional Commits](https://www.conventionalcommits.org/) spec:

```
<type>(<scope>): <description>

[optional body]
```

Common types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `perf`, `ci`. Scope is optional but encouraged (e.g. `alerts`, `stops`, `seed`, `rt`). Keep the subject line under 72 characters, imperative mood, no trailing period.
