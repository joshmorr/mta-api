import { db } from '../client';

type RouteRow = {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color: string;
  route_type: number;
};

export function getAllRoutes(typeCondition: string): RouteRow[] {
  return db
    .query<RouteRow, []>(
      `SELECT route_id, route_short_name, route_long_name, route_color, route_type
       FROM routes
       ${typeCondition}
       ORDER BY route_short_name`,
    )
    .all();
}

export function getRouteById(routeId: string): RouteRow | null {
  return db
    .query<RouteRow, [string]>(
      `SELECT route_id, route_short_name, route_long_name, route_color, route_type
       FROM routes WHERE route_id = ?`,
    )
    .get(routeId);
}
