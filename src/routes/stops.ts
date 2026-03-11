import { Hono } from 'hono';
import { db } from '../db/client';
import type { StopSummary, StopDetail } from '../types/api';

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

  let rows: { stop_id: string; stop_name: string; stop_lat: number; stop_lon: number }[];

  if (lat && lon) {
    // Proximity search using bounding box approximation (1 degree ≈ 111km)
    const latN  = Number(lat);
    const lonN  = Number(lon);
    const latDelta = radius / 111_000;
    const lonDelta = radius / (111_000 * Math.cos((latN * Math.PI) / 180));
    rows = db
      .query<typeof rows[0], [number, number, number, number, number, number, number, number, number]>(
        `SELECT stop_id, stop_name, stop_lat, stop_lon
         FROM stops
         WHERE location_type = 1
           AND stop_lat BETWEEN ? AND ?
           AND stop_lon BETWEEN ? AND ?
         ORDER BY ((stop_lat - ?) * (stop_lat - ?) + (stop_lon - ?) * (stop_lon - ?))
         LIMIT ?`
      )
      .all(
        latN - latDelta, latN + latDelta,
        lonN - lonDelta, lonN + lonDelta,
        latN, latN, lonN, lonN,
        limit
      );
  } else if (q) {
    rows = db
      .query<typeof rows[0], [string, number]>(
        `SELECT stop_id, stop_name, stop_lat, stop_lon
         FROM stops
         WHERE location_type = 1
           AND stop_name LIKE ? COLLATE NOCASE
         LIMIT ?`
      )
      .all(`%${q}%`, limit);
  } else {
    rows = db
      .query<typeof rows[0], [number]>(
        `SELECT stop_id, stop_name, stop_lat, stop_lon
         FROM stops
         WHERE location_type = 1
         LIMIT ?`
      )
      .all(limit);
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

  const stop = db
    .query<{ stop_id: string; stop_name: string; stop_lat: number; stop_lon: number; location_type: number }, [string]>(
      `SELECT stop_id, stop_name, stop_lat, stop_lon, location_type FROM stops WHERE stop_id = ?`
    )
    .get(stopId);

  if (!stop) {
    return c.json({ error: `Stop ${stopId} not found`, code: 'NOT_FOUND' }, 404);
  }

  // If it's a platform, redirect to its parent
  const parentId = stop.location_type === 0 ? getParentId(stopId) ?? stopId : stopId;
  const parent = parentId !== stopId
    ? db.query<typeof stop, [string]>(`SELECT stop_id, stop_name, stop_lat, stop_lon, location_type FROM stops WHERE stop_id = ?`).get(parentId) ?? stop
    : stop;

  const platforms = db
    .query<{ stop_id: string; stop_name: string }, [string]>(
      `SELECT stop_id, stop_name FROM stops WHERE parent_station = ? AND location_type = 0`
    )
    .all(parent.stop_id);

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

function getPlatformIds(parentStopId: string): string[] {
  const rows = db
    .query<{ stop_id: string }, [string]>(
      `SELECT stop_id FROM stops WHERE parent_station = ? AND location_type = 0`
    )
    .all(parentStopId);
  return rows.map((r) => r.stop_id);
}

function getParentId(stopId: string): string | null {
  const row = db
    .query<{ parent_station: string }, [string]>(
      `SELECT parent_station FROM stops WHERE stop_id = ?`
    )
    .get(stopId);
  return row?.parent_station ?? null;
}

function inferDirection(stopId: string): string {
  if (stopId.endsWith('N')) return 'Uptown / Northbound';
  if (stopId.endsWith('S')) return 'Downtown / Southbound';
  return stopId;
}
