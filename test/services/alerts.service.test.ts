import { describe, expect, it, mock, afterEach, afterAll } from 'bun:test';
import * as protobuf from 'protobufjs';
import { join } from 'path';
import type { FeedMessage } from '../../src/types/gtfs';
import { fetchAlerts, getAlerts, parseDirection } from '../../src/services/alerts.service';

// Stub globalThis.fetch with a real protobuf payload so the alerts service runs
// against the real cache module. (Mocking '../../src/cache/rtCache' via mock.module
// would persist across the whole test process and break sibling cache tests.)
async function encodeFeedMessage(payload: Partial<FeedMessage>): Promise<ArrayBuffer> {
  const root = await protobuf.load(
    join(import.meta.dir, '../../src/proto/gtfs-realtime.proto'),
  );
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

const realFetch = globalThis.fetch;
const realDateNow = Date.now;
let nowOffset = 0;

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
});

// Each test bumps "now" forward so the previous test's cached entry is expired.
function advanceClock() {
  nowOffset += 60 * 60 * 1000;
  const fixed = realDateNow() + nowOffset;
  Date.now = () => fixed;
}

function stubFetch(body: ArrayBuffer, init: ResponseInit = { status: 200 }) {
  globalThis.fetch = mock(async () => new Response(body, init)) as unknown as typeof fetch;
}

describe('fetchAlerts', () => {
  it('returns an empty list when the feed has no alert entities', async () => {
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1_700_000_000 },
      entity: [
        { id: 'tu', tripUpdate: { trip: { tripId: 't', routeId: '1' }, stopTimeUpdate: [] } },
      ],
    });
    stubFetch(body);
    advanceClock();

    const result = await fetchAlerts();
    expect(result.alerts).toEqual([]);
    expect(result.generated_at).toBe(1_700_000_000);
    expect(result.stale).toBe(false);
  });

  it('extracts English text and preserves per-entry informed_entities', async () => {
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1_700_000_001 },
      entity: [
        {
          id: 'a-1',
          alert: {
            activePeriod: [{ start: 100, end: 200 }],
            informedEntity: [
              { routeId: 'A', stopId: '101' },
              { routeId: 'A', stopId: '101' },
              { routeId: 'C', stopId: '102' },
              {},
            ],
            headerText: {
              translation: [
                { text: 'Bonjour', language: 'fr' },
                { text: 'Hello', language: 'en' },
              ],
            },
            descriptionText: { translation: [{ text: 'Service change', language: 'en' }] },
          },
        },
      ],
    });
    stubFetch(body);
    advanceClock();

    const result = await fetchAlerts();
    expect(result.alerts).toHaveLength(1);
    const a = result.alerts[0];
    expect(a.id).toBe('a-1');
    expect(a.informed_entities).toEqual([
      { route_id: 'A', stop_id: '101' },
      { route_id: 'A', stop_id: '101' },
      { route_id: 'C', stop_id: '102' },
      {},
    ]);
    expect(a.header).toBe('Hello');
    expect(a.description).toBe('Service change');
    expect(a.active_periods).toEqual([{ start: 100, end: 200 }]);
  });

  it('preserves per-entry direction_id and agency_id on informed_entities', async () => {
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1_700_000_002 },
      entity: [
        {
          id: 'a-2',
          alert: {
            activePeriod: [],
            informedEntity: [
              { agencyId: 'MTASBWY', routeId: '7', stopId: '711', directionId: 1 },
              { agencyId: 'MTASBWY', routeId: '7', stopId: '712', directionId: 1 },
              { agencyId: 'MTASBWY', routeId: '7', stopId: '713' },
            ],
            headerText: { translation: [{ text: '7 southbound work', language: 'en' }] },
          },
        },
      ],
    });
    stubFetch(body);
    advanceClock();

    const result = await fetchAlerts();
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].informed_entities).toEqual([
      { agency_id: 'MTASBWY', route_id: '7', stop_id: '711', direction_id: 1 },
      { agency_id: 'MTASBWY', route_id: '7', stop_id: '712', direction_id: 1 },
      { agency_id: 'MTASBWY', route_id: '7', stop_id: '713' },
    ]);
  });

  it('skips entities without an alert payload (mixed feed)', async () => {
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1 },
      entity: [
        { id: 'vp', vehicle: { trip: { tripId: 't', routeId: '1' } } },
        {
          id: 'a',
          alert: {
            activePeriod: [],
            informedEntity: [{ routeId: 'L' }],
            headerText: { translation: [{ text: 'L disruption' }] },
          },
        },
      ],
    });
    stubFetch(body);
    advanceClock();

    const result = await fetchAlerts();
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].id).toBe('a');
    expect(result.alerts[0].header).toBe('L disruption');
    expect(result.alerts[0].informed_entities).toEqual([{ route_id: 'L' }]);
  });
});

