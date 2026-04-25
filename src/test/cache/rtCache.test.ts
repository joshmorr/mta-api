import { describe, expect, it, mock, afterAll } from 'bun:test';
import * as protobuf from 'protobufjs';
import { join } from 'path';
import type { FeedMessage } from '../../types/gtfs';
import { getFeed } from '../../cache/rtCache';

async function encodeFeedMessage(payload: Partial<FeedMessage> = {}): Promise<ArrayBuffer> {
  const root = await protobuf.load(
    join(import.meta.dir, '../../proto/gtfs-realtime.proto'),
  );
  const Type = root.lookupType('transit_realtime.FeedMessage');
  const msg = Type.create({
    header: { gtfsRealtimeVersion: '2.0', timestamp: 1_700_000_000 },
    entity: [],
    ...payload,
  });
  const u8 = Type.encode(msg).finish();
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('rtCache.getFeed', () => {
  it('serves the cached entry on a second call within TTL', async () => {
    const body = await encodeFeedMessage();
    const fetchMock = mock(async () => new Response(body, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await getFeed('test/path-ttl');
    const second = await getFeed('test/path-ttl');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.stale).toBe(false);
    expect(second.stale).toBe(false);
    expect(second.feedMessage).toBe(first.feedMessage);
  });

  it('deduplicates concurrent fetches for the same feed path', async () => {
    const body = await encodeFeedMessage();
    let resolveFetch: ((r: Response) => void) | undefined;
    const fetchMock = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const p1 = getFeed('test/path-dedup');
    const p2 = getFeed('test/path-dedup');

    // Wait until the cache module has actually invoked fetch (proto-load is async).
    while (!resolveFetch) await new Promise((r) => setTimeout(r, 5));
    resolveFetch(new Response(body, { status: 200 }));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1.feedMessage).toBe(r2.feedMessage);
  });

  it('throws when upstream fails and no cached entry exists', async () => {
    const fetchMock = mock(async () => new Response('nope', { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getFeed('test/path-fail')).rejects.toThrow(/503/);
  });
});
