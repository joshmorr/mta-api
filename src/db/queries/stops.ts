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
