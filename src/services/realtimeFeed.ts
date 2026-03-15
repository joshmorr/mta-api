import { getFeed } from '../cache/rtCache';
import { getFeedPath } from './feedRouter';
import type { FeedId, FeedMessage } from '../types/gtfs';
import type { ArrivalResponse, Arrival, VehicleResponse } from '../types/api';
import {
  getChildPlatformIds,
  getServedRouteIdsByStopIds,
  type ServiceDateFilter,
  type WeekdayColumn,
  getStopNameById,
  isPlatformStop,
} from '../db/queries/realtimeFeed';
import { findRoutesById } from '../db/queries/routes';
import { findStopsById, getParentId } from '../db/queries/stops';

function toNumber(val: number | { toNumber(): number } | undefined): number {
  if (val === undefined) return 0;
  if (typeof val === 'object') return val.toNumber();
  return val;
}

export async function getArrivalsForStop(
  stopId: string,
  limit: number,
  feedId?: FeedId,
  routeFilter?: string[]
): Promise<ArrivalResponse> {
  const stop = resolveStop(stopId, feedId);
  const platformIds = resolvePlatformIds(stop.feed_id, stop.stop_id);

  const stopName = getStopNameById(stop.feed_id, stop.stop_id);

  if (!stopName) throw new NotFoundError(`Stop ${stopId} not found`);

  // Find which routes serve these stops
  const servedRoutes = getServedRouteIdsByStopIds(
    stop.feed_id,
    platformIds,
    getRelevantServiceDates(),
  );

  const routesToQuery = routeFilter
    ? servedRoutes.filter((r) => routeFilter.includes(r))
    : servedRoutes;

  // Deduplicate feed paths
  const feedPaths = new Set(
    routesToQuery
      .map((routeId) => getFeedPath(stop.feed_id, routeId))
      .filter((p): p is string => !!p)
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
          feed_id: stop.feed_id,
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
    feed_id: stop.feed_id,
    stop_id: stopId,
    stop_name: stopName,
    generated_at: now,
    stale: overallStale,
    ...(overallFeedError ? { feed_error: overallFeedError } : {}),
    arrivals: arrivals.slice(0, limit),
  };
}

export async function getVehiclesForRoute(routeId: string): Promise<{
  feed_id: FeedId;
  route_id: string;
  generated_at: number;
  vehicles: VehicleResponse[];
}>;

export async function getVehiclesForRoute(routeId: string, feedId?: FeedId): Promise<{
  feed_id: FeedId;
  route_id: string;
  generated_at: number;
  vehicles: VehicleResponse[];
}> {
  const route = resolveRoute(routeId, feedId);
  const feedPath = getFeedPath(route.feed_id, route.route_id);
  if (!feedPath) throw new NotFoundError(`No feed for route ${routeId}`);

  const { feedMessage } = await getFeed(feedPath);
  const now = Math.floor(Date.now() / 1000);
  const vehicles: VehicleResponse[] = [];

  for (const entity of feedMessage.entity) {
    if (!entity.vehicle) continue;
    const v = entity.vehicle;
    if (v.trip?.routeId !== route.route_id) continue;

    vehicles.push({
      feed_id: route.feed_id,
      trip_id: v.trip.tripId,
      current_stop_id: v.stopId ?? '',
      status: (v.currentStatus as VehicleResponse['status']) ?? 'IN_TRANSIT_TO',
      timestamp: toNumber(v.timestamp),
    });
  }

  return { feed_id: route.feed_id, route_id: route.route_id, generated_at: now, vehicles };
}

function resolvePlatformIds(feedId: FeedId, stopId: string): string[] {
  if (feedId !== 'subway') return [stopId];

  if (isPlatformStop(feedId, stopId)) return [stopId];

  const platforms = getChildPlatformIds(feedId, stopId);

  if (platforms.length > 0) return platforms;

  return [stopId];
}

function resolveStop(stopId: string, feedId?: FeedId) {
  const matches = findStopsById(stopId, feedId);
  if (!matches.length) {
    throw new NotFoundError(`Stop ${stopId} not found`);
  }
  if (matches.length > 1) {
    throw new AmbiguousEntityError(`Stop ${stopId} exists in multiple feeds`, matches.map((match) => match.feed_id));
  }

  const stop = matches[0];
  if (stop.feed_id !== 'subway') return stop;
  if (stop.location_type !== 0) return stop;

  const parentId = getParentId(stop.feed_id, stop.stop_id);
  if (!parentId) return stop;

  return findStopsById(parentId, stop.feed_id)[0] ?? stop;
}

function resolveRoute(routeId: string, feedId?: FeedId) {
  const matches = findRoutesById(routeId, feedId);
  if (!matches.length) {
    throw new NotFoundError(`Route ${routeId} not found`);
  }
  if (matches.length > 1) {
    throw new AmbiguousEntityError(`Route ${routeId} exists in multiple feeds`, matches.map((match) => match.feed_id));
  }
  return matches[0];
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class AmbiguousEntityError extends Error {
  feedIds: FeedId[];

  constructor(message: string, feedIds: FeedId[]) {
    super(message);
    this.name = 'AmbiguousEntityError';
    this.feedIds = feedIds;
  }
}

function getRelevantServiceDates(now: Date = new Date()): ServiceDateFilter[] {
  const current = getNyDateParts(now);
  const serviceDates: ServiceDateFilter[] = [
    {
      date: current.date,
      weekdayColumn: current.weekdayColumn,
    },
  ];

  // GTFS service days often extend past midnight via 24+ hour stop_times.
  if (current.hour < 5) {
    const previous = getNyDateParts(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    if (previous.date !== current.date) {
      serviceDates.push({
        date: previous.date,
        weekdayColumn: previous.weekdayColumn,
      });
    }
  }

  return serviceDates;
}

function getNyDateParts(date: Date): {
  date: string;
  weekdayColumn: WeekdayColumn;
  hour: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(date);

  const year = getDatePart(parts, 'year');
  const month = getDatePart(parts, 'month');
  const day = getDatePart(parts, 'day');
  const hour = Number(getDatePart(parts, 'hour'));
  const weekday = getDatePart(parts, 'weekday').toLowerCase() as WeekdayColumn;

  return {
    date: `${year}${month}${day}`,
    weekdayColumn: weekday,
    hour,
  };
}

function getDatePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const part = parts.find((entry) => entry.type === type);
  if (!part) {
    throw new Error(`Missing date part: ${type}`);
  }
  return part.value;
}
