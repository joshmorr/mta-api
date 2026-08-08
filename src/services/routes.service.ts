import { getAllRoutes, getRouteById } from '../db/queries/routes';
import type { RouteRow } from '../db/queries/routes';
import type { FeedId } from '../types/gtfs';
import type { RouteResponse } from '../types/api';

/**
 * GTFS lets either name be blank, and the MTA uses both conventions: subway
 * routes carry a short name (`A`) and no long name worth showing, while LIRR
 * and MNR branches are long-name only. Each field falls back through the other
 * to the route ID so neither is ever empty.
 *
 * `row` is optional because realtime feeds can name a route that is absent from
 * the static schedule; there the ID is the only label available. That is also
 * why the ID is passed separately rather than read off the row.
 */
export function toRouteNames(
  routeId: string,
  row?: RouteRow,
): { route_name: string; route_long_name: string } {
  return {
    route_name:      row?.route_short_name ?? row?.route_long_name ?? routeId,
    route_long_name: row?.route_long_name  ?? row?.route_short_name ?? routeId,
  };
}

function toRouteResponse(r: RouteRow): RouteResponse {
  const { route_name, route_long_name } = toRouteNames(r.route_id, r);
  return {
    feed_id:   r.feed_id,
    route_id:  r.route_id,
    name:      route_name,
    long_name: route_long_name,
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
