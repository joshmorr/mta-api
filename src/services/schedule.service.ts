import type { FeedId } from '../types/gtfs';
import type {
  ScheduleResponse,
  ScheduledDeparture,
  TripScheduleResponse,
  TripStop,
} from '../types/api';
import {
  getScheduledDepartures,
  getTripMeta,
  getTripStops,
  findSubwayTripIdsBySuffix,
  isTripActiveOnDate,
  type ScheduleRow,
  type TripStopRow,
} from '../db/queries/schedule';
import type { ServiceDateFilter } from '../db/queries/serviceCalendar';
import { findStopsById, getParentId, type StopRow } from '../db/queries/stops';
import { isPlatformStop, getChildPlatformIds } from '../db/queries/realtimeFeed';
import {
  getServiceDayOriginUnix,
  getScheduleServiceDates,
  weekdayColumnForDate,
} from '../utils/serviceDate';
import { toRouteNames } from './routes.service';
import { NotFoundError } from './realtime.service';

// The upper bound stop_times.departure_seconds realistically reaches (a
// generous margin over the observed max of ~27h for overnight service).
// A per-date `afterSeconds` bound past this means that date genuinely has
// nothing left to offer, so it's skipped rather than queried.
const MAX_DEPARTURE_SECONDS = 30 * 3600;

/**
 * Resolves a platform ID up to its parent station (subway only) so the
 * response always describes the station-level stop, mirroring
 * `getStopDetail`. LIRR and MNR stops are flat and returned as-is.
 *
 * A private duplicate of `realtime.service.ts`'s identically-shaped
 * `resolveStop` — not shared, to avoid a service-to-service import cycle
 * (this file already needs `NotFoundError` from that module, and it must
 * not need this one back).
 */
function resolveStop(stopId: string, feedId: FeedId, label = 'Stop'): StopRow {
  const matches = findStopsById(stopId, feedId);
  if (!matches.length) {
    throw new NotFoundError(`${label} ${stopId} not found`);
  }

  const stop = matches[0];
  if (stop.feed_id !== 'subway') return stop;
  if (stop.location_type !== 0) return stop;

  const parentId = getParentId(stop.feed_id, stop.stop_id);
  if (!parentId) return stop;

  return findStopsById(parentId, stop.feed_id)[0] ?? stop;
}

/**
 * Expands a (possibly parent) stop ID to the platform ID set stop_times
 * actually reference. `to` needs this exactly like `from` does — a bare
 * subway parent ID matches zero stop_times rows, since both realtime and
 * static data key on platforms.
 */
function resolvePlatformIds(feedId: FeedId, stopId: string): string[] {
  if (feedId !== 'subway') return [stopId];
  if (isPlatformStop(feedId, stopId)) return [stopId];

  const platforms = getChildPlatformIds(feedId, stopId);
  return platforms.length > 0 ? platforms : [stopId];
}

export interface ScheduleParams {
  stopId: string;
  feedId: FeedId;
  toStopId?: string;
  /** Unix seconds. Defaults to `date`'s start-of-day, or now if `date` is also absent. */
  after?: number;
  /** YYYYMMDD. Pins the query to a single service date instead of the default 3-day window. */
  date?: string;
  limit: number;
}

