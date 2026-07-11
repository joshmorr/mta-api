import { describe, expect, it, mock, afterEach, afterAll } from 'bun:test';
import * as protobuf from 'protobufjs';
import { join } from 'path';
import { getFeed } from '../../src/cache/rtCache';

async function encodePayload(): Promise<ArrayBuffer> {
  const root = await protobuf.load(
    join(import.meta.dir, '../../src/proto/gtfs-realtime.proto'),
  );
  const Type = root.lookupType('transit_realtime.FeedMessage');
  const u8 = Type.encode(
    Type.create({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1_700_000_000 },
      entity: [],
    }),
  ).finish();
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

const realFetch = globalThis.fetch;
const realDateNow = Date.now;

afterEach(() => {
  Date.now = realDateNow;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('rtCache.getFeed stale fallback', () => {
  it('returns cached entry with stale=true and feed_error when TTL has elapsed and upstream fails', async () => {
    const body = await encodePayload();
    let callCount = 0;
    const fetchMock = mock(async () => {
      callCount++;
      return callCount === 1
        ? new Response(body, { status: 200 })
        : new Response('boom', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let now = 1_700_000_000_000;
    Date.now = () => now;

    const first = await getFeed('stale/path');
    expect(first.stale).toBe(false);

    // Jump well past the configured TTL (default 20s, hours is plenty).
    now += 60 * 60 * 1000;

    const second = await getFeed('stale/path');
    expect(second.stale).toBe(true);
    expect(second.feed_error).toContain('500');
    expect(second.feedMessage).toBe(first.feedMessage);
  });
});
