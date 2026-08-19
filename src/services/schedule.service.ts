import type { FeedId } from '../types/gtfs';
import type {
  ScheduleLeg,
  ScheduleLegStop,
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
  type LegRow,
  type ScheduleRow,
  type TripStopRow,
} from '../db/queries/schedule';
import type { ServiceDateFilter } from '../db/queries/serviceCalendar';
import { findStopsById, getParentId, getStopNamesByIds, type StopRow } from '../db/queries/stops';
import {
  findTransferJourneys,
  MAX_TRANSFERS_BY_FEED,
  type Connection,
} from './transferSearch';
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
  fromStopId: string;
  feedId: FeedId;
  toStopId: string;
  /** Unix seconds. Defaults to `date`'s start-of-day, or now if `date` is also absent. */
  after?: number;
  /** YYYYMMDD. Pins the query to a single service date instead of the default 3-day window. */
  date?: string;
  limit: number;
  /** Train changes to allow. Clamped to what the feed supports; defaults to that. */
  maxTransfers?: number;
}

/**
 * A direct trip and a multi-leg journey, reduced to what ranking needs: when
 * it leaves, when it arrives, and how many changes it costs. Everything below
 * the sort works on this, so adding a second transfer later changes only how
 * candidates are *produced*.
 */
type JourneyCandidate = {
  legs: LegRow[];
  /** `connections[i]` precedes `legs[i + 1]`; empty on a direct trip. */
  connections: Connection[];
  serviceDate: string;
  departureTimestamp: number;
  /** Null only where the feed publishes no arrival_time at the destination. */
  arrivalTimestamp: number | null;
};

export function getSchedule(params: ScheduleParams, now: Date = new Date()): ScheduleResponse {
  const { fromStopId, feedId, toStopId, after, date, limit, maxTransfers } = params;
  const generatedAt = Math.floor(now.getTime() / 1000);

  const fromStop = resolveStop(fromStopId, feedId, 'Origin stop');
  const fromPlatformIds = resolvePlatformIds(fromStop.feed_id, fromStop.stop_id);

  const toStop = resolveStop(toStopId, fromStop.feed_id, 'Destination stop');
  const toPlatformIds = resolvePlatformIds(fromStop.feed_id, toStop.stop_id);

  // Clamped, not rejected: a client can send the same max_transfers to every
  // feed and get the best each one can currently answer.
  const feedCap = MAX_TRANSFERS_BY_FEED[fromStop.feed_id];
  const effectiveMaxTransfers = Math.min(maxTransfers ?? feedCap, feedCap);

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
  const candidates: JourneyCandidate[] = [];

  for (const cd of candidateDates) {
    const originUnix = getServiceDayOriginUnix(cd.date);
    // The per-date bound is only for the index seek; the absolute-timestamp
    // filter below is the correctness net.
    const afterSeconds = Math.max(0, afterUnix - originUnix);
    if (afterSeconds > MAX_DEPARTURE_SECONDS) continue;

    for (const platformId of fromPlatformIds) {
      const rows = getScheduledDepartures(fromStop.feed_id, platformId, toPlatformIds, cd, afterSeconds, limit);
      for (const row of rows) {
        candidates.push({
          legs: [scheduleRowToLeg(row)],
          connections: [],
          serviceDate: cd.date,
          departureTimestamp: originUnix + row.departure_seconds,
          arrivalTimestamp: row.dest_arrival_seconds !== null ? originUnix + row.dest_arrival_seconds : null,
        });
      }

      if (effectiveMaxTransfers < 1) continue;

      // How far into the day the transfer search has to reach. A full direct
      // page caps it: pruning never drops a direct trip, so `limit` of them
      // already sort at or before that last departure and nothing leaving
      // later could make the page anyway. A short page means this date's
      // direct trips ran out, so the search must run to the end of the
      // service day - otherwise an afternoon query would answer with direct
      // trips only, silently, exactly where a transfer is most likely to be
      // the only way through.
      const untilSeconds = rows.length === limit
        ? rows[rows.length - 1].departure_seconds
        : MAX_DEPARTURE_SECONDS;

      const journeys = findTransferJourneys({
        feedId: fromStop.feed_id,
        fromStopId: platformId,
        toStopIds: toPlatformIds,
        serviceDate: cd,
        afterSeconds,
        untilSeconds,
      });
      for (const journey of journeys) {
        const finalLeg = journey.legs[journey.legs.length - 1];
        candidates.push({
          legs: journey.legs,
          connections: journey.connections,
          serviceDate: cd.date,
          departureTimestamp: originUnix + journey.legs[0].board_departure_seconds,
          arrivalTimestamp: originUnix + finalLeg.alight_arrival_seconds,
        });
      }
    }
  }

  const page = pruneDominated(candidates.filter((c) => c.departureTimestamp >= afterUnix))
    .sort((a, b) =>
      a.departureTimestamp - b.departureTimestamp ||
      a.legs[0].trip_id.localeCompare(b.legs[0].trip_id) ||
      a.legs.length - b.legs.length)
    .slice(0, limit);

  const stopNames = getStopNamesByIds(
    fromStop.feed_id,
    [...new Set(page.flatMap((c) => c.legs.flatMap((l) => [l.board_stop_id, l.alight_stop_id])))],
  );
  const nameOf = (stopId: string) => stopNames.get(stopId)?.stop_name ?? stopId;

  const departures = page.map((c) => toScheduledDeparture(c, toStop, generatedAt, nameOf));

  const nextAfter =
    page.length === limit && departures.length > 0
      ? departures[departures.length - 1].departure_timestamp + 1
      : null;

  return {
    feed_id: fromStop.feed_id,
    from_stop_id: fromStop.stop_id,
    from_stop_name: fromStop.stop_name,
    to_stop_id: toStop.stop_id,
    to_stop_name: toStop.stop_name,
    service_dates: candidateDates.map((d) => d.date),
    generated_at: generatedAt,
    source: 'scheduled',
    max_transfers: effectiveMaxTransfers,
    departures,
    next_after: nextAfter,
  };
}

