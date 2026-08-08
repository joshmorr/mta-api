import { describe, expect, it, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import * as protobuf from 'protobufjs';
import { join } from 'path';
import {
  getNyDateParts,
  getRelevantServiceDates,
  getArrivalsForStop,
  getVehiclesForRoute,
  NotFoundError,
} from '../../src/services/realtime.service';
import type { FeedMessage } from '../../src/types/gtfs';
import { resetDb, seedSubway, seedLirr, seedMnr } from '../helpers/seed';
import { db } from '../../src/db/client';

// All dates chosen to have unambiguous NY equivalents:
//   EST = UTC-5 (winter), EDT = UTC-4 (summer)
//   Jan 15 2024 = Monday, Jul 4 2024 = Thursday (2024 is a leap year)

describe('getNyDateParts', () => {
  it('returns correct date, weekday, and hour during EST (winter)', () => {
    const result = getNyDateParts(new Date('2024-01-15T15:00:00.000Z'));
    expect(result).toEqual({ date: '20240115', weekdayColumn: 'monday', hour: 10 });
  });

  it('returns correct date, weekday, and hour during EDT (summer)', () => {
    const result = getNyDateParts(new Date('2024-07-04T17:00:00.000Z'));
    expect(result).toEqual({ date: '20240704', weekdayColumn: 'thursday', hour: 13 });
  });

  it('handles early morning (hour < 5)', () => {
    const result = getNyDateParts(new Date('2024-01-15T07:00:00.000Z'));
    expect(result).toEqual({ date: '20240115', weekdayColumn: 'monday', hour: 2 });
  });

  it('handles exactly midnight NY time', () => {
    const result = getNyDateParts(new Date('2024-01-15T05:00:00.000Z'));
    expect(result).toEqual({ date: '20240115', weekdayColumn: 'monday', hour: 0 });
  });

  it('formats date as YYYYMMDD (zero-padded)', () => {
    const result = getNyDateParts(new Date('2024-03-02T15:00:00.000Z'));
    expect(result.date).toBe('20240302');
  });

  it('handles the DST spring-forward boundary (Mar 10 2024)', () => {
    const result = getNyDateParts(new Date('2024-03-10T12:00:00.000Z'));
    expect(result.date).toBe('20240310');
    expect(result.hour).toBe(8);
    expect(result.weekdayColumn).toBe('sunday');
  });
});

describe('getRelevantServiceDates', () => {
  it('returns only current day when hour >= 5', () => {
    const result = getRelevantServiceDates(new Date('2024-01-15T15:00:00.000Z'));
    expect(result).toEqual([{ date: '20240115', weekdayColumn: 'monday' }]);
  });

  it('includes previous day when hour < 5 (late-night service extension)', () => {
    const result = getRelevantServiceDates(new Date('2024-01-15T07:00:00.000Z'));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ date: '20240115', weekdayColumn: 'monday' });
    expect(result[1]).toEqual({ date: '20240114', weekdayColumn: 'sunday' });
  });

  it('does NOT include previous day when hour is exactly 5', () => {
    const result = getRelevantServiceDates(new Date('2024-01-15T10:00:00.000Z'));
    expect(result).toHaveLength(1);
  });

  it('handles week boundary (Monday 1am → previous day is Sunday)', () => {
    const result = getRelevantServiceDates(new Date('2024-01-15T06:00:00.000Z'));
    expect(result[1].weekdayColumn).toBe('sunday');
  });

  it('handles month boundary (Feb 1 midnight → previous day is Jan 31)', () => {
    const result = getRelevantServiceDates(new Date('2024-02-01T05:00:00.000Z'));
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ date: '20240131', weekdayColumn: 'wednesday' });
  });
});

// --- Service-level tests for getArrivalsForStop / getVehiclesForRoute ---
//
// These use the in-memory DB (seeded via seedSubway()) and stub fetch with a
// real protobuf payload, so the realtime cache and the service exercise their
// full code paths against the real proto schema.

const realFetch = globalThis.fetch;
const realDateNow = Date.now;

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
});

// 2024-01-15 = Monday. Each test bumps the hour so the rtCache (keyed by
// feedPath) misses and triggers a fresh fetch, while staying on Monday.
let testHourOffset = 0;
function pinClockToMonday(): number {
  testHourOffset++;
  // 15:00 UTC = 10:00 EST Monday. +1..+8h keeps us on Monday after 5am ET.
  const fixedMs = Date.parse('2024-01-15T15:00:00.000Z') + testHourOffset * 60 * 60 * 1000;
  Date.now = () => fixedMs;
  return Math.floor(fixedMs / 1000);
}

