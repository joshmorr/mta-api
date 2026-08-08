import { db } from '../client';
import type { FeedId } from '../../types/gtfs';
import { activeServicePredicate, getActiveServiceIds, type ServiceDateFilter } from './serviceCalendar';

export type ScheduleRow = {
  feed_id: FeedId;
  trip_id: string;
  route_id: string;
  route_short_name: string | null;
  route_long_name: string | null;
  service_id: string;
  stop_id: string;
  stop_sequence: number;
  arrival_time: string | null;
  departure_time: string;
  arrival_seconds: number | null;
  departure_seconds: number;
  headsign: string | null;
  train_number: string | null;
  direction_id: number | null;
  track: string | null;
  peak_offpeak: number | null;
  pickup_type: number | null;
  drop_off_type: number | null;
  // Populated only when a `to` filter was supplied; NULL otherwise.
  dest_stop_id: string | null;
  dest_stop_sequence: number | null;
  dest_arrival_time: string | null;
  dest_arrival_seconds: number | null;
};

/**
 * Departures from a single `fromStopId` on a single service date, with
 * `departure_seconds >= afterSeconds` from a trip whose service is active
 * on `serviceDate` — without the service filter, every trip that has ever
 * stopped here would appear regardless of which day of the week it actually
 * runs. Callers run this once per (candidate service date × platform ID —
 * see below) and merge the results in JS: see `getActiveServiceIds`'s
 * neighbor `getServedRouteIdsByStopIds` for why OR-ing dates together is
 * wrong for the date dimension (two service dates' `10:05:00` are different
 * real instants, and a merged row would carry no marker of which date
 * produced it); the platform dimension has a sharper, SQLite-specific
 * reason below.
 *
 * **Why one `stop_id`, not a `fromStopIds` IN-list.** `ORDER BY
 * a.departure_seconds ASC` can only use `idx_stop_times_stop_dep`'s natural
 * order — and skip materializing/sorting every match before applying
 * `LIMIT` — when the scan is a single equality range on `stop_id`. An
 * `IN (?, ?)` (subway parent stations expand to at most two platforms) runs
 * as two separate per-value range scans, and SQLite has no way to merge two
 * already-sorted streams into one without buffering both first — so it
 * silently falls back to "fetch everything matching, sort in a temp
 * B-tree, then apply LIMIT". At a busy interchange (Times Sq, 10k+
 * historical stop_times rows across every published schedule variant) that
 * is the difference between ~0.05ms and ~20ms per query, *and*, worse, a
 * naive attempt to dodge the sort by dropping ORDER BY entirely returns
 * silently wrong results (verified: it drains one stop_id's index range
 * before touching the other's, even when that other's earliest departure is
 * chronologically first). Splitting into one query per platform sidesteps
 * all of it: each is a plain equality scan, the index already hands back
 * the top `limit` rows in order, and the caller's cross-platform (and
 * cross-date) merge is the same JS `sort().slice(limit)` it already needs.
 *
 * Filters on `t.service_id IN (activeServiceIds)` rather than
 * `activeServicePredicate` for the same reason: a board query's candidate
 * row count can run into the thousands, and `activeServicePredicate`'s
 * three per-row correlated subqueries against `calendar`/`calendar_dates`
 * multiply that cost. `calendar`/`calendar_dates` are tiny, so precomputing
 * the small active-service set once and checking membership against
 * `trips` rows already being fetched by `trip_id` is a cheap in-memory
 * comparison instead.
 *
 * When `toStopIds` is given (also platform-expanded by the caller, exactly
 * like `fromStopId` — a bare parent ID matches zero stop_times rows), this
 * self-joins `stop_times` for the same trip at a later `stop_sequence`. That
 * ordering condition is what selects the correct platform pair on each end
 * automatically (e.g. 127→101 picks 127N; 101→127 picks 101S) — direction
 * falls out of the query and is never inferred separately. The destination
 * side stays an IN-list: it doesn't drive the ORDER BY, so it never hits
 * the problem above, and it's cheap once the origin side is already bounded
 * to `limit` rows.
 */
