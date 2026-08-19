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
  seedLirrTransferSchedule,
  seedTransfersXfer,
} from '../helpers/seed';

// Monday, 2024-01-15, 10:00 NY (EST, UTC-5) - matches the fixtures'
// calendar/calendar_dates coverage (WKDY Mon-Fri; LIRR/MNR's calendar_dates
// exception is on this exact date).
const NOW = new Date('2024-01-15T15:00:00.000Z');

/**
 * Extends seedSubwaySchedule's two trips one stop further down the 1 line, to
 * South Ferry(142N), so both have somewhere to *reach*: T-LOCAL 127N(09:30) ->
 * 142N(09:50), and the 25:30 rollover trip T-LATE 127N(25:30) -> 142N(25:50).
 * Now that /schedule is a station-pair query, the ordering, rollover and
 * pagination cases all need two trips sharing one origin->destination pair,
 * and 127N is the last stop of both fixture trips as shipped. Local to this
 * file rather than in the shared fixture, which six suites pin exactly.
 */
function seedOnwardTo142(): void {
  db.run(
    `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
     VALUES
       ('subway', '142',  'South Ferry', 40.702068, -74.013664, 1, NULL),
       ('subway', '142N', 'South Ferry', 40.702068, -74.013664, 0, '142')`,
  );
  db.run(
    `INSERT INTO stop_times
       (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
     VALUES
       ('subway', 'T-LOCAL', '142N', '09:50:00', '09:50:00', 4, ${9 * 3600 + 50 * 60}, ${9 * 3600 + 50 * 60}),
       ('subway', 'T-LATE',  '142N', '25:50:00', '25:50:00', 2, ${25 * 3600 + 50 * 60}, ${25 * 3600 + 50 * 60})`,
  );
}

