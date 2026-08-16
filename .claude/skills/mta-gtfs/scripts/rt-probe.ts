#!/usr/bin/env bun
/**
 * rt-probe — fetch a live MTA GTFS-Realtime feed and describe what is actually in it.
 *
 * Every claim in this skill's reference files was checked with this script, and
 * anything you are about to assert about the feeds should be too: the MTA
 * changes what it populates without announcement, and the fields that matter
 * most (direction_id, current_status, vehicle position) are exactly the ones
 * that are silently absent on some feeds.
 *
 * Presence is reported by own-property check, never by truthiness. GTFS-RT is
 * proto2, so an unset scalar decodes to its zero default -- `directionId === 0`
 * cannot distinguish "northbound" from "never set".
 *
 * Usage:
 *   bun .claude/skills/mta-gtfs/scripts/rt-probe.ts <feed-path> [options]
 *   bun .claude/skills/mta-gtfs/scripts/rt-probe.ts --list
 *
 * Options:
 *   --summary          entity composition + field presence (default)
 *   --sample [N]       dump N decoded entities as JSON (default 1)
 *   --entity <id>      dump the entity with this id
 *   --field <path>     presence count + value histogram for a dotted path,
 *                      e.g. --field tripUpdate.trip.directionId
 *   --extensions       scan raw wire bytes for extension field numbers (>= 1000)
 *   --raw <file>       save the raw protobuf response and exit
 *   --json             machine-readable output for --summary
 *
 * Examples:
 *   bun scripts/rt-probe.ts nyct/gtfs-l
 *   bun scripts/rt-probe.ts mnr/gtfs-mnr --field vehicle.currentStatus
 *   bun scripts/rt-probe.ts nyct/gtfs-ace --extensions
 *   bun scripts/rt-probe.ts camsys/all-alerts --sample 2
 */

import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import protobuf from 'protobufjs';

const BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds';

const FEEDS: Record<string, string> = {
  'nyct/gtfs': '1 2 3 4 5 6 6X 7 7X GS',
  'nyct/gtfs-ace': 'A C E H (Rockaway) FS (Franklin)',
  'nyct/gtfs-bdfm': 'B D F FX M',
  'nyct/gtfs-g': 'G',
  'nyct/gtfs-jz': 'J Z',
  'nyct/gtfs-l': 'L',
  'nyct/gtfs-nqrw': 'N Q R W',
  'nyct/gtfs-si': 'SI (Staten Island Railway)',
  'lirr/gtfs-lirr': 'Long Island Rail Road, all branches',
  'mnr/gtfs-mnr': 'Metro-North, all branches',
  'camsys/all-alerts': 'service alerts, all modes',
  'camsys/subway-alerts': 'service alerts, subway',
  'camsys/bus-alerts': 'service alerts, bus',
  'camsys/lirr-alerts': 'service alerts, LIRR',
  'camsys/mnr-alerts': 'service alerts, MNR',
};

// --- fetch ---------------------------------------------------------------

/**
 * The gateway treats the whole feed path as one URL segment, so the slash must
 * be percent-encoded. A literal slash returns 403 "Missing Authentication
 * Token", which looks like an auth failure and is not one -- these feeds need
 * no key.
 */
function feedUrl(path: string): string {
  return `${BASE}/${encodeURIComponent(path)}`;
}

async function fetchFeed(path: string): Promise<Uint8Array> {
  const res = await fetch(feedUrl(path), { signal: AbortSignal.timeout(20_000) });
  const buf = new Uint8Array(await res.arrayBuffer());

  if (!res.ok) {
    const body = new TextDecoder().decode(buf.slice(0, 300));
    throw new Error(
      `HTTP ${res.status} for ${path}\n${body}\n` +
        (res.status === 403 ? 'Hint: 403 here usually means the slash was not percent-encoded.' : ''),
    );
  }
  // An unknown-but-well-formed path returns HTTP 200 with S3's XML error
  // document, so status alone never proves you are holding protobuf.
  if (buf[0] === 0x3c /* '<' */) {
    const body = new TextDecoder().decode(buf.slice(0, 400));
    throw new Error(`Upstream returned XML with HTTP 200 (unknown feed path?):\n${body}`);
  }
  return buf;
}

