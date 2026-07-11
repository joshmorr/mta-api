import { describe, expect, it, afterAll } from 'bun:test';
import { db, runMigrations } from '../../src/db/client';

/**
 * Exercises the legacy-schema rebuild path in db/client.ts:
 *
 *   const needsRebuild =
 *     hasColumn('stops', 'stop_id') && !hasColumn('stops', 'feed_id');
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
    runMigrations();
  });

  it('drops and recreates static tables when stops lacks feed_id', () => {
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

    // Sanity check: legacy stops exists, has stop_id, no feed_id
    const legacyCols = db.query<{ name: string }, []>(`PRAGMA table_info(stops)`).all();
    expect(legacyCols.some((c) => c.name === 'stop_id')).toBe(true);
    expect(legacyCols.some((c) => c.name === 'feed_id')).toBe(false);

    runMigrations();

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
});
