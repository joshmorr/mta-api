import { getAllRoutes, getRouteById } from '../db/queries/routes';
import type { RouteRow } from '../db/queries/routes';
import type { FeedId } from '../types/gtfs';
import type { RouteResponse } from '../types/api';

/**
 * GTFS lets either name be blank, and the MTA uses both conventions: subway
 * routes carry a short name (`A`) and no long name worth showing, while LIRR
 * and MNR branches are long-name only. Each field falls back through the other
 * to the route ID so neither is ever empty.
 */
function toRouteResponse(r: RouteRow): RouteResponse {
  return {
    feed_id:   r.feed_id,
    route_id:  r.route_id,
    name:      r.route_short_name ?? r.route_long_name ?? r.route_id,
    long_name: r.route_long_name ?? r.route_short_name ?? r.route_id,
    color:     r.route_color ?? '',
  };
}

export function listRoutes(feed?: FeedId): RouteResponse[] {
  return getAllRoutes(feed).map(toRouteResponse);
}

export function getRoute(routeId: string, feedId: FeedId): RouteResponse | null {
  const route = getRouteById(routeId, feedId);
  return route ? toRouteResponse(route) : null;
}
