import { db } from '../client';

type StopRow = { stop_id: string; stop_name: string; stop_lat: number; stop_lon: number };
type StopDetailRow = StopRow & { location_type: number };

export function findStopsByProximity(
  lat: number,
  lon: number,
  latDelta: number,
  lonDelta: number,
  limit: number,
): StopRow[] {
  return db
    .query<StopRow, [number, number, number, number, number, number, number, number, number]>(
      `SELECT stop_id, stop_name, stop_lat, stop_lon
       FROM stops
       WHERE location_type = 1
         AND stop_lat BETWEEN ? AND ?
         AND stop_lon BETWEEN ? AND ?
       ORDER BY ((stop_lat - ?) * (stop_lat - ?) + (stop_lon - ?) * (stop_lon - ?))
       LIMIT ?`,
    )
    .all(lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta, lat, lat, lon, lon, limit);
}

export function findStopsByName(q: string, limit: number): StopRow[] {
  return db
    .query<StopRow, [string, number]>(
      `SELECT stop_id, stop_name, stop_lat, stop_lon
       FROM stops
       WHERE location_type = 1
         AND stop_name LIKE ? COLLATE NOCASE
       LIMIT ?`,
    )
    .all(`%${q}%`, limit);
}

export function getAllStops(limit: number): StopRow[] {
  return db
    .query<StopRow, [number]>(
      `SELECT stop_id, stop_name, stop_lat, stop_lon
       FROM stops
       WHERE location_type = 1
       LIMIT ?`,
    )
    .all(limit);
}

export function getStopById(stopId: string): StopDetailRow | null {
  return db
    .query<StopDetailRow, [string]>(
      `SELECT stop_id, stop_name, stop_lat, stop_lon, location_type FROM stops WHERE stop_id = ?`,
    )
    .get(stopId);
}

export function getPlatformIds(parentStopId: string): string[] {
  const rows = db
    .query<{ stop_id: string }, [string]>(
      `SELECT stop_id FROM stops WHERE parent_station = ? AND location_type = 0`,
    )
    .all(parentStopId);
  return rows.map((r) => r.stop_id);
}

export function getPlatforms(parentStopId: string): { stop_id: string; stop_name: string }[] {
  return db
    .query<{ stop_id: string; stop_name: string }, [string]>(
      `SELECT stop_id, stop_name FROM stops WHERE parent_station = ? AND location_type = 0`,
    )
    .all(parentStopId);
}

export function getParentId(stopId: string): string | null {
  const row = db
    .query<{ parent_station: string }, [string]>(
      `SELECT parent_station FROM stops WHERE stop_id = ?`,
    )
    .get(stopId);
  return row?.parent_station ?? null;
}
