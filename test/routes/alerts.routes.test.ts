import { describe, expect, it, beforeEach, mock, afterAll } from 'bun:test';
import { alertsRouter } from '../../src/routes/alerts.routes';
import { makeTestApp } from '../helpers/app';
import { encodeFeedMessage } from '../helpers/rt';
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

describe('GET /alerts conditional requests', () => {
  beforeEach(() => {
    __resetRtCacheForTests();
    pinClock();
  });

  async function etagFrom(path: string): Promise<string> {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    const tag = res.headers.get('ETag');
    expect(tag).toMatch(/^W\/"\d+-[0-9a-z]+"$/);
    return tag as string;
  }

  it('returns a weak ETag on every 200', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const tag = await etagFrom('/alerts');
    // The validator is the feed's own publish time, not the wall clock.
    expect(tag.startsWith(`W/"${now}-`)).toBe(true);
  });

  it('answers a replayed ETag with 304 and an empty body', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const tag = await etagFrom('/alerts');

    const res = await app.request('/alerts', { headers: { 'If-None-Match': tag } });
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(tag);
    expect(await res.text()).toBe('');
  });

  it('304s on a filtered view too, keyed to that filter', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const tag = await etagFrom('/alerts?routes=A');

    const res = await app.request('/alerts?routes=A', { headers: { 'If-None-Match': tag } });
    expect(res.status).toBe(304);
  });

  it('does not 304 when the same ETag is replayed against a different query', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const tag = await etagFrom('/alerts?routes=A');

    // Same snapshot, different representation - a timestamp-only validator
    // would hand back a 304 for a body this client has never seen.
    const res = await app.request('/alerts?routes=1', { headers: { 'If-None-Match': tag } });
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).not.toBe(tag);
    const body = (await res.json()) as { alerts: AlertResponse[] };
    expect(body.alerts.map((a) => a.id).sort()).toEqual(['a2', 'a3']);
  });

  it('normalizes the query key: direction N/0 and route order agree', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));

    const byLetter = await etagFrom('/alerts?stop_id=127&direction=N');
    const byNumber = await etagFrom('/alerts?stop_id=127&direction=0');
    expect(byNumber).toBe(byLetter);

    const forward = await etagFrom('/alerts?routes=A,C');
    const reversed = await etagFrom('/alerts?routes=C,A');
    expect(reversed).toBe(forward);
  });

  it('distinguishes opposite directions', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const north = await etagFrom('/alerts?stop_id=127&direction=N');
    const south = await etagFrom('/alerts?stop_id=127&direction=S');
    expect(south).not.toBe(north);
  });

  it('returns a fresh 200 once the upstream snapshot advances', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const tag = await etagFrom('/alerts');

    __resetRtCacheForTests();
    const later = pinClock();
    stubFetchOk(await fixtureBody(later));

    const res = await app.request('/alerts', { headers: { 'If-None-Match': tag } });
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).not.toBe(tag);
    expect(res.headers.get('ETag')?.startsWith(`W/"${later}-`)).toBe(true);
  });

  it('never 304s while the feed is degraded, so stale stays visible', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const tag = await etagFrom('/alerts');

    // Expire the cached entry, then break upstream. The fallback replays the
    // same snapshot, so the timestamp still matches - but answering 304 here
    // would silently drop the stale flag the client needs to see.
    pinClock();
    globalThis.fetch = mock(async () => new Response('down', { status: 502 })) as unknown as typeof fetch;

    const res = await app.request('/alerts', { headers: { 'If-None-Match': tag } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stale: boolean; alerts: AlertResponse[] };
    expect(body.stale).toBe(true);
    expect(body.alerts.length).toBe(3);
  });

  it('ignores an unrelated If-None-Match value', async () => {
    const now = pinClock();
    stubFetchOk(await fixtureBody(now));
    const res = await app.request('/alerts', { headers: { 'If-None-Match': 'W/"nonsense"' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).not.toBe('W/"nonsense"');
  });

  it('still 503s on a conditional request when the feed is unreachable and uncached', async () => {
    pinClock();
    globalThis.fetch = mock(async () => new Response('down', { status: 502 })) as unknown as typeof fetch;
    const res = await app.request('/alerts', { headers: { 'If-None-Match': 'W/"1700000000-abc"' } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('FEED_ERROR');
  });
});

