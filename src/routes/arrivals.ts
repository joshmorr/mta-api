import { Hono } from 'hono';
import { AmbiguousEntityError, getArrivalsForStop, NotFoundError } from '../services/realtimeFeed';
import type { FeedId } from '../types/gtfs';

export const arrivalsRouter = new Hono();

function parseFeedId(value: string | undefined): FeedId | undefined {
  if (!value) return undefined;
  if (value === 'subway' || value === 'lirr' || value === 'mnr') return value;
  return undefined;
}

arrivalsRouter.get('/:stop_id/arrivals', async (c) => {
  const stopId      = c.req.param('stop_id');
  const feedId      = parseFeedId(c.req.query('feed_id'));
  const limit       = Math.min(Number(c.req.query('limit') ?? 5), 50);
  const routesParam = c.req.query('routes');
  const routeFilter = routesParam
    ? routesParam.split(',').map((r) => r.trim()).filter(Boolean)
    : undefined;

  if (c.req.query('feed_id') && !feedId) {
    return c.json({ error: 'feed_id must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  try {
    const result = await getArrivalsForStop(stopId, limit, feedId, routeFilter);
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
