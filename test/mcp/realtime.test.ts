import { describe, expect, it, beforeEach, mock, afterAll } from 'bun:test';
import { makeMcpClient, textOf } from '../helpers/mcp';
import { resetDb, seedSubway } from '../helpers/seed';
import { encodeFeedMessage } from '../helpers/rt';
import { db } from '../../src/db/client';
import { __resetRtCacheForTests } from '../../src/cache/rtCache';

const mcp = makeMcpClient();

const realFetch = globalThis.fetch;
const realDateNow = Date.now;

// The RT cache is module-level and shared by every test file in the run, and
// its entries expire against Date.now. Sibling files pin the clock to their own
// offsets from the same base, so an entry this file left behind at a later
// offset would still look fresh to a file that pins earlier — and that file
// would silently get our payload. Clearing the cache around each test keeps
// this file hermetic in both directions, and means the clock can stay fixed.
beforeEach(() => {
  __resetRtCacheForTests();
});

afterAll(async () => {
  __resetRtCacheForTests();
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
  await mcp.close();
});

/** 2024-01-15 15:00 UTC = Monday 10:00 ET, a weekday inside the fixture calendar. */
function pinClock(): number {
  const fixedMs = Date.parse('2024-01-15T15:00:00.000Z');
  Date.now = () => fixedMs;
  return Math.floor(fixedMs / 1000);
}

function stubFetchOk(body: ArrayBuffer): void {
  globalThis.fetch = mock(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

function stubFetchFail(status: number): void {
  globalThis.fetch = mock(async () => new Response('down', { status })) as unknown as typeof fetch;
}

describe('mta_get_arrivals', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    // The fixture calendar is weekdays-only; open it up so the pinned clock's
    // day of week never decides whether the trip is in service.
    db.run(`UPDATE calendar SET saturday = 1, sunday = 1 WHERE service_id = 'WKDY'`);
  });

  it('returns upcoming arrivals for a parent station', async () => {
    const now = pinClock();
    stubFetchOk(
      await encodeFeedMessage({
        header: { gtfsRealtimeVersion: '2.0', timestamp: now },
        entity: [
          {
            id: 'tu-1',
            tripUpdate: {
              trip: { tripId: 'T1', routeId: '1' },
              stopTimeUpdate: [{ stopId: '127N', arrival: { time: now + 120 } }],
            },
          },
        ],
      }),
    );

    const result = await mcp.callTool('mta_get_arrivals', { stop: '127', feed: 'subway' });
    expect(result.isError).toBeFalsy();

    const body = result.structuredContent as {
      stop_id: string;
      stop_name: string;
      stale: boolean;
      arrivals: { route_id: string; arrival_in_seconds: number }[];
    };
    expect(body.stop_id).toBe('127');
    expect(body.stop_name).toBe('Times Sq-42 St');
    expect(body.stale).toBe(false);
    expect(body.arrivals).toHaveLength(1);
    expect(body.arrivals[0].route_id).toBe('1');
    expect(body.arrivals[0].arrival_in_seconds).toBe(120);
  });

  it('honours the limit', async () => {
    const now = pinClock();
    stubFetchOk(
      await encodeFeedMessage({
        header: { gtfsRealtimeVersion: '2.0', timestamp: now },
        entity: [
          {
            id: 'tu-1',
            tripUpdate: {
              trip: { tripId: 'T1', routeId: '1' },
              stopTimeUpdate: [
                { stopId: '127N', arrival: { time: now + 60 } },
                { stopId: '127S', arrival: { time: now + 120 } },
              ],
            },
          },
        ],
      }),
    );

    const result = await mcp.callTool('mta_get_arrivals', { stop: '127', feed: 'subway', limit: 1 });
    expect((result.structuredContent as { arrivals: unknown[] }).arrivals).toHaveLength(1);
  });

  it('names the search tool when the stop does not exist', async () => {
    pinClock();
    stubFetchOk(await encodeFeedMessage({}));

    const result = await mcp.callTool('mta_get_arrivals', { stop: '999', feed: 'subway' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/mta_search_stops/);
  });

  it('reports staleness rather than failing when the upstream feed is down', async () => {
    pinClock();
    stubFetchFail(503);

    const result = await mcp.callTool('mta_get_arrivals', { stop: '127', feed: 'subway' });
    expect(result.isError).toBeFalsy();
    const body = result.structuredContent as { stale: boolean; feed_error?: string };
    expect(body.stale).toBe(true);
    expect(body.feed_error).toBeTruthy();
  });

  it('rejects a limit above the ceiling', async () => {
    const result = await mcp.callTool('mta_get_arrivals', { stop: '127', feed: 'subway', limit: 500 });
    expect(result.isError).toBe(true);
  });
});

