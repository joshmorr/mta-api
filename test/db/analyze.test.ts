import { describe, expect, it, beforeAll } from 'bun:test';
import { analyzeDb, db, runMigrations } from '../../src/db/client';
import { resetDb, seedSubway } from '../helpers/seed';

/**
 * Guards the two halves of the arrivals-path index fix:
 *
 *   1. the covering index (feed_id, stop_id, trip_id) exists after migrations, and
 *   2. analyzeDb() populates sqlite_stat1 so the planner can choose it.
 *
 * Without stats the planner mis-estimated feed_id as selective and walked the
 * whole feed via the primary-key autoindex — 162ms per /arrivals request against
 * the production DB, versus ~11ms once both are in place.
 */
describe('query planner statistics', () => {
  beforeAll(() => {
    runMigrations();
    resetDb();
    seedSubway();
  });

  it('creates the stop_times covering index', () => {
    const idx = db
      .query<{ name: string }, [string]>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = ?`,
      )
      .get('idx_stop_times_stop_trip');

    expect(idx?.name).toBe('idx_stop_times_stop_trip');
  });

  it('indexes exactly (feed_id, stop_id, trip_id), in that order', () => {
    // Column order is the whole point: the served-routes query constrains
    // feed_id and stop_id, so those must be the leftmost prefix for SQLite to
    // seek rather than scan. trip_id trails to make the index covering.
    const cols = db
      .query<{ seqno: number; name: string }, []>(`PRAGMA index_info(idx_stop_times_stop_trip)`)
      .all();

    expect(cols.map((c) => c.name)).toEqual(['feed_id', 'stop_id', 'trip_id']);
  });

  it('analyzeDb() writes stats for stop_times', () => {
    db.run('DROP TABLE IF EXISTS sqlite_stat1');

    analyzeDb();

    const stats = db
      .query<{ idx: string; stat: string }, []>(
        `SELECT idx, stat FROM sqlite_stat1 WHERE tbl = 'stop_times'`,
      )
      .all();

    expect(stats.length).toBeGreaterThan(0);
    expect(stats.some((s) => s.idx === 'idx_stop_times_stop_trip')).toBe(true);
  });

  it('resolves the served-routes lookup through the covering index', () => {
    analyzeDb();

    const stmt = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT DISTINCT t.route_id
         FROM stop_times st
         JOIN trips t ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
        WHERE st.feed_id = ? AND st.stop_id IN (?)`,
    );
    const plan = stmt.all('subway', '127N') as { detail: string }[];
    stmt.finalize();

    const stopTimesStep = plan.find((p) => / st\b/.test(p.detail));

    // Assert the *index chosen*, not the columns bound. On a fixture this small
    // SQLite reorders the join and binds trip_id first, so the bound-column list
    // reads the same whether or not the covering index exists — only the index
    // name distinguishes the fixed plan from the pre-fix one, which fell through
    // to sqlite_autoindex_stop_times_1.
    //
    // This is a proxy for the production behaviour, not a reproduction of it:
    // the real planner decision turns on 2.9M rows and their actual
    // distribution, and was verified by benchmark rather than here.
    expect(stopTimesStep?.detail).toContain('idx_stop_times_stop_trip');
  });
});
