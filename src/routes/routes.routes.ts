import { Hono } from 'hono';
import type { RouteResponse } from '../types/api';
import { getAllRoutes } from '../db/queries/routes';
import type { RouteRow, RouteTypeFilter } from '../db/queries/routes';

export const routesRouter = new Hono();

function toRouteResponse(r: RouteRow): RouteResponse {
  return {
    feed_id:   r.feed_id,
    route_id:  r.route_id,
    name:      r.route_short_name ?? r.route_long_name ?? r.route_id,
    long_name: r.route_long_name ?? r.route_short_name ?? r.route_id,
    color:     r.route_color ?? '',
  };
}

routesRouter.get('/', (c) => {
  const typeQuery = c.req.query('type');

  if (typeQuery && !['subway', 'lirr', 'mnr'].includes(typeQuery)) {
    return c.json({ error: `Unknown type: ${typeQuery}`, code: 'INVALID_PARAM' }, 400);
  }

  const type = typeQuery as RouteTypeFilter | undefined;
  const routes: RouteResponse[] = getAllRoutes(type).map(toRouteResponse);
  return c.json({ routes });
});
