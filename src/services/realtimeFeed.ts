import { getFeed } from '../cache/rtCache';
import { getFeedPath } from './feedRouter';
import type { FeedMessage } from '../types/gtfs';
import type { ArrivalResponse, Arrival, VehicleResponse } from '../types/api';
import {
  getChildPlatformIds,
  getServedRouteIdsByStopIds,
  getStopNameById,
  isPlatformStop,
} from '../db/queries/realtimeFeed';

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

  const stopName = getStopNameById(stopId);

  if (!stopName) throw new NotFoundError(`Stop ${stopId} not found`);

  // Find which routes serve these stops
  const servedRoutes = getServedRouteIdsByStopIds(platformIds);

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
    stop_name: stopName,
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
  if (isPlatformStop(stopId)) return [stopId];

  // Otherwise, treat as parent station and get child platforms
  const platforms = getChildPlatformIds(stopId);

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
