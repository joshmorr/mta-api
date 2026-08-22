import { getFeed } from '../cache/rtCache';
import { getFeedPath } from './feed.service';
import type { FeedId, FeedMessage, VehiclePosition } from '../types/gtfs';
import type { ArrivalResponse, Arrival, VehicleResponse } from '../types/api';
import {
  getChildPlatformIds,
  getServedRouteIdsByStopIds,
  getStopNameById,
  isPlatformStop,
} from '../db/queries/realtimeFeed';
import { findRoutesById, getRoutesByIds } from '../db/queries/routes';
import { toRouteNames } from './routes.service';
import { findStopsById, getParentId, getStopNamesByIds } from '../db/queries/stops';
import { nonEmpty, railroadStopTime, toNumber } from '../utils/realtime';
import { getRelevantServiceDates } from '../utils/serviceDate';
import { log } from '../utils/logger';

// VehicleStopStatus is a proto enum; protobufjs decodes it as an int.
// Map back to the string union our API contract returns.
const VEHICLE_STOP_STATUS: Record<number, NonNullable<Arrival['status']>> = {
  0: 'INCOMING_AT',
  1: 'STOPPED_AT',
  2: 'IN_TRANSIT_TO',
};

function toStopStatus(raw: unknown): NonNullable<Arrival['status']> {
  if (typeof raw === 'string') return raw as NonNullable<Arrival['status']>;
  if (typeof raw === 'number' && raw in VEHICLE_STOP_STATUS) return VEHICLE_STOP_STATUS[raw];
  return 'IN_TRANSIT_TO';
}

// current_status defaults to IN_TRANSIT_TO in proto2, so protobufjs can't
// distinguish "published as in-transit" from "not published at all" unless
// we check own-property presence before decoding. Raw wire counts of
// entities that actually publish it: MNR 44/227, subway ACE 38/76, LIRR
// 60/60 - treating the default as data fabricates status for the rest.
function presenceStatus(vehicle: VehiclePosition | undefined): Arrival['status'] {
  if (!vehicle || !Object.prototype.hasOwnProperty.call(vehicle, 'currentStatus')) return null;
  return toStopStatus(vehicle.currentStatus);
}

// VehicleDescriptor.label defaults to '' when absent in proto2, same
// ambiguity as currentStatus - presence-check it too.
function presenceTrainNumber(vehicle: VehiclePosition | undefined): string | null {
  if (!vehicle?.vehicle || !Object.prototype.hasOwnProperty.call(vehicle.vehicle, 'label')) return null;
  return vehicle.vehicle.label ?? null;
}

// StopTimeEvent.delay defaults to 0 when absent in proto2, indistinguishable
// from a genuine on-time (0s) delay without a presence check.
function presenceDelay(event: { delay?: number } | undefined): number | null {
  if (!event || !Object.prototype.hasOwnProperty.call(event, 'delay')) return null;
  return event.delay ?? null;
}

/**
 * The vehicle for a trip update's entity. MNR carries tripUpdate and vehicle
 * together on the SAME entity (226/226), and its vehicle.trip.tripId never
 * matches the tripUpdate's trip id, so a same-entity check must run before
 * the cross-entity map (LIRR is the opposite: 0 shared entities, 121
 * trip-only / 60 vehicle-only, so it needs the map).
 */
function resolveVehicle(
  entity: FeedMessage['entity'][number],
  tripId: string,
  vehicleByTripId: Map<string, VehiclePosition>,
): VehiclePosition | undefined {
  return entity.vehicle ?? vehicleByTripId.get(tripId);
}

/**
 * The route a vehicle is running, which only the subway states directly.
 *
 * `VehiclePosition.trip.routeId` is set on every subway vehicle (67/67) and on
 * no LIRR or MNR vehicle at all (0/64, 0/91) - on those feeds only the
 * TripUpdate descriptor names the route, so filtering vehicles by the
 * VehiclePosition's own routeId matches nothing and the route looks idle.
 *
 * Which TripUpdate to read differs by feed, the same split `resolveVehicle`
 * handles from the other side: MNR packs both payloads onto one entity and its
 * two trip IDs disagree, so only the same entity resolves it (91/91 same-entity
 * vs 0/91 cross-entity), while LIRR splits them across entities and joins by
 * trip ID (64/64). All three steps together resolve every vehicle on all three
 * feeds.
 */
