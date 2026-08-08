import { describe, expect, it, beforeEach } from 'bun:test';
import { getSchedule, getTripSchedule } from '../../src/services/schedule.service';
import { NotFoundError } from '../../src/services/realtime.service';
import { db } from '../../src/db/client';
import {
  resetDb,
  seedSubway,
  seedSubwaySchedule,
  seedLirrSchedule,
  seedMnrSchedule,
} from '../helpers/seed';

// Monday, 2024-01-15, 10:00 NY (EST, UTC-5) - matches the fixtures'
// calendar/calendar_dates coverage (WKDY Mon-Fri; LIRR/MNR's calendar_dates
// exception is on this exact date).
const NOW = new Date('2024-01-15T15:00:00.000Z');

describe('services/schedule.service', () => {
  beforeEach(() => {
    resetDb();
  });

  describe('getSchedule', () => {
    it('throws NotFoundError for an unknown stop', () => {
      expect(() => getSchedule({ stopId: 'nope', feedId: 'subway', limit: 10 }, NOW)).toThrow(NotFoundError);
    });

    it('resolves a platform stop_id to its parent station in the response header', () => {
      seedSubwaySchedule();
      const res = getSchedule({ stopId: '101N', feedId: 'subway', date: '20240115', limit: 20 }, NOW);
      expect(res.stop_id).toBe('101');
      expect(res.stop_name).toBe('Van Cortlandt Park-242 St');
      expect(res.feed_id).toBe('subway');
      expect(res.source).toBe('scheduled');
    });

    it('merges departures across a parent station\'s platforms in correct global order', () => {
      // Regression case for the platform-IN-list performance bug: a naive
      // `stop_id IN (127N, 127S)` query can return results sorted only
      // *within* each platform, silently missing a genuinely-earlier
      // departure on the other one. T-SOUTH departs 127S at 09:15, before
      // T-LOCAL's 09:30 at 127N - both must appear, 127S first.
      seedSubwaySchedule();
      db.run(
        `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
         VALUES ('subway', 'T-SOUTH', '1', 'WKDY', 1, NULL)`,
      );
      db.run(
        `INSERT INTO stop_times (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
         VALUES ('subway', 'T-SOUTH', '127S', '09:15:00', '09:15:00', 1, ${9 * 3600 + 15 * 60}, ${9 * 3600 + 15 * 60})`,
      );
      // 127 is the parent both T-LOCAL (127N) and T-SOUTH (127S) share.
      const res = getSchedule({ stopId: '127', feedId: 'subway', date: '20240115', limit: 20 }, NOW);
      const both = res.departures.filter((d) => d.trip_id === 'T-SOUTH' || d.trip_id === 'T-LOCAL');
      expect(both.map((d) => d.trip_id)).toEqual(['T-SOUTH', 'T-LOCAL']);
    });

    it('pins to a single service date when `date` is given, ignoring the 3-day window', () => {
      seedSubwaySchedule();
      const res = getSchedule({ stopId: '101', feedId: 'subway', date: '20240115', limit: 20 }, NOW);
      expect(res.service_dates).toEqual(['20240115']);
      expect(res.departures.every((d) => d.service_date === '20240115')).toBe(true);
    });

    it('returns the whole-day timetable for a pinned date, sorted by departure_timestamp', () => {
      seedSubwaySchedule();
      // Both T-LOCAL (09:30) and T-LATE (25:30, i.e. 01:30 the next
      // calendar day) stop at 127N.
      const res = getSchedule({ stopId: '127N', feedId: 'subway', date: '20240115', limit: 20 }, NOW);
      expect(res.departures.map((d) => d.trip_id)).toEqual(['T-LOCAL', 'T-LATE']);
      expect(res.departures[0].departure_timestamp).toBeLessThan(res.departures[1].departure_timestamp);
    });

    it('computes departure_timestamp correctly across the spring-forward DST boundary', () => {
      // Prove the schedule layer, not just getServiceDayOriginUnix in
      // isolation, resolves the 25:30:00 rollover to the correct real
      // wall-clock instant. 2024-03-10 is a Sunday, when WKDY doesn't
      // normally run - force it active via a calendar_dates exception, the
      // same override machinery already covered elsewhere.
      seedSubwaySchedule();
      db.run(
        `INSERT INTO calendar_dates (feed_id, service_id, date, exception_type)
         VALUES ('subway', 'WKDY', '20240310', 1)`,
      );
      const res = getSchedule({ stopId: '127N', feedId: 'subway', date: '20240310', limit: 20 }, NOW);
      const late = res.departures.find((d) => d.trip_id === 'T-LATE')!;
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).formatToParts(new Date(late.departure_timestamp * 1000));
      const get = (t: string) => parts.find((p) => p.type === t)!.value;
      expect(`${get('year')}${get('month')}${get('day')}`).toBe('20240311');
      expect(get('hour')).toBe('01');
      expect(get('minute')).toBe('30');
    });

    it('excludes a trip whose service is not active on the pinned date', () => {
      seedSubwaySchedule();
      // Sunday - WKDY does not run.
      const res = getSchedule({ stopId: '101', feedId: 'subway', date: '20240114', limit: 20 }, NOW);
      expect(res.departures).toEqual([]);
    });

    it('defaults to [yesterday, today, tomorrow] relative to the injected `now` when neither date nor after is given', () => {
      seedSubwaySchedule();
      const res = getSchedule({ stopId: '101', feedId: 'subway', limit: 20 }, NOW);
      expect(res.service_dates).toEqual(['20240114', '20240115', '20240116']);
    });

    it('filters out today\'s already-passed departure, but still surfaces tomorrow\'s (WKDY runs Tue too)', () => {
      seedSubwaySchedule();
      // T-LOCAL departs 101N at 09:00 local; NOW is 10:00 local Monday, so
      // today's run must be excluded - but WKDY also runs Tuesday, and
      // tomorrow 09:00 is still genuinely in the future relative to now.
      const res = getSchedule({ stopId: '101', feedId: 'subway', limit: 20 }, NOW);
      const localRuns = res.departures.filter((d) => d.trip_id === 'T-LOCAL');
      expect(localRuns.map((d) => d.service_date)).toEqual(['20240116']);
    });

    it('an explicit `after` before 09:00 includes T-LOCAL', () => {
      seedSubwaySchedule();
      const eightAm = Math.floor(new Date('2024-01-15T13:00:00.000Z').getTime() / 1000); // 08:00 NY
      const res = getSchedule({ stopId: '101', feedId: 'subway', after: eightAm, limit: 20 }, NOW);
      expect(res.departures.some((d) => d.trip_id === 'T-LOCAL')).toBe(true);
    });

    describe('to filter', () => {
      it('resolves a real LIRR A->B query and populates destination with duration_seconds', () => {
        seedLirrSchedule();
        const res = getSchedule(
          { stopId: '44', feedId: 'lirr', toStopId: '237', date: '20240115', limit: 20 },
          NOW,
        );
        expect(res.to_stop_id).toBe('237');
        expect(res.to_stop_name).toBe('Penn Station');
        expect(res.departures).toHaveLength(1);
        const dep = res.departures[0];
        expect(dep.destination).toEqual({
          stop_id: '237',
          stop_name: 'Penn Station',
          stop_sequence: 3,
          arrival_time: '13:30:00',
          arrival_timestamp: dep.departure_timestamp + (13 * 3600 + 30 * 60 - (12 * 3600 + 22 * 60)),
          duration_seconds: 13 * 3600 + 30 * 60 - (12 * 3600 + 22 * 60),
        });
      });

      it('omits `destination` entirely when `to` is not given', () => {
        seedLirrSchedule();
        const res = getSchedule({ stopId: '44', feedId: 'lirr', date: '20240115', limit: 20 }, NOW);
        expect(res.departures[0].destination).toBeUndefined();
        expect('destination' in res.departures[0]).toBe(false);
      });

      it('throws NotFoundError with a destination-specific message for an unknown `to` stop', () => {
        seedLirrSchedule();
        expect(() =>
          getSchedule({ stopId: '44', feedId: 'lirr', toStopId: 'nope', limit: 20 }, NOW),
        ).toThrow(/Destination stop nope not found/);
      });
    });

    describe('pagination', () => {
      it('sets next_after on a full page and null otherwise', () => {
        seedSubwaySchedule();
        const full = getSchedule({ stopId: '127N', feedId: 'subway', date: '20240115', limit: 1 }, NOW);
        expect(full.departures).toHaveLength(1);
        expect(full.next_after).toBe(full.departures[0].departure_timestamp + 1);

        const notFull = getSchedule({ stopId: '127N', feedId: 'subway', date: '20240115', limit: 20 }, NOW);
        expect(notFull.next_after).toBeNull();
      });

      it('next_after as the following after= excludes the already-seen departure', () => {
        seedSubwaySchedule();
        const page1 = getSchedule({ stopId: '127N', feedId: 'subway', date: '20240115', limit: 1 }, NOW);
        const page2 = getSchedule(
          { stopId: '127N', feedId: 'subway', date: '20240115', after: page1.next_after!, limit: 20 },
          NOW,
        );
        expect(page2.departures.map((d) => d.trip_id)).toEqual(['T-LATE']);
      });
    });
  });

  describe('getTripSchedule', () => {
    it('resolves an exact LIRR trip_id with a pinned date', () => {
      seedLirrSchedule();
      const res = getTripSchedule({ tripId: 'GO201_26_SCHED', feedId: 'lirr', date: '20240115' }, NOW);
      expect(res.matched_by).toBe('exact');
      expect(res.resolved_trip_id).toBe('GO201_26_SCHED');
      expect(res.trip_id).toBe('GO201_26_SCHED');
      expect(res.route_id).toBe('RONK');
      expect(res.route_long_name).toBe('Ronkonkoma Branch');
      expect(res.headsign).toBe('Penn Station');
      expect(res.train_number).toBe('1013');
      expect(res.direction_id).toBe(1);
      expect(res.peak).toBe(false);
      expect(res.service_date).toBe('20240115');
      expect(res.origin.stop_id).toBe('44');
      expect(res.destination.stop_id).toBe('237');
      expect(res.stops).toHaveLength(3);
      expect(res.origin.departure_timestamp).not.toBeNull();
    });

    it('defaults service_date to the first candidate date the service is active on', () => {
      seedLirrSchedule();
      // No date given; NOW resolves to [Sun 1/14, Mon 1/15, Tue 1/16] -
      // only Monday has an exception_type=1 row for SCHED.
      const res = getTripSchedule({ tripId: 'GO201_26_SCHED', feedId: 'lirr' }, NOW);
      expect(res.service_date).toBe('20240115');
    });

    it('returns null service_date and null timestamps when no candidate date is active', () => {
      seedLirrSchedule();
      db.run(`DELETE FROM calendar_dates WHERE service_id = 'SCHED'`);
      const res = getTripSchedule({ tripId: 'GO201_26_SCHED', feedId: 'lirr' }, NOW);
      expect(res.service_date).toBeNull();
      expect(res.origin.departure_timestamp).toBeNull();
      expect(res.origin.departure_time).toBe('12:22:00'); // raw time still present
    });

    it('resolves a subway trip_id via suffix match when no exact match exists', () => {
      seedSubwaySchedule();
      db.run(
        `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
         VALUES ('subway', '086850_1..S03R', '1', 'WKDY', 1, NULL)`,
      );
      db.run(
        `INSERT INTO stop_times (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
         VALUES ('subway', '086850_1..S03R', '127N', '11:00:00', '11:00:00', 1, ${11 * 3600}, ${11 * 3600})`,
      );
      const res = getTripSchedule({ tripId: '1..S03R', feedId: 'subway' }, NOW);
      expect(res.matched_by).toBe('rt_trip_id_suffix');
      expect(res.resolved_trip_id).toBe('086850_1..S03R');
      expect(res.trip_id).toBe('1..S03R'); // echoes the ID as requested
    });

    it('throws a Metro-North-specific NotFoundError without attempting suffix resolution', () => {
      seedMnrSchedule();
      expect(() => getTripSchedule({ tripId: 'some-rt-id', feedId: 'mnr' }, NOW)).toThrow(
        /Metro-North's realtime trip IDs can't be resolved/,
      );
    });

    it('throws a plain NotFoundError for an unresolvable LIRR trip_id (no suffix fallback)', () => {
      seedLirrSchedule();
      expect(() => getTripSchedule({ tripId: 'not-a-real-trip', feedId: 'lirr' }, NOW)).toThrow(NotFoundError);
    });

    it('throws NotFoundError for a subway trip_id with no exact or suffix match', () => {
      seedSubwaySchedule();
      expect(() => getTripSchedule({ tripId: 'totally-unknown', feedId: 'subway' }, NOW)).toThrow(NotFoundError);
    });

    it('throws NotFoundError for a trip that exists but has zero stop_times', () => {
      seedSubway();
      db.run(
        `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
         VALUES ('subway', 'ORPHAN', '1', 'WKDY', 0, NULL)`,
      );
      expect(() => getTripSchedule({ tripId: 'ORPHAN', feedId: 'subway' }, NOW)).toThrow(NotFoundError);
    });
  });
});
