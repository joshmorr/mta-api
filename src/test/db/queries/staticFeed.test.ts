import { describe, expect, it, beforeEach } from 'bun:test';
import {
  upsertStops,
  upsertRoutes,
  upsertTrips,
  upsertStopTimes,
  upsertStopTimesBatch,
  upsertCalendar,
  upsertCalendarDates,
  clearFeedData,
  setFeedMeta,
  getFeedMeta,
  isDbEmpty,
} from '../../../db/queries/staticFeed';
import { db } from '../../../db/client';
import { resetDb } from '../../helpers/seed';

describe('db/queries/staticFeed', () => {
  beforeEach(() => {
    resetDb();
  });

  describe('upsertStops', () => {
    it('inserts rows with parsed numerics and prefixed colors', () => {
      upsertStops(
        [
          {
            stop_id: 'A',
            stop_name: 'Alpha',
            stop_lat: '40.5',
            stop_lon: '-73.5',
            location_type: '1',
            parent_station: '',
          },
          // Empty stop_id → skipped
          {
            stop_id: '',
            stop_name: 'X',
            stop_lat: '0',
            stop_lon: '0',
            location_type: '0',
            parent_station: '',
          },
        ],
        'subway',
      );
      const rows = db
        .query<{ stop_id: string; stop_lat: number; location_type: number; parent_station: string | null }, []>(
          `SELECT stop_id, stop_lat, location_type, parent_station FROM stops`,
        )
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        stop_id: 'A',
        stop_lat: 40.5,
        location_type: 1,
        parent_station: null, // empty string normalized to null
      });
    });

    it('falls back to stop_id when stop_name is empty', () => {
      upsertStops(
        [
          {
            stop_id: 'B',
            stop_name: '',
            stop_lat: '0',
            stop_lon: '0',
            location_type: '0',
            parent_station: '',
          },
        ],
        'lirr',
      );
      const row = db.query<{ stop_name: string }, []>(`SELECT stop_name FROM stops`).get();
      expect(row?.stop_name).toBe('B');
    });

    it('overwrites on conflict (INSERT OR REPLACE)', () => {
      const base = {
        stop_id: 'A',
        stop_lat: '40',
        stop_lon: '-73',
        location_type: '0',
        parent_station: '',
      };
      upsertStops([{ ...base, stop_name: 'first' }], 'subway');
      upsertStops([{ ...base, stop_name: 'second' }], 'subway');
      const rows = db.query<{ stop_name: string }, []>(`SELECT stop_name FROM stops`).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].stop_name).toBe('second');
    });
  });

  describe('upsertRoutes', () => {
    it('prefixes route_color with #', () => {
      upsertRoutes(
        [
          {
            route_id: 'A',
            agency_id: 'NYCT',
            route_short_name: 'A',
            route_long_name: '8th Av',
            route_color: '0039A6',
            route_type: '1',
          },
        ],
        'subway',
      );
      const row = db.query<{ route_color: string }, []>(`SELECT route_color FROM routes`).get();
      expect(row?.route_color).toBe('#0039A6');
    });

    it('writes NULL color when source is empty', () => {
      upsertRoutes(
        [
          {
            route_id: 'A',
            agency_id: 'NYCT',
            route_short_name: 'A',
            route_long_name: '',
            route_color: '',
            route_type: '1',
          },
        ],
        'subway',
      );
      const row = db.query<{ route_color: string | null }, []>(`SELECT route_color FROM routes`).get();
      expect(row?.route_color).toBeNull();
    });

    it('skips rows with empty route_id', () => {
      upsertRoutes(
        [{ route_id: '', agency_id: '', route_short_name: '', route_long_name: '', route_color: '', route_type: '1' }],
        'subway',
      );
      expect(db.query<{ cnt: number }, []>(`SELECT COUNT(*) cnt FROM routes`).get()?.cnt).toBe(0);
    });
  });

  describe('upsertTrips', () => {
    it('skips rows missing trip_id or route_id, and parses direction_id', () => {
      // Need a route the FK refers to
      upsertRoutes(
        [{ route_id: 'A', agency_id: '', route_short_name: 'A', route_long_name: '', route_color: '', route_type: '1' }],
        'subway',
      );
      upsertTrips(
        [
          { trip_id: 'T1', route_id: 'A', service_id: 'S', direction_id: '1', shape_id: '' },
          { trip_id: '', route_id: 'A', service_id: 'S', direction_id: '0', shape_id: '' },
          { trip_id: 'T3', route_id: '', service_id: 'S', direction_id: '0', shape_id: '' },
        ],
        'subway',
      );
      const rows = db
        .query<{ trip_id: string; direction_id: number; shape_id: string | null }, []>(
          `SELECT trip_id, direction_id, shape_id FROM trips`,
        )
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ trip_id: 'T1', direction_id: 1, shape_id: null });
    });
  });

  describe('upsertStopTimes (eager)', () => {
    beforeEach(() => {
      // Trips/Stops needed for FKs
      upsertRoutes(
        [{ route_id: 'A', agency_id: '', route_short_name: 'A', route_long_name: '', route_color: '', route_type: '1' }],
        'subway',
      );
      upsertTrips([{ trip_id: 'T1', route_id: 'A', service_id: 'S', direction_id: '0', shape_id: '' }], 'subway');
      upsertStops(
        [{ stop_id: 'X', stop_name: 'X', stop_lat: '0', stop_lon: '0', location_type: '0', parent_station: '' }],
        'subway',
      );
    });

    it('inserts and skips invalid rows', () => {
      upsertStopTimes(
        [
          { trip_id: 'T1', stop_id: 'X', arrival_time: '10:00:00', departure_time: '10:00:00', stop_sequence: '1' },
          { trip_id: '', stop_id: 'X', arrival_time: '', departure_time: '', stop_sequence: '0' }, // skipped
        ],
        'subway',
      );
      const rows = db
        .query<{ stop_sequence: number; arrival_time: string | null }, []>(
          `SELECT stop_sequence, arrival_time FROM stop_times`,
        )
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ stop_sequence: 1, arrival_time: '10:00:00' });
    });
  });

  describe('upsertStopTimesBatch (streaming)', () => {
    beforeEach(() => {
      upsertRoutes(
        [{ route_id: 'A', agency_id: '', route_short_name: 'A', route_long_name: '', route_color: '', route_type: '1' }],
        'subway',
      );
      upsertTrips([{ trip_id: 'T1', route_id: 'A', service_id: 'S', direction_id: '0', shape_id: '' }], 'subway');
      upsertStops(
        [{ stop_id: 'X', stop_name: 'X', stop_lat: '0', stop_lon: '0', location_type: '0', parent_station: '' }],
        'subway',
      );
    });

    it('flushes pushed rows on .flush()', () => {
      const inserter = upsertStopTimesBatch('subway');
      for (let i = 1; i <= 3; i++) {
        inserter.push({
          trip_id: 'T1',
          stop_id: 'X',
          arrival_time: `10:0${i}:00`,
          departure_time: `10:0${i}:00`,
          stop_sequence: String(i),
        });
      }
      inserter.flush();
      expect(db.query<{ cnt: number }, []>(`SELECT COUNT(*) cnt FROM stop_times`).get()?.cnt).toBe(3);
    });

    it('flush() is a no-op when nothing was pushed', () => {
      const inserter = upsertStopTimesBatch('subway');
      expect(() => inserter.flush()).not.toThrow();
      expect(db.query<{ cnt: number }, []>(`SELECT COUNT(*) cnt FROM stop_times`).get()?.cnt).toBe(0);
    });

    it('skips rows missing trip_id or stop_id', () => {
      const inserter = upsertStopTimesBatch('subway');
      inserter.push({
        trip_id: '',
        stop_id: 'X',
        arrival_time: '10:00:00',
        departure_time: '10:00:00',
        stop_sequence: '1',
      });
      inserter.flush();
      expect(db.query<{ cnt: number }, []>(`SELECT COUNT(*) cnt FROM stop_times`).get()?.cnt).toBe(0);
    });
  });

  describe('upsertCalendar / upsertCalendarDates', () => {
    it('parses weekday flags as integers', () => {
      upsertCalendar(
        [
          {
            service_id: 'WKDY',
            monday: '1',
            tuesday: '1',
            wednesday: '1',
            thursday: '1',
            friday: '1',
            saturday: '0',
            sunday: '0',
            start_date: '20240101',
            end_date: '20241231',
          },
        ],
        'subway',
      );
      const row = db
        .query<{ monday: number; saturday: number }, []>(`SELECT monday, saturday FROM calendar`)
        .get();
      expect(row).toEqual({ monday: 1, saturday: 0 });
    });

    it('skips calendar_dates rows missing service_id or date', () => {
      upsertCalendarDates(
        [
          { service_id: 'A', date: '20240115', exception_type: '1' },
          { service_id: '', date: '20240115', exception_type: '1' },
          { service_id: 'A', date: '', exception_type: '1' },
        ],
        'subway',
      );
      expect(db.query<{ cnt: number }, []>(`SELECT COUNT(*) cnt FROM calendar_dates`).get()?.cnt).toBe(1);
    });
  });

  describe('clearFeedData', () => {
    it('deletes only the requested feed', () => {
      upsertStops(
        [{ stop_id: 'A', stop_name: 'A', stop_lat: '0', stop_lon: '0', location_type: '0', parent_station: '' }],
        'subway',
      );
      upsertStops(
        [{ stop_id: 'A', stop_name: 'A', stop_lat: '0', stop_lon: '0', location_type: '0', parent_station: '' }],
        'lirr',
      );
      clearFeedData('subway');
      const rows = db.query<{ feed_id: string }, []>(`SELECT feed_id FROM stops`).all();
      expect(rows.map((r) => r.feed_id)).toEqual(['lirr']);
    });
  });

  describe('feed_meta', () => {
    it('roundtrips setFeedMeta / getFeedMeta', () => {
      const before = Math.floor(Date.now() / 1000);
      setFeedMeta('subway');
      const after = Math.floor(Date.now() / 1000);
      const stored = getFeedMeta('subway');
      expect(stored).not.toBeNull();
      expect(stored!).toBeGreaterThanOrEqual(before);
      expect(stored!).toBeLessThanOrEqual(after);
    });

    it('returns null for unknown feed', () => {
      expect(getFeedMeta('mnr')).toBeNull();
    });
  });

  describe('isDbEmpty', () => {
    it('is true when no stops are present', () => {
      expect(isDbEmpty()).toBe(true);
    });

    it('is false once any stop exists', () => {
      upsertStops(
        [{ stop_id: 'A', stop_name: 'A', stop_lat: '0', stop_lon: '0', location_type: '0', parent_station: '' }],
        'subway',
      );
      expect(isDbEmpty()).toBe(false);
    });
  });
});
