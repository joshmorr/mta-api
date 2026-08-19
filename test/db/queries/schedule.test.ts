import { describe, expect, it, beforeEach } from 'bun:test';
import {
  getScheduledDepartures,
  getTripMeta,
  getTripStops,
  findSubwayTripIdsBySuffix,
  isTripActiveOnDate,
  getOutboundLegs,
  getInboundLegs,
} from '../../../src/db/queries/schedule';
import { db } from '../../../src/db/client';
import {
  resetDb,
  seedSubwaySchedule,
  seedLirrSchedule,
  seedMnrSchedule,
  seedLirrTransferSchedule,
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
    it('returns departures that reach the destination, ordered by departure_seconds', () => {
      seedSubwaySchedule();
      // T-LOCAL departs 101N at 09:00:00 (32400s) and reaches 127N at 09:30.
      const rows = getScheduledDepartures('subway', '101N', ['127N'], MONDAY, 0, 10);
      expect(rows.map((r) => r.trip_id)).toEqual(['T-LOCAL']);
      expect(rows[0]).toMatchObject({
        route_id: '1',
        stop_id: '101N',
        stop_sequence: 1,
        departure_seconds: 9 * 3600,
        headsign: null,
        dest_stop_id: '127N',
      });
    });

    it('excludes departures at or before afterSeconds', () => {
      seedSubwaySchedule();
      const before = getScheduledDepartures('subway', '101N', ['127N'], MONDAY, 9 * 3600, 10);
      expect(before).toHaveLength(1); // >= is inclusive
      const after = getScheduledDepartures('subway', '101N', ['127N'], MONDAY, 9 * 3600 + 1, 10);
      expect(after).toHaveLength(0);
    });

    it('respects limit', () => {
      seedSubwaySchedule();
      // A second 101N -> 127N trip, seeded here rather than in the shared
      // fixture (six suites assert against its exact current shape). Two
      // matching trips is the minimum that makes LIMIT observable.
      db.run(
        `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
         VALUES ('subway', 'T-LOCAL-2', '1', 'WKDY', 0, NULL)`,
      );
      db.run(
        `INSERT INTO stop_times
           (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
         VALUES
           ('subway', 'T-LOCAL-2', '101N', '09:15:00', '09:15:00', 1, ${9 * 3600 + 900}, ${9 * 3600 + 900}),
           ('subway', 'T-LOCAL-2', '127N', '09:45:00', '09:45:00', 2, ${9 * 3600 + 2700}, ${9 * 3600 + 2700})`,
      );

      expect(getScheduledDepartures('subway', '101N', ['127N'], MONDAY, 0, 10).map((r) => r.trip_id))
        .toEqual(['T-LOCAL', 'T-LOCAL-2']);
      expect(getScheduledDepartures('subway', '101N', ['127N'], MONDAY, 0, 1).map((r) => r.trip_id))
        .toEqual(['T-LOCAL']);
    });

    it('excludes rows with no departure_seconds', () => {
      seedSubwaySchedule();
      // seedSubway's T1 runs 127N -> 127S, but neither stop_time has
      // arrival/departure_seconds populated (the raw INSERT omits those
      // columns) - so the pair matches the join yet must not appear.
      const rows = getScheduledDepartures('subway', '127N', ['127S'], MONDAY, 0, 10);
      expect(rows).toEqual([]);
    });

    it('excludes a trip whose service is not active on the queried date, even though it stops there', () => {
      seedSubwaySchedule();
      // T-LOCAL/T-LATE run WKDY (Mon-Fri); Sunday is inactive for them.
      const rows = getScheduledDepartures('subway', '101N', ['127N'], SUNDAY, 0, 10);
      expect(rows).toEqual([]);
    });

    it('honors a calendar_dates exception_type=1 addition on an otherwise-inactive weekday', () => {
      seedSubwaySchedule();
      // seedSubwaySchedule adds a calendar_dates exception_type=1 row for
      // WKDY on 2024-01-20 (a Saturday).
      const rows = getScheduledDepartures(
        'subway',
        '101N',
        ['127N'],
        { date: '20240120', weekdayColumn: 'saturday' },
        0,
        10,
      );
      expect(rows.map((r) => r.trip_id)).toEqual(['T-LOCAL']);
    });

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

    it('short-circuits to [] when toStopIds is empty rather than degrading into no filter', () => {
      seedLirrSchedule();
      expect(getScheduledDepartures('lirr', '44', [], MONDAY, 0, 10)).toEqual([]);
      // Sanity: the same query with a real destination does match.
      expect(getScheduledDepartures('lirr', '44', ['237'], MONDAY, 0, 10)).toHaveLength(1);
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

describe('db/queries/schedule - journey legs', () => {
  beforeEach(() => {
    resetDb();
    seedLirrTransferSchedule();
  });

  const DAY_END = 30 * 3600;

  describe('getOutboundLegs', () => {
    it('pairs each origin departure with every stop it reaches afterwards', () => {
      const legs = getOutboundLegs('lirr', '171', [], MONDAY, 0, DAY_END);

      expect(legs.every((l) => l.board_stop_id === '171')).toBe(true);
      expect(legs.map((l) => l.alight_stop_id)).toEqual(['214', '237']);
      expect(legs[0].trip_id).toBe('XFER-A');
      expect(legs[0].board_departure_seconds).toBe(10 * 3600);
      expect(legs[0].alight_arrival_seconds).toBe(10 * 3600 + 30 * 60);
      expect(legs[0].route_long_name).toBe('Port Washington Branch');
      expect(legs[0].train_number).toBe('300');
      expect(legs[0].alight_track).toBe('3');
    });

    it('omits excluded stops from the alighting side', () => {
      const legs = getOutboundLegs('lirr', '171', ['237'], MONDAY, 0, DAY_END);

      expect(legs.map((l) => l.alight_stop_id)).toEqual(['214']);
    });

    it('bounds the first leg by the departure window', () => {
      expect(getOutboundLegs('lirr', '171', [], MONDAY, 10 * 3600 + 1, DAY_END)).toEqual([]);
      expect(getOutboundLegs('lirr', '171', [], MONDAY, 0, 10 * 3600 - 1)).toEqual([]);
      // Both bounds are inclusive.
      expect(getOutboundLegs('lirr', '171', [], MONDAY, 10 * 3600, 10 * 3600)).not.toEqual([]);
    });

    it('excludes trips whose service is not active on the date', () => {
      expect(getOutboundLegs('lirr', '171', [], SUNDAY, 0, DAY_END)).toEqual([]);
    });

    it('skips a stop with no published arrival time', () => {
      db.run(
        `UPDATE stop_times SET arrival_time = NULL, arrival_seconds = NULL
         WHERE feed_id = 'lirr' AND trip_id = 'XFER-A' AND stop_id = '214'`,
      );

      expect(getOutboundLegs('lirr', '171', [], MONDAY, 0, DAY_END).map((l) => l.alight_stop_id))
        .toEqual(['237']);
    });
  });

  describe('getInboundLegs', () => {
    it('returns every stop a rider could board from to reach the destination', () => {
      const legs = getInboundLegs('lirr', ['27'], [], MONDAY, 0);

      expect(legs.every((l) => l.alight_stop_id === '27')).toBe(true);
      expect(new Set(legs.map((l) => l.trip_id))).toEqual(new Set(['XFER-B', 'XFER-C', 'XFER-D']));
      expect(new Set(legs.map((l) => l.board_stop_id))).toEqual(new Set(['214', '237']));
    });

    it('omits excluded stops from the boarding side', () => {
      const legs = getInboundLegs('lirr', ['27'], ['237'], MONDAY, 0);

      expect(new Set(legs.map((l) => l.board_stop_id))).toEqual(new Set(['214']));
    });

    it('is ordered by boarding stop then departure, so callers can bucket it', () => {
      const legs = getInboundLegs('lirr', ['27'], [], MONDAY, 0);
      const keys = legs.map((l) => [l.board_stop_id, l.board_departure_seconds] as const);

      expect(keys).toEqual([...keys].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]));
    });

    it('trims second legs departing before the earliest possible connection', () => {
      // Inclusive: XFER-B leaves Woodside at exactly 10:45, XFER-D at 10:33.
      const trimmed = getInboundLegs('lirr', ['27'], [], MONDAY, 10 * 3600 + 45 * 60);
      expect(new Set(trimmed.map((l) => l.trip_id))).toEqual(new Set(['XFER-B', 'XFER-C']));

      expect(getInboundLegs('lirr', ['27'], [], MONDAY, 11 * 3600 + 1)).toEqual([]);
    });

    it('excludes trips whose service is not active on the date', () => {
      expect(getInboundLegs('lirr', ['27'], [], SUNDAY, 0)).toEqual([]);
    });

    it('matches nothing rather than everything for an empty destination set', () => {
      expect(getInboundLegs('lirr', [], [], MONDAY, 0)).toEqual([]);
    });
  });
});
