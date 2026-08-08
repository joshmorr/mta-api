import { db } from '../client';
import type { FeedId } from '../../types/gtfs';
import { activeServicePredicate, type ServiceDateFilter, type WeekdayColumn } from './serviceCalendar';

// Re-exported so existing imports of these two types from this module keep
// compiling — the definitions now live in serviceCalendar.ts alongside the
// predicate that uses them.
export type { ServiceDateFilter, WeekdayColumn };

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
  const predicates = serviceDates.map((serviceDate) => activeServicePredicate('t', serviceDate));
  const serviceDateSql = predicates.length
    ? ` AND (${predicates.map((p) => p.sql).join(' OR ')})`
    : '';
  const serviceDateParams = predicates.flatMap((p) => p.params);
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