import * as protobuf from 'protobufjs';
import { join } from 'path';
import type { FeedMessage } from '../../src/types/gtfs';

/**
 * Encode a GTFS-RT payload the way the MTA serves it, for stubbing
 * `globalThis.fetch`.
 *
 * Tests drive the realtime services through the real `src/cache/rtCache`
 * module rather than mocking it: `mock.module` persists for the whole test
 * process, so mocking the cache in one file breaks sibling cache tests.
 *
 * This loads the same three protos as the cache does, so extension fields
 * round-trip. They're written under their fully-qualified keys, matching what
 * protobufjs produces on decode:
 *
 * ```ts
 * stopTimeUpdate: [{
 *   stopId: '1',
 *   '.transit_realtime.mtaRailroadStopTimeUpdate': { track: '17', trainStatus: 'On-Time' },
 * }]
 * ```
 *
 * Because this is a real encode/decode round trip, proto2 default behaviour is
 * exercised too — an omitted `trainStatus` and one set to `''` both come back
 * as `''`, which is exactly the case `nonEmpty` exists to handle.
 */
export async function encodeFeedMessage(
  payload: Partial<FeedMessage> = {},
): Promise<ArrayBuffer> {
  const root = await protobuf.load([
    join(import.meta.dir, '../../src/proto/gtfs-realtime.proto'),
    join(import.meta.dir, '../../src/proto/gtfs-realtime-MTARR.proto'),
    join(import.meta.dir, '../../src/proto/gtfs-realtime-service-status.proto'),
  ]);
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