describe('mta_get_vehicles', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
  });

  it('lists active vehicles on a route', async () => {
    const now = pinClock();
    stubFetchOk(
      await encodeFeedMessage({
        header: { gtfsRealtimeVersion: '2.0', timestamp: now },
        entity: [
          {
            id: 'vp-1',
            vehicle: {
              trip: { tripId: 'T1', routeId: '1' },
              stopId: '127N',
              currentStatus: 'INCOMING_AT',
              timestamp: now,
            },
          },
        ],
      }),
    );

    const result = await mcp.callTool('mta_get_vehicles', { route: '1', feed: 'subway' });
    expect(result.isError).toBeFalsy();
    const body = result.structuredContent as {
      route_id: string;
      vehicles: { trip_id: string; current_stop_id: string }[];
    };
    expect(body.route_id).toBe('1');
    expect(body.vehicles).toHaveLength(1);
    expect(body.vehicles[0]).toMatchObject({ trip_id: 'T1', current_stop_id: '127N' });
  });

  it('names the route listing tool for a route with no feed', async () => {
    pinClock();
    stubFetchOk(await encodeFeedMessage({}));

    const result = await mcp.callTool('mta_get_vehicles', { route: 'ZZ', feed: 'subway' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/mta_list_routes/);
  });
});

describe('mta_get_alerts', () => {
  /** Five alerts on route L at stop 101, so the default limit of 20 is not hit. */
  async function stubAlerts(count: number, now: number) {
    stubFetchOk(
      await encodeFeedMessage({
        header: { gtfsRealtimeVersion: '2.0', timestamp: now },
        entity: Array.from({ length: count }, (_, i) => ({
          id: `alert-${i}`,
          alert: {
            activePeriod: [{ start: now, end: now + 3600 }],
            informedEntity: [{ routeId: 'L', stopId: '101' }],
            headerText: { translation: [{ text: `L disruption ${i}`, language: 'en' }] },
            descriptionText: { translation: [{ text: 'Delays in both directions.', language: 'en' }] },
          },
        })),
      }),
    );
  }

  it('returns alerts with headers and descriptions', async () => {
    const now = pinClock();
    await stubAlerts(2, now);

    const result = await mcp.callTool('mta_get_alerts');
    expect(result.isError).toBeFalsy();
    const body = result.structuredContent as {
      alerts: { id: string; header: string; description: string }[];
      truncated?: boolean;
    };
    expect(body.alerts).toHaveLength(2);
    expect(body.alerts[0].header).toBe('L disruption 0');
    expect(body.alerts[0].description).toBe('Delays in both directions.');
    expect(body.truncated).toBeUndefined();
  });

  it('filters by route', async () => {
    const now = pinClock();
    await stubAlerts(2, now);

    const match = await mcp.callTool('mta_get_alerts', { routes: ['L'] });
    expect((match.structuredContent as { alerts: unknown[] }).alerts).toHaveLength(2);
  });

  it('returns an empty list when the route filter matches nothing', async () => {
    const now = pinClock();
    await stubAlerts(2, now);

    const result = await mcp.callTool('mta_get_alerts', { routes: ['Q'] });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { alerts: unknown[] }).alerts).toEqual([]);
  });

  it('truncates past the limit and says how many matched', async () => {
    const now = pinClock();
    await stubAlerts(5, now);

    const result = await mcp.callTool('mta_get_alerts', { limit: 2 });
    const body = result.structuredContent as {
      alerts: unknown[];
      truncated: boolean;
      total_matched: number;
    };
    expect(body.alerts).toHaveLength(2);
    expect(body.truncated).toBe(true);
    expect(body.total_matched).toBe(5);
  });

  it('keeps direction-less alerts when a direction is requested', async () => {
    const now = pinClock();
    await stubAlerts(1, now);

    // The fixture names no direction, so per §5.2 it affects both.
    const result = await mcp.callTool('mta_get_alerts', { stop_id: '101', direction: 'S' });
    expect((result.structuredContent as { alerts: unknown[] }).alerts).toHaveLength(1);
  });

  it('rejects a direction outside the N/S aliases', async () => {
    const result = await mcp.callTool('mta_get_alerts', { stop_id: '101', direction: 'E' });
    expect(result.isError).toBe(true);
  });
});
