import { db } from '../client';
import type {
  GtfsCalendar,
  GtfsRoute,
  GtfsStop,
  GtfsStopTime,
  GtfsTrip,
} from '../../types/gtfs';

const BATCH_SIZE = 1000;

export function upsertStops(rows: GtfsStop[]) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
     VALUES ($stop_id, $stop_name, $stop_lat, $stop_lon, $location_type, $parent_station)`
  );
  db.transaction(() => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      for (const r of rows.slice(i, i + BATCH_SIZE)) {
        if (!r.stop_id) continue;
        stmt.run({
          $stop_id:        r.stop_id,
          $stop_name:      r.stop_name || r.stop_id,
          $stop_lat:       parseFloat(r.stop_lat) || null,
          $stop_lon:       parseFloat(r.stop_lon) || null,
          $location_type:  parseInt(r.location_type) || 0,
          $parent_station: r.parent_station || null,
        });
      }
    }
  })();
}

export function upsertRoutes(rows: GtfsRoute[]) {
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

export function upsertTrips(rows: GtfsTrip[]) {
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

export function upsertStopTimes(rows: GtfsStopTime[]) {
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

export function upsertCalendar(rows: GtfsCalendar[]) {
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

export function setFeedMeta(feedId: string) {
  db.run(
    `INSERT OR REPLACE INTO feed_meta (feed_id, last_synced) VALUES (?, ?)`,
    [feedId, Math.floor(Date.now() / 1000)]
  );
}

export function getFeedMeta(feedId: string): number | null {
  const row = db
    .query<{ last_synced: number }, [string]>(
      `SELECT last_synced FROM feed_meta WHERE feed_id = ?`
    )
    .get(feedId);
  return row?.last_synced ?? null;
}

export function isDbEmpty(): boolean {
  const row = db.query<{ cnt: number }, []>(`SELECT COUNT(*) as cnt FROM stops`).get();
  return !row || row.cnt === 0;
}