function resolveVehicleRouteId(
  entity: FeedMessage['entity'][number],
  routeByTripId: Map<string, string>,
): string | undefined {
  const own = entity.vehicle?.trip?.routeId;
  if (own) return own;

  const sameEntity = entity.tripUpdate?.trip?.routeId;
  if (sameEntity) return sameEntity;

  const tripId = entity.vehicle?.trip?.tripId;
  return tripId ? routeByTripId.get(tripId) : undefined;
}

/** Subway platform IDs encode direction as an `N`/`S` suffix on the parent ID. */
function directionFromPlatformId(stopId: string): 'NORTH' | 'SOUTH' | null {
  if (stopId.endsWith('N')) return 'NORTH';
  if (stopId.endsWith('S')) return 'SOUTH';
  return null;
}

export async function getArrivalsForStop(
  stopId: string,
  limit: number,
  feedId: FeedId,
  routeFilter?: string[],
  directionFilter?: 'NORTH' | 'SOUTH',
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
  // Route names are attached after the window is chosen, so the collection
  // phase carries only what the realtime feed itself provides.
  const matched: CollectedArrival[] = [];
  let overallStale = false;
  let overallFeedError: string | undefined;

  for (const feedPath of Array.from(feedPaths)) {
    let feedMessage: FeedMessage;
    let stale: boolean;
    let feed_error: string | undefined;

    try {
      ({ feedMessage, stale, feed_error } = await getFeed(feedPath));
    } catch (err) {
      // One feed of several can fail while the request still succeeds on the
      // rest, so this never surfaces as a 503 — it would otherwise be silent.
      log.warn({ err, feedPath, stop: stopId }, 'feed fetch failed, skipping');
      overallStale = true;
      overallFeedError = err instanceof Error ? err.message : 'Feed unavailable';
      continue;
    }

    if (stale) {
      overallStale = true;
      overallFeedError = feed_error;
    }

    // Index vehicle positions by trip id once per feed message so the inner
    // arrivals loop is O(1) per lookup instead of rescanning all entities.
    // This covers LIRR/subway, where the vehicle lives on a *different*
    // entity than the trip update (0 shared entities for LIRR: 121
    // trip-only, 60 vehicle-only).
    const vehicleByTripId = new Map<string, VehiclePosition>();
    for (const entity of feedMessage.entity) {
      const tripId = entity.vehicle?.trip?.tripId;
      if (tripId) vehicleByTripId.set(tripId, entity.vehicle as VehiclePosition);
    }

    for (const entity of feedMessage.entity) {
      if (!entity.tripUpdate) continue;
      const { trip, stopTimeUpdate } = entity.tripUpdate;

      // A TripUpdate's descriptor always names its route on all three feeds
      // (115/115 LIRR, 91/91 MNR, 67/67 subway) - it is only VehiclePosition
      // descriptors that leave routeId unset, so this fallback is unreachable.
      const tripRouteId = trip.routeId ?? '';

      if (routeFilter && !routeFilter.includes(tripRouteId)) continue;

      // Computed once per entity, not per matched stop time update.
      const vehicle = resolveVehicle(entity, trip.tripId, vehicleByTripId);
      const status = presenceStatus(vehicle);
      const trainNumber = presenceTrainNumber(vehicle);
      // The LAST stop time update is the true terminus in all three feeds,
      // with no truncation - ACE carries up to 40 updates resolving to only
      // 9 distinct real terminals.
      const destinationRawStopId = stopTimeUpdate[stopTimeUpdate.length - 1]?.stopId ?? null;

      // LIRR direction_id is branch-relative, not compass - a "Penn
      // Station" trip with direction_id=1 means inbound, not south.
      // own-property-guarded: optional uint32 defaults to 0 in proto2.
      let directionId: 0 | 1 | null = null;
      if (stop.feed_id === 'lirr' && Object.prototype.hasOwnProperty.call(trip, 'directionId')) {
        if (trip.directionId === 0 || trip.directionId === 1) directionId = trip.directionId;
      }

      for (const stu of stopTimeUpdate) {
        if (!platformIds.includes(stu.stopId)) continue;

        const refRaw = stu.arrival?.time ?? stu.departure?.time;
        if (!refRaw) continue;
        const refTime = toNumber(refRaw);
        if (refTime <= now) continue;

        const arrivalTime = stu.arrival ? toNumber(stu.arrival.time) : null;
        const departureTime = stu.departure ? toNumber(stu.departure.time) : null;
        const delaySeconds = presenceDelay(stu.arrival) ?? presenceDelay(stu.departure);

        // MTA Railroad extension, LIRR/MNR only. Both are proto2 optional
        // strings that the railroads publish as '' when they have nothing, so
        // nonEmpty is the presence test rather than hasOwnProperty.
        const railroad = railroadStopTime(stu);
        const track = nonEmpty(railroad?.track);
        const trainStatus = nonEmpty(railroad?.trainStatus);

        // Subway direction is the matched platform suffix, full stop - free,
        // 100% coverage, no proto2-default ambiguity. Deliberately not the
        // NYCT direction enum (absent on 46% of updates and indistinguishable
        // from NORTH when absent).
        const direction = stop.feed_id === 'subway' ? directionFromPlatformId(stu.stopId) : null;
        if (directionFilter && direction !== directionFilter) continue;
        const directionSource: Arrival['direction_source'] =
          direction !== null ? 'stop_suffix' : directionId !== null ? 'rt_direction_id' : null;

        matched.push({
          feed_id: stop.feed_id,
          route_id: tripRouteId,
          trip_id: trip.tripId,
          arrival_time: arrivalTime,
          arrival_in_seconds: arrivalTime !== null ? arrivalTime - now : null,
          departure_time: departureTime,
          departure_in_seconds: departureTime !== null ? departureTime - now : null,
          delay_seconds: delaySeconds,
          destination_raw_stop_id: destinationRawStopId,
          direction,
          direction_id: directionId,
          direction_source: directionSource,
          train_number: trainNumber,
          track,
          train_status: trainStatus,
          status,
          source: 'realtime',
        });
      }
    }
  }

  matched.sort((a, b) => (a.arrival_time ?? a.departure_time ?? 0) - (b.arrival_time ?? b.departure_time ?? 0));

  return {
    feed_id: stop.feed_id,
    stop_id: stopId,
    stop_name: stopName,
    generated_at: now,
    stale: overallStale,
    ...(overallFeedError ? { feed_error: overallFeedError } : {}),
    arrivals: withRouteNames(stop.feed_id, withDestinationNames(stop.feed_id, matched.slice(0, limit))),
  };
}

