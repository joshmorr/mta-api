import { Hono } from 'hono';
import type { StopDetail } from '../types/api';
import type { RouteResponse } from '../types/api';
import { getStopById, getPlatforms, getParentId } from '../db/queries/stops';
import { getRouteById } from '../db/queries/routes';
import { getArrivalsForStop, getVehiclesForRoute, NotFoundError } from '../services/realtime.service';
import { parseFeedId } from '../utils/feedParams';

export const feedsRouter = new Hono();

feedsRouter.get('/:feed_id/stops/:stop_id', (c) => {
  const stopId = c.req.param('stop_id');
  const feedId = parseFeedId(c.req.param('feed_id'));

  if (!feedId) {
    return c.json({ error: 'feed_id must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  const stop = getStopById(stopId, feedId);

  if (!stop) {
    return c.json({ error: `Stop ${stopId} not found`, code: 'NOT_FOUND' }, 404);
  }

  const parentId = stop.feed_id === 'subway' && stop.location_type === 0
    ? getParentId(stop.feed_id, stopId) ?? stopId
    : stopId;
  const parent = parentId !== stopId
    ? getStopById(parentId, stop.feed_id) ?? stop
    : stop;

  const platforms = parent.feed_id === 'subway' ? getPlatforms(parent.feed_id, parent.stop_id) : [];

  const detail: StopDetail = {
    feed_id: parent.feed_id,
    stop_id: parent.stop_id,
    stop_name: parent.stop_name,
    lat: parent.stop_lat,
    lon: parent.stop_lon,
    platforms: platforms.map((platform) => ({
      stop_id: platform.stop_id,
      direction: inferDirection(platform.stop_id),
    })),
  };

  return c.json(detail);
});

feedsRouter.get('/:feed_id/stops/:stop_id/arrivals', async (c) => {
  const stopId      = c.req.param('stop_id');
  const feedId      = parseFeedId(c.req.param('feed_id'));
  const limit       = Math.min(Number(c.req.query('limit') ?? 5), 50);
  const routesParam = c.req.query('routes');
  const routeFilter = routesParam
    ? routesParam.split(',').map((r) => r.trim()).filter(Boolean)
    : undefined;

  if (!feedId) {
    return c.json({ error: 'feed_id must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  try {
    const result = await getArrivalsForStop(stopId, limit, feedId, routeFilter);
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message, code: 'NOT_FOUND' }, 404);
    }
    return c.json({ error: 'Feed unavailable', code: 'FEED_ERROR' }, 503, {
      'Retry-After': '30',
    });
  }
});

feedsRouter.get('/:feed_id/routes/:route_id', (c) => {
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

feedsRouter.get('/:feed_id/routes/:route_id/vehicles', async (c) => {
  const routeId = c.req.param('route_id');
  const feedId  = parseFeedId(c.req.param('feed_id'));

  if (!feedId) {
    return c.json({ error: 'feed_id must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  try {
    const result = await getVehiclesForRoute(routeId, feedId);
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message, code: 'NOT_FOUND' }, 404);
    }
    return c.json({ error: 'Feed unavailable', code: 'FEED_ERROR' }, 503, {
      'Retry-After': '30',
    });
  }
});

function inferDirection(stopId: string): string {
  if (stopId.endsWith('N')) return 'Uptown / Northbound';
  if (stopId.endsWith('S')) return 'Downtown / Southbound';
  return stopId;
}