async function encodeFeedMessage(payload: Partial<FeedMessage>): Promise<ArrayBuffer> {
  const root = await protobuf.load(join(import.meta.dir, '../../src/proto/gtfs-realtime.proto'));
  const Type = root.lookupType('transit_realtime.FeedMessage');
  const u8 = Type.encode(
    Type.create({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 0 },
      entity: [],
      ...payload,
    }),
  ).finish();
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

function stubFetchWith(body: ArrayBuffer | (() => Response)): void {
  globalThis.fetch = mock(async () => {
    if (typeof body === 'function') return body();
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

function stubFetchFailing(status = 503): void {
  globalThis.fetch = mock(async () => new Response('upstream down', { status })) as unknown as typeof fetch;
}

describe('getArrivalsForStop', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    // Make WKDY active every day so tests don't depend on the runner's wall clock.
    db.run(`UPDATE calendar SET saturday = 1, sunday = 1 WHERE service_id = 'WKDY'`);
  });

  it('returns sorted future arrivals for the parent station, expanding to platforms', async () => {
    const now = pinClockToMonday();
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 't1',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [
              { stopId: '127N', arrival: { time: now + 300 } }, // +5 min
              { stopId: '127S', arrival: { time: now + 60 } },  // +1 min
            ],
          },
        },
        {
          id: 'v1',
          vehicle: {
            trip: { tripId: 'T1', routeId: '1' },
            currentStatus: 1 as never, // STOPPED_AT — protobufjs needs the int, not the name
            timestamp: now,
          },
        },
      ],
    });
    stubFetchWith(body);

    const result = await getArrivalsForStop('127', 5, 'subway');
    expect(result.feed_id).toBe('subway');
    expect(result.stop_id).toBe('127');
    expect(result.stop_name).toBe('Times Sq-42 St');
    expect(result.stale).toBe(false);
    expect(result.arrivals).toHaveLength(2);
    // Sorted by arrival_time ascending — 127S (+60) before 127N (+300)
    expect(result.arrivals[0].trip_id).toBe('T1');
    expect(result.arrivals[0].status).toBe('STOPPED_AT'); // pulled from vehicle entity
    expect(result.arrivals[1].arrival_in_seconds!).toBeGreaterThan(result.arrivals[0].arrival_in_seconds!);
  });

  it('respects limit when more arrivals are available', async () => {
    const now = pinClockToMonday();
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [
              { stopId: '127N', arrival: { time: now + 60 } },
              { stopId: '127N', arrival: { time: now + 120 } },
              { stopId: '127N', arrival: { time: now + 180 } },
            ],
          },
        },
      ],
    });
    stubFetchWith(body);

    const result = await getArrivalsForStop('127', 2, 'subway');
    expect(result.arrivals).toHaveLength(2);
  });

  it('drops arrivals at or before now', async () => {
    const now = pinClockToMonday();
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [
              { stopId: '127N', arrival: { time: now - 60 } },     // past
              { stopId: '127N', arrival: { time: now } },           // exactly now → dropped
              { stopId: '127N', arrival: { time: now + 60 } },     // future
            ],
          },
        },
      ],
    });
    stubFetchWith(body);

    const result = await getArrivalsForStop('127', 10, 'subway');
    expect(result.arrivals).toHaveLength(1);
    expect(result.arrivals[0].arrival_in_seconds).toBe(60);
  });

  it('intersects routeFilter with served routes and tripUpdate.routeId', async () => {
    // Add a second route '2' that also serves 127N
    db.run(
      `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
       VALUES ('subway', '2', 'NYCT', '2', '7 Av Express', NULL, 1)`,
    );
    db.run(
      `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
       VALUES ('subway', 'T2', '2', 'WKDY', 0, NULL)`,
    );
    db.run(
      `INSERT INTO stop_times (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence)
       VALUES ('subway', 'T2', '127N', '10:00:00', '10:00:00', 1)`,
    );

    const now = pinClockToMonday();
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 60 } }],
          },
        },
        {
          id: 'b',
          tripUpdate: {
            trip: { tripId: 'T2', routeId: '2' },
            stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 90 } }],
          },
        },
      ],
    });
    stubFetchWith(body);

    const result = await getArrivalsForStop('127', 10, 'subway', ['1']);
    expect(result.arrivals.map((a) => a.route_id)).toEqual(['1']);
  });

  it('leaves status null when no matching vehicle entity publishes one', async () => {
    const now = pinClockToMonday();
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 60 } }],
          },
        },
      ],
    });
    stubFetchWith(body);

    const result = await getArrivalsForStop('127', 10, 'subway');
    expect(result.arrivals[0].status).toBeNull();
  });

  it('leaves status null when the matched vehicle entity has no currentStatus on the wire', async () => {
    // current_status defaults to IN_TRANSIT_TO in proto2 - protobufjs can't
    // tell "published as in-transit" from "not published at all" unless the
    // field is actually absent from the encoded message.
    const now = pinClockToMonday();
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 't1',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 60 } }],
          },
        },
        {
          id: 'v1',
          vehicle: { trip: { tripId: 'T1', routeId: '1' }, timestamp: now },
        },
      ],
    });
    stubFetchWith(body);

    const result = await getArrivalsForStop('127', 10, 'subway');
    expect(result.arrivals[0].status).toBeNull();
  });

  it('reads status from the same entity when tripUpdate and vehicle are attached together (MNR shape)', async () => {
    // MNR carries tripUpdate and vehicle on the SAME entity, and its
    // vehicle.trip.tripId never matches the tripUpdate's trip id - so a
    // cross-entity map lookup alone misses it. The same-entity check must
    // run first.
    const now = pinClockToMonday();
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 't1',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 60 } }],
          },
          vehicle: {
            trip: { tripId: 'does-not-match-tripUpdate-id', routeId: '1' },
            currentStatus: 0 as never, // INCOMING_AT
            timestamp: now,
          },
        },
      ],
    });
    stubFetchWith(body);

    const result = await getArrivalsForStop('127', 10, 'subway');
    expect(result.arrivals[0].status).toBe('INCOMING_AT');
  });

  it('throws NotFoundError when stop does not exist', async () => {
    pinClockToMonday();
    await expect(getArrivalsForStop('does-not-exist', 5, 'subway')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('marks the response stale and includes feed_error when fetch fails (no prior cache)', async () => {
    pinClockToMonday();
    stubFetchFailing(503);
    const result = await getArrivalsForStop('127', 5, 'subway');
    expect(result.stale).toBe(true);
    expect(result.feed_error).toMatch(/503/);
    expect(result.arrivals).toEqual([]);
  });

  it('echoes the input stopId in the response even when resolved to a parent station', async () => {
    const now = pinClockToMonday();
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 60 } }],
          },
        },
      ],
    });
    stubFetchWith(body);

    // Input is a platform — service resolves to parent then expands platforms.
    const result = await getArrivalsForStop('127N', 10, 'subway');
    expect(result.stop_id).toBe('127N'); // echoes input, not the resolved parent
  });
});

