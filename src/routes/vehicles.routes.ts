import { Hono } from 'hono';
import { getVehiclesForRoute, NotFoundError } from '../services/realtime.service';
import { parseFeedId } from '../utils/feedParams';

export const vehiclesRouter = new Hono();

vehiclesRouter.get('/', async (c) => {
  const routeId = c.req.query('route');
  const feedRaw = c.req.query('feed');
  const feedId  = parseFeedId(feedRaw);

  if (!routeId) {
    return c.json({ error: 'route is required', code: 'INVALID_PARAM' }, 400);
  }

  if (!feedRaw) {
    return c.json({ error: 'feed is required', code: 'INVALID_PARAM' }, 400);
  }

  if (!feedId) {
    return c.json({ error: 'feed must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
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
