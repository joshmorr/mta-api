import { describe, expect, it, beforeEach, mock, afterAll } from 'bun:test';
import * as protobuf from 'protobufjs';
import { join } from 'path';
import { alertsRouter } from '../../src/routes/alerts.routes';
import { makeTestApp } from '../helpers/app';
import type { FeedMessage } from '../../src/types/gtfs';
import type { AlertResponse } from '../../src/types/api';
import { __resetRtCacheForTests } from '../../src/cache/rtCache';

const app = makeTestApp(alertsRouter, '/alerts');

const realFetch = globalThis.fetch;
const realDateNow = Date.now;
afterAll(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
});

let testHourOffset = 300;
function pinClock(): number {
  testHourOffset++;
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

function stubFetchOk(body: ArrayBuffer): void {
  globalThis.fetch = mock(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

/** Build a feed with a few alerts useful for filter testing. */
async function fixtureBody(now: number): Promise<ArrayBuffer> {
  return encodeFeedMessage({
    header: { gtfsRealtimeVersion: '2.0', timestamp: now },
    entity: [
      {
        id: 'a1',
        alert: {
          activePeriod: [],
          informedEntity: [{ routeId: 'A' }, { routeId: 'C' }],
          headerText: { translation: [{ text: 'A/C disruption', language: 'en' }] },
        },
      },
      {
        id: 'a2',
        alert: {
          activePeriod: [],
          informedEntity: [
            { routeId: '1', stopId: '127', directionId: 0 }, // northbound at Times Sq
          ],
          headerText: { translation: [{ text: '1 northbound', language: 'en' }] },
        },
      },
      {
        id: 'a3',
        alert: {
          activePeriod: [],
          informedEntity: [
            { routeId: '1', stopId: '127' }, // both directions (no direction_id)
          ],
          headerText: { translation: [{ text: '1 both ways at 127', language: 'en' }] },
        },
      },
    ],
  });
}

describe('GET /alerts', () => {
  beforeEach(() => {
    __resetRtCacheForTests();
    pinClock();
  });

  it('returns 200 with all alerts when no filter is given', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const res = await app.request('/alerts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: AlertResponse[]; stale: boolean };
    expect(body.alerts.map((a) => a.id).sort()).toEqual(['a1', 'a2', 'a3']);
    expect(body.stale).toBe(false);
  });

  it('filters alerts by routes (comma-separated)', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const res = await app.request('/alerts?routes=A');
    const body = (await res.json()) as { alerts: AlertResponse[] };
    expect(body.alerts.map((a) => a.id)).toEqual(['a1']);
  });

  it('filters alerts by stop_id', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const res = await app.request('/alerts?stop_id=127');
    const body = (await res.json()) as { alerts: AlertResponse[] };
    expect(body.alerts.map((a) => a.id).sort()).toEqual(['a2', 'a3']);
  });

  it('filters by stop_id + direction=N (0) — includes alerts with no direction_id', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const res = await app.request('/alerts?stop_id=127&direction=N');
    const body = (await res.json()) as { alerts: AlertResponse[] };
    // a2 is dir=0 (matches), a3 has no dir (matches both directions)
    expect(body.alerts.map((a) => a.id).sort()).toEqual(['a2', 'a3']);
  });

  it('filters by stop_id + direction=S (1) — excludes the dir=0 alert', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const res = await app.request('/alerts?stop_id=127&direction=S');
    const body = (await res.json()) as { alerts: AlertResponse[] };
    // a2 is dir=0 (mismatch), a3 has no dir (always matches)
    expect(body.alerts.map((a) => a.id)).toEqual(['a3']);
  });

  it('treats direction=0/1 the same as N/S', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const resN = await app.request('/alerts?stop_id=127&direction=0');
    const resS = await app.request('/alerts?stop_id=127&direction=1');
    const bodyN = (await resN.json()) as { alerts: AlertResponse[] };
    const bodyS = (await resS.json()) as { alerts: AlertResponse[] };
    expect(bodyN.alerts.map((a) => a.id).sort()).toEqual(['a2', 'a3']);
    expect(bodyS.alerts.map((a) => a.id)).toEqual(['a3']);
  });

  it('returns 503 when alerts feed fetch fails (no cache)', async () => {
    pinClock();
    globalThis.fetch = mock(async () => new Response('down', { status: 502 })) as unknown as typeof fetch;
    const res = await app.request('/alerts');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('FEED_ERROR');
  });

  it('rejects unknown direction values via Zod', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const res = await app.request('/alerts?stop_id=127&direction=X');
    expect(res.status).toBe(400);
  });
});