/**
 * Drops transfer journeys nothing would choose: one is removed when some other
 * candidate leaves no earlier, arrives no later, and costs no more changes.
 *
 * This, not the connection-time cap, is what keeps transfer results honest.
 * The search happily pairs a train with a later one at every stop it touches,
 * and most of those pairs mean "get off a train that was already going where
 * you are going, then wait" - a Penn->Ronkonkoma day produces 671 candidates
 * against 42 direct trips, of which 11 transfers survive here, each genuinely
 * beating the through trains.
 *
 * **Direct trips are never dropped**, even when another direct trip dominates
 * them. They are the endpoint's existing contract - a board of every departure
 * that reaches the destination - and subway and Metro-North, which search no
 * transfers at all, must come back byte-identical to before this existed.
 *
 * A candidate with no published arrival time is neither pruned nor allowed to
 * prune: with nothing to compare, dominance is undecidable rather than false.
 */
function pruneDominated(candidates: JourneyCandidate[]): JourneyCandidate[] {
  const comparable = candidates.filter((c) => c.arrivalTimestamp !== null);

  const kept = candidates.filter((candidate) => {
    if (candidate.connections.length === 0) return true;
    if (candidate.arrivalTimestamp === null) return true;

    return !comparable.some((other) =>
      other !== candidate &&
      other.departureTimestamp >= candidate.departureTimestamp &&
      other.arrivalTimestamp! <= candidate.arrivalTimestamp! &&
      other.connections.length <= candidate.connections.length &&
      (other.departureTimestamp > candidate.departureTimestamp ||
        other.arrivalTimestamp! < candidate.arrivalTimestamp! ||
        other.connections.length < candidate.connections.length));
  });

  // Journeys identical on all three ranking axes survive the filter above -
  // it only drops strictly worse ones - but they are interchangeable to a
  // rider, so keep the first of each set.
  const seen = new Set<string>();
  return kept.filter((c) => {
    if (c.connections.length === 0) return true;
    const key = `${c.departureTimestamp}|${c.arrivalTimestamp}|${c.connections.length}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Presents a direct trip's origin/destination stop_times pair in the same
 * shape the transfer search produces, so one leg builder serves both and the
 * `legs` array can never disagree with the fields beside it.
 */
function scheduleRowToLeg(row: ScheduleRow): LegRow {
  return {
    feed_id: row.feed_id,
    trip_id: row.trip_id,
    route_id: row.route_id,
    route_short_name: row.route_short_name,
    route_long_name: row.route_long_name,
    service_id: row.service_id,
    headsign: row.headsign,
    train_number: row.train_number,
    direction_id: row.direction_id,
    peak_offpeak: row.peak_offpeak,
    board_stop_id: row.stop_id,
    board_stop_sequence: row.stop_sequence,
    board_arrival_time: row.arrival_time,
    board_arrival_seconds: row.arrival_seconds,
    board_departure_time: row.departure_time,
    board_departure_seconds: row.departure_seconds,
    board_track: row.track,
    board_pickup_type: row.pickup_type,
    board_drop_off_type: row.drop_off_type,
    alight_stop_id: row.dest_stop_id,
    alight_stop_sequence: row.dest_stop_sequence,
    alight_arrival_time: row.dest_arrival_time,
    // getScheduledDepartures already filters to rows that reach the
    // destination; only the *time* can be absent, and the caller keeps the
    // nullable timestamp it computed from `dest_arrival_seconds` for that.
    alight_arrival_seconds: row.dest_arrival_seconds ?? 0,
    alight_departure_time: row.dest_departure_time,
    alight_departure_seconds: row.dest_departure_seconds,
    alight_track: row.dest_track,
    alight_pickup_type: row.dest_pickup_type,
    alight_drop_off_type: row.dest_drop_off_type,
  };
}

function toScheduledDeparture(
  candidate: JourneyCandidate,
  toStop: StopRow,
  nowUnix: number,
  nameOf: (stopId: string) => string,
): ScheduledDeparture {
  const { legs, connections, serviceDate, departureTimestamp, arrivalTimestamp } = candidate;
  const originUnix = getServiceDayOriginUnix(serviceDate);
  const first = legs[0];
  const final = legs[legs.length - 1];

  const arrivalAtOrigin = first.board_arrival_seconds !== null ? originUnix + first.board_arrival_seconds : null;
  const { route_name, route_long_name } = toRouteNames(first.route_id, first);

  const destination: ScheduledDeparture['destination'] = {
    // The canonical requested `to` stop, not the specific matched platform -
    // every departure in the response describes the same destination the
    // caller asked for.
    stop_id: toStop.stop_id,
    stop_name: toStop.stop_name,
    stop_sequence: final.alight_stop_sequence,
    arrival_time: final.alight_arrival_time,
    arrival_timestamp: arrivalTimestamp,
    duration_seconds: arrivalTimestamp !== null ? arrivalTimestamp - departureTimestamp : null,
  };

  return {
    feed_id: first.feed_id,
    trip_id: first.trip_id,
    route_id: first.route_id,
    route_name,
    route_long_name,
    service_id: first.service_id,
    service_date: serviceDate,
    stop_id: first.board_stop_id,
    stop_sequence: first.board_stop_sequence,
    arrival_time: first.board_arrival_time,
    departure_time: first.board_departure_time,
    arrival_timestamp: arrivalAtOrigin,
    departure_timestamp: departureTimestamp,
    departure_in_seconds: departureTimestamp - nowUnix,
    headsign: first.headsign,
    train_number: first.train_number,
    direction_id: normalizeDirectionId(first.direction_id),
    track: first.board_track,
    peak: normalizePeak(first.peak_offpeak),
    pickup_type: first.board_pickup_type,
    drop_off_type: first.board_drop_off_type,
    destination,
    transfers: connections.length,
    legs: legs.map((leg, i) => toScheduleLeg(leg, i, connections[i - 1] ?? null, serviceDate, originUnix, nameOf)),
  };
}

function toScheduleLeg(
  leg: LegRow,
  legIndex: number,
  connection: Connection | null,
  serviceDate: string,
  originUnix: number,
  nameOf: (stopId: string) => string,
): ScheduleLeg {
  const { route_name, route_long_name } = toRouteNames(leg.route_id, leg);

  const origin: ScheduleLegStop = {
    stop_id: leg.board_stop_id,
    stop_name: nameOf(leg.board_stop_id),
    stop_sequence: leg.board_stop_sequence,
    arrival_time: leg.board_arrival_time,
    arrival_timestamp: leg.board_arrival_seconds !== null ? originUnix + leg.board_arrival_seconds : null,
    departure_time: leg.board_departure_time,
    departure_timestamp: originUnix + leg.board_departure_seconds,
    track: leg.board_track,
    pickup_type: leg.board_pickup_type,
    drop_off_type: leg.board_drop_off_type,
  };

  const destination: ScheduleLegStop = {
    stop_id: leg.alight_stop_id,
    stop_name: nameOf(leg.alight_stop_id),
    stop_sequence: leg.alight_stop_sequence,
    arrival_time: leg.alight_arrival_time,
    arrival_timestamp: leg.alight_arrival_time !== null ? originUnix + leg.alight_arrival_seconds : null,
    departure_time: leg.alight_departure_time,
    departure_timestamp:
      leg.alight_departure_seconds !== null ? originUnix + leg.alight_departure_seconds : null,
    track: leg.alight_track,
    pickup_type: leg.alight_pickup_type,
    drop_off_type: leg.alight_drop_off_type,
  };

  return {
    leg_index: legIndex,
    feed_id: leg.feed_id,
    trip_id: leg.trip_id,
    route_id: leg.route_id,
    route_name,
    route_long_name,
    service_id: leg.service_id,
    service_date: serviceDate,
    direction_id: normalizeDirectionId(leg.direction_id),
    headsign: leg.headsign,
    train_number: leg.train_number,
    peak: normalizePeak(leg.peak_offpeak),
    origin,
    destination,
    duration_seconds:
      destination.arrival_timestamp !== null
        ? destination.arrival_timestamp - origin.departure_timestamp!
        : null,
    transfer: connection && {
      stop_id: connection.stopId,
      stop_name: nameOf(connection.stopId),
      arrival_timestamp: originUnix + connection.arrivalSeconds,
      departure_timestamp: originUnix + connection.departureSeconds,
      connection_seconds: connection.connectionSeconds,
      min_transfer_time: connection.minTransferTime,
      guaranteed: connection.guaranteed,
    },
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
        'trip_id - the two ID schemes are unrelated for this feed',
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
      throw new NotFoundError(`Trip ${tripId} not found in the ${feedId} feed`);
    }
  }

  const stopRows = getTripStops(feedId, resolvedTripId);
  if (!stopRows.length) {
    throw new NotFoundError(`Trip ${resolvedTripId} has no scheduled stops`);
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
