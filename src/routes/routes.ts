import { Hono } from 'hono';
import { db } from '../db/client';
import type { RouteResponse } from '../types/api';

export const routesRouter = new Hono();

const ROUTE_TYPE_MAP: Record<number, RouteResponse['type']> = {
  1: 'subway',
  2: 'lirr',   // will distinguish MNR by agency below
};

routesRouter.get('/', (c) => {
  const typeFilter = c.req.query('type');

  let typeCondition = '';
  if (typeFilter === 'subway') typeCondition = `AND r.route_type = 1`;
  else if (typeFilter === 'lirr') typeCondition = `AND r.route_type = 2 AND r.route_id LIKE 'LIRR%'`;
  else if (typeFilter === 'mnr') typeCondition = `AND r.route_type = 2 AND r.route_id NOT LIKE 'LIRR%'`;
  else if (typeFilter) {
    return c.json({ error: `Unknown type: ${typeFilter}`, code: 'INVALID_PARAM' }, 400);
  }

  const rows = db
    .query<{
      route_id: string;
      route_short_name: string;
      route_long_name: string;
      route_color: string;
      route_type: number;
    }, []>(`SELECT route_id, route_short_name, route_long_name, route_color, route_type
            FROM routes
            ${typeCondition}
            ORDER BY route_short_name`)
    .all();

  const routes: RouteResponse[] = rows.map((r) => ({
    route_id:  r.route_id,
    name:      r.route_short_name,
    long_name: r.route_long_name,
    color:     r.route_color ?? '',
    type:      r.route_type === 1 ? 'subway' : r.route_id.startsWith('LIRR') ? 'lirr' : 'mnr',
  }));

  return c.json({ routes });
});

routesRouter.get('/:route_id', (c) => {
  const routeId = c.req.param('route_id');

  const row = db
    .query<{
      route_id: string;
      route_short_name: string;
      route_long_name: string;
      route_color: string;
      route_type: number;
    }, [string]>(
      `SELECT route_id, route_short_name, route_long_name, route_color, route_type
       FROM routes WHERE route_id = ?`
    )
    .get(routeId);

  if (!row) {
    return c.json({ error: `Route ${routeId} not found`, code: 'NOT_FOUND' }, 404);
  }

  const route: RouteResponse = {
    route_id:  row.route_id,
    name:      row.route_short_name,
    long_name: row.route_long_name,
    color:     row.route_color ?? '',
    type:      row.route_type === 1 ? 'subway' : row.route_id.startsWith('LIRR') ? 'lirr' : 'mnr',
  };

  return c.json(route);
});
