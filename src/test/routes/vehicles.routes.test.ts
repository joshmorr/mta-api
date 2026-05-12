import { describe, expect, it, beforeEach, mock, afterAll } from 'bun:test';
import * as protobuf from 'protobufjs';
import { join } from 'path';
import { vehiclesRouter } from '../../routes/vehicles.routes';
import { makeTestApp } from '../helpers/app';
import { resetDb, seedSubway } from '../helpers/seed';
import { __resetRtCacheForTests } from '../../cache/rtCache';
import type { FeedMessage } from '../../types/gtfs';

const app = makeTestApp(vehiclesRouter, '/vehicles');

const realFetch = globalThis.fetch;
const realDateNow = Date.now;
afterAll(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
});

let testHourOffset = 200;
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

describe('GET /vehicles', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    __resetRtCacheForTests();
  });

  it('returns 400 when route is missing (Zod schema)', async () => {
    const res = await app.request('/vehicles?feed=subway');
    expect(res.status).toBe(400);
  });

  it('returns 400 when feed is missing (Zod schema)', async () => {
    const res = await app.request('/vehicles?route=1');
    expect(res.status).toBe(400);
  });

  it('returns 200 with vehicles for the route', async () => {
    const now = pinClockToMonday();
    stubFetchOk(
      await encodeFeedMessage({
        header: { gtfsRealtimeVersion: '2.0', timestamp: now },
        entity: [
          {
            id: 'v1',
            vehicle: {
              trip: { tripId: 'T1', routeId: '1' },
              stopId: '127N',
              currentStatus: 1 as never, // STOPPED_AT
              timestamp: now,
            },
          },
        ],
      }),
    );
    const res = await app.request('/vehicles?route=1&feed=subway');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      route_id: string;
      vehicles: Array<{ trip_id: string; status: string; current_stop_id: string }>;
    };
    expect(body.route_id).toBe('1');
    expect(body.vehicles).toHaveLength(1);
    expect(body.vehicles[0].trip_id).toBe('T1');
    expect(body.vehicles[0].status).toBe('STOPPED_AT');
  });

  it('returns 404 when route does not exist', async () => {
    pinClockToMonday();
    const res = await app.request('/vehicles?route=NOPE&feed=subway');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns 503 when the feed is unavailable (no cache)', async () => {
    pinClockToMonday();
    stubFetchFail(500);
    const res = await app.request('/vehicles?route=1&feed=subway');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('FEED_ERROR');
  });
});
