import { Hono } from 'hono';
import { getArrivalsForStop, NotFoundError } from '../services/realtimeFeed';
import { parseFeedId } from './feedParams';

export const arrivalsRouter = new Hono();

arrivalsRouter.get('/:feed_id/stops/:stop_id/arrivals', async (c) => {
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