describe('route names on arrivals', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    db.run(`UPDATE calendar SET saturday = 1, sunday = 1 WHERE service_id = 'WKDY'`);
  });

  /** Give the LIRR fixture (stops + the PW route) a schedule so PW is a served route at stop 1. */
  function seedLirrSchedule(): void {
    seedLirr();
    db.run(
      `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
       VALUES ('lirr', 'L1', 'PW', 'DAILY', 0, NULL)`,
    );
    db.run(
      `INSERT INTO stop_times (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence)
       VALUES ('lirr', 'L1', '1', '10:00:00', '10:00:00', 1)`,
    );
    db.run(
      `INSERT INTO calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
       VALUES ('lirr', 'DAILY', 1, 1, 1, 1, 1, 1, 1, '20200101', '20991231')`,
    );
  }

  it('names a commuter-rail route by its branch, not its numeric id', async () => {
    // The reported bug: LIRR publishes no route_short_name, so an unlabelled
    // arrival left clients rendering "Route PW" instead of the branch name.
    seedLirrSchedule();
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'L1', routeId: 'PW' },
            stopTimeUpdate: [{ stopId: '1', arrival: { time: now + 60 } }],
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('1', 10, 'lirr');
    expect(result.arrivals).toHaveLength(1);
    expect(result.arrivals[0].route_name).toBe('Port Washington Branch');
    expect(result.arrivals[0].route_long_name).toBe('Port Washington Branch');
  });

  it('keeps the subway bullet as the name rather than the long name', async () => {
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 60 } }],
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('127', 10, 'subway');
    expect(result.arrivals[0].route_name).toBe('1');
    expect(result.arrivals[0].route_long_name).toBe('Broadway - 7 Avenue Local');
  });

  it('falls back to the route id when the realtime feed names an unknown route', async () => {
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'TG', routeId: 'GHOST' }, // absent from the static schedule
            stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 60 } }],
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('127', 10, 'subway');
    expect(result.arrivals).toHaveLength(1);
    expect(result.arrivals[0].route_name).toBe('GHOST');
    expect(result.arrivals[0].route_long_name).toBe('GHOST');
  });
});

