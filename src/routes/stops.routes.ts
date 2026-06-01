import { createRoute, z } from '@hono/zod-openapi';
import {
  findStopsByProximity,
  findStopsByName,
  getAllStops,
  getPlatformIds,
  getStopById,
  getPlatforms,
  getParentId,
} from '../db/queries/stops';
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
  const { q, lat, lon, feed: feedId, radius, limit } = c.req.valid('query');

  let rows;

  if (lat !== undefined && lon !== undefined) {
    const latDelta = radius / 111_000;
    const lonDelta = radius / (111_000 * Math.cos((lat * Math.PI) / 180));
    rows = findStopsByProximity(lat, lon, latDelta, lonDelta, limit, feedId);
  } else if (q) {
    rows = findStopsByName(q, limit, feedId);
  } else {
    rows = getAllStops(limit, feedId);
  }

  const stops = rows.map((s) => ({
    feed_id:   s.feed_id as 'subway' | 'lirr' | 'mnr',
    stop_id:   s.stop_id,
    stop_name: s.stop_name,
    lat:       s.stop_lat,
    lon:       s.stop_lon,
    platforms: s.feed_id === 'subway' ? getPlatformIds(s.feed_id, s.stop_id) : [],
  }));

  return c.json({ stops }, 200 as const);
});

const getStopRoute = createRoute({
  method: 'get',
  path: '/:stop_id',
  tags: ['Stops'],
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

  const stop = getStopById(stopId, feedId);

  if (!stop) {
    return c.json({ error: `Stop ${stopId} not found`, code: 'NOT_FOUND' }, 404 as const);
  }

  const parentId = stop.feed_id === 'subway' && stop.location_type === 0
    ? getParentId(stop.feed_id, stopId) ?? stopId
    : stopId;
  const parent = parentId !== stopId
    ? getStopById(parentId, stop.feed_id) ?? stop
    : stop;

  const platforms = parent.feed_id === 'subway' ? getPlatforms(parent.feed_id, parent.stop_id) : [];

  return c.json({
    feed_id:   parent.feed_id as 'subway' | 'lirr' | 'mnr',
    stop_id:   parent.stop_id,
    stop_name: parent.stop_name,
    lat:       parent.stop_lat,
    lon:       parent.stop_lon,
    platforms: platforms.map((platform) => ({
      stop_id:   platform.stop_id,
      direction: inferDirection(platform.stop_id),
    })),
  }, 200 as const);
});

function inferDirection(stopId: string): string {
  if (stopId.endsWith('N')) return 'Uptown / Northbound';
  if (stopId.endsWith('S')) return 'Downtown / Southbound';
  return stopId;
}
