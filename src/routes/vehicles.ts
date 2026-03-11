import { Hono } from 'hono';
import { getVehiclesForRoute, NotFoundError } from '../services/realtimeFeed';

export const vehiclesRouter = new Hono();

vehiclesRouter.get('/:route_id/vehicles', async (c) => {
  const routeId = c.req.param('route_id');

  try {
    const result = await getVehiclesForRoute(routeId);
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
