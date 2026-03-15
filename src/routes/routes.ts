import { Hono } from 'hono';
import type { RouteResponse } from '../types/api';
import { findRoutesById, getAllRoutes } from '../db/queries/routes';
import type { RouteRow, RouteTypeFilter } from '../db/queries/routes';
import type { FeedId } from '../types/gtfs';

export const routesRouter = new Hono();

function parseFeedId(value: string | undefined): FeedId | undefined {
  if (!value) return undefined;
  if (value === 'subway' || value === 'lirr' || value === 'mnr') return value;
  return undefined;
}

function toRouteResponse(r: RouteRow): RouteResponse {
  return {
    feed_id:   r.feed_id,
    route_id:  r.route_id,
    name:      r.route_short_name ?? r.route_long_name ?? r.route_id,
    long_name: r.route_long_name ?? r.route_short_name ?? r.route_id,
    color:     r.route_color ?? '',
    type:      r.feed_id,
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
  const feedId = parseFeedId(c.req.query('feed_id'));

  if (c.req.query('feed_id') && !feedId) {
    return c.json({ error: 'feed_id must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  const matches = findRoutesById(routeId, feedId);

  if (matches.length > 1) {
    return c.json({ error: `Route ${routeId} exists in multiple feeds; provide feed_id`, code: 'AMBIGUOUS_ID', feeds: matches.map((match) => match.feed_id) }, 409);
  }

  const row = matches[0] ?? null;

  if (!row) {
    return c.json({ error: `Route ${routeId} not found`, code: 'NOT_FOUND' }, 404);
  }

  return c.json(toRouteResponse(row));
});
