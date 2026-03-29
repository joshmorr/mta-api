import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
  findStopsByProximity,
  findStopsByName,
  getAllStops,
  getPlatformIds,
  getStopById,
  getPlatforms,
  getParentId,
} from '../db/queries/stops';
import { parseFeedId } from '../utils/feedParams';
import {
  StopListResponseSchema,
  StopDetailSchema,
  ErrorSchema,
} from '../schemas/api';

export const stopsRouter = new OpenAPIHono();

const listStopsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Stops'],
  summary: 'List or search stops',
  description: 'Returns stops filtered by name, proximity, or feed. Provide `lat`+`lon` for proximity search, `q` for name search, or neither for all stops.',
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: 'Search stops by name' }),
      lat: z.string().optional().openapi({ description: 'Latitude for proximity search', example: '40.7484' }),
      lon: z.string().optional().openapi({ description: 'Longitude for proximity search', example: '-73.9967' }),
      feed: z.enum(['subway', 'lirr', 'mnr']).optional().openapi({ description: 'Filter by feed' }),
      radius: z.string().optional().openapi({ description: 'Search radius in meters (max 1600, default 400)', example: '400' }),
      limit: z.string().optional().openapi({ description: 'Max results (max 50, default 20)', example: '20' }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: StopListResponseSchema } }, description: 'List of stops' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid parameters' },
  },
});

stopsRouter.openapi(listStopsRoute, (c) => {
  const q      = c.req.query('q');
  const lat    = c.req.query('lat');
  const lon    = c.req.query('lon');
  const feedId = parseFeedId(c.req.query('feed'));
  const radius = Number(c.req.query('radius') ?? 400);
  const limit  = Math.min(Number(c.req.query('limit') ?? 20), 50);

  if (c.req.query('feed') && !feedId) {
    return c.json({ error: 'feed must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400 as const);
  }

  if (radius > 1600) {
    return c.json({ error: 'radius must be <= 1600', code: 'INVALID_PARAM' }, 400 as const);
  }

  let rows;

  if (lat && lon) {
    const latN     = Number(lat);
    const lonN     = Number(lon);
    const latDelta = radius / 111_000;
    const lonDelta = radius / (111_000 * Math.cos((latN * Math.PI) / 180));
    rows = findStopsByProximity(latN, lonN, latDelta, lonDelta, limit, feedId);
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
  const stopId  = c.req.param('stop_id');
  const feedRaw = c.req.query('feed');
  const feedId  = parseFeedId(feedRaw);

  if (!feedRaw) {
    return c.json({ error: 'feed is required', code: 'INVALID_PARAM' }, 400 as const);
  }

  if (!feedId) {
    return c.json({ error: 'feed must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400 as const);
  }

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
