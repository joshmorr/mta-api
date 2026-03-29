import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getArrivalsForStop, NotFoundError } from '../services/realtime.service';
import { parseFeedId } from '../utils/feedParams';
import { ArrivalResponseSchema, ErrorSchema } from '../schemas/api';

export const arrivalsRouter = new OpenAPIHono();

const getArrivalsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Arrivals'],
  summary: 'Get arrivals for a stop',
  description: 'Returns upcoming train arrivals at a stop from the GTFS-RT feed.',
  request: {
    query: z.object({
      stop: z.string().openapi({ description: 'Stop ID', example: '127N' }),
      feed: z.enum(['subway', 'lirr', 'mnr']).openapi({ description: 'Feed the stop belongs to' }),
      limit: z.string().optional().openapi({ description: 'Max arrivals to return (max 50, default 5)', example: '5' }),
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
  const stopId      = c.req.query('stop');
  const feedRaw     = c.req.query('feed');
  const feedId      = parseFeedId(feedRaw);
  const limit       = Math.min(Number(c.req.query('limit') ?? 5), 50);
  const routesParam = c.req.query('routes');
  const routeFilter = routesParam
    ? routesParam.split(',').map((r) => r.trim()).filter(Boolean)
    : undefined;

  if (!stopId) {
    return c.json({ error: 'stop is required', code: 'INVALID_PARAM' }, 400 as const);
  }

  if (!feedRaw) {
    return c.json({ error: 'feed is required', code: 'INVALID_PARAM' }, 400 as const);
  }

  if (!feedId) {
    return c.json({ error: 'feed must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400 as const);
  }

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
