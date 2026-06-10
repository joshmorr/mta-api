import { createRoute, z } from '@hono/zod-openapi';
import { getArrivalsForStop, NotFoundError } from '../services/realtime.service';
import { createApiRouter } from '../utils/openapi';
import { ArrivalResponseSchema, ErrorSchema } from '../schemas/api';

export const arrivalsRouter = createApiRouter();

const getArrivalsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Arrivals'],
  operationId: 'getArrivals',
  summary: 'Get arrivals for a stop',
  description: 'Returns upcoming train arrivals at a stop from the GTFS-RT feed.',
  request: {
    query: z.object({
      stop: z.string().openapi({ description: 'Stop ID', example: '127N' }),
      feed: z.enum(['subway', 'lirr', 'mnr']).openapi({ description: 'Feed the stop belongs to' }),
      limit: z.coerce.number({ message: 'must be a number' }).int().positive({ message: 'must be greater than 0' }).default(5).transform((n) => Math.min(n, 50)).openapi({ description: 'Max arrivals to return (clamped to 50, default 5)', example: 5 }),
      routes: z.string().optional().openapi({ description: 'Comma-separated route IDs to filter by', example: 'A,C,E' }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: ArrivalResponseSchema } }, description: 'Upcoming arrivals' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid parameters' },
    404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Stop not found' },
    503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Feed unavailable' },
  },
});

arrivalsRouter.openapi(getArrivalsRoute, async (c) => {
  const { stop: stopId, feed: feedId, limit, routes: routesParam } = c.req.valid('query');
  const routeFilter = routesParam
    ? routesParam.split(',').map((r) => r.trim()).filter(Boolean)
    : undefined;

  try {
    const result = await getArrivalsForStop(stopId, limit, feedId, routeFilter);
    return c.json(result, 200 as const);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message, code: 'NOT_FOUND' }, 404 as const);
    }
    return c.json({ error: 'Feed unavailable', code: 'FEED_ERROR' }, 503 as const);
  }
});
