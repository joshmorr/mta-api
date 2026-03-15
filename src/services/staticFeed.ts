import { unzipSync } from 'fflate';
import {
  getFeedMeta,
  isDbEmpty as isDbEmptyQuery,
  setFeedMeta,
  upsertCalendar,
  upsertRoutes,
  upsertStops,
  upsertStopTimes,
  upsertTrips,
} from '../db/queries/staticFeed';
import type {
  GtfsStop,
  GtfsRoute,
  GtfsTrip,
  GtfsStopTime,
  GtfsCalendar,
} from '../types/gtfs';

const SUBWAY_URL = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip';
const LIRR_URL   = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip';
const MNR_URL    = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip';

// --- CSV parser ---

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].replace(/\r/, '').split(',');
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/, '');
    if (!line) continue;
    const vals = splitCSVLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = vals[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// --- Feed sync ---

async function syncFeed(url: string, feedId: string) {
  console.error(`[staticFeed] Syncing ${feedId}...`);
  const buffer = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch ${url}: HTTP ${r.status}`);
    return r.arrayBuffer();
  });

  const files = unzipSync(new Uint8Array(buffer));
  const getText = (name: string) =>
    name in files ? new TextDecoder().decode(files[name]) : '';

  const stops     = parseCSV(getText('stops.txt'))      as unknown as GtfsStop[];
  const routes    = parseCSV(getText('routes.txt'))     as unknown as GtfsRoute[];
  const trips     = parseCSV(getText('trips.txt'))      as unknown as GtfsTrip[];
  const stopTimes = parseCSV(getText('stop_times.txt')) as unknown as GtfsStopTime[];
  const calendar  = parseCSV(getText('calendar.txt'))   as unknown as GtfsCalendar[];

  upsertStops(stops);
  upsertRoutes(routes);
  upsertTrips(trips);
  upsertStopTimes(stopTimes);
  if (calendar.length) upsertCalendar(calendar);

  setFeedMeta(feedId);
  console.error(`[staticFeed] ${feedId} synced. stops=${stops.length} routes=${routes.length} trips=${trips.length} stop_times=${stopTimes.length}`);
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
