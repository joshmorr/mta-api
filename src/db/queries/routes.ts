import { db } from '../client';
import type { FeedId } from '../../types/gtfs';

export type RouteRow = {
  feed_id: FeedId;
  route_id: string;
  route_short_name: string | null;
  route_long_name: string | null;
  route_color: string | null;
  route_type: number;
};

export type RouteTypeFilter = 'subway' | 'lirr' | 'mnr';

const SELECT_ROUTES = `SELECT feed_id, route_id, route_short_name, route_long_name, route_color, route_type FROM routes`;

function toFeedId(type?: RouteTypeFilter): FeedId | undefined {
  if (!type) return undefined;
  return type;
}

export function getAllRoutes(type?: RouteTypeFilter): RouteRow[] {
  const feedId = toFeedId(type);
  if (feedId) {
    return db
      .query<RouteRow, [FeedId]>(
        `${SELECT_ROUTES} WHERE feed_id = ? ORDER BY COALESCE(route_short_name, route_long_name, route_id)`,
      )
      .all(feedId);
  }
  return db
    .query<RouteRow, []>(`${SELECT_ROUTES} ORDER BY route_short_name`)
    .all();
}

export function findRoutesById(routeId: string, feedId?: FeedId): RouteRow[] {
  if (feedId) {
    const row = db
      .query<RouteRow, [FeedId, string]>(
        `SELECT feed_id, route_id, route_short_name, route_long_name, route_color, route_type
         FROM routes WHERE feed_id = ? AND route_id = ?`,
      )
      .get(feedId, routeId);
    return row ? [row] : [];
  }

  return db
    .query<RouteRow, [string]>(
      `SELECT feed_id, route_id, route_short_name, route_long_name, route_color, route_type
       FROM routes WHERE route_id = ?
       ORDER BY feed_id`,
    )
    .all(routeId);
}

/**
 * Batch sibling of `getRouteById`, so a caller holding many route IDs (an
 * arrivals board) resolves them in one statement instead of one per row.
 */
export function getRoutesByIds(feedId: FeedId, routeIds: string[]): RouteRow[] {
  if (!routeIds.length) return [];

  const placeholders = routeIds.map(() => '?').join(',');
  return db
    .query<RouteRow, [FeedId, ...string[]]>(
      `${SELECT_ROUTES} WHERE feed_id = ? AND route_id IN (${placeholders})`,
    )
    .all(feedId, ...routeIds);
}

export function getRouteById(routeId: string, feedId: FeedId): RouteRow | null {
  return db
    .query<RouteRow, [FeedId, string]>(
      `SELECT feed_id, route_id, route_short_name, route_long_name, route_color, route_type
       FROM routes WHERE feed_id = ? AND route_id = ?`,
    )
    .get(feedId, routeId);
}
