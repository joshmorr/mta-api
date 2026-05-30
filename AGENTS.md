# AGENTS.md

## Commands

```sh
bun install
bun run dev          # hot reload; auto-seeds DB if empty
bun run start
bun run seed         # download + import all GTFS static feeds (~2-3 min)
bun run build        # bundles to dist/
bun run lint         # oxlint src/ scripts/  (NOT eslint — CLAUDE.md is wrong)
bun run lint:fix
bun test
bun test src/test/utils/csv.test.ts   # single test file
bun test --coverage
bunx tsc --noEmit    # type-check only (no build script for this)
```

## Architecture

### Two data layers
- **Static GTFS** — SQLite (`bun:sqlite`), populated from MTA S3 ZIPs. Tables keyed on `(feed_id, ...)` because the MTA reuses IDs (`stop_id=1` exists in subway, lirr, and mnr). Every single-entity query **must** include `feed_id`; omitting it silently returns rows from the wrong feed.
- **Realtime GTFS-RT** — In-memory cache (`src/cache/rtCache.ts`). 20s TTL, promise deduplication, stale fallback. `__resetRtCacheForTests()` is the test-only escape hatch.

### Dual type system — kept manually in sync
- `src/schemas/api.ts` — Zod schemas used by `createRoute()` for OpenAPI and request validation.
- `src/types/api.ts` — plain TypeScript interfaces used by services. Same shapes, not derived from each other.
- The union `'subway' | 'lirr' | 'mnr'` is `FeedId` in `types/gtfs.ts` and `FeedType` in `types/api.ts`. They are not aliased.

### Subway vs. LIRR/MNR stops
- Subway: hierarchical. `location_type=1` = parent station (what the API returns in listings). `location_type=0` = N/S platform (children, used in arrivals).
- LIRR/MNR: flat. All stops have `location_type=0`, no `parent_station`. `getPlatforms()` returns empty for these feeds.
- `SEARCHABLE_STOP_CONDITION` in `src/db/queries/stops.ts` encodes this difference — touch it carefully.

### Route → RT feed mapping
Subway routes map to specific RT paths (A/C/E → `nyct/gtfs-ace`). Mapping lives in `src/services/feed.service.ts` as `SUBWAY_ROUTE_TO_FEED`. Routes not in the map are silently skipped. LIRR and MNR always use a single path.

## Critical Hono Patterns

Every `c.json()` call **requires** `as const` on the status code:
```ts
return c.json(data, 200 as const);
return c.json({ error: "Not found" }, 404 as const);
```
Without it, TypeScript widens the status to `number` and the type check fails against the `createRoute()` response declarations.

Literal strings in responses must also be `as const`:
```ts
return c.json({ status: 'ok' as const }, 200 as const);  // HealthResponseSchema has z.literal('ok')
```

## Test Patterns

### Setup
`bunfig.toml` sets `[test] preload = ["./src/test/setup.ts"]`. The preload sets `process.env.DB_PATH = ':memory:'` and runs migrations before any test module loads. Tests never touch the filesystem DB.

### Isolation
- DB tests call `resetDb()` in `beforeEach`. The DB singleton is shared across the whole `bun test` run — skipping cleanup will leak state to other files.
- Route tests use `makeTestApp(router, '/mount')` from `src/test/helpers/app.ts`. Never import `src/index.ts` in tests — it calls `startup()` which registers real `setInterval` timers.

### Fixtures (`src/test/helpers/seed.ts`)
- `resetDb()` → `seedSubway()` / `seedLirr()` / `seedMnr()`
- Subway fixture calendar (`WKDY`) has `saturday=0, sunday=0`. Tests that need the fixture active on weekends must UPDATE manually:
  ```ts
  db.run("UPDATE calendar SET saturday = 1, sunday = 1 WHERE service_id = 'WKDY'");
  ```

### RT mocking
Tests mock `globalThis.fetch` to return a real protobuf-encoded `ArrayBuffer` built from the actual `.proto` file — the real decode path is exercised. `currentStatus` in vehicle payloads must be an integer (`0 | 1 | 2`), not the string name; cast with `as never` to satisfy TypeScript.

### Clock pinning
Tests pin `Date.now` to control calendar service date matching and RTCache TTL. Restore in `afterAll`/`afterEach`.

### `migrations.test.ts`
Drops and recreates tables with a legacy schema inside the test, then restores in `afterAll`. This modifies the shared in-memory DB — execution order relative to other DB tests matters.

## Protobuf / Runtime Quirks

- `import.meta.dir` (Bun-specific) is used to locate `src/proto/gtfs-realtime.proto` at runtime and in tests. Adjust relative depth accordingly.
- `VehiclePosition.currentStatus` decodes as an integer (`0 | 1 | 2`). A `VEHICLE_STOP_STATUS` map in `realtime.service.ts` converts to the string union.
- `directionId` is checked with `Object.prototype.hasOwnProperty.call(entity, 'directionId')` because protobufjs exposes scalar defaults via the prototype — field presence can't be detected with a simple truthiness check.
- protobufjs `Long` values need `toNumber()` from `src/utils/realtime.ts` before arithmetic.

## Other Gotchas

- **Linter is `oxlint`**, not ESLint. No `.eslintrc` or `eslint.config.*` exists.
- **`route_color` is stored with a `#` prefix** (`upsertRoutes` prepends it). GTFS CSV has raw hex without `#`.
- **Late-night service**: `getRelevantServiceDates()` includes the previous calendar day when NY hour < 5, to handle `stop_times` entries with values like `25:30:00`.
- **503 during seeding**: While `state.seeding = true`, all routes except `/health` return `{ error: "Service is seeding initial data", code: "SEEDING" }`.
- **Stale RT**: When an upstream fetch fails but a prior cache entry exists, arrivals still return with `stale: true`. When there is no cache at all, the service throws and the route returns 503.
- **Rate limiter is in-process** (a module-level `Map`). All requests without a proxy share one bucket keyed on `'unknown'`.
- **`data/` is gitignored and auto-created** by `client.ts` via `mkdirSync(..., { recursive: true })`.
- **`console.error` for logging** (not `console.log`) — intentional to keep stdout clean.

## Commit Style

Conventional Commits with scope: `feat(alerts): ...`, `fix(seed): ...`. Subject ≤72 chars, imperative mood, no trailing period.
