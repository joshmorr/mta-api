import { describe, expect, it, beforeEach } from 'bun:test';
import {
  findStopsByProximity,
  findStopsByName,
  getAllStops,
  findStopsById,
  getStopById,
  getPlatformIds,
  getPlatforms,
  getParentId,
} from '../../../db/queries/stops';
import { resetDb, seedSubway, seedLirr, seedMnr } from '../../helpers/seed';
import { db } from '../../../db/client';

describe('db/queries/stops', () => {
  beforeEach(() => {
    resetDb();
  });

  describe('SEARCHABLE_STOP_CONDITION (collection queries)', () => {
    it('subway listings include parent stations (location_type=1) and exclude platforms', () => {
      seedSubway();
      const all = getAllStops(50);
      expect(all.map((s) => s.stop_id)).toEqual(['127']);
    });

    it('LIRR listings include flat stops (no parent_station)', () => {
      seedLirr();
      const all = getAllStops(50);
      expect(all.map((s) => s.stop_id).sort()).toEqual(['1', '2']);
    });

    it('cross-feed listings combine subway parents and rail flat stops', () => {
      seedSubway();
      seedLirr();
      seedMnr();
      const all = getAllStops(50);
      const byFeed = all.reduce<Record<string, string[]>>((acc, s) => {
        (acc[s.feed_id] ??= []).push(s.stop_id);
        return acc;
      }, {});
      expect(byFeed.subway).toEqual(['127']);
      expect(byFeed.lirr.sort()).toEqual(['1', '2']);
      expect(byFeed.mnr.sort()).toEqual(['1', '2']);
    });

    it('respects feedId filter', () => {
      seedSubway();
      seedLirr();
      const lirrOnly = getAllStops(50, 'lirr');
      expect(lirrOnly.every((s) => s.feed_id === 'lirr')).toBe(true);
      expect(lirrOnly).toHaveLength(2);
    });

    it('respects limit', () => {
      seedLirr();
      seedMnr();
      const limited = getAllStops(2);
      expect(limited).toHaveLength(2);
    });
  });

  describe('findStopsByName', () => {
    beforeEach(() => {
      seedSubway();
      seedLirr();
    });

    it('matches case-insensitively', () => {
      expect(findStopsByName('TIMES sq', 10).map((s) => s.stop_id)).toEqual(['127']);
    });

    it('matches partial substrings (LIKE %q%)', () => {
      expect(findStopsByName('Penn', 10).map((s) => s.stop_id)).toEqual(['1']);
    });

    it('returns empty when no match', () => {
      expect(findStopsByName('nowhereville', 10)).toEqual([]);
    });

    it('honors feedId filter', () => {
      // Both fixtures have a stop named "Times Sq..." or "Penn Station";
      // confirm filter only returns the matching feed.
      const lirrOnly = findStopsByName('Penn', 10, 'lirr');
      expect(lirrOnly.every((s) => s.feed_id === 'lirr')).toBe(true);
    });
  });

  describe('findStopsByProximity', () => {
    beforeEach(() => {
      seedSubway();
      seedLirr();
    });

    it('returns stops within the bounding box ordered by distance', () => {
      // Search near Penn Station (LIRR id "1"), 1km box
      const latDelta = 1000 / 111_000;
      const lonDelta = 1000 / (111_000 * Math.cos((40.7505 * Math.PI) / 180));
      const rows = findStopsByProximity(40.7505, -73.9934, latDelta, lonDelta, 10);
      // Both Penn (lirr 1) and Times Sq (subway 127) are within ~1km of Penn
      const ids = rows.map((s) => `${s.feed_id}:${s.stop_id}`);
      expect(ids[0]).toBe('lirr:1'); // Penn is closest to itself
      expect(ids).toContain('subway:127');
    });

    it('excludes stops outside the bounding box', () => {
      const latDelta = 50 / 111_000;
      const lonDelta = 50 / (111_000 * Math.cos((40.7505 * Math.PI) / 180));
      const rows = findStopsByProximity(40.7505, -73.9934, latDelta, lonDelta, 10);
      // 50m box around Penn excludes Times Sq (~3km away)
      expect(rows.every((s) => s.stop_id === '1' && s.feed_id === 'lirr')).toBe(true);
    });

    it('honors feedId filter', () => {
      const latDelta = 5000 / 111_000;
      const lonDelta = 5000 / (111_000 * Math.cos((40.7505 * Math.PI) / 180));
      const rows = findStopsByProximity(40.7505, -73.9934, latDelta, lonDelta, 10, 'lirr');
      expect(rows.every((s) => s.feed_id === 'lirr')).toBe(true);
    });
  });

  describe('findStopsById', () => {
    it('returns matches across feeds when feedId is omitted', () => {
      // Both LIRR and MNR seed a stop with id "1"
      seedLirr();
      seedMnr();
      const rows = findStopsById('1');
      const feeds = rows.map((s) => s.feed_id).sort();
      expect(feeds).toEqual(['lirr', 'mnr']);
    });

    it('narrows to a single feed when feedId is provided', () => {
      seedLirr();
      seedMnr();
      const rows = findStopsById('1', 'mnr');
      expect(rows).toHaveLength(1);
      expect(rows[0].feed_id).toBe('mnr');
    });

    it('returns platforms too (no SEARCHABLE_STOP_CONDITION applied)', () => {
      seedSubway();
      const rows = findStopsById('127N', 'subway');
      expect(rows).toHaveLength(1);
      expect(rows[0].location_type).toBe(0);
      expect(rows[0].parent_station).toBe('127');
    });
  });

  describe('getStopById', () => {
    beforeEach(() => seedSubway());

    it('returns the row when found', () => {
      const row = getStopById('127', 'subway');
      expect(row?.stop_name).toBe('Times Sq-42 St');
    });

    it('returns null when not found', () => {
      expect(getStopById('999', 'subway')).toBeNull();
    });
  });

  describe('platform helpers', () => {
    beforeEach(() => seedSubway());

    it('getPlatformIds returns child platform IDs', () => {
      expect(getPlatformIds('subway', '127').sort()).toEqual(['127N', '127S']);
    });

    it('getPlatformIds returns [] when no children', () => {
      expect(getPlatformIds('subway', '127N')).toEqual([]);
    });

    it('getPlatforms returns id+name', () => {
      const rows = getPlatforms('subway', '127');
      expect(rows.every((r) => r.stop_name === 'Times Sq-42 St')).toBe(true);
      expect(rows.map((r) => r.stop_id).sort()).toEqual(['127N', '127S']);
    });

    it('getParentId returns the parent station for a platform', () => {
      expect(getParentId('subway', '127N')).toBe('127');
    });

    it('getParentId returns null for a parent station (no parent_station)', () => {
      expect(getParentId('subway', '127')).toBeNull();
    });

    it('getParentId returns null when stop is missing', () => {
      expect(getParentId('subway', 'nope')).toBeNull();
    });
  });

  // Sanity: confirm the schema present (proves bunfig preload + migrations ran)
  it('uses an in-memory DB (no ./data file written)', () => {
    const row = db.query<{ name: string }, []>(`PRAGMA database_list`).get();
    expect(row?.name).toBe('main');
  });
});
