import { describe, expect, it, beforeEach } from 'bun:test';
import { getAllRoutes, findRoutesById, getRouteById } from '../../../src/db/queries/routes';
import { db } from '../../../src/db/client';
import { resetDb, seedSubway, seedLirr, seedMnr } from '../../helpers/seed';

describe('db/queries/routes', () => {
  beforeEach(() => {
    resetDb();
  });

  describe('getAllRoutes', () => {
    it('returns all routes across feeds when no type filter', () => {
      seedSubway();
      seedLirr();
      seedMnr();
      const rows = getAllRoutes();
      expect(rows.map((r) => `${r.feed_id}:${r.route_id}`).sort()).toEqual([
        'lirr:PW',
        'mnr:HUDSON',
        'subway:1',
      ]);
    });

    it('filters by feed when type is provided', () => {
      seedSubway();
      seedLirr();
      const rows = getAllRoutes('lirr');
      expect(rows).toHaveLength(1);
      expect(rows[0].feed_id).toBe('lirr');
    });

    it('returns [] when no routes exist', () => {
      expect(getAllRoutes()).toEqual([]);
    });

    it('orders feed-filtered results by COALESCE(short_name, long_name, route_id)', () => {
      // Seed two subway routes — Z (short_name) and A (short_name)
      db.run(
        `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
         VALUES
           ('subway', 'Z', 'NYCT', 'Z', 'Nassau St Express', NULL, 1),
           ('subway', 'A', 'NYCT', 'A', '8th Av Local', NULL, 1)`,
      );
      const rows = getAllRoutes('subway');
      expect(rows.map((r) => r.route_id)).toEqual(['A', 'Z']);
    });
  });

  describe('findRoutesById', () => {
    it('returns matches across feeds when feedId omitted', () => {
      // Seed same id "1" in two feeds
      db.run(
        `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
         VALUES
           ('subway', '1', 'NYCT', '1', 'Broadway-7th Av Local', '#EE352E', 1),
           ('lirr',   '1', 'LI',   '1', 'Some LIRR Branch',      NULL,     2)`,
      );
      const rows = findRoutesById('1');
      expect(rows.map((r) => r.feed_id).sort()).toEqual(['lirr', 'subway']);
    });

    it('narrows to a single row when feedId provided', () => {
      seedSubway();
      const rows = findRoutesById('1', 'subway');
      expect(rows).toHaveLength(1);
      expect(rows[0].feed_id).toBe('subway');
    });

    it('returns [] when no match', () => {
      seedSubway();
      expect(findRoutesById('NOPE', 'subway')).toEqual([]);
      expect(findRoutesById('NOPE')).toEqual([]);
    });
  });

  describe('getRouteById', () => {
    beforeEach(() => seedSubway());

    it('returns the row when found', () => {
      const row = getRouteById('1', 'subway');
      expect(row?.route_short_name).toBe('1');
      expect(row?.route_color).toBe('#EE352E');
    });

    it('returns null when feed_id mismatches', () => {
      expect(getRouteById('1', 'lirr')).toBeNull();
    });

    it('returns null when not found', () => {
      expect(getRouteById('999', 'subway')).toBeNull();
    });
  });
});
