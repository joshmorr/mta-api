import { Hono } from 'hono';
import type { RouteResponse } from '../types/api';
import { getAllRoutes, getRouteById } from '../db/queries/routes';
import type { RouteRow, RouteTypeFilter } from '../db/queries/routes';
import { parseFeedId } from '../utils/feedParams';

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
  const feed = c.req.query('feed');

  if (feed && !['subway', 'lirr', 'mnr'].includes(feed)) {
    return c.json({ error: `Unknown feed: ${feed}`, code: 'INVALID_PARAM' }, 400);
  }

  const type = feed as RouteTypeFilter | undefined;
  const routes: RouteResponse[] = getAllRoutes(type).map(toRouteResponse);
  return c.json({ routes });
});

routesRouter.get('/:route_id', (c) => {
  const routeId = c.req.param('route_id');
  const feedRaw = c.req.query('feed');
  const feedId  = parseFeedId(feedRaw);

  if (!feedRaw) {
    return c.json({ error: 'feed is required', code: 'INVALID_PARAM' }, 400);
  }

  if (!feedId) {
    return c.json({ error: 'feed must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  const route = getRouteById(routeId, feedId);

  if (!route) {
    return c.json({ error: `Route ${routeId} not found`, code: 'NOT_FOUND' }, 404);
  }

  const response: RouteResponse = {
    feed_id:   route.feed_id,
    route_id:  route.route_id,
    name:      route.route_short_name ?? route.route_long_name ?? route.route_id,
    long_name: route.route_long_name ?? route.route_short_name ?? route.route_id,
    color:     route.route_color ?? '',
  };

  return c.json(response);
});
