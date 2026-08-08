import { describe, expect, it, afterAll } from 'bun:test';
import { db, runMigrations } from '../../src/db/client';

function toLegacyStopsSchema() {
  // Tear down to a known-bad state
  db.run('DROP TABLE IF EXISTS stop_times');
  db.run('DROP TABLE IF EXISTS trips');
  db.run('DROP TABLE IF EXISTS calendar_dates');
  db.run('DROP TABLE IF EXISTS calendar');
  db.run('DROP TABLE IF EXISTS routes');
  db.run('DROP TABLE IF EXISTS stops');
  db.run('DROP TABLE IF EXISTS feed_meta');
  db.run(
    // Legacy stops schema: no feed_id column
    `CREATE TABLE stops (
       stop_id        TEXT PRIMARY KEY,
       stop_name      TEXT NOT NULL,
       stop_lat       REAL,
       stop_lon       REAL,
       location_type  INTEGER,
       parent_station TEXT
     )`,
  );
  db.run(`INSERT INTO stops (stop_id, stop_name) VALUES ('127', 'Times Sq-42 St')`);
}

/**
 * Exercises the legacy-schema rebuild path in db/client.ts:
 *
 *   const needsRebuild =
 *     tableExists('stops')
 *     && (hasColumn('stops', 'stop_id') && !hasColumn('stops', 'feed_id') || ...);
 *
 * To trigger it we drop everything and recreate `stops` in the legacy
 * shape (no feed_id), then call runMigrations() and verify the table
 * was recreated with feed_id present.
 *
 * Because db is a module-level singleton shared across tests, the
 * afterAll restores the schema by running the standard migrations,
 * which leaves the in-memory DB in the expected state for any
 * subsequent test files.
 */
describe('runMigrations — legacy-schema rebuild', () => {
  afterAll(() => {
    runMigrations({ allowDestructiveRebuild: true });
  });

  it('drops and recreates static tables when explicitly allowed (bun run seed path)', () => {
    toLegacyStopsSchema();

    // Sanity check: legacy stops exists, has stop_id, no feed_id
    const legacyCols = db.query<{ name: string }, []>(`PRAGMA table_info(stops)`).all();
    expect(legacyCols.some((c) => c.name === 'stop_id')).toBe(true);
    expect(legacyCols.some((c) => c.name === 'feed_id')).toBe(false);

    runMigrations({ allowDestructiveRebuild: true });

    const newCols = db.query<{ name: string }, []>(`PRAGMA table_info(stops)`).all();
    expect(newCols.some((c) => c.name === 'feed_id')).toBe(true);
    // All companion tables came back too
    for (const t of ['routes', 'trips', 'stop_times', 'calendar', 'calendar_dates', 'feed_meta']) {
      const exists = db
        .query<{ name: string }, [string]>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
        )
        .get(t);
      expect(exists?.name).toBe(t);
    }
  });

  it('leaves existing data alone by default (server-boot path)', () => {
    toLegacyStopsSchema();

    // Default call — as used by startup.ts and mcp/stdio.ts — must not drop
    // the legacy table, even though its shape is out of date. There is no
    // reseed step after server boot, so dropping here would just delete data
    // with nothing to replace it.
    runMigrations();

    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(stops)`).all();
    expect(cols.some((c) => c.name === 'feed_id')).toBe(false);
    const row = db.query<{ stop_id: string }, []>(`SELECT stop_id FROM stops`).get();
    expect(row?.stop_id).toBe('127');
  });

  it('does not warn or rebuild on a brand-new DB with no stops table yet', () => {
    db.run('DROP TABLE IF EXISTS stop_times');
    db.run('DROP TABLE IF EXISTS trips');
    db.run('DROP TABLE IF EXISTS calendar_dates');
    db.run('DROP TABLE IF EXISTS calendar');
    db.run('DROP TABLE IF EXISTS routes');
    db.run('DROP TABLE IF EXISTS stops');
    db.run('DROP TABLE IF EXISTS feed_meta');

    runMigrations();

    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(stops)`).all();
    expect(cols.some((c) => c.name === 'feed_id')).toBe(true);
  });
});