// --- decode --------------------------------------------------------------

function findProto(): string {
  // Walk up from this script looking for the repo's unmodified upstream proto.
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'src/proto/gtfs-realtime.proto');
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* keep walking */
    }
    dir = resolve(dir, '..');
  }
  throw new Error('Could not locate src/proto/gtfs-realtime.proto. Run from inside the repo.');
}

async function decode(bytes: Uint8Array) {
  const root = await protobuf.load(findProto());
  const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
  return FeedMessage.decode(bytes) as unknown as FeedMessage;
}

interface FeedMessage {
  header: Record<string, unknown>;
  entity: Record<string, unknown>[];
  toJSON(): unknown;
}

/** protobufjs returns Long for 64-bit fields; normalize for display. */
function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'toNumber' in (v as object)) return (v as { toNumber(): number }).toNumber();
  return undefined;
}

/** Own-property presence. The only honest presence test on a proto2 message. */
function has(obj: unknown, key: string): boolean {
  return obj != null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Resolve a dotted path, treating arrays as fan-out. Returns [container, leaf] pairs. */
function walk(root: unknown, path: string[]): { parent: unknown; key: string }[] {
  if (path.length === 0) return [];
  const [head, ...rest] = path;
  const nodes = Array.isArray(root) ? root : [root];
  const out: { parent: unknown; key: string }[] = [];
  for (const node of nodes) {
    if (node == null || typeof node !== 'object') continue;
    if (rest.length === 0) {
      out.push({ parent: node, key: head });
    } else if (has(node, head)) {
      out.push(...walk((node as Record<string, unknown>)[head], rest));
    }
  }
  return out;
}

// --- summary -------------------------------------------------------------

const FIELD_PATHS = [
  'tripUpdate.trip.tripId',
  'tripUpdate.trip.routeId',
  'tripUpdate.trip.startDate',
  'tripUpdate.trip.startTime',
  'tripUpdate.trip.directionId',
  'tripUpdate.trip.scheduleRelationship',
  'tripUpdate.delay',
  'tripUpdate.stopTimeUpdate.stopId',
  'tripUpdate.stopTimeUpdate.stopSequence',
  'tripUpdate.stopTimeUpdate.arrival',
  'tripUpdate.stopTimeUpdate.arrival.delay',
  'tripUpdate.stopTimeUpdate.arrival.uncertainty',
  'tripUpdate.stopTimeUpdate.departure',
  'tripUpdate.stopTimeUpdate.scheduleRelationship',
  'vehicle.trip.tripId',
  'vehicle.trip.directionId',
  'vehicle.position',
  'vehicle.currentStatus',
  'vehicle.currentStopSequence',
  'vehicle.stopId',
  'vehicle.timestamp',
  'vehicle.vehicle.id',
  'vehicle.vehicle.label',
  'alert.informedEntity',
  'alert.activePeriod',
  'alert.cause',
  'alert.effect',
  'alert.headerText',
  'alert.descriptionText',
];

function summary(feed: FeedMessage, path: string, json: boolean) {
  const entities = feed.entity ?? [];
  const counts = {
    entities: entities.length,
    tripUpdate: entities.filter((e) => has(e, 'tripUpdate')).length,
    vehicle: entities.filter((e) => has(e, 'vehicle')).length,
    alert: entities.filter((e) => has(e, 'alert')).length,
  };
  const both = entities.filter((e) => has(e, 'tripUpdate') && has(e, 'vehicle')).length;

  const fields: Record<string, { present: number; total: number }> = {};
  for (const p of FIELD_PATHS) {
    const segs = p.split('.');
    const slots = walk(entities, segs);
    if (slots.length === 0) continue;
    fields[p] = {
      present: slots.filter((s) => has(s.parent, s.key)).length,
      total: slots.length,
    };
  }

  const header = {
    gtfsRealtimeVersion: feed.header?.gtfs_realtime_version ?? feed.header?.gtfsRealtimeVersion,
    incrementality: feed.header?.incrementality ?? 0,
    timestamp: num(feed.header?.timestamp),
    timestampIso: num(feed.header?.timestamp) ? new Date(num(feed.header!.timestamp)! * 1000).toISOString() : null,
  };

  if (json) {
    console.log(JSON.stringify({ feed: path, header, counts, entitiesWithBoth: both, fields }, null, 2));
    return;
  }

  console.log(`\nfeed            ${path}  (${FEEDS[path] ?? 'unknown path'})`);
  console.log(`fetched         ${new Date().toISOString()}`);
  console.log(`version         ${header.gtfsRealtimeVersion}   incrementality=${header.incrementality}`);
  console.log(`header.timestamp ${header.timestamp} (${header.timestampIso})`);
  console.log(`\nentities        ${counts.entities}`);
  console.log(`  trip_update   ${counts.tripUpdate}`);
  console.log(`  vehicle       ${counts.vehicle}`);
  console.log(`  alert         ${counts.alert}`);
  console.log(`  both TU+VP in one entity: ${both}`);
  console.log(`\nfield presence (own-property, not truthiness):`);
  const width = Math.max(...Object.keys(fields).map((k) => k.length));
  for (const [k, v] of Object.entries(fields)) {
    const pct = v.total === 0 ? 0 : Math.round((v.present / v.total) * 100);
    const bar = pct === 100 ? 'always' : pct === 0 ? 'NEVER' : `${pct}%`;
    console.log(`  ${k.padEnd(width)}  ${String(v.present).padStart(6)}/${String(v.total).padEnd(6)} ${bar}`);
  }
  console.log();
}

// --- field histogram -----------------------------------------------------

function fieldReport(feed: FeedMessage, path: string) {
  const slots = walk(feed.entity ?? [], path.split('.'));
  const present = slots.filter((s) => has(s.parent, s.key));
  console.log(`\n${path}`);
  console.log(`  occurrences reachable: ${slots.length}`);
  console.log(`  own-property present:  ${present.length}`);
  const hist = new Map<string, number>();
  for (const s of present) {
    const raw = (s.parent as Record<string, unknown>)[s.key];
    const v = num(raw) ?? (typeof raw === 'object' ? '[object]' : String(raw));
    const key = String(v);
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }
  const rows = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (rows.length) {
    console.log(`  value histogram (top ${rows.length}):`);
    for (const [v, n] of rows) console.log(`    ${String(v).padEnd(40)} ${n}`);
  }
  console.log();
}

// --- extension scan ------------------------------------------------------

/**
 * Raw wire walk looking for field numbers >= 1000, which is where the MTA hangs
 * its vendor extensions (NYCT 1001, MTARR 1005, Mercury/alerts 1001). The stock
 * gtfs-realtime.proto drops these silently on decode, so the only way to see
 * whether they are present is to read the bytes.
 */
const NAMES: Record<string, Record<number, string>> = {
  FeedMessage: { 1: 'header', 2: 'entity' },
  FeedEntity: { 1: 'id', 3: 'trip_update', 4: 'vehicle', 5: 'alert' },
  TripUpdate: { 1: 'trip', 2: 'stop_time_update', 3: 'vehicle', 4: 'timestamp', 5: 'delay' },
  VehiclePosition: { 1: 'trip', 2: 'position', 4: 'current_status', 7: 'stop_id', 8: 'vehicle' },
  Alert: { 1: 'active_period', 5: 'informed_entity', 10: 'header_text', 11: 'description_text' },
  TripDescriptor: { 1: 'trip_id', 5: 'route_id', 6: 'direction_id' },
  StopTimeUpdate: { 1: 'stop_sequence', 2: 'arrival', 3: 'departure', 4: 'stop_id' },
};
const CHILD: Record<string, Record<number, string>> = {
  FeedMessage: { 2: 'FeedEntity' },
  FeedEntity: { 3: 'TripUpdate', 4: 'VehiclePosition', 5: 'Alert' },
  TripUpdate: { 1: 'TripDescriptor', 2: 'StopTimeUpdate' },
  VehiclePosition: { 1: 'TripDescriptor' },
};

function scanExtensions(bytes: Uint8Array) {
  const found = new Map<string, { count: number; bytes: number }>();

  function walkMsg(buf: Uint8Array, type: string, path: string, depth: number) {
    if (depth > 6) return;
    const r = new protobuf.Reader(buf);
    while (r.pos < r.len) {
      const tag = r.uint32();
      const field = tag >>> 3;
      const wire = tag & 7;
      const name = NAMES[type]?.[field] ?? `#${field}`;
      const here = path ? `${path}.${name}` : name;
      if (field >= 1000) {
        const start = r.pos;
        r.skipType(wire);
        const size = r.pos - start;
        const key = `${here}  (field ${field}, wire ${wire})`;
        const prev = found.get(key) ?? { count: 0, bytes: 0 };
        found.set(key, { count: prev.count + 1, bytes: prev.bytes + size });
        continue;
      }
      if (wire === 2) {
        const len = r.uint32();
        const sub = buf.subarray(r.pos, r.pos + len);
        r.pos += len;
        const childType = CHILD[type]?.[field];
        if (childType) walkMsg(sub, childType, here, depth + 1);
        continue;
      }
      r.skipType(wire);
    }
  }

  walkMsg(bytes, 'FeedMessage', '', 0);

  console.log('\nextension field numbers (>= 1000) found on the wire:');
  if (found.size === 0) {
    console.log('  none');
  } else {
    for (const [k, v] of [...found.entries()].sort()) {
      console.log(`  ${k.padEnd(52)} x${String(v.count).padStart(5)}  ${v.bytes} bytes`);
    }
    console.log(
      '\n  These are dropped by the stock gtfs-realtime.proto. Extension definitions:\n' +
        '  https://github.com/OneBusAway/onebusaway-gtfs-realtime-api/tree/master/src/main/proto/com/google/transit/realtime',
    );
  }
  console.log();
}

// --- main ----------------------------------------------------------------

function usage(): never {
  console.log(
    [
      'Usage: bun rt-probe.ts <feed-path> [--summary|--sample [N]|--entity <id>|--field <path>|--extensions|--raw <file>] [--json]',
      '       bun rt-probe.ts --list',
      '',
      'Feed paths:',
      ...Object.entries(FEEDS).map(([p, d]) => `  ${p.padEnd(22)} ${d}`),
    ].join('\n'),
  );
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv.includes('--list')) usage();

const path = argv[0];
if (path.startsWith('--')) usage();
const flag = (name: string) => argv.indexOf(name);

// Report upstream problems as the message they are -- a stack trace buries the
// part that matters (the 403-vs-XML distinction above).
process.on('uncaughtException', (err: Error) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});

const bytes = await fetchFeed(path);

if (flag('--raw') >= 0) {
  const out = argv[flag('--raw') + 1];
  writeFileSync(out, bytes);
  console.log(`wrote ${bytes.length} bytes to ${out}`);
  process.exit(0);
}

if (flag('--extensions') >= 0) {
  scanExtensions(bytes);
  process.exit(0);
}

const feed = await decode(bytes);

if (flag('--field') >= 0) {
  fieldReport(feed, argv[flag('--field') + 1]);
} else if (flag('--entity') >= 0) {
  const id = argv[flag('--entity') + 1];
  const e = (feed.entity ?? []).find((x) => String(x.id) === id);
  console.log(e ? JSON.stringify(e, null, 2) : `no entity with id ${id}`);
} else if (flag('--sample') >= 0) {
  const n = Number(argv[flag('--sample') + 1]) || 1;
  console.log(JSON.stringify((feed.entity ?? []).slice(0, n), null, 2));
} else {
  summary(feed, path, flag('--json') >= 0);
}
