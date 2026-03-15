import { Hono } from 'hono';
import type { RouteResponse } from '../types/api';
import { getRouteById } from '../db/queries/routes';
import { parseFeedId } from './feedParams';

export const feedRoutesRouter = new Hono();

feedRoutesRouter.get('/:feed_id/routes/:route_id', (c) => {
  const routeId = c.req.param('route_id');
  const feedId = parseFeedId(c.req.param('feed_id'));

  if (!feedId) {
    return c.json({ error: 'feed_id must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  const route = getRouteById(routeId, feedId);

  if (!route) {
    return c.json({ error: `Route ${routeId} not found`, code: 'NOT_FOUND' }, 404);
  }

  const response: RouteResponse = {
    feed_id: route.feed_id,
    route_id: route.route_id,
    name: route.route_short_name ?? route.route_long_name ?? route.route_id,
    long_name: route.route_long_name ?? route.route_short_name ?? route.route_id,
    color: route.route_color ?? '',
    type: route.feed_id,
  };

  return c.json(response);
});