export function getScheduledDepartures(
  feedId: FeedId,
  fromStopId: string,
  toStopIds: string[] | null,
  serviceDate: ServiceDateFilter,
  afterSeconds: number,
  limit: number,
): ScheduleRow[] {
  // `null` means "no destination filter" (plain board query). `[]` is
  // distinct from that — a caller passing an explicit, empty destination
  // set means "no destination platform resolved," which can never match
  // any row, so short-circuit rather than let an empty SQL IN-list either
  // error or (worse) silently degrade into "no filter".
  if (toStopIds !== null && toStopIds.length === 0) return [];

  const activeServiceIds = getActiveServiceIds(feedId, serviceDate);
  if (!activeServiceIds.length) return [];

  const servicePlaceholders = activeServiceIds.map(() => '?').join(',');
  const destStopIds = toStopIds; // narrowed: non-null here, and non-empty per the guard above

  const destJoin = destStopIds
    ? `JOIN stop_times b
         ON b.feed_id = a.feed_id
        AND b.trip_id = a.trip_id
        AND b.stop_id IN (${destStopIds.map(() => '?').join(',')})
        AND b.stop_sequence > a.stop_sequence`
    : '';
  const destSelect = destStopIds
    ? `b.stop_id AS dest_stop_id, b.stop_sequence AS dest_stop_sequence,
       b.arrival_time AS dest_arrival_time, b.arrival_seconds AS dest_arrival_seconds`
    : `NULL AS dest_stop_id, NULL AS dest_stop_sequence,
       NULL AS dest_arrival_time, NULL AS dest_arrival_seconds`;

  // Placeholders are bound in the order they appear in the compiled SQL
  // text, not the order clauses are conceptually written in: destJoin's
  // `?`s come first, then the WHERE clause's own — feed_id, stop_id,
  // afterSeconds, the service_id IN-list — and LIMIT's last.
  const params: Array<string | number> = [];
  if (destStopIds) params.push(...destStopIds);
  params.push(feedId, fromStopId, afterSeconds, ...activeServiceIds, limit);

  return db
    .query<ScheduleRow, Array<string | number>>(
      `SELECT
         a.feed_id AS feed_id, a.trip_id AS trip_id, t.route_id AS route_id,
         r.route_short_name AS route_short_name, r.route_long_name AS route_long_name,
         t.service_id AS service_id,
         a.stop_id AS stop_id, a.stop_sequence AS stop_sequence,
         a.arrival_time AS arrival_time, a.departure_time AS departure_time,
         a.arrival_seconds AS arrival_seconds, a.departure_seconds AS departure_seconds,
         t.trip_headsign AS headsign, t.trip_short_name AS train_number,
         t.direction_id AS direction_id, a.track AS track, t.peak_offpeak AS peak_offpeak,
         a.pickup_type AS pickup_type, a.drop_off_type AS drop_off_type,
         ${destSelect}
       FROM stop_times a
       JOIN trips t ON t.feed_id = a.feed_id AND t.trip_id = a.trip_id
       JOIN routes r ON r.feed_id = t.feed_id AND r.route_id = t.route_id
       ${destJoin}
       WHERE a.feed_id = ? AND a.stop_id = ?
         AND a.departure_seconds IS NOT NULL
         AND a.departure_seconds >= ?
         AND t.service_id IN (${servicePlaceholders})
       ORDER BY a.departure_seconds ASC, a.trip_id ASC
       LIMIT ?`,
    )
    .all(...params);
}

export type TripMetaRow = {
  feed_id: FeedId;
  trip_id: string;
  route_id: string;
  route_short_name: string | null;
  route_long_name: string | null;
  service_id: string;
  direction_id: number | null;
  headsign: string | null;
  train_number: string | null;
  peak_offpeak: number | null;
};

