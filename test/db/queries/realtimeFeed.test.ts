import { describe, expect, it, beforeEach } from 'bun:test';
import {
  getStopNameById,
  isPlatformStop,
  getChildPlatformIds,
  getServedRouteIdsByStopIds,
} from '../../../src/db/queries/realtimeFeed';
import { db } from '../../../src/db/client';
import { resetDb, seedSubway, seedSubwaySchedule, seedLirrSchedule, seedMnrSchedule } from '../../helpers/seed';

describe('db/queries/realtimeFeed', () => {
  beforeEach(() => {
    resetDb();
  });

  describe('getStopNameById', () => {
    beforeEach(() => seedSubway());

    it('returns the stop name', () => {
      expect(getStopNameById('subway', '127')).toBe('Times Sq-42 St');
    });

    it('returns null when not found', () => {
      expect(getStopNameById('subway', 'nope')).toBeNull();
    });

    it('respects feed_id', () => {
      expect(getStopNameById('lirr', '127')).toBeNull();
    });
  });

  describe('isPlatformStop', () => {
    beforeEach(() => seedSubway());

    it('returns true for a platform (location_type = 0)', () => {
      expect(isPlatformStop('subway', '127N')).toBe(true);
    });

    it('returns false for a parent station (location_type = 1)', () => {
      expect(isPlatformStop('subway', '127')).toBe(false);
    });

    it('returns false when stop is missing', () => {
      expect(isPlatformStop('subway', 'nope')).toBe(false);
    });
  });

  describe('getChildPlatformIds', () => {
    beforeEach(() => seedSubway());

    it('returns the platform IDs for a parent station', () => {
      expect(getChildPlatformIds('subway', '127').sort()).toEqual(['127N', '127S']);
    });

    it('returns [] for a stop with no children', () => {
      expect(getChildPlatformIds('subway', '127N')).toEqual([]);
    });
  });

  describe('getServedRouteIdsByStopIds', () => {
    it('returns [] immediately when stopIds is empty', () => {
      // Even with no fixture, no SQL should run.
      expect(
        getServedRouteIdsByStopIds('subway', [], [{ date: '20240115', weekdayColumn: 'monday' }]),
      ).toEqual([]);
    });

    it('returns the route when calendar weekday matches and date is in window', () => {
      seedSubway();
      // WKDY service is monday=1, start_date=20200101, end_date=20991231
      const rows = getServedRouteIdsByStopIds(
        'subway',
        ['127N'],
        [{ date: '20240115', weekdayColumn: 'monday' }], // a Monday
      );
      expect(rows).toEqual(['1']);
    });

    it('returns [] when weekday is not active in calendar (Sunday for WKDY)', () => {
      seedSubway();
      const rows = getServedRouteIdsByStopIds(
        'subway',
        ['127N'],
        [{ date: '20240114', weekdayColumn: 'sunday' }],
      );
      expect(rows).toEqual([]);
    });

    it('returns [] when date falls outside calendar start/end window', () => {
      seedSubway();
      const rows = getServedRouteIdsByStopIds(
        'subway',
        ['127N'],
        [{ date: '20100115', weekdayColumn: 'monday' }], // before 20200101
      );
      expect(rows).toEqual([]);
    });

    it('honors calendar_dates exception_type=2 (service removed on a specific date)', () => {
      seedSubway();
      db.run(
        `INSERT INTO calendar_dates (feed_id, service_id, date, exception_type)
         VALUES ('subway', 'WKDY', '20240115', 2)`,
      );
      const rows = getServedRouteIdsByStopIds(
        'subway',
        ['127N'],
        [{ date: '20240115', weekdayColumn: 'monday' }],
      );
      expect(rows).toEqual([]);
    });

    it('honors calendar_dates exception_type=1 (service added on a date the calendar would not match)', () => {
      seedSubway();
      // Sunday — WKDY normally inactive. Add an exception making it active just for this date.
      db.run(
        `INSERT INTO calendar_dates (feed_id, service_id, date, exception_type)
         VALUES ('subway', 'WKDY', '20240114', 1)`,
      );
      const rows = getServedRouteIdsByStopIds(
        'subway',
        ['127N'],
        [{ date: '20240114', weekdayColumn: 'sunday' }],
      );
      expect(rows).toEqual(['1']);
    });

    it('ORs multiple service dates (late-night case: previous + current day)', () => {
      seedSubway();
      // The WKDY service is inactive Sunday but active Monday. Pass both
      // — should still find the route via Monday.
      const rows = getServedRouteIdsByStopIds(
        'subway',
        ['127N'],
        [
          { date: '20240115', weekdayColumn: 'monday' },
          { date: '20240114', weekdayColumn: 'sunday' },
        ],
      );
      expect(rows).toEqual(['1']);
    });

    it('does NOT pass weekday match alone if calendar is missing (no false positive)', () => {
      // Insert only a trip with no calendar at all
      db.run(
        `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
         VALUES ('subway', 'X', 'X', 0, 0, 0, NULL)`,
      );
      db.run(
        `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
         VALUES ('subway', 'R', 'NYCT', 'R', 'R', NULL, 1)`,
      );
      db.run(
        `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
         VALUES ('subway', 'TX', 'R', 'NOPE', 0, NULL)`,
      );
      db.run(
        `INSERT INTO stop_times (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence)
         VALUES ('subway', 'TX', 'X', '10:00:00', '10:00:00', 1)`,
      );
      const rows = getServedRouteIdsByStopIds(
        'subway',
        ['X'],
        [{ date: '20240115', weekdayColumn: 'monday' }],
      );
      expect(rows).toEqual([]);
    });

    it('deduplicates routes when multiple trips serve the stop', () => {
      seedSubway();
      // Add a second trip on the same route serving the same platform
      db.run(
        `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
         VALUES ('subway', 'T2', '1', 'WKDY', 1, NULL)`,
      );
      db.run(
        `INSERT INTO stop_times (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence)
         VALUES ('subway', 'T2', '127N', '10:30:00', '10:30:00', 1)`,
      );
      const rows = getServedRouteIdsByStopIds(
        'subway',
        ['127N'],
        [{ date: '20240115', weekdayColumn: 'monday' }],
      );
      expect(rows).toEqual(['1']);
    });

    it('queries multiple stop_ids correctly (IN clause)', () => {
      seedSubway();
      const rows = getServedRouteIdsByStopIds(
        'subway',
        ['127N', '127S'],
        [{ date: '20240115', weekdayColumn: 'monday' }],
      );
      expect(rows).toEqual(['1']);
    });

    // LIRR and MNR ship no calendar.txt — every trip's service is active
    // exclusively via a calendar_dates exception_type=1 row, with no
    // calendar row backing it at all. A regression here (e.g. a query that
    // requires a calendar row to exist) fails silently as an empty array,
    // not a thrown error, so it needs its own coverage rather than relying
    // on the calendar+calendar_dates interplay cases above.
    it('resolves calendar_dates-only service with no calendar row (LIRR)', () => {
      seedLirrSchedule();
      const rows = getServedRouteIdsByStopIds(
        'lirr',
        ['44'],
        [{ date: '20240115', weekdayColumn: 'monday' }],
      );
      expect(rows).toEqual(['RONK']);
    });

    it('resolves calendar_dates-only service with no calendar row (MNR)', () => {
      seedMnrSchedule();
      const rows = getServedRouteIdsByStopIds(
        'mnr',
        ['1'],
        [{ date: '20240115', weekdayColumn: 'monday' }],
      );
      expect(rows).toEqual(['NH']);
    });

    it('returns [] for calendar_dates-only service on a date with no exception row', () => {
      seedLirrSchedule();
      const rows = getServedRouteIdsByStopIds(
        'lirr',
        ['44'],
        [{ date: '20240116', weekdayColumn: 'tuesday' }],
      );
      expect(rows).toEqual([]);
    });

    // Re-asserts exception_type=2 beating a matching weekday against a
    // physically real, three-stop trip (not the T1 fixture) after the
    // activeServicePredicate extraction.
    it('honors exception_type=2 removal against a real trip, even on its normally-active weekday', () => {
      seedSubwaySchedule();
      // WKDY is Mon-Fri; 2024-01-22 is a Monday, removed via calendar_dates.
      const rows = getServedRouteIdsByStopIds(
        'subway',
        ['101N'],
        [{ date: '20240122', weekdayColumn: 'monday' }],
      );
      expect(rows).toEqual([]);
    });

    it('honors exception_type=1 addition against a real trip, on its normally-inactive weekday', () => {
      seedSubwaySchedule();
      // WKDY is Mon-Fri; 2024-01-20 is a Saturday, added via calendar_dates.
      const rows = getServedRouteIdsByStopIds(
        'subway',
        ['101N'],
        [{ date: '20240120', weekdayColumn: 'saturday' }],
      );
      expect(rows).toEqual(['1']);
    });
  });
});
