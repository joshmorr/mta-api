import { Hono } from 'hono';
import type { StopSummary, StopDetail } from '../types/api';
import {
  findStopsByProximity,
  findStopsByName,
  getAllStops,
  getStopById,
  getPlatformIds,
  getPlatforms,
  getParentId,
} from '../db/queries/stops';

export const stopsRouter = new Hono();

stopsRouter.get('/', (c) => {
  const q      = c.req.query('q');
  const lat    = c.req.query('lat');
  const lon    = c.req.query('lon');
  const radius = Number(c.req.query('radius') ?? 400);
  const limit  = Math.min(Number(c.req.query('limit') ?? 20), 50);

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
    rows = findStopsByProximity(latN, lonN, latDelta, lonDelta, limit);
  } else if (q) {
    rows = findStopsByName(q, limit);
  } else {
    rows = getAllStops(limit);
  }

  const stops: StopSummary[] = rows.map((s) => ({
    stop_id:   s.stop_id,
    stop_name: s.stop_name,
    lat:       s.stop_lat,
    lon:       s.stop_lon,
    platforms: getPlatformIds(s.stop_id),
  }));

  return c.json({ stops });
});

stopsRouter.get('/:stop_id', (c) => {
  const stopId = c.req.param('stop_id');

  const stop = getStopById(stopId);

  if (!stop) {
    return c.json({ error: `Stop ${stopId} not found`, code: 'NOT_FOUND' }, 404);
  }

  // If it's a platform, resolve to its parent station
  const parentId = stop.location_type === 0 ? getParentId(stopId) ?? stopId : stopId;
  const parent   = parentId !== stopId ? getStopById(parentId) ?? stop : stop;

  const platforms = getPlatforms(parent.stop_id);

  const detail: StopDetail = {
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