describe('parseDirection', () => {
  it('maps both the N/S aliases and the raw GTFS values', () => {
    expect(parseDirection('N')).toBe(0);
    expect(parseDirection('0')).toBe(0);
    expect(parseDirection('S')).toBe(1);
    expect(parseDirection('1')).toBe(1);
  });

  it('returns undefined when no direction is given', () => {
    expect(parseDirection(undefined)).toBeUndefined();
  });
});

describe('getAlerts', () => {
  /**
   * Three alerts:
   *   a-route-only  — route A, no stop
   *   a-northbound  — route A at stop 101, direction 0 only
   *   a-bothways    — route B at stop 101, no direction (both directions)
   */
  async function stubAlertFeed() {
    const body = await encodeFeedMessage({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1_700_000_100 },
      entity: [
        {
          id: 'a-route-only',
          alert: {
            activePeriod: [],
            informedEntity: [{ routeId: 'A' }],
            headerText: { translation: [{ text: 'A delays', language: 'en' }] },
          },
        },
        {
          id: 'a-northbound',
          alert: {
            activePeriod: [],
            informedEntity: [{ routeId: 'A', stopId: '101', directionId: 0 }],
            headerText: { translation: [{ text: 'A northbound bypass', language: 'en' }] },
          },
        },
        {
          id: 'a-bothways',
          alert: {
            activePeriod: [],
            informedEntity: [{ routeId: 'B', stopId: '101' }],
            headerText: { translation: [{ text: 'B elevator out', language: 'en' }] },
          },
        },
      ],
    });
    stubFetch(body);
    advanceClock();
  }

  it('returns everything when no filter is given', async () => {
    await stubAlertFeed();
    const { alerts } = await getAlerts();
    expect(alerts.map((a) => a.id)).toEqual(['a-route-only', 'a-northbound', 'a-bothways']);
  });

  it('passes through the feed metadata', async () => {
    await stubAlertFeed();
    const result = await getAlerts();
    expect(result.generated_at).toBe(1_700_000_100);
    expect(result.stale).toBe(false);
  });

  it('filters by route', async () => {
    await stubAlertFeed();
    const { alerts } = await getAlerts({ routes: ['A'] });
    expect(alerts.map((a) => a.id)).toEqual(['a-route-only', 'a-northbound']);
  });

  it('accepts several routes at once', async () => {
    await stubAlertFeed();
    const { alerts } = await getAlerts({ routes: ['B', 'Z'] });
    expect(alerts.map((a) => a.id)).toEqual(['a-bothways']);
  });

  it('filters by stop, dropping alerts that name no stop', async () => {
    await stubAlertFeed();
    const { alerts } = await getAlerts({ stopId: '101' });
    expect(alerts.map((a) => a.id)).toEqual(['a-northbound', 'a-bothways']);
  });

  it('keeps direction-less entries when a direction is requested', async () => {
    await stubAlertFeed();
    // a-northbound is direction 0 so it drops out; a-bothways names no
    // direction, which per §5.2 means both are affected.
    const { alerts } = await getAlerts({ stopId: '101', direction: 1 });
    expect(alerts.map((a) => a.id)).toEqual(['a-bothways']);
  });

  it('matches the requested direction', async () => {
    await stubAlertFeed();
    const { alerts } = await getAlerts({ stopId: '101', direction: 0 });
    expect(alerts.map((a) => a.id)).toEqual(['a-northbound', 'a-bothways']);
  });

  it('ignores direction when no stop is given', async () => {
    await stubAlertFeed();
    const { alerts } = await getAlerts({ direction: 1 });
    expect(alerts).toHaveLength(3);
  });

  it('combines route and stop filters', async () => {
    await stubAlertFeed();
    const { alerts } = await getAlerts({ routes: ['A'], stopId: '101' });
    expect(alerts.map((a) => a.id)).toEqual(['a-northbound']);
  });

  it('returns an empty list when nothing matches', async () => {
    await stubAlertFeed();
    const { alerts } = await getAlerts({ routes: ['NOPE'] });
    expect(alerts).toEqual([]);
  });
});
