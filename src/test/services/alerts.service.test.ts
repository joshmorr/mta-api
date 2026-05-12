import { describe, expect, it, mock, afterEach, afterAll } from 'bun:test';
import * as protobuf from 'protobufjs';
import { join } from 'path';
import type { FeedMessage } from '../../types/gtfs';
import { fetchAlerts } from '../../services/alerts.service';

// Stub globalThis.fetch with a real protobuf payload so the alerts service runs
// against the real cache module. (Mocking '../../cache/rtCache' via mock.module
// would persist across the whole test process and break sibling cache tests.)
async function encodeFeedMessage(payload: Partial<FeedMessage>): Promise<ArrayBuffer> {
  const root = await protobuf.load(
    join(import.meta.dir, '../../proto/gtfs-realtime.proto'),
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
