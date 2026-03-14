import { db } from '../client';

export type RouteRow = {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color: string;
  route_type: number;
};

export type RouteTypeFilter = 'subway' | 'lirr' | 'mnr';

const SELECT_ROUTES = `SELECT route_id, route_short_name, route_long_name, route_color, route_type FROM routes`;

export function getAllRoutes(type?: RouteTypeFilter): RouteRow[] {
  if (type === 'subway') {
    return db
      .query<RouteRow, [number]>(`${SELECT_ROUTES} WHERE route_type = ? ORDER BY route_short_name`)
      .all(1);
  }
  if (type === 'lirr') {
    return db
      .query<RouteRow, [number]>(`${SELECT_ROUTES} WHERE route_type = ? AND route_id LIKE 'LIRR%' ORDER BY route_short_name`)
      .all(2);
  }
  if (type === 'mnr') {
    return db
      .query<RouteRow, [number]>(`${SELECT_ROUTES} WHERE route_type = ? AND route_id NOT LIKE 'LIRR%' ORDER BY route_short_name`)
      .all(2);
  }
  return db
    .query<RouteRow, []>(`${SELECT_ROUTES} ORDER BY route_short_name`)
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
