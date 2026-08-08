import { db } from '../client';
import type {
  FeedId,
  GtfsCalendar,
  GtfsCalendarDate,
  GtfsRoute,
  GtfsStop,
  GtfsStopTime,
  GtfsTransfer,
  GtfsTrip,
} from '../../types/gtfs';
import { toGtfsSeconds, toIntOrNull } from '../../utils/gtfsParse';

const BATCH_SIZE = 1000;

export function clearFeedData(feedId: FeedId) {
  db.transaction(() => {
    db.run(`DELETE FROM stop_times WHERE feed_id = ?`, [feedId]);
    db.run(`DELETE FROM trips WHERE feed_id = ?`, [feedId]);
    db.run(`DELETE FROM calendar_dates WHERE feed_id = ?`, [feedId]);
    db.run(`DELETE FROM calendar WHERE feed_id = ?`, [feedId]);
    db.run(`DELETE FROM routes WHERE feed_id = ?`, [feedId]);
    db.run(`DELETE FROM stops WHERE feed_id = ?`, [feedId]);
    db.run(`DELETE FROM transfers WHERE feed_id = ?`, [feedId]);
  })();
}

export function upsertStops(rows: GtfsStop[], feedId: FeedId) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stops
       (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station,
        stop_code, stop_desc, zone_id, wheelchair_boarding)
     VALUES
       ($feed_id, $stop_id, $stop_name, $stop_lat, $stop_lon, $location_type, $parent_station,
        $stop_code, $stop_desc, $zone_id, $wheelchair_boarding)`
  );
  db.transaction(() => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      for (const r of rows.slice(i, i + BATCH_SIZE)) {
        if (!r.stop_id) continue;
        stmt.run({
          $feed_id:             feedId,
          $stop_id:             r.stop_id,
          $stop_name:           r.stop_name || r.stop_id,
          $stop_lat:            parseFloat(r.stop_lat) || null,
          $stop_lon:            parseFloat(r.stop_lon) || null,
          $location_type:       parseInt(r.location_type) || 0,
          $parent_station:      r.parent_station || null,
          $stop_code:           r.stop_code || null,
          $stop_desc:           r.stop_desc || null,
          $zone_id:             r.zone_id || null,
          $wheelchair_boarding: toIntOrNull(r.wheelchair_boarding),
        });
      }
    }
  })();
}

export function upsertRoutes(rows: GtfsRoute[], feedId: FeedId) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO routes
       (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type,
        route_desc, route_url, route_text_color, route_sort_order)
     VALUES
       ($feed_id, $route_id, $agency_id, $route_short_name, $route_long_name, $route_color, $route_type,
        $route_desc, $route_url, $route_text_color, $route_sort_order)`
  );
  db.transaction(() => {
    for (const r of rows) {
      if (!r.route_id) continue;
      stmt.run({
        $feed_id:          feedId,
        $route_id:         r.route_id,
        $agency_id:        r.agency_id || null,
        $route_short_name: r.route_short_name,
        $route_long_name:  r.route_long_name,
        $route_color:      r.route_color ? `#${r.route_color}` : null,
        $route_type:       parseInt(r.route_type) || 0,
        $route_desc:       r.route_desc || null,
        $route_url:        r.route_url || null,
        $route_text_color: r.route_text_color ? `#${r.route_text_color}` : null,
        $route_sort_order: toIntOrNull(r.route_sort_order),
      });
    }
  })();
}

export function upsertTrips(rows: GtfsTrip[], feedId: FeedId) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO trips
       (feed_id, trip_id, route_id, service_id, direction_id, shape_id,
        trip_headsign, trip_short_name, block_id, wheelchair_accessible, peak_offpeak)
     VALUES
       ($feed_id, $trip_id, $route_id, $service_id, $direction_id, $shape_id,
        $trip_headsign, $trip_short_name, $block_id, $wheelchair_accessible, $peak_offpeak)`
  );
  db.transaction(() => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      for (const r of rows.slice(i, i + BATCH_SIZE)) {
        if (!r.trip_id || !r.route_id) continue;
        stmt.run({
          $feed_id:               feedId,
          $trip_id:               r.trip_id,
          $route_id:              r.route_id,
          $service_id:            r.service_id,
          $direction_id:          toIntOrNull(r.direction_id),
          $shape_id:              r.shape_id || null,
          $trip_headsign:         r.trip_headsign || null,
          $trip_short_name:       r.trip_short_name || null,
          $block_id:              r.block_id || null,
          $wheelchair_accessible: toIntOrNull(r.wheelchair_accessible),
          $peak_offpeak:          toIntOrNull(r.peak_offpeak),
        });
      }
    }
  })();
}

export function upsertStopTimes(rows: GtfsStopTime[], feedId: FeedId) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stop_times
       (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence,
        track, note_id, pickup_type, drop_off_type, arrival_seconds, departure_seconds)
     VALUES
       ($feed_id, $trip_id, $stop_id, $arrival_time, $departure_time, $stop_sequence,
        $track, $note_id, $pickup_type, $drop_off_type, $arrival_seconds, $departure_seconds)`
  );
  db.transaction(() => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      for (const r of rows.slice(i, i + BATCH_SIZE)) {
        if (!r.trip_id || !r.stop_id) continue;
        const stopSequence = parseInt(r.stop_sequence);
        if (Number.isNaN(stopSequence)) continue;
        stmt.run({
          $feed_id:           feedId,
          $trip_id:           r.trip_id,
          $stop_id:           r.stop_id,
          $arrival_time:      r.arrival_time || null,
          $departure_time:    r.departure_time || null,
          $stop_sequence:     stopSequence,
          $track:             r.track || null,
          $note_id:           r.note_id || null,
          $pickup_type:       toIntOrNull(r.pickup_type),
          $drop_off_type:     toIntOrNull(r.drop_off_type),
          $arrival_seconds:   toGtfsSeconds(r.arrival_time),
          $departure_seconds: toGtfsSeconds(r.departure_time),
        });
      }
    }
  })();
}

