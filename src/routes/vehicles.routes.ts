import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getVehiclesForRoute, NotFoundError } from '../services/realtime.service';
import { parseFeedId } from '../utils/feedParams';
import { VehicleListResponseSchema, ErrorSchema } from '../schemas/api';

export const vehiclesRouter = new OpenAPIHono();

const getVehiclesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Vehicles'],
  summary: 'Get active vehicles for a route',
  description: 'Returns current vehicle positions for all active trips on a route from the GTFS-RT feed.',
  request: {
    query: z.object({
      route: z.string().openapi({ description: 'Route ID', example: 'A' }),
      feed: z.enum(['subway', 'lirr', 'mnr']).openapi({ description: 'Feed the route belongs to' }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: VehicleListResponseSchema } }, description: 'Active vehicles' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid parameters' },
    404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Route not found' },
    503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Feed unavailable' },
  },
});

vehiclesRouter.openapi(getVehiclesRoute, async (c) => {
  const routeId = c.req.query('route');
  const feedRaw = c.req.query('feed');
  const feedId  = parseFeedId(feedRaw);

  if (!routeId) {
    return c.json({ error: 'route is required', code: 'INVALID_PARAM' }, 400 as const);
  }

  if (!feedRaw) {
    return c.json({ error: 'feed is required', code: 'INVALID_PARAM' }, 400 as const);
  }

  if (!feedId) {
    return c.json({ error: 'feed must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400 as const);
  }

  try {
    const result = await getVehiclesForRoute(routeId, feedId);
    return c.json(result, 200 as const);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message, code: 'NOT_FOUND' }, 404 as const);
    }
    return c.json({ error: 'Feed unavailable', code: 'FEED_ERROR' }, 503 as const);
  }
});