export function getTripMeta(feedId: FeedId, tripId: string): TripMetaRow | null {
  return db
    .query<TripMetaRow, [FeedId, string]>(
      `SELECT t.feed_id AS feed_id, t.trip_id AS trip_id, t.route_id AS route_id,
              r.route_short_name AS route_short_name, r.route_long_name AS route_long_name,
              t.service_id AS service_id, t.direction_id AS direction_id,
              t.trip_headsign AS headsign, t.trip_short_name AS train_number,
              t.peak_offpeak AS peak_offpeak
       FROM trips t
       JOIN routes r ON r.feed_id = t.feed_id AND r.route_id = t.route_id
       WHERE t.feed_id = ? AND t.trip_id = ?`,
    )
    .get(feedId, tripId);
}

export type TripStopRow = {
  stop_id: string;
  stop_name: string;
  parent_station_id: string | null;
  stop_sequence: number;
  arrival_time: string | null;
  departure_time: string | null;
  arrival_seconds: number | null;
  departure_seconds: number | null;
  track: string | null;
  pickup_type: number | null;
  drop_off_type: number | null;
};

export function getTripStops(feedId: FeedId, tripId: string): TripStopRow[] {
  return db
    .query<TripStopRow, [FeedId, string]>(
      `SELECT st.stop_id AS stop_id, s.stop_name AS stop_name, s.parent_station AS parent_station_id,
              st.stop_sequence AS stop_sequence,
              st.arrival_time AS arrival_time, st.departure_time AS departure_time,
              st.arrival_seconds AS arrival_seconds, st.departure_seconds AS departure_seconds,
              st.track AS track, st.pickup_type AS pickup_type, st.drop_off_type AS drop_off_type
       FROM stop_times st
       JOIN stops s ON s.feed_id = st.feed_id AND s.stop_id = st.stop_id
       WHERE st.feed_id = ? AND st.trip_id = ?
       ORDER BY st.stop_sequence ASC`,
    )
    .all(feedId, tripId);
}

/**
 * Subway-only trip ID resolution for /trips/{trip_id}: the ID a client reads
 * off /arrivals is the realtime trip ID, which is frequently a *suffix* of
 * the static trip_id rather than an exact match. Narrowed by
 * activeServicePredicate against the candidate service dates so the ~8
 * same-suffix variants (one per calendar/service-id combination) collapse
 * to the handful actually running around the query's reference time. An
 * unindexed `LIKE '%'||?` scan of ~84k subway trips is acceptable on this
 * cold, infrequently-hit endpoint.
 */
export function findSubwayTripIdsBySuffix(
  tripIdSuffix: string,
  serviceDates: ServiceDateFilter[],
): string[] {
  const predicates = serviceDates.map((sd) => activeServicePredicate('t', sd));
  const dateSql = predicates.length ? ` AND (${predicates.map((p) => p.sql).join(' OR ')})` : '';
  const dateParams = predicates.flatMap((p) => p.params);

  const rows = db
    .query<{ trip_id: string }, Array<string>>(
      `SELECT DISTINCT t.trip_id AS trip_id
       FROM trips t
       WHERE t.feed_id = 'subway' AND t.trip_id LIKE '%' || ?${dateSql}
       ORDER BY t.trip_id
       LIMIT 5`,
    )
    .all(tripIdSuffix, ...dateParams);

  return rows.map((r) => r.trip_id);
}

export function isTripActiveOnDate(feedId: FeedId, tripId: string, serviceDate: ServiceDateFilter): boolean {
  const { sql, params } = activeServicePredicate('t', serviceDate);
  const row = db
    .query<{ one: number }, Array<string>>(
      `SELECT 1 AS one FROM trips t WHERE t.feed_id = ? AND t.trip_id = ? AND (${sql}) LIMIT 1`,
    )
    .get(feedId, tripId, ...params);
  return !!row;
}