/**
 * Returns push/flush callbacks for inserting stop_times in batches,
 * so the full row array never needs to exist in memory.
 */
export function upsertStopTimesBatch(feedId: FeedId) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stop_times
       (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence,
        track, note_id, pickup_type, drop_off_type, arrival_seconds, departure_seconds)
     VALUES
       ($feed_id, $trip_id, $stop_id, $arrival_time, $departure_time, $stop_sequence,
        $track, $note_id, $pickup_type, $drop_off_type, $arrival_seconds, $departure_seconds)`
  );
  const batch: GtfsStopTime[] = [];

  const flushBatch = db.transaction(() => {
    for (const r of batch) {
      const stopSequence = parseInt(r.stop_sequence);
      if (Number.isNaN(stopSequence)) continue;
      stmt.run({
        $feed_id:           feedId,
        $trip_id:           r.trip_id,
        $stop_id:           r.stop_id,
        $arrival_time:      r.arrival_time || null,
        $departure_time:    r.departure_time || null,
        $stop_sequence:     stopSequence,
        $track:             r.track || null,
        $note_id:           r.note_id || null,
        $pickup_type:       toIntOrNull(r.pickup_type),
        $drop_off_type:     toIntOrNull(r.drop_off_type),
        $arrival_seconds:   toGtfsSeconds(r.arrival_time),
        $departure_seconds: toGtfsSeconds(r.departure_time),
      });
    }
    batch.length = 0;
  });

  return {
    push(row: GtfsStopTime) {
      if (!row.trip_id || !row.stop_id) return;
      batch.push(row);
      if (batch.length >= BATCH_SIZE) flushBatch();
    },
    flush() {
      if (batch.length) flushBatch();
    },
  };
}

export function upsertCalendar(rows: GtfsCalendar[], feedId: FeedId) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO calendar
       (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
     VALUES
       ($feed_id, $service_id, $monday, $tuesday, $wednesday, $thursday, $friday, $saturday, $sunday, $start_date, $end_date)`
  );
  db.transaction(() => {
    for (const r of rows) {
      if (!r.service_id) continue;
      stmt.run({
        $feed_id:    feedId,
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

export function upsertCalendarDates(rows: GtfsCalendarDate[], feedId: FeedId) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO calendar_dates (feed_id, service_id, date, exception_type)
     VALUES ($feed_id, $service_id, $date, $exception_type)`
  );
  db.transaction(() => {
    for (const r of rows) {
      if (!r.service_id || !r.date) continue;
      stmt.run({
        $feed_id:        feedId,
        $service_id:     r.service_id,
        $date:           r.date,
        $exception_type: parseInt(r.exception_type) || 0,
      });
    }
  })();
}

/**
 * `transfers` has no declared PK (see schema.ts), so this is a plain INSERT,
 * not INSERT OR REPLACE — there is no conflict target, and per-trip rows that
 * share every other column (common on MNR) must all survive.
 */
export function upsertTransfers(rows: GtfsTransfer[], feedId: FeedId) {
  const stmt = db.prepare(
    `INSERT INTO transfers
       (feed_id, from_stop_id, to_stop_id, transfer_type, min_transfer_time,
        from_route_id, to_route_id, from_trip_id, to_trip_id)
     VALUES
       ($feed_id, $from_stop_id, $to_stop_id, $transfer_type, $min_transfer_time,
        $from_route_id, $to_route_id, $from_trip_id, $to_trip_id)`
  );
  db.transaction(() => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      for (const r of rows.slice(i, i + BATCH_SIZE)) {
        if (!r.from_stop_id || !r.to_stop_id) continue;
        stmt.run({
          $feed_id:           feedId,
          $from_stop_id:      r.from_stop_id,
          $to_stop_id:        r.to_stop_id,
          $transfer_type:     toIntOrNull(r.transfer_type),
          $min_transfer_time: toIntOrNull(r.min_transfer_time),
          $from_route_id:     r.from_route_id || null,
          $to_route_id:       r.to_route_id || null,
          $from_trip_id:      r.from_trip_id || null,
          $to_trip_id:        r.to_trip_id || null,
        });
      }
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