export function getSchedule(params: ScheduleParams, now: Date = new Date()): ScheduleResponse {
  const { stopId, feedId, toStopId, after, date, limit } = params;
  const generatedAt = Math.floor(now.getTime() / 1000);

  const stop = resolveStop(stopId, feedId);
  const fromPlatformIds = resolvePlatformIds(stop.feed_id, stop.stop_id);

  const toStop = toStopId ? resolveStop(toStopId, stop.feed_id, 'Destination stop') : null;
  const toPlatformIds = toStop ? resolvePlatformIds(stop.feed_id, toStop.stop_id) : null;

  const candidateDates: ServiceDateFilter[] = date
    ? [{ date, weekdayColumn: weekdayColumnForDate(date) }]
    : getScheduleServiceDates(after !== undefined ? new Date(after * 1000) : now);

  const afterUnix = after ?? (date ? getServiceDayOriginUnix(date) : generatedAt);

  // Run one query per (candidate service date × origin platform) and merge
  // in JS - do not OR the dates together, and do not query platforms as a
  // single IN-list. Two service dates' same nominal departure_seconds are
  // two different real instants, and a merged row carries no marker of
  // which date matched it (timestamp, sort order, and `after` comparison
  // would all be indeterminate). Platforms are a SQLite-specific version of
  // the same problem: getScheduledDepartures's ORDER BY can only skip
  // sorting every match and push LIMIT into the index when the scan is a
  // single stop_id equality - see its docstring for the measured cost of
  // getting this wrong at a busy interchange (~20ms vs ~0.1ms). Both
  // dimensions are small (at most 3 dates, at most 2 subway platforms), so
  // up to 6 fast queries beats one slow one.
  type Candidate = { row: ScheduleRow; serviceDate: string; departureTimestamp: number };
  const candidates: Candidate[] = [];

  for (const cd of candidateDates) {
    const originUnix = getServiceDayOriginUnix(cd.date);
    // The per-date bound is only for the index seek; the absolute-timestamp
    // filter below is the correctness net.
    const afterSeconds = Math.max(0, afterUnix - originUnix);
    if (afterSeconds > MAX_DEPARTURE_SECONDS) continue;

    for (const platformId of fromPlatformIds) {
      const rows = getScheduledDepartures(stop.feed_id, platformId, toPlatformIds, cd, afterSeconds, limit);
      for (const row of rows) {
        candidates.push({ row, serviceDate: cd.date, departureTimestamp: originUnix + row.departure_seconds });
      }
    }
  }

  const page = candidates
    .filter((c) => c.departureTimestamp >= afterUnix)
    .sort((a, b) => a.departureTimestamp - b.departureTimestamp || a.row.trip_id.localeCompare(b.row.trip_id))
    .slice(0, limit);

  const departures = page.map((c) =>
    toScheduledDeparture(c.row, c.serviceDate, c.departureTimestamp, toStop, generatedAt),
  );

  const nextAfter =
    page.length === limit && departures.length > 0
      ? departures[departures.length - 1].departure_timestamp + 1
      : null;

  return {
    feed_id: stop.feed_id,
    stop_id: stop.stop_id,
    stop_name: stop.stop_name,
    to_stop_id: toStop?.stop_id ?? null,
    to_stop_name: toStop?.stop_name ?? null,
    service_dates: candidateDates.map((d) => d.date),
    generated_at: generatedAt,
    source: 'scheduled',
    departures,
    next_after: nextAfter,
  };
}

function toScheduledDeparture(
  row: ScheduleRow,
  serviceDate: string,
  departureTimestamp: number,
  toStop: StopRow | null,
  nowUnix: number,
): ScheduledDeparture {
  const originUnix = getServiceDayOriginUnix(serviceDate);
  const arrivalTimestamp = row.arrival_seconds !== null ? originUnix + row.arrival_seconds : null;
  const { route_name, route_long_name } = toRouteNames(row.route_id, row);

  let destination: ScheduledDeparture['destination'];
  if (toStop && row.dest_stop_id !== null) {
    const destArrivalTimestamp = row.dest_arrival_seconds !== null ? originUnix + row.dest_arrival_seconds : null;
    destination = {
      // The canonical requested `to` stop, not the specific matched
      // platform - every departure in a `to`-filtered response describes
      // the same destination the caller asked for.
      stop_id: toStop.stop_id,
      stop_name: toStop.stop_name,
      stop_sequence: row.dest_stop_sequence!,
      arrival_time: row.dest_arrival_time,
      arrival_timestamp: destArrivalTimestamp,
      duration_seconds: destArrivalTimestamp !== null ? destArrivalTimestamp - departureTimestamp : null,
    };
  }

  return {
    feed_id: row.feed_id,
    trip_id: row.trip_id,
    route_id: row.route_id,
    route_name,
    route_long_name,
    service_id: row.service_id,
    service_date: serviceDate,
    stop_id: row.stop_id,
    stop_sequence: row.stop_sequence,
    arrival_time: row.arrival_time,
    departure_time: row.departure_time,
    arrival_timestamp: arrivalTimestamp,
    departure_timestamp: departureTimestamp,
    departure_in_seconds: departureTimestamp - nowUnix,
    headsign: row.headsign,
    train_number: row.train_number,
    direction_id: normalizeDirectionId(row.direction_id),
    track: row.track,
    peak: normalizePeak(row.peak_offpeak),
    pickup_type: row.pickup_type,
    drop_off_type: row.drop_off_type,
    ...(destination ? { destination } : {}),
  };
}

