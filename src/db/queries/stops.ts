import { db } from '../client';
import type { FeedId } from '../../types/gtfs';

export type StopRow = {
  feed_id: FeedId;
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  location_type: number;
  parent_station: string | null;
};

const SEARCHABLE_STOP_CONDITION = `
  (
    (feed_id = 'subway' AND location_type = 1)
    OR (feed_id != 'subway' AND (parent_station IS NULL OR parent_station = ''))
  )
`;

function withOptionalFeedFilter(baseSql: string, feedId?: FeedId): { sql: string; params: Array<string | number> } {
  if (!feedId) {
    return { sql: baseSql, params: [] };
  }
  return {
    sql: `${baseSql} AND feed_id = ?`,
    params: [feedId],
  };
}

export function findStopsByProximity(
  lat: number,
  lon: number,
  latDelta: number,
  lonDelta: number,
  limit: number,
  feedId?: FeedId,
): StopRow[] {
  const baseSql = `SELECT feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station
       FROM stops
       WHERE ${SEARCHABLE_STOP_CONDITION}
         AND stop_lat BETWEEN ? AND ?
         AND stop_lon BETWEEN ? AND ?`;
  const { sql, params } = withOptionalFeedFilter(baseSql, feedId);
  return db
    .query<StopRow, Array<string | number>>(
      `${sql}
       ORDER BY ((stop_lat - ?) * (stop_lat - ?) + (stop_lon - ?) * (stop_lon - ?))
       LIMIT ?`,
    )
    .all(lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta, ...params, lat, lat, lon, lon, limit);
}

export function findStopsByName(q: string, limit: number, feedId?: FeedId): StopRow[] {
  const baseSql = `SELECT feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station
       FROM stops
       WHERE ${SEARCHABLE_STOP_CONDITION}
         AND stop_name LIKE ? COLLATE NOCASE`;
  const { sql, params } = withOptionalFeedFilter(baseSql, feedId);
  return db
    .query<StopRow, Array<string | number>>(
      `${sql}
       ORDER BY feed_id, stop_name, stop_id
       LIMIT ?`,
    )
    .all(`%${q}%`, ...params, limit);
}

export function getAllStops(limit: number, feedId?: FeedId): StopRow[] {
  const baseSql = `SELECT feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station
       FROM stops
       WHERE ${SEARCHABLE_STOP_CONDITION}`;
  const { sql, params } = withOptionalFeedFilter(baseSql, feedId);
  return db
    .query<StopRow, Array<string | number>>(
      `${sql}
       ORDER BY feed_id, stop_name, stop_id
       LIMIT ?`,
    )
    .all(...params, limit);
}

export function findStopsById(stopId: string, feedId?: FeedId): StopRow[] {
  const baseSql = `SELECT feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station
       FROM stops
       WHERE stop_id = ?`;
  const { sql, params } = withOptionalFeedFilter(baseSql, feedId);
  return db
    .query<StopRow, Array<string | number>>(
      `${sql}
       ORDER BY feed_id`,
    )
    .all(stopId, ...params);
}

export function getStopById(stopId: string, feedId: FeedId): StopRow | null {
  return db
    .query<StopRow, [FeedId, string]>(
      `SELECT feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station
       FROM stops
       WHERE feed_id = ? AND stop_id = ?`,
    )
    .get(feedId, stopId);
}

export function getPlatformIds(feedId: FeedId, parentStopId: string): string[] {
  const rows = db
    .query<{ stop_id: string }, [FeedId, string]>(
      `SELECT stop_id FROM stops WHERE feed_id = ? AND parent_station = ? AND location_type = 0`,
    )
    .all(feedId, parentStopId);
  return rows.map((r) => r.stop_id);
}

export function getPlatforms(feedId: FeedId, parentStopId: string): { stop_id: string; stop_name: string }[] {
  return db
    .query<{ stop_id: string; stop_name: string }, [FeedId, string]>(
      `SELECT stop_id, stop_name FROM stops WHERE feed_id = ? AND parent_station = ? AND location_type = 0`,
    )
    .all(feedId, parentStopId);
}

export function getParentId(feedId: FeedId, stopId: string): string | null {
  const row = db
    .query<{ parent_station: string }, [FeedId, string]>(
      `SELECT parent_station FROM stops WHERE feed_id = ? AND stop_id = ?`,
    )
    .get(feedId, stopId);
  return row?.parent_station ?? null;
}

export type TransferRow = {
  to_stop_id: string;
  to_stop_name: string;
  transfer_type: number | null;
  min_transfer_time: number | null;
  from_route_id: string | null;
  to_route_id: string | null;
  from_trip_id: string | null;
  to_trip_id: string | null;
};

/**
 * Transfers originating at a stop, joined to the destination stop's name.
 * `from_stop_id` must already be the ID as it appears in transfers.txt — for
 * subway that is the parent station, never a platform — so callers resolve
 * to a parent/platform ID the same way they do for `getPlatforms`.
 */
export function getTransfersByStopId(feedId: FeedId, fromStopId: string): TransferRow[] {
  return db
    .query<TransferRow, [FeedId, string]>(
      `SELECT t.to_stop_id AS to_stop_id,
              COALESCE(s.stop_name, t.to_stop_id) AS to_stop_name,
              t.transfer_type AS transfer_type,
              t.min_transfer_time AS min_transfer_time,
              t.from_route_id AS from_route_id,
              t.to_route_id AS to_route_id,
              t.from_trip_id AS from_trip_id,
              t.to_trip_id AS to_trip_id
       FROM transfers t
       LEFT JOIN stops s ON s.feed_id = t.feed_id AND s.stop_id = t.to_stop_id
       WHERE t.feed_id = ? AND t.from_stop_id = ?
       ORDER BY t.to_stop_id`,
    )
    .all(feedId, fromStopId);
}

export type ResolvedStopName = { stop_id: string; stop_name: string };

/**
 * Batch-resolve display names for a set of stop IDs, self-joining a subway
 * platform onto its parent station so the name is the station ("Jamaica
 * Center-Parsons/Archer"), not the platform. LIRR/MNR stops have no parent
 * and resolve to themselves. One query for the whole set, mirroring
 * `getRoutesByIds` - callers key the result by the *original* input ID.
 */
export function getStopNamesByIds(feedId: FeedId, stopIds: string[]): Map<string, ResolvedStopName> {
  if (!stopIds.length) return new Map();

  const placeholders = stopIds.map(() => '?').join(',');
  const rows = db
    .query<
      { input_stop_id: string; resolved_stop_id: string; stop_name: string },
      Array<string | FeedId>
    >(
      `SELECT s.stop_id AS input_stop_id,
              COALESCE(p.stop_id, s.stop_id) AS resolved_stop_id,
              COALESCE(p.stop_name, s.stop_name) AS stop_name
       FROM stops s
       LEFT JOIN stops p ON p.feed_id = s.feed_id AND p.stop_id = s.parent_station
       WHERE s.feed_id = ? AND s.stop_id IN (${placeholders})`,
    )
    .all(feedId, ...stopIds);

  return new Map(rows.map((r) => [r.input_stop_id, { stop_id: r.resolved_stop_id, stop_name: r.stop_name }]));
}
