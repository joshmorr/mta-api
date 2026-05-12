import { describe, expect, it, mock, afterEach, afterAll } from 'bun:test';
import * as protobuf from 'protobufjs';
import { join } from 'path';
import { getFeed, __resetRtCacheForTests } from '../../cache/rtCache';
import { config } from '../../config';
import type { FeedMessage } from '../../types/gtfs';

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

async function encodeFeedMessage(): Promise<ArrayBuffer> {
  const root = await protobuf.load(join(import.meta.dir, '../../proto/gtfs-realtime.proto'));
  const Type = root.lookupType('transit_realtime.FeedMessage');
  const u8 = Type.encode(
    Type.create({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1_700_000_000 },
      entity: [],
    } as Partial<FeedMessage>),
  ).finish();
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

describe('rtCache edge cases', () => {
  it('still serves the cached entry at exactly TTL boundary', async () => {
    __resetRtCacheForTests();
    const body = await encodeFeedMessage();
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
    const body = await encodeFeedMessage();
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
