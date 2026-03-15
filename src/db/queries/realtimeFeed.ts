import { db } from '../client';

export function getStopNameById(stopId: string): string | null {
  const row = db
    .query<{ stop_name: string }, [string]>(
      `SELECT stop_name FROM stops WHERE stop_id = ?`
    )
    .get(stopId);

  return row?.stop_name ?? null;
}

export function getServedRouteIdsByStopIds(stopIds: string[]): string[] {
  if (!stopIds.length) return [];

  const placeholders = stopIds.map(() => '?').join(',');
  const rows = db
    .query<{ route_id: string }, string[]>(
      `SELECT DISTINCT t.route_id
       FROM stop_times st
       JOIN trips t ON t.trip_id = st.trip_id
       WHERE st.stop_id IN (${placeholders})`
    )
    .all(...stopIds);

  return rows.map((r) => r.route_id);
}

export function isPlatformStop(stopId: string): boolean {
  const row = db
    .query<{ stop_id: string }, [string]>(
      `SELECT stop_id FROM stops WHERE stop_id = ? AND location_type = 0`
    )
    .get(stopId);

  return !!row;
}

export function getChildPlatformIds(parentStopId: string): string[] {
  const rows = db
    .query<{ stop_id: string }, [string]>(
      `SELECT stop_id FROM stops WHERE parent_station = ? AND location_type = 0`
    )
    .all(parentStopId);

  return rows.map((r) => r.stop_id);
}