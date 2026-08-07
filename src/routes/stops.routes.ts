import { createRoute, z } from '@hono/zod-openapi';
import { searchStops, getStopDetail } from '../services/stops.service';
import { createApiRouter } from '../utils/openapi';
import {
  StopListResponseSchema,
  StopDetailSchema,
  ErrorSchema,
} from '../schemas/api';

export const stopsRouter = createApiRouter();

const listStopsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Stops'],
  operationId: 'listStops',
  summary: 'List or search stops',
  description: 'Returns stops filtered by name, proximity, or feed. Provide `lat`+`lon` for proximity search, `q` for name search, or neither for all stops.',
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: 'Search stops by name' }),
      lat: z.coerce.number({ message: 'must be a number' }).optional().openapi({ description: 'Latitude for proximity search', example: 40.7484 }),
      lon: z.coerce.number({ message: 'must be a number' }).optional().openapi({ description: 'Longitude for proximity search', example: -73.9967 }),
      feed: z.enum(['subway', 'lirr', 'mnr']).optional().openapi({ description: 'Filter by feed' }),
      radius: z.coerce.number({ message: 'must be a number' }).positive({ message: 'must be greater than 0' }).max(1600, { message: 'must be <= 1600' }).default(400).openapi({ description: 'Search radius in meters (max 1600, default 400)', example: 400 }),
      limit: z.coerce.number({ message: 'must be a number' }).int().positive({ message: 'must be greater than 0' }).default(20).transform((n) => Math.min(n, 50)).openapi({ description: 'Max results (clamped to 50, default 20)', example: 20 }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: StopListResponseSchema } }, description: 'List of stops' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid parameters' },
  },
});

stopsRouter.openapi(listStopsRoute, (c) => {
  const { q, lat, lon, feed, radius, limit } = c.req.valid('query');
  const stops = searchStops({ q, lat, lon, feed, radius, limit });
  return c.json({ stops }, 200 as const);
});

const getStopRoute = createRoute({
  method: 'get',
  path: '/:stop_id',
  tags: ['Stops'],
  operationId: 'getStop',
  summary: 'Get stop by ID',
  description: 'Returns full details for a stop including platform directions. For subway stops, resolves to the parent station.',
  request: {
    params: z.object({
      stop_id: z.string().openapi({ description: 'Stop ID', example: '127' }),
    }),
    query: z.object({
      feed: z.enum(['subway', 'lirr', 'mnr']).openapi({ description: 'Feed the stop belongs to' }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: StopDetailSchema } }, description: 'Stop detail' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid parameters' },
    404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Stop not found' },
  },
});

stopsRouter.openapi(getStopRoute, (c) => {
  const { stop_id: stopId } = c.req.valid('param');
  const { feed: feedId } = c.req.valid('query');

  const stop = getStopDetail(stopId, feedId);

  if (!stop) {
    return c.json({ error: `Stop ${stopId} not found`, code: 'NOT_FOUND' }, 404 as const);
  }

  return c.json(stop, 200 as const);
});
