import { Hono } from 'hono';
import type { RouteResponse } from '../types/api';
import { getAllRoutes, getRouteById } from '../db/queries/routes';

export const routesRouter = new Hono();

function toRouteResponse(r: {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color: string;
  route_type: number;
}): RouteResponse {
  return {
    route_id:  r.route_id,
    name:      r.route_short_name,
    long_name: r.route_long_name,
    color:     r.route_color ?? '',
    type:      r.route_type === 1 ? 'subway' : r.route_id.startsWith('LIRR') ? 'lirr' : 'mnr',
  };
}

routesRouter.get('/', (c) => {
  const typeFilter = c.req.query('type');

  let typeCondition = '';
  if (typeFilter === 'subway') typeCondition = `AND route_type = 1`;
  else if (typeFilter === 'lirr') typeCondition = `AND route_type = 2 AND route_id LIKE 'LIRR%'`;
  else if (typeFilter === 'mnr') typeCondition = `AND route_type = 2 AND route_id NOT LIKE 'LIRR%'`;
  else if (typeFilter) {
    return c.json({ error: `Unknown type: ${typeFilter}`, code: 'INVALID_PARAM' }, 400);
  }

  const routes: RouteResponse[] = getAllRoutes(typeCondition).map(toRouteResponse);
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
