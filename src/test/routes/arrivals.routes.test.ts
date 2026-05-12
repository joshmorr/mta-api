import { describe, expect, it, beforeEach, mock, afterAll } from 'bun:test';
import * as protobuf from 'protobufjs';
import { join } from 'path';
import { arrivalsRouter } from '../../routes/arrivals.routes';
import { makeTestApp } from '../helpers/app';
import { resetDb, seedSubway } from '../helpers/seed';
import { db } from '../../db/client';
import type { FeedMessage } from '../../types/gtfs';

const app = makeTestApp(arrivalsRouter, '/arrivals');

const realFetch = globalThis.fetch;
const realDateNow = Date.now;
afterAll(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
});

let testHourOffset = 100; // start past realtime.service's offsets to avoid cache collision
function pinClockToMonday(): number {
  testHourOffset++;
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

function stubFetchOk(body: ArrayBuffer): void {
  globalThis.fetch = mock(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

function stubFetchFail(status: number): void {
  globalThis.fetch = mock(async () => new Response('down', { status })) as unknown as typeof fetch;
}

describe('GET /arrivals', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    db.run(`UPDATE calendar SET saturday = 1, sunday = 1 WHERE service_id = 'WKDY'`);
  });

  describe('parameter validation', () => {
    // Note: required-query validation is handled by the @hono/zod-openapi
    // schema layer before the handler runs, so these return Zod errors.
    it('returns 400 when stop is missing', async () => {
      const res = await app.request('/arrivals?feed=subway');
      expect(res.status).toBe(400);
    });

    it('returns 400 when feed is missing', async () => {
      const res = await app.request('/arrivals?stop=127');
      expect(res.status).toBe(400);
    });

    it('returns 400 when feed is not a known value', async () => {
      const res = await app.request('/arrivals?stop=127&feed=bus');
      expect(res.status).toBe(400);
    });
  });

  describe('happy path', () => {
    it('returns 200 with future arrivals sorted ascending', async () => {
      const now = pinClockToMonday();
      stubFetchOk(
        await encodeFeedMessage({
          header: { gtfsRealtimeVersion: '2.0', timestamp: now },
          entity: [
            {
              id: 'a',
              tripUpdate: {
                trip: { tripId: 'T1', routeId: '1' },
                stopTimeUpdate: [
                  { stopId: '127N', arrival: { time: now + 200 } },
                  { stopId: '127S', arrival: { time: now + 60 } },
                ],
              },
            },
          ],
        }),
      );
      const res = await app.request('/arrivals?stop=127&feed=subway');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        stop_id: string;
        arrivals: Array<{ arrival_in_seconds: number; route_id: string }>;
      };
      expect(body.stop_id).toBe('127');
      expect(body.arrivals).toHaveLength(2);
      expect(body.arrivals[0].arrival_in_seconds).toBeLessThan(body.arrivals[1].arrival_in_seconds);
    });

    it('clamps limit to 50', async () => {
      const now = pinClockToMonday();
      const stopTimeUpdate = Array.from({ length: 60 }, (_, i) => ({
        stopId: '127N',
        arrival: { time: now + (i + 1) * 30 },
      }));
      stubFetchOk(
        await encodeFeedMessage({
          header: { gtfsRealtimeVersion: '2.0', timestamp: now },
          entity: [
            { id: 'a', tripUpdate: { trip: { tripId: 'T1', routeId: '1' }, stopTimeUpdate } },
          ],
        }),
      );
      const res = await app.request('/arrivals?stop=127&feed=subway&limit=999');
      const body = (await res.json()) as { arrivals: unknown[] };
      expect(body.arrivals).toHaveLength(50);
    });

    it('forwards routes filter as comma-separated', async () => {
      // Add a second route '2' on the same platform so we have something to filter
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
      stubFetchOk(
        await encodeFeedMessage({
          header: { gtfsRealtimeVersion: '2.0', timestamp: now },
          entity: [
            { id: 'a', tripUpdate: { trip: { tripId: 'T1', routeId: '1' }, stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 60 } }] } },
            { id: 'b', tripUpdate: { trip: { tripId: 'T2', routeId: '2' }, stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 90 } }] } },
          ],
        }),
      );
      const res = await app.request('/arrivals?stop=127&feed=subway&routes=1');
      const body = (await res.json()) as { arrivals: Array<{ route_id: string }> };
      expect(body.arrivals.every((a) => a.route_id === '1')).toBe(true);
    });
  });

  describe('error mapping', () => {
    it('returns 404 when the stop does not exist', async () => {
      pinClockToMonday();
      const res = await app.request('/arrivals?stop=does-not-exist&feed=subway');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 200 with stale=true when fetch fails (no cache)', async () => {
      // The service catches feed errors per-feed and returns stale results
      // rather than letting the route map to 503.
      pinClockToMonday();
      stubFetchFail(503);
      const res = await app.request('/arrivals?stop=127&feed=subway');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { stale: boolean; arrivals: unknown[] };
      expect(body.stale).toBe(true);
      expect(body.arrivals).toEqual([]);
    });
  });
});
