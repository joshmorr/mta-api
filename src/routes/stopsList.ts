import { Hono } from 'hono';
import type { StopSummary } from '../types/api';
import {
  findStopsByProximity,
  findStopsByName,
  getAllStops,
  getPlatformIds,
} from '../db/queries/stops';
import { parseFeedId } from './feedParams';

export const stopsRouter = new Hono();

stopsRouter.get('/', (c) => {
  const q      = c.req.query('q');
  const lat    = c.req.query('lat');
  const lon    = c.req.query('lon');
  const feedId = parseFeedId(c.req.query('feed_id'));
  const radius = Number(c.req.query('radius') ?? 400);
  const limit  = Math.min(Number(c.req.query('limit') ?? 20), 50);

  if (c.req.query('feed_id') && !feedId) {
    return c.json({ error: 'feed_id must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
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
