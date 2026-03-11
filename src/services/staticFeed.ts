import { unzipSync } from 'fflate';
import { db } from '../db/client';
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

const BATCH_SIZE = 1000;

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

// --- Upsert helpers ---

function upsertStops(rows: GtfsStop[]) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
     VALUES ($stop_id, $stop_name, $stop_lat, $stop_lon, $location_type, $parent_station)`
  );
  db.transaction(() => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      for (const r of rows.slice(i, i + BATCH_SIZE)) {
        if (!r.stop_id) continue;
        stmt.run({
          $stop_id:         r.stop_id,
          $stop_name:       r.stop_name || r.stop_id,
          $stop_lat:        parseFloat(r.stop_lat) || null,
          $stop_lon:        parseFloat(r.stop_lon) || null,
          $location_type:   parseInt(r.location_type) || 0,
          $parent_station:  r.parent_station || null,
        });
      }
    }
  })();
}

function upsertRoutes(rows: GtfsRoute[]) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO routes (route_id, route_short_name, route_long_name, route_color, route_type)
     VALUES ($route_id, $route_short_name, $route_long_name, $route_color, $route_type)`
  );
  db.transaction(() => {
    for (const r of rows) {
      if (!r.route_id) continue;
      stmt.run({
        $route_id:         r.route_id,
        $route_short_name: r.route_short_name,
        $route_long_name:  r.route_long_name,
        $route_color:      r.route_color ? `#${r.route_color}` : null,
        $route_type:       parseInt(r.route_type) || 0,
      });
    }
  })();
}

function upsertTrips(rows: GtfsTrip[]) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO trips (trip_id, route_id, service_id, direction_id, shape_id)
     VALUES ($trip_id, $route_id, $service_id, $direction_id, $shape_id)`
  );
  db.transaction(() => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      for (const r of rows.slice(i, i + BATCH_SIZE)) {
        if (!r.trip_id || !r.route_id) continue;
        stmt.run({
          $trip_id:      r.trip_id,
          $route_id:     r.route_id,
          $service_id:   r.service_id,
          $direction_id: parseInt(r.direction_id) || 0,
          $shape_id:     r.shape_id || null,
        });
      }
    }
  })();
}

function upsertStopTimes(rows: GtfsStopTime[]) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stop_times (trip_id, stop_id, arrival_time, departure_time, stop_sequence)
     VALUES ($trip_id, $stop_id, $arrival_time, $departure_time, $stop_sequence)`
  );
  db.transaction(() => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      for (const r of rows.slice(i, i + BATCH_SIZE)) {
        if (!r.trip_id || !r.stop_id) continue;
        stmt.run({
          $trip_id:        r.trip_id,
          $stop_id:        r.stop_id,
          $arrival_time:   r.arrival_time || null,
          $departure_time: r.departure_time || null,
          $stop_sequence:  parseInt(r.stop_sequence) || 0,
        });
      }
    }
  })();
}

function upsertCalendar(rows: GtfsCalendar[]) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO calendar
       (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
     VALUES
       ($service_id, $monday, $tuesday, $wednesday, $thursday, $friday, $saturday, $sunday, $start_date, $end_date)`
  );
  db.transaction(() => {
    for (const r of rows) {
      if (!r.service_id) continue;
      stmt.run({
        $service_id: r.service_id,
        $monday:     parseInt(r.monday),
        $tuesday:    parseInt(r.tuesday),
        $wednesday:  parseInt(r.wednesday),
        $thursday:   parseInt(r.thursday),
        $friday:     parseInt(r.friday),
        $saturday:   parseInt(r.saturday),
        $sunday:     parseInt(r.sunday),
        $start_date: r.start_date,
        $end_date:   r.end_date,
      });
    }
  })();
}

function setFeedMeta(feedId: string) {
  db.run(
    `INSERT OR REPLACE INTO feed_meta (feed_id, last_synced) VALUES (?, ?)`,
    [feedId, Math.floor(Date.now() / 1000)]
  );
}

function getFeedMeta(feedId: string): number | null {
  const row = db
    .query<{ last_synced: number }, string>(
      `SELECT last_synced FROM feed_meta WHERE feed_id = ?`
    )
    .get(feedId);
  return row?.last_synced ?? null;
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
  const row = db.query<{ cnt: number }, []>(`SELECT COUNT(*) as cnt FROM stops`).get();
  return !row || row.cnt === 0;
}

export function isFeedStale(feedId: string, maxAgeMs: number): boolean {
  const last = getFeedMeta(feedId);
  if (!last) return true;
  return Date.now() / 1000 - last > maxAgeMs / 1000;
}
