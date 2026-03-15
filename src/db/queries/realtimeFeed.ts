import { db } from '../client';
import type { FeedId } from '../../types/gtfs';

export type WeekdayColumn =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export type ServiceDateFilter = {
  date: string;
  weekdayColumn: WeekdayColumn;
};

export function getStopNameById(feedId: FeedId, stopId: string): string | null {
  const row = db
    .query<{ stop_name: string }, [FeedId, string]>(
      `SELECT stop_name FROM stops WHERE feed_id = ? AND stop_id = ?`
    )
    .get(feedId, stopId);

  return row?.stop_name ?? null;
}

export function getServedRouteIdsByStopIds(
  feedId: FeedId,
  stopIds: string[],
  serviceDates: ServiceDateFilter[],
): string[] {
  if (!stopIds.length) return [];

  const placeholders = stopIds.map(() => '?').join(',');
  const serviceDateSql = serviceDates.length
    ? ` AND (${serviceDates.map((serviceDate) => getActiveServiceSql(serviceDate.weekdayColumn)).join(' OR ')})`
    : '';
  const serviceDateParams = serviceDates.flatMap((serviceDate) => [
    serviceDate.date,
    serviceDate.date,
    serviceDate.date,
    serviceDate.date,
  ]);
  const rows = db
    .query<{ route_id: string }, Array<string>>(
      `SELECT DISTINCT t.route_id
       FROM stop_times st
       JOIN trips t ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
       WHERE st.feed_id = ? AND st.stop_id IN (${placeholders})${serviceDateSql}`
    )
    .all(feedId, ...stopIds, ...serviceDateParams);

  return rows.map((r) => r.route_id);
}

function getActiveServiceSql(weekdayColumn: WeekdayColumn): string {
  return `(
    EXISTS (
      SELECT 1
      FROM calendar_dates cd_added
      WHERE cd_added.feed_id = t.feed_id
        AND cd_added.service_id = t.service_id
        AND cd_added.date = ?
        AND cd_added.exception_type = 1
    )
    OR (
      EXISTS (
        SELECT 1
        FROM calendar c
        WHERE c.feed_id = t.feed_id
          AND c.service_id = t.service_id
          AND c.start_date <= ?
          AND c.end_date >= ?
          AND c.${weekdayColumn} = 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM calendar_dates cd_removed
        WHERE cd_removed.feed_id = t.feed_id
          AND cd_removed.service_id = t.service_id
          AND cd_removed.date = ?
          AND cd_removed.exception_type = 2
      )
    )
  )`;
}

export function isPlatformStop(feedId: FeedId, stopId: string): boolean {
  const row = db
    .query<{ stop_id: string }, [FeedId, string]>(
      `SELECT stop_id FROM stops WHERE feed_id = ? AND stop_id = ? AND location_type = 0`
    )
    .get(feedId, stopId);

  return !!row;
}

export function getChildPlatformIds(feedId: FeedId, parentStopId: string): string[] {
  const rows = db
    .query<{ stop_id: string }, [FeedId, string]>(
      `SELECT stop_id FROM stops WHERE feed_id = ? AND parent_station = ? AND location_type = 0`
    )
    .all(feedId, parentStopId);

  return rows.map((r) => r.stop_id);
}