import { describe, expect, it, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import * as protobuf from 'protobufjs';
import { join } from 'path';
import {
  getNyDateParts,
  getRelevantServiceDates,
  getArrivalsForStop,
  getVehiclesForRoute,
  NotFoundError,
} from '../../services/realtime.service';
import type { FeedMessage } from '../../types/gtfs';
import { resetDb, seedSubway } from '../helpers/seed';
import { db } from '../../db/client';

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
  const root = await protobuf.load(join(import.meta.dir, '../../proto/gtfs-realtime.proto'));
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
    expect(result.arrivals[1].arrival_in_seconds).toBeGreaterThan(result.arrivals[0].arrival_in_seconds);
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

  it('defaults vehicle status to IN_TRANSIT_TO when no matching vehicle entity', async () => {
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
    expect(result.arrivals[0].status).toBe('IN_TRANSIT_TO');
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