describe('destination and direction on arrivals', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    db.run(`UPDATE calendar SET saturday = 1, sunday = 1 WHERE service_id = 'WKDY'`);
  });

  function seedLirrSchedule(): void {
    seedLirr();
    db.run(
      `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
       VALUES ('lirr', 'L1', 'PW', 'DAILY', 0, NULL)`,
    );
    db.run(
      `INSERT INTO stop_times (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence)
       VALUES ('lirr', 'L1', '1', '10:00:00', '10:00:00', 1)`,
    );
    db.run(
      `INSERT INTO calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
       VALUES ('lirr', 'DAILY', 1, 1, 1, 1, 1, 1, 1, '20200101', '20991231')`,
    );
  }

  function seedMnrSchedule(): void {
    seedMnr();
    db.run(
      `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
       VALUES ('mnr', 'M1', 'HUDSON', 'DAILY', 0, NULL)`,
    );
    db.run(
      `INSERT INTO stop_times (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence)
       VALUES ('mnr', 'M1', '1', '10:00:00', '10:00:00', 1)`,
    );
    db.run(
      `INSERT INTO calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
       VALUES ('mnr', 'DAILY', 1, 1, 1, 1, 1, 1, 1, '20200101', '20991231')`,
    );
  }

  it('resolves subway destination to the parent station name, not the platform', async () => {
    // ACE-style: many stop time updates, destination is the LAST one.
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [
              { stopId: '127N', arrival: { time: now + 60 } },
              { stopId: '127S', arrival: { time: now + 300 } }, // last STU = true terminus
            ],
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('127', 10, 'subway');
    const arrival = result.arrivals.find((a) => a.trip_id === 'T1' && a.arrival_in_seconds === 60);
    expect(arrival?.destination_stop_id).toBe('127'); // resolved to parent, not '127S'
    expect(arrival?.destination).toBe('Times Sq-42 St');
  });

  it('gives subway direction from the matched platform suffix', async () => {
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [
              { stopId: '127N', arrival: { time: now + 60 } },
              { stopId: '127S', arrival: { time: now + 120 } },
            ],
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('127', 10, 'subway');
    const north = result.arrivals.find((a) => a.arrival_in_seconds === 60);
    const south = result.arrivals.find((a) => a.arrival_in_seconds === 120);
    expect(north?.direction).toBe('NORTH');
    expect(north?.direction_source).toBe('stop_suffix');
    expect(north?.direction_id).toBeNull();
    expect(south?.direction).toBe('SOUTH');
  });

  it('filters arrivals by the direction query param', async () => {
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [
              { stopId: '127N', arrival: { time: now + 60 } },
              { stopId: '127S', arrival: { time: now + 120 } },
            ],
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('127', 10, 'subway', undefined, 'SOUTH');
    expect(result.arrivals).toHaveLength(1);
    expect(result.arrivals[0].direction).toBe('SOUTH');
  });

  it('reads LIRR direction_id from the trip descriptor, branch-relative and not compass', async () => {
    seedLirrSchedule();
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'L1', routeId: 'PW', directionId: 1 },
            stopTimeUpdate: [{ stopId: '1', arrival: { time: now + 60 } }],
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('1', 10, 'lirr');
    expect(result.arrivals[0].direction_id).toBe(1);
    expect(result.arrivals[0].direction).toBeNull();
    expect(result.arrivals[0].direction_source).toBe('rt_direction_id');
    expect(result.arrivals[0].destination_stop_id).toBe('1'); // flat model, no parent to resolve
    expect(result.arrivals[0].destination).toBe('Penn Station');
  });

  it('leaves LIRR direction_id null when the trip descriptor omits it', async () => {
    // optional uint32 direction_id defaults to 0 in proto2 - own-property
    // presence must gate it or every LIRR trip reads as direction_id=0.
    seedLirrSchedule();
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'L1', routeId: 'PW' },
            stopTimeUpdate: [{ stopId: '1', arrival: { time: now + 60 } }],
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('1', 10, 'lirr');
    expect(result.arrivals[0].direction_id).toBeNull();
    expect(result.arrivals[0].direction_source).toBeNull();
  });

  it('leaves both direction and direction_id null for MNR, whose direction IS destination', async () => {
    seedMnrSchedule();
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'M1', routeId: 'HUDSON', directionId: 0 },
            stopTimeUpdate: [{ stopId: '1', arrival: { time: now + 60 } }],
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('1', 10, 'mnr');
    expect(result.arrivals[0].direction).toBeNull();
    expect(result.arrivals[0].direction_id).toBeNull();
    expect(result.arrivals[0].direction_source).toBeNull();
    expect(result.arrivals[0].destination).toBe('Grand Central');
  });

  it('reads train_number from the vehicle descriptor label, presence-checked', async () => {
    seedLirrSchedule();
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'L1', routeId: 'PW' },
            stopTimeUpdate: [{ stopId: '1', arrival: { time: now + 60 } }],
          },
          vehicle: {
            trip: { tripId: 'does-not-match', routeId: 'PW' },
            vehicle: { label: '2306' },
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('1', 10, 'lirr');
    expect(result.arrivals[0].train_number).toBe('2306');
  });

  it('leaves delay_seconds null when not published, and reads it (including a genuine 0) when present', async () => {
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [
              { stopId: '127N', arrival: { time: now + 60 } }, // no delay field at all
              { stopId: '127S', arrival: { time: now + 120, delay: 0 } }, // on-time, genuinely 0
            ],
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('127', 10, 'subway');
    const noDelay = result.arrivals.find((a) => a.arrival_in_seconds === 60);
    const onTime = result.arrivals.find((a) => a.arrival_in_seconds === 120);
    expect(noDelay?.delay_seconds).toBeNull();
    expect(onTime?.delay_seconds).toBe(0);
  });

  it('stamps every arrival source: "realtime"', async () => {
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'a',
          tripUpdate: {
            trip: { tripId: 'T1', routeId: '1' },
            stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 60 } }],
          },
        },
      ],
    }));

    const result = await getArrivalsForStop('127', 10, 'subway');
    expect(result.arrivals[0].source).toBe('realtime');
  });
});