// Collected before route/destination names are resolved: carries the raw
// terminus stop id so it can be batch-resolved once, mirroring route
// resolution below.
type CollectedArrival = Omit<Arrival, 'route_name' | 'route_long_name' | 'destination_stop_id' | 'destination'> & {
  destination_raw_stop_id: string | null;
};

type RawArrival = Omit<Arrival, 'route_name' | 'route_long_name'>;

/**
 * Resolve destination names in one batched query over the distinct termini,
 * mirroring `withRouteNames`. Subway platform ids (e.g. `A02N`) resolve to
 * their parent station so the name is the station, not the platform.
 */
function withDestinationNames(feedId: FeedId, arrivals: CollectedArrival[]): RawArrival[] {
  const distinctIds = Array.from(
    new Set(arrivals.map((a) => a.destination_raw_stop_id).filter((id): id is string => id !== null)),
  );
  const namesById = getStopNamesByIds(feedId, distinctIds);

  return arrivals.map(({ destination_raw_stop_id, ...rest }) => {
    const resolved = destination_raw_stop_id ? namesById.get(destination_raw_stop_id) : undefined;
    return {
      ...rest,
      destination_stop_id: resolved?.stop_id ?? destination_raw_stop_id,
      destination: resolved?.stop_name ?? null,
    };
  });
}

