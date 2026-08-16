import { describe, expect, it, mock, afterEach, afterAll } from 'bun:test';
import { getFeed, __resetRtCacheForTests } from '../../src/cache/rtCache';
import { config } from '../../src/config';
import { encodeFeedMessage } from '../helpers/rt';

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

/** Header timestamp matches the pinned clock below; nothing asserts on it. */
const feedHeader = { gtfsRealtimeVersion: '2.0', timestamp: 1_700_000_000 };

describe('rtCache edge cases', () => {
  it('still serves the cached entry at exactly TTL boundary', async () => {
    __resetRtCacheForTests();
    const body = await encodeFeedMessage({ header: feedHeader });
    const fetchMock = mock(async () => new Response(body, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let now = 1_700_000_000_000;
    Date.now = () => now;

    const first = await getFeed('edge/ttl-boundary');
    expect(first.stale).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Jump exactly to the TTL boundary — the strict-less-than comparison means
    // this counts as expired and triggers a refetch.
    now += config.rtCacheTtlMs;
    await getFeed('edge/ttl-boundary');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Just under the boundary on a fresh entry — cache hit, no extra fetch.
    now += config.rtCacheTtlMs - 1;
    await getFeed('edge/ttl-boundary');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed pending fetch does not poison the next call (re-attempts)', async () => {
    __resetRtCacheForTests();
    let firstCall = true;
    const body = await encodeFeedMessage({ header: feedHeader });
    const fetchMock = mock(async () => {
      if (firstCall) {
        firstCall = false;
        return new Response('boom', { status: 500 });
      }
      return new Response(body, { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getFeed('edge/poison')).rejects.toThrow(/500/);
    // Second call should re-issue fetch (pending was deleted via .finally)
    const second = await getFeed('edge/poison');
    expect(second.stale).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('vendor extension decoding', () => {
  // The Mercury proto is vendored WITHOUT its FeedHeader extension. NYCT claims
  // the same field number (1001) on FeedHeader, so had we kept Mercury's, a
  // subway feed header would decode its NYCT bytes as a MercuryFeedHeader and
  // report a field that isn't there. Everything shares one protobufjs root, so
  // this is the check that the trim held.
  it('decodes a subway-style feed header without inventing an extension field', async () => {
    __resetRtCacheForTests();
    const body = await encodeFeedMessage({ header: feedHeader });
    globalThis.fetch = mock(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    Date.now = () => 1_700_000_000_000;

    const { feedMessage } = await getFeed('edge/subway-header');
    expect(Object.keys(feedMessage.header)).toEqual(['gtfsRealtimeVersion', 'timestamp']);
  });

  it('round-trips the railroad stop time extension', async () => {
    __resetRtCacheForTests();
    const body = await encodeFeedMessage({
      header: feedHeader,
      entity: [
        {
          id: 'r',
          tripUpdate: {
            trip: { tripId: 'L1', routeId: 'PW' },
            stopTimeUpdate: [
              {
                stopId: '237',
                arrival: { time: 1_700_000_100 },
                '.transit_realtime.mtaRailroadStopTimeUpdate': { track: '17', trainStatus: 'Late' },
              },
            ],
          },
        },
      ],
    });
    globalThis.fetch = mock(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    Date.now = () => 1_700_000_000_000;

    const { feedMessage } = await getFeed('edge/railroad-ext');
    const stu = feedMessage.entity[0].tripUpdate!.stopTimeUpdate[0];
    expect(stu['.transit_realtime.mtaRailroadStopTimeUpdate']).toEqual({
      track: '17',
      trainStatus: 'Late',
    });
  });
});
