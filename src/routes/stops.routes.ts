import { Hono } from 'hono';
import type { StopSummary, StopDetail } from '../types/api';
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

export const stopsRouter = new Hono();

stopsRouter.get('/', (c) => {
  const q      = c.req.query('q');
  const lat    = c.req.query('lat');
  const lon    = c.req.query('lon');
  const feedId = parseFeedId(c.req.query('feed'));
  const radius = Number(c.req.query('radius') ?? 400);
  const limit  = Math.min(Number(c.req.query('limit') ?? 20), 50);

  if (c.req.query('feed') && !feedId) {
    return c.json({ error: 'feed must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  if (radius > 1600) {
    return c.json({ error: 'radius must be <= 1600', code: 'INVALID_PARAM' }, 400);
  }

  let rows;

  if (lat && lon) {
    // Proximity search using bounding box approximation (1 degree ≈ 111km)
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

  const stops: StopSummary[] = rows.map((s) => ({
    feed_id:   s.feed_id,
    stop_id:   s.stop_id,
    stop_name: s.stop_name,
    lat:       s.stop_lat,
    lon:       s.stop_lon,
    platforms: s.feed_id === 'subway' ? getPlatformIds(s.feed_id, s.stop_id) : [],
  }));

  return c.json({ stops });
});

stopsRouter.get('/:stop_id', (c) => {
  const stopId  = c.req.param('stop_id');
  const feedRaw = c.req.query('feed');
  const feedId  = parseFeedId(feedRaw);

  if (!feedRaw) {
    return c.json({ error: 'feed is required', code: 'INVALID_PARAM' }, 400);
  }

  if (!feedId) {
    return c.json({ error: 'feed must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  const stop = getStopById(stopId, feedId);

  if (!stop) {
    return c.json({ error: `Stop ${stopId} not found`, code: 'NOT_FOUND' }, 404);
  }

  const parentId = stop.feed_id === 'subway' && stop.location_type === 0
    ? getParentId(stop.feed_id, stopId) ?? stopId
    : stopId;
  const parent = parentId !== stopId
    ? getStopById(parentId, stop.feed_id) ?? stop
    : stop;

  const platforms = parent.feed_id === 'subway' ? getPlatforms(parent.feed_id, parent.stop_id) : [];

  const detail: StopDetail = {
    feed_id:   parent.feed_id,
    stop_id:   parent.stop_id,
    stop_name: parent.stop_name,
    lat:       parent.stop_lat,
    lon:       parent.stop_lon,
    platforms: platforms.map((platform) => ({
      stop_id:   platform.stop_id,
      direction: inferDirection(platform.stop_id),
    })),
  };

  return c.json(detail);
});

function inferDirection(stopId: string): string {
  if (stopId.endsWith('N')) return 'Uptown / Northbound';
  if (stopId.endsWith('S')) return 'Downtown / Southbound';
  return stopId;
}