export interface TripScheduleParams {
  tripId: string;
  feedId: FeedId;
  /** YYYYMMDD. Defaults to the first candidate date the trip's service is active on. */
  date?: string;
}

/**
 * Resolves an `/arrivals`-sourced trip ID to its full static schedule.
 *
 * LIRR trip IDs match exactly or not at all. Subway RT trip IDs are
 * frequently a *suffix* of the static trip_id, so a failed exact match
 * falls back to one `LIKE '%'||suffix` scan narrowed by the active-service
 * predicate. MNR's realtime and static trip ID schemes are unrelated, so
 * there is no fallback for it - a clear message is the best available
 * outcome, repeated in the MCP tool description so an agent stops retrying.
 */
export function getTripSchedule(params: TripScheduleParams, now: Date = new Date()): TripScheduleResponse {
  const { tripId, feedId, date } = params;

  let resolvedTripId = tripId;
  let matchedBy: TripScheduleResponse['matched_by'] = 'exact';
  let meta = getTripMeta(feedId, tripId);

  if (!meta) {
    if (feedId === 'mnr') {
      throw new NotFoundError(
        `Trip ${tripId} not found. Metro-North's realtime trip IDs can't be resolved to a static ` +
        'trip_id - the two ID schemes are unrelated for this feed.',
      );
    }

    if (feedId === 'subway') {
      const candidateDates = date
        ? [{ date, weekdayColumn: weekdayColumnForDate(date) }]
        : getScheduleServiceDates(now);
      const matches = findSubwayTripIdsBySuffix(tripId, candidateDates);
      if (matches.length) {
        resolvedTripId = matches[0];
        matchedBy = 'rt_trip_id_suffix';
        meta = getTripMeta(feedId, resolvedTripId);
      }
    }

    if (!meta) {
      throw new NotFoundError(`Trip ${tripId} not found in the ${feedId} feed.`);
    }
  }

  const stopRows = getTripStops(feedId, resolvedTripId);
  if (!stopRows.length) {
    throw new NotFoundError(`Trip ${resolvedTripId} has no scheduled stops.`);
  }

  const serviceDate = resolveServiceDate(feedId, resolvedTripId, date, now);
  const originUnix = serviceDate !== null ? getServiceDayOriginUnix(serviceDate) : null;
  const stops: TripStop[] = stopRows.map((s) => toTripStop(s, originUnix));

  const { route_name, route_long_name } = toRouteNames(meta.route_id, meta);

  return {
    feed_id: feedId,
    trip_id: tripId,
    resolved_trip_id: resolvedTripId,
    matched_by: matchedBy,
    route_id: meta.route_id,
    route_name,
    route_long_name,
    service_id: meta.service_id,
    service_date: serviceDate,
    direction_id: normalizeDirectionId(meta.direction_id),
    headsign: meta.headsign,
    train_number: meta.train_number,
    peak: normalizePeak(meta.peak_offpeak),
    source: 'scheduled',
    origin: stops[0],
    destination: stops[stops.length - 1],
    stops,
  };
}

/**
 * An explicit `date` is used as given - the caller asked for this trip on
 * this date, active or not. Otherwise, the first of [yesterday, today,
 * tomorrow] the trip's service is actually active on; `null` (raw times,
 * no timestamps) if none of the three are.
 */
function resolveServiceDate(feedId: FeedId, tripId: string, date: string | undefined, now: Date): string | null {
  if (date) return date;

  for (const cd of getScheduleServiceDates(now)) {
    if (isTripActiveOnDate(feedId, tripId, cd)) return cd.date;
  }
  return null;
}

function toTripStop(row: TripStopRow, originUnix: number | null): TripStop {
  return {
    stop_id: row.stop_id,
    stop_name: row.stop_name,
    parent_station_id: row.parent_station_id,
    stop_sequence: row.stop_sequence,
    arrival_time: row.arrival_time,
    departure_time: row.departure_time,
    arrival_timestamp: originUnix !== null && row.arrival_seconds !== null ? originUnix + row.arrival_seconds : null,
    departure_timestamp:
      originUnix !== null && row.departure_seconds !== null ? originUnix + row.departure_seconds : null,
    track: row.track,
    pickup_type: row.pickup_type,
    drop_off_type: row.drop_off_type,
  };
}

function normalizeDirectionId(value: number | null): 0 | 1 | null {
  return value === 0 || value === 1 ? value : null;
}

function normalizePeak(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}
