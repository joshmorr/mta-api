import { unzipSync } from 'fflate';
import { parseCSV, forEachCSVRow } from '../utils/csv';
import {
  clearFeedData,
  getFeedMeta,
  isDbEmpty as isDbEmptyQuery,
  setFeedMeta,
  upsertCalendar,
  upsertCalendarDates,
  upsertRoutes,
  upsertStops,
  upsertStopTimesBatch,
  upsertTrips,
} from '../db/queries/staticFeed';
import type {
  FeedId,
  GtfsStop,
  GtfsRoute,
  GtfsTrip,
  GtfsStopTime,
  GtfsCalendar,
  GtfsCalendarDate,
} from '../types/gtfs';

const SUBWAY_URL = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip';
const LIRR_URL   = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip';
const MNR_URL    = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip';

/** Only decompress files we actually import — skip shapes.txt etc. */
const NEEDED_FILES = new Set([
  'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt',
  'calendar.txt', 'calendar_dates.txt',
]);

// --- Feed sync ---

/**
 * Extract a single file from the zip, parse it as CSV, then delete it
 * from the zip object so the raw bytes can be GC'd immediately.
 */
function extractAndParse(files: Record<string, Uint8Array>, name: string): unknown[] {
  if (!(name in files)) return [];
  const text = new TextDecoder().decode(files[name]);
  delete files[name];
  return parseCSV(text);
}

async function syncFeed(url: string, feedId: FeedId) {
  console.error(`[staticFeed] Syncing ${feedId}...`);
  const buffer = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch ${url}: HTTP ${r.status}`);
    return r.arrayBuffer();
  });

  // Only decompress files we need; skip shapes.txt etc. to save memory
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (file) => NEEDED_FILES.has(file.name),
  });

  clearFeedData(feedId);

  // Process one table at a time so only one parsed array is in memory
  const counts: Record<string, number> = {};

  let rows = extractAndParse(files, 'stops.txt') as unknown as GtfsStop[];
  counts.stops = rows.length;
  upsertStops(rows, feedId);
  rows = null!;

  let routeRows = extractAndParse(files, 'routes.txt') as unknown as GtfsRoute[];
  counts.routes = routeRows.length;
  upsertRoutes(routeRows, feedId);
  routeRows = null!;

  let tripRows = extractAndParse(files, 'trips.txt') as unknown as GtfsTrip[];
  counts.trips = tripRows.length;
  upsertTrips(tripRows, feedId);
  tripRows = null!;

  // stop_times is the largest table (~1M rows for subway) — stream-insert
  // so we never hold all parsed rows in memory at once.
  {
    if (!('stop_times.txt' in files)) {
      counts.stop_times = 0;
    } else {
      const text = new TextDecoder().decode(files['stop_times.txt']);
      delete files['stop_times.txt'];
      const inserter = upsertStopTimesBatch(feedId);
      counts.stop_times = forEachCSVRow(text, (row) => {
        inserter.push(row as unknown as GtfsStopTime);
      });
      inserter.flush();
    }
  }

  let calRows = extractAndParse(files, 'calendar.txt') as unknown as GtfsCalendar[];
  counts.calendar = calRows.length;
  if (calRows.length) upsertCalendar(calRows, feedId);
  calRows = null!;

  let cdRows = extractAndParse(files, 'calendar_dates.txt') as unknown as GtfsCalendarDate[];
  counts.calendar_dates = cdRows.length;
  if (cdRows.length) upsertCalendarDates(cdRows, feedId);
  cdRows = null!;

  setFeedMeta(feedId);
  console.error(`[staticFeed] ${feedId} synced. stops=${counts.stops} routes=${counts.routes} trips=${counts.trips} stop_times=${counts.stop_times} calendar_dates=${counts.calendar_dates}`);
}

export async function syncSubwayFeed() {
  await syncFeed(SUBWAY_URL, 'subway');
}

export async function syncLirrFeed() {
  await syncFeed(LIRR_URL, 'lirr');
}

export async function syncMnrFeed() {
  await syncFeed(MNR_URL, 'mnr');
}

export function getLastSynced(feedId: string) {
  return getFeedMeta(feedId);
}

export function isDbEmpty(): boolean {
  return isDbEmptyQuery();
}

export function isFeedStale(feedId: string, maxAgeMs: number): boolean {
  const last = getFeedMeta(feedId);
  if (!last) return true;
  return Date.now() / 1000 - last > maxAgeMs / 1000;
}
