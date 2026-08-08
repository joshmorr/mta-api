import { Database } from 'bun:sqlite';
import { config } from '../config';
import {
  CREATE_STOPS,
  CREATE_ROUTES,
  CREATE_TRIPS,
  CREATE_STOP_TIMES,
  CREATE_CALENDAR,
  CREATE_CALENDAR_DATES,
  CREATE_FEED_META,
  CREATE_TRANSFERS,
  CREATE_INDEXES,
} from './schema';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

function createDb(): Database {
  if (config.dbPath !== ':memory:') {
    mkdirSync(dirname(config.dbPath), { recursive: true });
  }
  const db = new Database(config.dbPath, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  // Two connections now share the DB file (main thread reads, sync worker writes).
  // WAL already permits concurrent reader+writer; this is defensive against
  // transient SQLITE_BUSY (e.g. during a WAL checkpoint).
  db.run('PRAGMA busy_timeout = 5000');
  return db;
}

export const db = createDb();

function hasColumn(tableName: string, columnName: string): boolean {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function tableExists(tableName: string): boolean {
  const row = db
    .query<{ name: string }, [string]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return row != null;
}

function recreateStaticTables() {
  db.run('DROP TABLE IF EXISTS stop_times');
  db.run('DROP TABLE IF EXISTS trips');
  db.run('DROP TABLE IF EXISTS calendar_dates');
  db.run('DROP TABLE IF EXISTS calendar');
  db.run('DROP TABLE IF EXISTS routes');
  db.run('DROP TABLE IF EXISTS stops');
  db.run('DROP TABLE IF EXISTS transfers');
}

export function resetStaticData() {
  db.run('DELETE FROM stop_times');
  db.run('DELETE FROM trips');
  db.run('DELETE FROM calendar_dates');
  db.run('DELETE FROM calendar');
  db.run('DELETE FROM routes');
  db.run('DELETE FROM stops');
  db.run('DELETE FROM transfers');
  db.run('DELETE FROM feed_meta');
}

/**
 * Collect query-planner statistics into `sqlite_stat1`.
 *
 * Without stats SQLite falls back on fixed guesses about how selective each
 * column is, and it has no way to know that `stop_times.feed_id` has only three
 * distinct values — so `feed_id = 'subway'` looks selective when it actually
 * matches 84% of the table. That mis-estimate made the planner walk the whole
 * feed via the primary-key autoindex on the arrivals hot path instead of
 * seeking on (feed_id, stop_id).
 *
 * Deliberately *not* called from runMigrations(): stats belong to the data, not
 * the schema. The server only ever reads a prebuilt DB, and running ANALYZE
 * against an empty or freshly-migrated database would write stats describing no
 * rows — worse than having none. This is a build-time step, invoked at the end
 * of `bun run seed` once every feed is imported. `VACUUM INTO` copies
 * `sqlite_stat1` like any other table, so the stats survive into the published
 * artifact.
 */
export function analyzeDb() {
  db.run('ANALYZE');
}

/**
 * `allowDestructiveRebuild` gates dropping+recreating the static tables when their
 * shape is out of date (see `needsRebuild` below). It defaults to false because
 * dropping data is only safe when something is about to repopulate it — true for
 * `scripts/seed.ts` (which deletes and reimports every feed right after this
 * runs) but not for server boot (`startup.ts`, `mcp/stdio.ts`), which only ever
 * reads a DB that fetch-db.ts already placed on disk. On Fly, a code deploy that
 * adds a required column can land *before* the next daily DB rebuild publishes a
 * matching DB (schema and data are built/published independently, on different
 * schedules) — if boot dropped tables in that window it would erase the prebuilt
 * DB with nothing able to refill it, turning a same-day schema bump into a full
 * outage. Boot instead logs a warning and leaves the existing (possibly
 * old-shape) data in place; queries touching the missing column fail until a
 * matching DB is downloaded, but every other endpoint keeps serving.
 */
export function runMigrations(opts: { allowDestructiveRebuild?: boolean } = {}) {
  // A brand-new DB (no `stops` table yet) just needs the schema created below —
  // there's no existing data to lose, so this is never a "rebuild".
  const needsRebuild =
    tableExists('stops')
    && (
      (hasColumn('stops', 'stop_id') && !hasColumn('stops', 'feed_id'))
      || !hasColumn('stop_times', 'departure_seconds')
      || !hasColumn('trips', 'trip_headsign')
    );

  if (needsRebuild) {
    if (opts.allowDestructiveRebuild) {
      recreateStaticTables();
    } else {
      console.error(
        '[migrations] WARNING: existing schema is missing columns the current code ' +
        'expects (stops.feed_id / stop_times.departure_seconds / trips.trip_headsign). ' +
        'Refusing to drop existing data outside `bun run seed` — queries touching the ' +
        'missing column(s) will fail until a DB built from the current schema is loaded.',
      );
    }
  }

  db.run(CREATE_STOPS);
  db.run(CREATE_ROUTES);
  db.run(CREATE_TRIPS);
  db.run(CREATE_STOP_TIMES);
  db.run(CREATE_CALENDAR);
  db.run(CREATE_CALENDAR_DATES);
  db.run(CREATE_FEED_META);
  db.run(CREATE_TRANSFERS);
  for (const idx of CREATE_INDEXES) {
    db.run(idx);
  }
}
