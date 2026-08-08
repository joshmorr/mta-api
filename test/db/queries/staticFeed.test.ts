import { describe, expect, it, beforeEach } from 'bun:test';
import {
  upsertStops,
  upsertRoutes,
  upsertTrips,
  upsertStopTimes,
  upsertStopTimesBatch,
  upsertCalendar,
  upsertCalendarDates,
  upsertTransfers,
  clearFeedData,
  setFeedMeta,
  getFeedMeta,
  isDbEmpty,
} from '../../../src/db/queries/staticFeed';
import { db } from '../../../src/db/client';
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

    it('captures stop_code/stop_desc/zone_id/wheelchair_boarding when the feed ships them', () => {
      upsertStops(
        [
          {
            stop_id: 'A',
            stop_name: 'Alpha',
            stop_lat: '40.5',
            stop_lon: '-73.5',
            location_type: '0',
            parent_station: '',
            stop_code: 'ABT',
            stop_desc: 'Albertson',
            zone_id: '3',
            wheelchair_boarding: '1',
          },
        ],
        'lirr',
      );
      const row = db
        .query<
          { stop_code: string | null; stop_desc: string | null; zone_id: string | null; wheelchair_boarding: number | null },
          []
        >(`SELECT stop_code, stop_desc, zone_id, wheelchair_boarding FROM stops`)
        .get();
      expect(row).toEqual({
        stop_code: 'ABT',
        stop_desc: 'Albertson',
        zone_id: '3',
        wheelchair_boarding: 1,
      });
    });

    it('stores NULL, not 0, for wheelchair_boarding when the column is absent from the feed', () => {
      // Subway stops.txt ships no wheelchair_boarding column, so the field is
      // absent from the row object entirely (not '') — mirrors what parseCSV
      // produces for an unshipped column.
      upsertStops(
        [
          {
            stop_id: 'A',
            stop_name: 'Alpha',
            stop_lat: '0',
            stop_lon: '0',
            location_type: '0',
            parent_station: '',
          },
        ],
        'subway',
      );
      const row = db
        .query<{ wheelchair_boarding: number | null }, []>(
          `SELECT wheelchair_boarding FROM stops`,
        )
        .get();
      expect(row?.wheelchair_boarding).toBeNull();
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

    it('captures route_desc/route_url/route_sort_order and prefixes route_text_color with #', () => {
      upsertRoutes(
        [
          {
            route_id: 'A',
            agency_id: 'NYCT',
            route_short_name: 'A',
            route_long_name: '8th Av',
            route_color: '0039A6',
            route_type: '1',
            route_desc: 'Trains operate...',
            route_url: 'https://mta.info/a',
            route_text_color: 'FFFFFF',
            route_sort_order: '5',
          },
        ],
        'subway',
      );
      const row = db
        .query<
          { route_desc: string | null; route_url: string | null; route_text_color: string | null; route_sort_order: number | null },
          []
        >(`SELECT route_desc, route_url, route_text_color, route_sort_order FROM routes`)
        .get();
      expect(row).toEqual({
        route_desc: 'Trains operate...',
        route_url: 'https://mta.info/a',
        route_text_color: '#FFFFFF',
        route_sort_order: 5,
      });
    });

    it('leaves route_sort_order NULL when the feed does not ship it', () => {
      upsertRoutes(
        [{ route_id: 'A', agency_id: '', route_short_name: 'A', route_long_name: '', route_color: '', route_type: '1' }],
        'lirr',
      );
      const row = db.query<{ route_sort_order: number | null }, []>(`SELECT route_sort_order FROM routes`).get();
      expect(row?.route_sort_order).toBeNull();
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

    it('stores direction_id as NULL rather than 0 when blank', () => {
      upsertRoutes(
        [{ route_id: 'A', agency_id: '', route_short_name: 'A', route_long_name: '', route_color: '', route_type: '1' }],
        'subway',
      );
      upsertTrips(
        [{ trip_id: 'T1', route_id: 'A', service_id: 'S', direction_id: '', shape_id: '' }],
        'subway',
      );
      const row = db.query<{ direction_id: number | null }, []>(`SELECT direction_id FROM trips`).get();
      expect(row?.direction_id).toBeNull();
    });

    it('captures trip_headsign/trip_short_name/block_id/wheelchair_accessible/peak_offpeak', () => {
      upsertRoutes(
        [{ route_id: 'A', agency_id: '', route_short_name: 'A', route_long_name: '', route_color: '', route_type: '1' }],
        'lirr',
      );
      upsertTrips(
        [
          {
            trip_id: 'T1',
            route_id: 'A',
            service_id: 'S',
            direction_id: '1',
            shape_id: '',
            trip_headsign: 'Penn Station',
            trip_short_name: '1234',
            block_id: 'B1',
            wheelchair_accessible: '1',
            peak_offpeak: '1',
          },
        ],
        'lirr',
      );
      const row = db
        .query<
          {
            trip_headsign: string | null;
            trip_short_name: string | null;
            block_id: string | null;
            wheelchair_accessible: number | null;
            peak_offpeak: number | null;
          },
          []
        >(
          `SELECT trip_headsign, trip_short_name, block_id, wheelchair_accessible, peak_offpeak FROM trips`,
        )
        .get();
      expect(row).toEqual({
        trip_headsign: 'Penn Station',
        trip_short_name: '1234',
        block_id: 'B1',
        wheelchair_accessible: 1,
        peak_offpeak: 1,
      });
    });

    it('leaves peak_offpeak NULL for feeds that do not ship the extension (e.g. subway)', () => {
      upsertRoutes(
        [{ route_id: 'A', agency_id: '', route_short_name: 'A', route_long_name: '', route_color: '', route_type: '1' }],
        'subway',
      );
      upsertTrips(
        [{ trip_id: 'T1', route_id: 'A', service_id: 'S', direction_id: '0', shape_id: '' }],
        'subway',
      );
      const row = db.query<{ peak_offpeak: number | null }, []>(`SELECT peak_offpeak FROM trips`).get();
      expect(row?.peak_offpeak).toBeNull();
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

    it('skips a row with a blank stop_sequence rather than inserting it as 0', () => {
      upsertStopTimes(
        [
          { trip_id: 'T1', stop_id: 'X', arrival_time: '10:00:00', departure_time: '10:00:00', stop_sequence: '' },
        ],
        'subway',
      );
      expect(db.query<{ cnt: number }, []>(`SELECT COUNT(*) cnt FROM stop_times`).get()?.cnt).toBe(0);
    });

    it('keeps a genuine stop_sequence of 0', () => {
      upsertStopTimes(
        [
          { trip_id: 'T1', stop_id: 'X', arrival_time: '10:00:00', departure_time: '10:00:00', stop_sequence: '0' },
        ],
        'subway',
      );
      const row = db.query<{ stop_sequence: number }, []>(`SELECT stop_sequence FROM stop_times`).get();
      expect(row?.stop_sequence).toBe(0);
    });

    it('computes arrival_seconds/departure_seconds alongside the raw text, including post-midnight rollover', () => {
      upsertStopTimes(
        [
          { trip_id: 'T1', stop_id: 'X', arrival_time: '25:30:00', departure_time: '25:31:00', stop_sequence: '1' },
        ],
        'subway',
      );
      const row = db
        .query<
          { arrival_time: string; arrival_seconds: number; departure_time: string; departure_seconds: number },
          []
        >(`SELECT arrival_time, arrival_seconds, departure_time, departure_seconds FROM stop_times`)
        .get();
      expect(row).toEqual({
        arrival_time: '25:30:00',
        arrival_seconds: 25 * 3600 + 30 * 60,
        departure_time: '25:31:00',
        departure_seconds: 25 * 3600 + 31 * 60,
      });
    });

    it('captures track/note_id/pickup_type/drop_off_type when the feed ships them', () => {
      upsertStopTimes(
        [
          {
            trip_id: 'T1',
            stop_id: 'X',
            arrival_time: '10:00:00',
            departure_time: '10:00:00',
            stop_sequence: '1',
            track: '14',
            note_id: 'N1',
            pickup_type: '0',
            drop_off_type: '1',
          },
        ],
        'subway',
      );
      const row = db
        .query<
          { track: string | null; note_id: string | null; pickup_type: number | null; drop_off_type: number | null },
          []
        >(`SELECT track, note_id, pickup_type, drop_off_type FROM stop_times`)
        .get();
      expect(row).toEqual({ track: '14', note_id: 'N1', pickup_type: 0, drop_off_type: 1 });
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

    it('skips a row with a blank stop_sequence rather than inserting it as 0', () => {
      const inserter = upsertStopTimesBatch('subway');
      inserter.push({
        trip_id: 'T1',
        stop_id: 'X',
        arrival_time: '10:00:00',
        departure_time: '10:00:00',
        stop_sequence: '',
      });
      inserter.flush();
      expect(db.query<{ cnt: number }, []>(`SELECT COUNT(*) cnt FROM stop_times`).get()?.cnt).toBe(0);
    });

    it('computes arrival_seconds/departure_seconds for streamed rows too', () => {
      const inserter = upsertStopTimesBatch('subway');
      inserter.push({
        trip_id: 'T1',
        stop_id: 'X',
        arrival_time: '10:05:30',
        departure_time: '10:06:00',
        stop_sequence: '1',
      });
      inserter.flush();
      const row = db
        .query<{ arrival_seconds: number; departure_seconds: number }, []>(
          `SELECT arrival_seconds, departure_seconds FROM stop_times`,
        )
        .get();
      expect(row).toEqual({
        arrival_seconds: 10 * 3600 + 5 * 60 + 30,
        departure_seconds: 10 * 3600 + 6 * 60,
      });
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

  describe('upsertTransfers', () => {
    it('parses a subway-shaped row (no route/trip columns)', () => {
      upsertTransfers(
        [{ from_stop_id: '127', to_stop_id: '902', transfer_type: '2', min_transfer_time: '180' }],
        'subway',
      );
      const row = db
        .query<
          { from_stop_id: string; to_stop_id: string; transfer_type: number; min_transfer_time: number; from_trip_id: string | null },
          []
        >(`SELECT from_stop_id, to_stop_id, transfer_type, min_transfer_time, from_trip_id FROM transfers`)
        .get();
      expect(row).toEqual({
        from_stop_id:      '127',
        to_stop_id:        '902',
        transfer_type:     2,
        min_transfer_time: 180,
        from_trip_id:      null,
      });
    });

    it('parses an LIRR-shaped row (adds from_trip_id/to_trip_id)', () => {
      upsertTransfers(
        [
          {
            from_stop_id: '102',
            to_stop_id: '102',
            from_trip_id: 'GO201_26_2306',
            to_trip_id: 'GO201_26_2',
            transfer_type: '1',
            min_transfer_time: '',
          },
        ],
        'lirr',
      );
      const row = db
        .query<{ from_trip_id: string | null; to_trip_id: string | null; min_transfer_time: number | null }, []>(
          `SELECT from_trip_id, to_trip_id, min_transfer_time FROM transfers`,
        )
        .get();
      expect(row).toEqual({ from_trip_id: 'GO201_26_2306', to_trip_id: 'GO201_26_2', min_transfer_time: null });
    });

    it('parses an MNR-shaped row and keeps both rows on a shared stop pair that differ only by trip', () => {
      upsertTransfers(
        [
          {
            from_stop_id: '20',
            to_stop_id: '20',
            from_route_id: '',
            to_route_id: '',
            from_trip_id: 'TRIP_A1',
            to_trip_id: 'TRIP_B1',
            transfer_type: '1',
            min_transfer_time: '',
          },
          {
            from_stop_id: '20',
            to_stop_id: '20',
            from_route_id: '',
            to_route_id: '',
            from_trip_id: 'TRIP_A2',
            to_trip_id: 'TRIP_B2',
            transfer_type: '1',
            min_transfer_time: '',
          },
        ],
        'mnr',
      );
      const rows = db
        .query<{ from_trip_id: string; to_trip_id: string }, []>(
          `SELECT from_trip_id, to_trip_id FROM transfers ORDER BY from_trip_id`,
        )
        .all();
      expect(rows).toEqual([
        { from_trip_id: 'TRIP_A1', to_trip_id: 'TRIP_B1' },
        { from_trip_id: 'TRIP_A2', to_trip_id: 'TRIP_B2' },
      ]);
    });

    it('skips rows missing from_stop_id or to_stop_id', () => {
      upsertTransfers(
        [
          { from_stop_id: '', to_stop_id: '902', transfer_type: '2' },
          { from_stop_id: '127', to_stop_id: '', transfer_type: '2' },
        ],
        'subway',
      );
      expect(db.query<{ cnt: number }, []>(`SELECT COUNT(*) cnt FROM transfers`).get()?.cnt).toBe(0);
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

    it('also deletes only the requested feed from transfers', () => {
      upsertTransfers([{ from_stop_id: 'A', to_stop_id: 'B', transfer_type: '2' }], 'subway');
      upsertTransfers([{ from_stop_id: 'A', to_stop_id: 'B', transfer_type: '2' }], 'lirr');
      clearFeedData('subway');
      const rows = db.query<{ feed_id: string }, []>(`SELECT feed_id FROM transfers`).all();
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
