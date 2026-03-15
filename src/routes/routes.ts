import { Hono } from 'hono';
import type { RouteResponse } from '../types/api';
import { getAllRoutes, getRouteById } from '../db/queries/routes';
import type { RouteRow, RouteTypeFilter } from '../db/queries/routes';

export const routesRouter = new Hono();

function toRouteResponse(r: RouteRow): RouteResponse {
  return {
    route_id:  r.route_id,
    name:      r.route_short_name,
    long_name: r.route_long_name,
    color:     r.route_color ?? '',
    type:      r.route_type === 1 ? 'subway' : r.route_id.startsWith('LIRR') ? 'lirr' : 'mnr',
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

routesRouter.get('/:route_id', (c) => {
  const routeId = c.req.param('route_id');

  const row = getRouteById(routeId);

  if (!row) {
    return c.json({ error: `Route ${routeId} not found`, code: 'NOT_FOUND' }, 404);
  }

  return c.json(toRouteResponse(row));
});
