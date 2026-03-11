import { getFeed } from '../cache/rtCache';
import { getFeedPath } from './feedRouter';
import type { FeedMessage, VehiclePosition } from '../types/gtfs';
import type { ArrivalResponse, Arrival, VehicleResponse } from '../types/api';
import { db } from '../db/client';

function toNumber(val: number | { toNumber(): number } | undefined): number {
  if (val === undefined) return 0;
  if (typeof val === 'object') return val.toNumber();
  return val;
}

export async function getArrivalsForStop(
  stopId: string,
  limit: number,
  routeFilter?: string[]
): Promise<ArrivalResponse> {
  // Resolve platform IDs (handles both parent station and platform IDs)
  const platformIds = resolvePlatformIds(stopId);

  const stopRow = db
    .query<{ stop_name: string }, string>(
      `SELECT stop_name FROM stops WHERE stop_id = ?`
    )
    .get(stopId);

  if (!stopRow) throw new NotFoundError(`Stop ${stopId} not found`);

  // Find which routes serve these stops
  const placeholders = platformIds.map(() => '?').join(',');
  const servedRoutes = db
    .query<{ route_id: string }, string[]>(
      `SELECT DISTINCT t.route_id
       FROM stop_times st
       JOIN trips t ON t.trip_id = st.trip_id
       WHERE st.stop_id IN (${placeholders})`
    )
    .all(...platformIds)
    .map((r) => r.route_id);

  const routesToQuery = routeFilter
    ? servedRoutes.filter((r) => routeFilter.includes(r))
    : servedRoutes;

  // Deduplicate feed paths
  const feedPaths = new Set(
    routesToQuery.map(getFeedPath).filter((p): p is string => !!p)
  );

  const now = Math.floor(Date.now() / 1000);
  const arrivals: Arrival[] = [];
  let overallStale = false;
  let overallFeedError: string | undefined;

  for (const feedPath of Array.from(feedPaths)) {
    let feedMessage: FeedMessage;
    let stale: boolean;
    let feed_error: string | undefined;

    try {
      ({ feedMessage, stale, feed_error } = await getFeed(feedPath));
    } catch (err) {
      overallStale = true;
      overallFeedError = err instanceof Error ? err.message : 'Feed unavailable';
      continue;
    }

    if (stale) {
      overallStale = true;
      overallFeedError = feed_error;
    }

    for (const entity of feedMessage.entity) {
      if (!entity.tripUpdate) continue;
      const { trip, stopTimeUpdate } = entity.tripUpdate;

      if (routeFilter && !routeFilter.includes(trip.routeId)) continue;

      for (const stu of stopTimeUpdate) {
        if (!platformIds.includes(stu.stopId)) continue;
        if (!stu.arrival) continue;

        const arrivalTime = toNumber(stu.arrival.time);
        if (arrivalTime <= now) continue;

        // Find vehicle status for this trip
        const vehicleEntity = feedMessage.entity.find(
          (e) => e.vehicle?.trip?.tripId === trip.tripId
        );
        const status =
          (vehicleEntity?.vehicle?.currentStatus as Arrival['status']) ??
          'IN_TRANSIT_TO';

        arrivals.push({
          route_id: trip.routeId,
          trip_id: trip.tripId,
          arrival_time: arrivalTime,
          arrival_in_seconds: arrivalTime - now,
          status,
        });
      }
    }
  }

  arrivals.sort((a, b) => a.arrival_time - b.arrival_time);

  return {
    stop_id: stopId,
    stop_name: stopRow.stop_name,
    generated_at: now,
    stale: overallStale,
    ...(overallFeedError ? { feed_error: overallFeedError } : {}),
    arrivals: arrivals.slice(0, limit),
  };
}

export async function getVehiclesForRoute(routeId: string): Promise<{
  route_id: string;
  generated_at: number;
  vehicles: VehicleResponse[];
}> {
  const feedPath = getFeedPath(routeId);
  if (!feedPath) throw new NotFoundError(`No feed for route ${routeId}`);

  const { feedMessage } = await getFeed(feedPath);
  const now = Math.floor(Date.now() / 1000);
  const vehicles: VehicleResponse[] = [];

  for (const entity of feedMessage.entity) {
    if (!entity.vehicle) continue;
    const v = entity.vehicle;
    if (v.trip?.routeId !== routeId) continue;

    vehicles.push({
      trip_id: v.trip.tripId,
      current_stop_id: v.stopId ?? '',
      status: (v.currentStatus as VehicleResponse['status']) ?? 'IN_TRANSIT_TO',
      timestamp: toNumber(v.timestamp),
    });
  }

  return { route_id: routeId, generated_at: now, vehicles };
}

function resolvePlatformIds(stopId: string): string[] {
  // If it's already a directional stop (ends in N/S or similar), return as-is
  const directional = db
    .query<{ stop_id: string }, string>(
      `SELECT stop_id FROM stops WHERE stop_id = ? AND location_type = 0`
    )
    .get(stopId);

  if (directional) return [stopId];

  // Otherwise, treat as parent station and get child platforms
  const platforms = db
    .query<{ stop_id: string }, string>(
      `SELECT stop_id FROM stops WHERE parent_station = ? AND location_type = 0`
    )
    .all(stopId)
    .map((r) => r.stop_id);

  if (platforms.length > 0) return platforms;

  // Fallback: the stop_id itself (maybe schema has no parent_station column yet)
  return [stopId];
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
