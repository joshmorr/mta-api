import { Hono } from 'hono';
import { getArrivalsForStop, NotFoundError } from '../services/realtime.service';
import { parseFeedId } from '../utils/feedParams';

export const arrivalsRouter = new Hono();

arrivalsRouter.get('/', async (c) => {
  const stopId      = c.req.query('stop');
  const feedRaw     = c.req.query('feed');
  const feedId      = parseFeedId(feedRaw);
  const limit       = Math.min(Number(c.req.query('limit') ?? 5), 50);
  const routesParam = c.req.query('routes');
  const routeFilter = routesParam
    ? routesParam.split(',').map((r) => r.trim()).filter(Boolean)
    : undefined;

  if (!stopId) {
    return c.json({ error: 'stop is required', code: 'INVALID_PARAM' }, 400);
  }

  if (!feedRaw) {
    return c.json({ error: 'feed is required', code: 'INVALID_PARAM' }, 400);
  }

  if (!feedId) {
    return c.json({ error: 'feed must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
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
