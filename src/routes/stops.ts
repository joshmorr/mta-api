import { Hono } from 'hono';
import type { StopSummary, StopDetail } from '../types/api';
import {
  findStopsByProximity,
  findStopsByName,
  getAllStops,
  findStopsById,
  getStopById,
  getPlatformIds,
  getPlatforms,
  getParentId,
} from '../db/queries/stops';
import type { FeedId } from '../types/gtfs';

export const stopsRouter = new Hono();

function parseFeedId(value: string | undefined): FeedId | undefined {
  if (!value) return undefined;
  if (value === 'subway' || value === 'lirr' || value === 'mnr') return value;
  return undefined;
}

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

stopsRouter.get('/:stop_id', (c) => {
  const stopId = c.req.param('stop_id');
  const feedId = parseFeedId(c.req.query('feed_id'));

  if (c.req.query('feed_id') && !feedId) {
    return c.json({ error: 'feed_id must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  const matches = findStopsById(stopId, feedId);

  if (matches.length > 1) {
    return c.json({ error: `Stop ${stopId} exists in multiple feeds; provide feed_id`, code: 'AMBIGUOUS_ID', feeds: matches.map((match) => match.feed_id) }, 409);
  }

  const stop = matches[0] ? getStopById(matches[0].stop_id, matches[0].feed_id) : null;

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
    platforms: platforms.map((p) => ({
      stop_id:   p.stop_id,
      direction: inferDirection(p.stop_id),
    })),
  };

  return c.json(detail);
});

function inferDirection(stopId: string): string {
  if (stopId.endsWith('N')) return 'Uptown / Northbound';
  if (stopId.endsWith('S')) return 'Downtown / Southbound';
  return stopId;
}