describe('services/schedule.service', () => {
  beforeEach(() => {
    resetDb();
  });

  describe('getSchedule', () => {
    it('throws NotFoundError with an origin-specific message for an unknown `from` stop', () => {
      seedSubwaySchedule();
      expect(() =>
        getSchedule({ fromStopId: 'nope', feedId: 'subway', toStopId: '127', limit: 10 }, NOW),
      ).toThrow(/Origin stop nope not found/);
      expect(() =>
        getSchedule({ fromStopId: 'nope', feedId: 'subway', toStopId: '127', limit: 10 }, NOW),
      ).toThrow(NotFoundError);
    });

    it('resolves platform stop_ids to their parent stations in the response header', () => {
      seedSubwaySchedule();
      const res = getSchedule(
        { fromStopId: '101N', feedId: 'subway', toStopId: '127N', date: '20240115', limit: 20 },
        NOW,
      );
      expect(res.from_stop_id).toBe('101');
      expect(res.from_stop_name).toBe('Van Cortlandt Park-242 St');
      expect(res.to_stop_id).toBe('127');
      expect(res.to_stop_name).toBe('Times Sq-42 St');
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
      seedOnwardTo142();
      db.run(
        `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
         VALUES ('subway', 'T-SOUTH', '1', 'WKDY', 1, NULL)`,
      );
      db.run(
        `INSERT INTO stop_times (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
         VALUES
           ('subway', 'T-SOUTH', '127S', '09:15:00', '09:15:00', 1, ${9 * 3600 + 15 * 60}, ${9 * 3600 + 15 * 60}),
           ('subway', 'T-SOUTH', '142N', '09:40:00', '09:40:00', 2, ${9 * 3600 + 40 * 60}, ${9 * 3600 + 40 * 60})`,
      );
      // 127 is the parent both T-LOCAL (127N) and T-SOUTH (127S) share; both
      // continue to 142N.
      const res = getSchedule(
        { fromStopId: '127', feedId: 'subway', toStopId: '142', date: '20240115', limit: 20 },
        NOW,
      );
      const both = res.departures.filter((d) => d.trip_id === 'T-SOUTH' || d.trip_id === 'T-LOCAL');
      expect(both.map((d) => d.trip_id)).toEqual(['T-SOUTH', 'T-LOCAL']);
    });

    it('pins to a single service date when `date` is given, ignoring the 3-day window', () => {
      seedSubwaySchedule();
      const res = getSchedule(
        { fromStopId: '101', feedId: 'subway', toStopId: '127', date: '20240115', limit: 20 },
        NOW,
      );
      expect(res.service_dates).toEqual(['20240115']);
      expect(res.departures.every((d) => d.service_date === '20240115')).toBe(true);
    });

    it('returns the whole-day timetable for a pinned date, sorted by departure_timestamp', () => {
      seedSubwaySchedule();
      seedOnwardTo142();
      // Both T-LOCAL (09:30) and T-LATE (25:30, i.e. 01:30 the next
      // calendar day) depart 127N and reach 142N.
      const res = getSchedule(
        { fromStopId: '127N', feedId: 'subway', toStopId: '142N', date: '20240115', limit: 20 },
        NOW,
      );
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
      seedOnwardTo142();
      db.run(
        `INSERT INTO calendar_dates (feed_id, service_id, date, exception_type)
         VALUES ('subway', 'WKDY', '20240310', 1)`,
      );
      const res = getSchedule(
        { fromStopId: '127N', feedId: 'subway', toStopId: '142N', date: '20240310', limit: 20 },
        NOW,
      );
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
      const res = getSchedule(
        { fromStopId: '101', feedId: 'subway', toStopId: '127', date: '20240114', limit: 20 },
        NOW,
      );
      expect(res.departures).toEqual([]);
    });

    it('defaults to [yesterday, today, tomorrow] relative to the injected `now` when neither date nor after is given', () => {
      seedSubwaySchedule();
      const res = getSchedule({ fromStopId: '101', feedId: 'subway', toStopId: '127', limit: 20 }, NOW);
      expect(res.service_dates).toEqual(['20240114', '20240115', '20240116']);
    });

    it('filters out today\'s already-passed departure, but still surfaces tomorrow\'s (WKDY runs Tue too)', () => {
      seedSubwaySchedule();
      // T-LOCAL departs 101N at 09:00 local; NOW is 10:00 local Monday, so
      // today's run must be excluded - but WKDY also runs Tuesday, and
      // tomorrow 09:00 is still genuinely in the future relative to now.
      const res = getSchedule({ fromStopId: '101', feedId: 'subway', toStopId: '127', limit: 20 }, NOW);
      const localRuns = res.departures.filter((d) => d.trip_id === 'T-LOCAL');
      expect(localRuns.map((d) => d.service_date)).toEqual(['20240116']);
    });

    it('an explicit `after` before 09:00 includes T-LOCAL', () => {
      seedSubwaySchedule();
      const eightAm = Math.floor(new Date('2024-01-15T13:00:00.000Z').getTime() / 1000); // 08:00 NY
      const res = getSchedule(
        { fromStopId: '101', feedId: 'subway', toStopId: '127', after: eightAm, limit: 20 },
        NOW,
      );
      expect(res.departures.some((d) => d.trip_id === 'T-LOCAL')).toBe(true);
    });

    describe('destination', () => {
      it('resolves a real LIRR A->B query and populates destination with duration_seconds', () => {
        seedLirrSchedule();
        const res = getSchedule(
          { fromStopId: '44', feedId: 'lirr', toStopId: '237', date: '20240115', limit: 20 },
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

      it('throws NotFoundError with a destination-specific message for an unknown `to` stop', () => {
        seedLirrSchedule();
        expect(() =>
          getSchedule({ fromStopId: '44', feedId: 'lirr', toStopId: 'nope', limit: 20 }, NOW),
        ).toThrow(/Destination stop nope not found/);
      });

      it('returns no departures for a pair no trip connects in that direction', () => {
        seedLirrSchedule();
        // Penn(237) -> Deer Park(44) is the reverse of the only seeded trip.
        const res = getSchedule(
          { fromStopId: '237', feedId: 'lirr', toStopId: '44', date: '20240115', limit: 20 },
          NOW,
        );
        expect(res.departures).toEqual([]);
        expect(res.from_stop_name).toBe('Penn Station');
        expect(res.to_stop_name).toBe('Deer Park');
      });
    });

    describe('pagination', () => {
      it('sets next_after on a full page and null otherwise', () => {
        seedSubwaySchedule();
        seedOnwardTo142();
        const full = getSchedule(
          { fromStopId: '127N', feedId: 'subway', toStopId: '142N', date: '20240115', limit: 1 },
          NOW,
        );
        expect(full.departures).toHaveLength(1);
        expect(full.next_after).toBe(full.departures[0].departure_timestamp + 1);

        const notFull = getSchedule(
          { fromStopId: '127N', feedId: 'subway', toStopId: '142N', date: '20240115', limit: 20 },
          NOW,
        );
        expect(notFull.next_after).toBeNull();
      });

      it('next_after as the following after= excludes the already-seen departure', () => {
        seedSubwaySchedule();
        seedOnwardTo142();
        const page1 = getSchedule(
          { fromStopId: '127N', feedId: 'subway', toStopId: '142N', date: '20240115', limit: 1 },
          NOW,
        );
        const page2 = getSchedule(
          {
            fromStopId: '127N',
            feedId: 'subway',
            toStopId: '142N',
            date: '20240115',
            after: page1.next_after!,
            limit: 20,
          },
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

describe('services/schedule.service - transfer journeys', () => {
  beforeEach(() => {
    resetDb();
    seedLirrTransferSchedule();
  });

  const pair = { fromStopId: '171', feedId: 'lirr' as const, toStopId: '27', date: '20240115', limit: 20 };

  it('answers a station pair that has no through train', () => {
    const result = getSchedule(pair, NOW);

    expect(result.max_transfers).toBe(1);
    expect(result.departures).toHaveLength(1);

    const [journey] = result.departures;
    expect(journey.transfers).toBe(1);
    expect(journey.legs).toHaveLength(2);
    expect(journey.legs.map((l) => l.trip_id)).toEqual(['XFER-A', 'XFER-D']);
  });

  it('describes the first leg\'s boarding in the fields beside `legs`', () => {
    const [journey] = getSchedule(pair, NOW).departures;

    expect(journey.trip_id).toBe('XFER-A');
    expect(journey.stop_id).toBe('171');
    expect(journey.departure_time).toBe('10:00:00');
    expect(journey.train_number).toBe('300');
    expect(journey.legs[0].origin.stop_id).toBe(journey.stop_id);
    expect(journey.legs[0].origin.departure_timestamp).toBe(journey.departure_timestamp);
    expect(journey.legs[0].trip_id).toBe(journey.trip_id);
  });

  it('measures `destination` and duration_seconds across the whole journey', () => {
    const [journey] = getSchedule(pair, NOW).departures;

    // 10:00 out of Port Washington, 11:10 into Babylon.
    expect(journey.destination.stop_id).toBe('27');
    expect(journey.destination.arrival_time).toBe('11:10:00');
    expect(journey.destination.duration_seconds).toBe(70 * 60);
    expect(journey.destination.arrival_timestamp).toBe(journey.legs[1].destination.arrival_timestamp);
  });

  it('describes the interchange on the leg being transferred onto', () => {
    seedTransfersXfer();

    const [journey] = getSchedule(pair, NOW).departures;

    expect(journey.legs[0].transfer).toBeNull();
    const transfer = journey.legs[1].transfer!;
    expect(transfer.stop_id).toBe('214');
    expect(transfer.stop_name).toBe('Woodside');
    expect(transfer.connection_seconds).toBe(15 * 60);
    expect(transfer.min_transfer_time).toBe(600);
    expect(transfer.guaranteed).toBe(true);
    expect(transfer.departure_timestamp - transfer.arrival_timestamp).toBe(transfer.connection_seconds);
    expect(transfer.arrival_timestamp).toBe(journey.legs[0].destination.arrival_timestamp!);
    expect(transfer.departure_timestamp).toBe(journey.legs[1].origin.departure_timestamp!);
  });

  it('times each leg independently of the wait between them', () => {
    seedTransfersXfer();

    const [journey] = getSchedule(pair, NOW).departures;

    expect(journey.legs[0].duration_seconds).toBe(30 * 60); // 10:00 -> 10:30
    expect(journey.legs[1].duration_seconds).toBe(45 * 60); // 10:45 -> 11:30
    expect(journey.legs[0].route_long_name).toBe('Port Washington Branch');
    expect(journey.legs[1].route_long_name).toBe('Babylon Branch');
    expect(journey.legs.map((l) => l.leg_index)).toEqual([0, 1]);
  });

  it('never routes a transfer through a city terminal', () => {
    const result = getSchedule(pair, NOW);

    expect(
      result.departures.every((d) => d.legs.every((l) => l.transfer?.stop_id !== '237')),
    ).toBe(true);
  });

  it('returns direct trips only when max_transfers is 0', () => {
    const result = getSchedule({ ...pair, maxTransfers: 0 }, NOW);

    expect(result.max_transfers).toBe(0);
    expect(result.departures).toEqual([]);
  });

  it('clamps a request down to what the feed supports', () => {
    resetDb();
    seedSubwaySchedule();
    seedOnwardTo142();

    const result = getSchedule(
      { fromStopId: '127', feedId: 'subway', toStopId: '142', limit: 5, maxTransfers: 1 },
      NOW,
    );

    expect(result.max_transfers).toBe(0);
    expect(result.departures.every((d) => d.transfers === 0)).toBe(true);
  });

  it('gives a direct trip one leg mirroring the fields beside it', () => {
    resetDb();
    seedLirrSchedule();

    const [departure] = getSchedule(
      { fromStopId: '44', feedId: 'lirr', toStopId: '237', date: '20240115', limit: 5 },
      NOW,
    ).departures;

    expect(departure.transfers).toBe(0);
    expect(departure.legs).toHaveLength(1);
    expect(departure.legs[0].transfer).toBeNull();
    expect(departure.legs[0].origin.stop_id).toBe('44');
    expect(departure.legs[0].destination.stop_id).toBe('237');
    expect(departure.legs[0].destination.arrival_timestamp).toBe(departure.destination.arrival_timestamp);
    expect(departure.legs[0].trip_id).toBe(departure.trip_id);
  });

  it('drops a transfer journey a direct trip already beats', () => {
    // A through train leaving Port Washington at 10:05 and reaching Babylon at
    // 11:05 leaves later and arrives sooner than the 10:00 connection, so the
    // connection is not worth offering.
    db.run(
      `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, trip_headsign, trip_short_name, peak_offpeak)
       VALUES ('lirr', 'XFER-THRU', 'BABY', 'XSVC', 0, 'Babylon', '700', 0)`,
    );
    db.run(
      `INSERT INTO stop_times
         (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
       VALUES
         ('lirr', 'XFER-THRU', '171', '10:05:00', '10:05:00', 1, ${10 * 3600 + 5 * 60}, ${10 * 3600 + 5 * 60}),
         ('lirr', 'XFER-THRU', '27',  '11:05:00', '11:05:00', 2, ${11 * 3600 + 5 * 60}, ${11 * 3600 + 5 * 60})`,
    );

    const result = getSchedule(pair, NOW);

    expect(result.departures).toHaveLength(1);
    expect(result.departures[0].trip_id).toBe('XFER-THRU');
    expect(result.departures[0].transfers).toBe(0);
  });

  it('keeps a transfer journey that beats the through trains', () => {
    // Same through train, but now a slow one: it arrives after the connection.
    db.run(
      `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, trip_headsign, trip_short_name, peak_offpeak)
       VALUES ('lirr', 'XFER-SLOW', 'BABY', 'XSVC', 0, 'Babylon', '800', 0)`,
    );
    db.run(
      `INSERT INTO stop_times
         (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
       VALUES
         ('lirr', 'XFER-SLOW', '171', '10:05:00', '10:05:00', 1, ${10 * 3600 + 5 * 60}, ${10 * 3600 + 5 * 60}),
         ('lirr', 'XFER-SLOW', '27',  '12:30:00', '12:30:00', 2, ${12 * 3600 + 30 * 60}, ${12 * 3600 + 30 * 60})`,
    );

    const result = getSchedule(pair, NOW);

    expect(result.departures.map((d) => d.trip_id)).toEqual(['XFER-A', 'XFER-SLOW']);
    expect(result.departures.map((d) => d.transfers)).toEqual([1, 0]);
  });

  it('never drops a direct trip another direct trip dominates', () => {
    // The existing /schedule contract is a board of every departure that
    // reaches the destination, so a slow through train stays even though a
    // later one overtakes it.
    resetDb();
    seedLirrSchedule();
    db.run(
      `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, trip_headsign, trip_short_name, peak_offpeak)
       VALUES ('lirr', 'GO201_26_EXP', 'RONK', 'SCHED', 1, 'Penn Station', '1015', 0)`,
    );
    db.run(
      `INSERT INTO stop_times
         (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
       VALUES
         ('lirr', 'GO201_26_EXP', '44',  '12:25:00', '12:25:00', 1, ${12 * 3600 + 25 * 60}, ${12 * 3600 + 25 * 60}),
         ('lirr', 'GO201_26_EXP', '237', '13:00:00', '13:00:00', 2, ${13 * 3600}, ${13 * 3600})`,
    );

    const result = getSchedule(
      { fromStopId: '44', feedId: 'lirr', toStopId: '237', date: '20240115', limit: 20 },
      NOW,
    );

    expect(result.departures.map((d) => d.trip_id)).toEqual(['GO201_26_SCHED', 'GO201_26_EXP']);
  });

  it('paginates a mixed page of direct and transfer journeys', () => {
    db.run(
      `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, trip_headsign, trip_short_name, peak_offpeak)
       VALUES ('lirr', 'XFER-SLOW', 'BABY', 'XSVC', 0, 'Babylon', '800', 0)`,
    );
    db.run(
      `INSERT INTO stop_times
         (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
       VALUES
         ('lirr', 'XFER-SLOW', '171', '10:05:00', '10:05:00', 1, ${10 * 3600 + 5 * 60}, ${10 * 3600 + 5 * 60}),
         ('lirr', 'XFER-SLOW', '27',  '12:30:00', '12:30:00', 2, ${12 * 3600 + 30 * 60}, ${12 * 3600 + 30 * 60})`,
    );

    const first = getSchedule({ ...pair, limit: 1 }, NOW);
    expect(first.departures.map((d) => d.trip_id)).toEqual(['XFER-A']);
    expect(first.next_after).toBe(first.departures[0].departure_timestamp + 1);

    const second = getSchedule({ ...pair, limit: 1, after: first.next_after! }, NOW);
    expect(second.departures.map((d) => d.trip_id)).toEqual(['XFER-SLOW']);
    // A full page always hands back a cursor; exhaustion shows on the next one.
    expect(second.next_after).toBe(second.departures[0].departure_timestamp + 1);

    const third = getSchedule({ ...pair, limit: 1, after: second.next_after! }, NOW);
    expect(third.departures).toEqual([]);
    expect(third.next_after).toBeNull();
  });
});
