import { Hono } from 'hono';
import { AmbiguousEntityError, getVehiclesForRoute, NotFoundError } from '../services/realtimeFeed';
import type { FeedId } from '../types/gtfs';

export const vehiclesRouter = new Hono();

function parseFeedId(value: string | undefined): FeedId | undefined {
  if (!value) return undefined;
  if (value === 'subway' || value === 'lirr' || value === 'mnr') return value;
  return undefined;
}

vehiclesRouter.get('/:route_id/vehicles', async (c) => {
  const routeId = c.req.param('route_id');
  const feedId  = parseFeedId(c.req.query('feed_id'));

  if (c.req.query('feed_id') && !feedId) {
    return c.json({ error: 'feed_id must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  try {
    const result = await getVehiclesForRoute(routeId, feedId);
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message, code: 'NOT_FOUND' }, 404);
    }
    if (err instanceof AmbiguousEntityError) {
      return c.json({ error: err.message, code: 'AMBIGUOUS_ID', feeds: err.feedIds }, 409);
    }
    return c.json({ error: 'Feed unavailable', code: 'FEED_ERROR' }, 503, {
      'Retry-After': '30',
    });
  }
});