describe('getVehiclesForRoute', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
  });

  it('returns vehicles for the given route only', async () => {
    const now = pinClockToMonday();
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'v1',
          vehicle: {
            trip: { tripId: 'T1', routeId: '1' },
            stopId: '127N',
            currentStatus: 0 as never, // INCOMING_AT
            timestamp: now,
          },
        },
        {
          id: 'v2',
          vehicle: {
            trip: { tripId: 'TX', routeId: '2' }, // different route
            stopId: '127S',
            currentStatus: 1 as never, // STOPPED_AT
            timestamp: now,
          },
        },
        {
          id: 'tu', // trip-update entity should be ignored
          tripUpdate: { trip: { tripId: 'T1', routeId: '1' }, stopTimeUpdate: [] },
        },
      ],
    });
    stubFetchWith(body);

    const result = await getVehiclesForRoute('1', 'subway');
    expect(result.feed_id).toBe('subway');
    expect(result.route_id).toBe('1');
    expect(result.vehicles).toHaveLength(1);
    expect(result.vehicles[0].trip_id).toBe('T1');
    expect(result.vehicles[0].current_stop_id).toBe('127N');
    expect(result.vehicles[0].status).toBe('INCOMING_AT');
  });

  it('throws NotFoundError when route does not exist', async () => {
    pinClockToMonday();
    await expect(getVehiclesForRoute('NOPE', 'subway')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('labels the envelope with the route name', async () => {
    const now = pinClockToMonday();
    stubFetchWith(await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [],
    }));

    const result = await getVehiclesForRoute('1', 'subway');
    expect(result.route_name).toBe('1');
    expect(result.route_long_name).toBe('Broadway - 7 Avenue Local');
  });

  it('defaults current_stop_id to "" and status to IN_TRANSIT_TO when missing', async () => {
    const now = pinClockToMonday();
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        {
          id: 'v1',
          vehicle: { trip: { tripId: 'T1', routeId: '1' }, timestamp: now },
        },
      ],
    });
    stubFetchWith(body);

    const result = await getVehiclesForRoute('1', 'subway');
    expect(result.vehicles[0].current_stop_id).toBe('');
    expect(result.vehicles[0].status).toBe('IN_TRANSIT_TO');
  });
});
