import { describe, expect, it, beforeEach } from 'bun:test';
import {
  getScheduledDepartures,
  getTripMeta,
  getTripStops,
  findSubwayTripIdsBySuffix,
  isTripActiveOnDate,
} from '../../../src/db/queries/schedule';
import { db } from '../../../src/db/client';
import {
  resetDb,
  seedSubwaySchedule,
  seedLirrSchedule,
  seedMnrSchedule,
} from '../../helpers/seed';

// WKDY (subway) and the LIRR/MNR calendar_dates exception are both active on
// this Monday; SUNDAY is a date/weekday none of the schedule fixtures' services
// run on, for exercising the active-service filter.
const MONDAY = { date: '20240115', weekdayColumn: 'monday' } as const;
const SUNDAY = { date: '20240114', weekdayColumn: 'sunday' } as const;

describe('db/queries/schedule', () => {
  beforeEach(() => {
    resetDb();
  });

  describe('getScheduledDepartures', () => {
    it('returns board departures ordered by departure_seconds, past the after bound', () => {
      seedSubwaySchedule();
      // T-LOCAL departs 101N at 09:00:00 (32400s); T-LATE has no stop_time at 101N.
      const rows = getScheduledDepartures('subway', '101N', null, MONDAY, 0, 10);
      expect(rows.map((r) => r.trip_id)).toEqual(['T-LOCAL']);
      expect(rows[0]).toMatchObject({
        route_id: '1',
        stop_id: '101N',
        stop_sequence: 1,
        departure_seconds: 9 * 3600,
        headsign: null,
        dest_stop_id: null,
      });
    });

    it('excludes departures at or before afterSeconds', () => {
      seedSubwaySchedule();
      const before = getScheduledDepartures('subway', '101N', null, MONDAY, 9 * 3600, 10);
      expect(before).toHaveLength(1); // >= is inclusive
      const after = getScheduledDepartures('subway', '101N', null, MONDAY, 9 * 3600 + 1, 10);
      expect(after).toHaveLength(0);
    });

    it('respects limit', () => {
      seedSubwaySchedule();
      // T-LOCAL (09:30) and T-LATE (25:30) both stop at 127N on Monday.
      const rows = getScheduledDepartures('subway', '127N', null, MONDAY, 0, 1);
      expect(rows).toHaveLength(1);
    });

    it('excludes rows with no departure_seconds', () => {
      seedSubwaySchedule();
      // seedSubway's T1 stop_time at 127S has no arrival/departure_seconds
      // populated (raw INSERT omits those columns) - it must not appear.
      const rows = getScheduledDepartures('subway', '127S', null, MONDAY, 0, 10);
      expect(rows).toEqual([]);
    });

    it('excludes a trip whose service is not active on the queried date, even though it stops there', () => {
      seedSubwaySchedule();
      // T-LOCAL/T-LATE run WKDY (Mon-Fri); Sunday is inactive for them.
      const rows = getScheduledDepartures('subway', '101N', null, SUNDAY, 0, 10);
      expect(rows).toEqual([]);
    });

    it('honors a calendar_dates exception_type=1 addition on an otherwise-inactive weekday', () => {
      seedSubwaySchedule();
      // seedSubwaySchedule adds a calendar_dates exception_type=1 row for
      // WKDY on 2024-01-20 (a Saturday).
      const rows = getScheduledDepartures(
        'subway',
        '101N',
        null,
        { date: '20240120', weekdayColumn: 'saturday' },
        0,
        10,
      );
      expect(rows.map((r) => r.trip_id)).toEqual(['T-LOCAL']);
    });

    describe('with a `to` filter (platform-expanded destination self-join)', () => {
      it('resolves a real LIRR A->B trip end to end (Deer Park -> Penn via Wyandanch)', () => {
        seedLirrSchedule();
        const rows = getScheduledDepartures('lirr', '44', ['237'], MONDAY, 0, 10);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          trip_id: 'GO201_26_SCHED',
          stop_id: '44',
          stop_sequence: 1,
          dest_stop_id: '237',
          dest_stop_sequence: 3,
          dest_arrival_time: '13:30:00',
          dest_arrival_seconds: 13 * 3600 + 30 * 60,
        });
      });

      it('picks the correct destination platform automatically via stop_sequence ordering (subway)', () => {
        seedSubwaySchedule();
        // to=127 (parent, expands to 127N/127S). T-LOCAL only ever visits
        // the N platform, so the join must land on 127N, never 127S.
        const rows = getScheduledDepartures('subway', '101N', ['127N', '127S'], MONDAY, 0, 10);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          trip_id: 'T-LOCAL',
          stop_id: '101N',
          dest_stop_id: '127N',
          dest_stop_sequence: 3,
        });
      });

      it('returns [] in the reverse direction (destination stop_sequence not after origin)', () => {
        seedLirrSchedule();
        const rows = getScheduledDepartures('lirr', '237', ['44'], MONDAY, 0, 10);
        expect(rows).toEqual([]);
      });

      it('short-circuits to [] when toStopIds is an empty array, distinct from null (no filter)', () => {
        seedLirrSchedule();
        expect(getScheduledDepartures('lirr', '44', [], MONDAY, 0, 10)).toEqual([]);
        expect(getScheduledDepartures('lirr', '44', null, MONDAY, 0, 10)).toHaveLength(1);
      });

      it('resolves a real MNR A->B trip end to end (Grand Central -> Stamford via Harlem-125 St)', () => {
        seedMnrSchedule();
        const rows = getScheduledDepartures('mnr', '1', ['124'], MONDAY, 0, 10);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          trip_id: 'MNR-SCHED-1',
          headsign: 'Stamford',
          dest_stop_id: '124',
          dest_stop_sequence: 3,
          dest_arrival_time: '09:56:00',
        });
      });
    });
  });

  describe('getTripMeta / getTripStops', () => {
    it('returns full trip metadata including the new dropped-column fields', () => {
      seedLirrSchedule();
      const meta = getTripMeta('lirr', 'GO201_26_SCHED');
      expect(meta).toMatchObject({
        route_id: 'RONK',
        route_long_name: 'Ronkonkoma Branch',
        service_id: 'SCHED',
        direction_id: 1,
        headsign: 'Penn Station',
        train_number: '1013',
        peak_offpeak: 0,
      });
    });

    it('returns null for an unknown trip', () => {
      seedLirrSchedule();
      expect(getTripMeta('lirr', 'nope')).toBeNull();
    });

    it('returns stops in stop_sequence order with track/pickup/drop_off populated', () => {
      seedLirrSchedule();
      const stops = getTripStops('lirr', 'GO201_26_SCHED');
      expect(stops.map((s) => s.stop_id)).toEqual(['44', '220', '237']);
      expect(stops[1]).toMatchObject({
        stop_name: 'Wyandanch',
        stop_sequence: 2,
        track: '2',
        arrival_time: '12:35:00',
        departure_time: '12:36:00',
      });
    });

    it('parent_station_id is null for flat (LIRR/MNR) stops and set for subway platforms', () => {
      seedLirrSchedule();
      expect(getTripStops('lirr', 'GO201_26_SCHED')[0].parent_station_id).toBeNull();

      seedSubwaySchedule();
      const subwayStops = getTripStops('subway', 'T-LOCAL');
      expect(subwayStops[0].parent_station_id).toBe('101');
    });
  });

  describe('findSubwayTripIdsBySuffix', () => {
    beforeEach(() => {
      seedSubwaySchedule();
      db.run(
        `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
         VALUES ('subway', '086850_1..S03R', '1', 'WKDY', 1, NULL)`,
      );
    });

    it('matches a realtime-style suffix against the full static trip_id', () => {
      const matches = findSubwayTripIdsBySuffix('1..S03R', [MONDAY]);
      expect(matches).toEqual(['086850_1..S03R']);
    });

    it('excludes matches whose service is not active on any candidate date', () => {
      const matches = findSubwayTripIdsBySuffix('1..S03R', [SUNDAY]);
      expect(matches).toEqual([]);
    });

    it('returns [] for a suffix with no match', () => {
      const matches = findSubwayTripIdsBySuffix('nonexistent-suffix', [MONDAY]);
      expect(matches).toEqual([]);
    });
  });

  describe('isTripActiveOnDate', () => {
    it('true for calendar_dates-only service on its exception date (LIRR)', () => {
      seedLirrSchedule();
      expect(isTripActiveOnDate('lirr', 'GO201_26_SCHED', MONDAY)).toBe(true);
    });

    it('false for calendar_dates-only service on a date with no exception row', () => {
      seedLirrSchedule();
      expect(isTripActiveOnDate('lirr', 'GO201_26_SCHED', { date: '20240116', weekdayColumn: 'tuesday' })).toBe(false);
    });

    it('honors exception_type=2 removal for calendar-backed service (subway)', () => {
      seedSubwaySchedule();
      expect(isTripActiveOnDate('subway', 'T-LOCAL', { date: '20240122', weekdayColumn: 'monday' })).toBe(false);
    });

    it('false for an unknown trip', () => {
      expect(isTripActiveOnDate('subway', 'nope', MONDAY)).toBe(false);
    });
  });
});
