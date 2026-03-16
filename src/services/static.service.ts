import { unzipSync } from 'fflate';
import { parseCSV } from '../utils/csv';
import {
  clearFeedData,
  getFeedMeta,
  isDbEmpty as isDbEmptyQuery,
  setFeedMeta,
  upsertCalendar,
  upsertCalendarDates,
  upsertRoutes,
  upsertStops,
  upsertStopTimes,
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

// --- Feed sync ---

async function syncFeed(url: string, feedId: FeedId) {
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
  const calendarDates = parseCSV(getText('calendar_dates.txt')) as unknown as GtfsCalendarDate[];

  clearFeedData(feedId);
  upsertStops(stops, feedId);
  upsertRoutes(routes, feedId);
  upsertTrips(trips, feedId);
  upsertStopTimes(stopTimes, feedId);
  if (calendar.length) upsertCalendar(calendar, feedId);
  if (calendarDates.length) upsertCalendarDates(calendarDates, feedId);

  setFeedMeta(feedId);
  console.error(`[staticFeed] ${feedId} synced. stops=${stops.length} routes=${routes.length} trips=${trips.length} stop_times=${stopTimes.length} calendar_dates=${calendarDates.length}`);
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
