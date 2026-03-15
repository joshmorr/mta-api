import { Hono } from 'hono';
import { getVehiclesForRoute, NotFoundError } from '../services/realtimeFeed';
import { parseFeedId } from './feedParams';

export const vehiclesRouter = new Hono();

vehiclesRouter.get('/:feed_id/routes/:route_id/vehicles', async (c) => {
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
