import { describe, expect, it, beforeEach } from 'bun:test';
import { getDbCounts } from '../../../db/queries/health';
import { db } from '../../../db/client';
import { resetDb, seedSubway, seedLirr, seedMnr } from '../../helpers/seed';

describe('db/queries/health.getDbCounts', () => {
  beforeEach(() => {
    resetDb();
  });

  it('returns zeros when DB is empty', () => {
    expect(getDbCounts()).toEqual({
      totalStops: 0,
      totalRoutes: 0,
      subwayStops: 0,
      subwayRoutes: 0,
      lirrStops: 0,
      lirrRoutes: 0,
      mnrStops: 0,
      mnrRoutes: 0,
    });
  });

  it('counts subway parent stations only (not platforms)', () => {
    seedSubway(); // 1 parent + 2 platforms
    const counts = getDbCounts();
    expect(counts.subwayStops).toBe(1);
    expect(counts.subwayRoutes).toBe(1);
    // Total should also count only the parent, not platforms
    expect(counts.totalStops).toBe(1);
  });

  it('counts LIRR/MNR flat stops (parent_station NULL or empty)', () => {
    seedLirr(); // 2 stops
    seedMnr(); // 2 stops
    const counts = getDbCounts();
    expect(counts.lirrStops).toBe(2);
    expect(counts.mnrStops).toBe(2);
    expect(counts.totalStops).toBe(4); // no subway parents
  });

  it('aggregates totals across feeds', () => {
    seedSubway();
    seedLirr();
    seedMnr();
    const counts = getDbCounts();
    expect(counts.totalStops).toBe(1 + 2 + 2); // subway parent + lirr + mnr
    expect(counts.totalRoutes).toBe(3);
  });

  it('treats LIRR rows with empty-string parent_station as flat stops', () => {
    db.run(
      `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
       VALUES ('lirr', 'X', 'Test', 0, 0, 0, '')`,
    );
    expect(getDbCounts().lirrStops).toBe(1);
  });

  it('does NOT count subway platforms toward subwayStops', () => {
    db.run(
      `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
       VALUES
         ('subway', 'A',  'A station', 0, 0, 1, NULL),
         ('subway', 'AN', 'A platform N', 0, 0, 0, 'A')`,
    );
    expect(getDbCounts().subwayStops).toBe(1);
  });
});