/**
 * Resolve every distinct route in one query, then label each arrival.
 *
 * `route_id` alone is unusable as a display label: on LIRR and Metro-North it
 * is an opaque number, so an unlabelled feed leaves a client rendering
 * "Route 4" where a rider expects "Ronkonkoma Branch".
 */
function withRouteNames(feedId: FeedId, arrivals: RawArrival[]): Arrival[] {
  const distinctIds = Array.from(new Set(arrivals.map((a) => a.route_id)));
  const rowById = new Map(
    getRoutesByIds(feedId, distinctIds).map((row) => [row.route_id, row]),
  );

  return arrivals.map(({ feed_id, route_id, ...rest }) => ({
    feed_id,
    route_id,
    ...toRouteNames(route_id, rowById.get(route_id)),
    ...rest,
  }));
}

export async function getVehiclesForRoute(routeId: string, feedId: FeedId): Promise<{
  feed_id: FeedId;
  route_id: string;
  route_name: string;
  route_long_name: string;
  generated_at: number;
  vehicles: VehicleResponse[];
}> {
  const route = resolveRoute(routeId, feedId);
  const feedPath = getFeedPath(route.feed_id, route.route_id);
  if (!feedPath) throw new NotFoundError(`No feed for route ${routeId}`);

  const { feedMessage } = await getFeed(feedPath);
  const now = Math.floor(Date.now() / 1000);
  const vehicles: VehicleResponse[] = [];

  // Coordinates are only reliable on LIRR (always published). Subway never
  // publishes them, and MNR only publishes them for a minority of vehicles
  // at any given moment - not worth exposing a mostly-null field for it.
  const hasCoords = route.feed_id === 'lirr';

  // LIRR names the route only on its TripUpdate entities; see resolveVehicleRouteId.
  const routeByTripId = new Map<string, string>();
  for (const entity of feedMessage.entity) {
    const trip = entity.tripUpdate?.trip;
    if (trip?.tripId && trip.routeId) routeByTripId.set(trip.tripId, trip.routeId);
  }

  for (const entity of feedMessage.entity) {
    if (!entity.vehicle) continue;
    const v = entity.vehicle;
    if (resolveVehicleRouteId(entity, routeByTripId) !== route.route_id) continue;

    vehicles.push({
      feed_id: route.feed_id,
      trip_id: v.trip.tripId,
      current_stop_id: v.stopId ?? '',
      status: toStopStatus(v.currentStatus),
      timestamp: toNumber(v.timestamp),
      latitude: hasCoords ? v.position?.latitude ?? null : null,
      longitude: hasCoords ? v.position?.longitude ?? null : null,
    });
  }

  return {
    feed_id: route.feed_id,
    route_id: route.route_id,
    // `route` is the static row resolveRoute already fetched — no extra query.
    ...toRouteNames(route.route_id, route),
    generated_at: now,
    vehicles,
  };
}

function resolvePlatformIds(feedId: FeedId, stopId: string): string[] {
  if (feedId !== 'subway') return [stopId];

  if (isPlatformStop(feedId, stopId)) return [stopId];

  const platforms = getChildPlatformIds(feedId, stopId);

  if (platforms.length > 0) return platforms;

  return [stopId];
}

function resolveStop(stopId: string, feedId: FeedId) {
  const matches = findStopsById(stopId, feedId);
  if (!matches.length) {
    throw new NotFoundError(`Stop ${stopId} not found`);
  }

  const stop = matches[0];
  if (stop.feed_id !== 'subway') return stop;
  if (stop.location_type !== 0) return stop;

  const parentId = getParentId(stop.feed_id, stop.stop_id);
  if (!parentId) return stop;

  return findStopsById(parentId, stop.feed_id)[0] ?? stop;
}

function resolveRoute(routeId: string, feedId: FeedId) {
  const matches = findRoutesById(routeId, feedId);
  if (!matches.length) {
    throw new NotFoundError(`Route ${routeId} not found`);
  }
  return matches[0];
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
