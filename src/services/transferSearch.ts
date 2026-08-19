import type { FeedId } from '../types/gtfs';
import { getOutboundLegs, getInboundLegs, type LegRow } from '../db/queries/schedule';
import { getGuaranteedTransferTripPairs, getSameStopMinTransferTimes } from '../db/queries/transfers';
import type { ServiceDateFilter } from '../db/queries/serviceCalendar';

/**
 * Stops that are never a transfer point for a journey within a single feed.
 *
 * LIRR's city terminals are where the railroad *ends*, so reaching one and
 * boarding again means riding into Manhattan or Brooklyn and back out - never
 * a sensible LIRR-only itinerary, however well the times line up. They are
 * real interchanges, but to the subway and Metro-North, and inter-feed
 * journeys are not supported yet. Woodside and Jamaica are the actual
 * junctions and carry essentially every result once these are removed.
 *
 * Feeds absent from this map exclude nothing.
 */
export const EXCLUDED_TRANSFER_STOP_IDS: Partial<Record<FeedId, readonly string[]>> = {
  lirr: [
    '237', // Penn Station
    '349', // Grand Central
    '241', // Atlantic Terminal
    '90',  // Hunterspoint Avenue
    '118', // Long Island City
  ],
};

/**
 * How many transfers each feed's journey search will consider. Subway and MNR
 * stay at 0 pending the multi-transfer work; a request asking for more than
 * its feed supports is clamped rather than rejected, so a client can ask for
 * the same thing everywhere and get the best each feed can currently answer.
 */
export const MAX_TRANSFERS_BY_FEED: Record<FeedId, number> = {
  subway: 0,
  lirr: 1,
  mnr: 0,
};

/** The largest cap any feed supports - the request validator's upper bound. */
export const MAX_SUPPORTED_TRANSFERS = Math.max(...Object.values(MAX_TRANSFERS_BY_FEED));

/**
 * Applied where the feed publishes no minimum of its own. Deliberately short:
 * it is a floor against pairing a train with one departing the same instant,
 * not an estimate of how long a particular platform change takes.
 */
const DEFAULT_MIN_CONNECTION_SECONDS = 180;

/**
 * The longest wait the search will treat as a connection.
 *
 * This bounds the search; it is *not* the noise control - the caller's
 * dominance filter is, and it is far better at it (a Saturday
 * Huntington->Far Rockaway query grows from 19 to 42 raw candidates when this
 * moves 30m->60m, but from 18 to 19 shown results). Set from measured
 * coverage across three service days: 60m reaches 99.6% of the LIRR station
 * pairs that have no direct service and covers waits out to the p99 (66m) of
 * journeys that survive pruning, where 30m drops 6% of those pairs outright
 * on weekends - on sparse branches a 40-minute wait at Woodside is genuinely
 * the only way to make the trip at that hour.
 */
const MAX_CONNECTION_SECONDS = 60 * 60;

export type TransferJourney = {
  legs: LegRow[];
  /** Parallel to `legs`; `connections[i]` precedes `legs[i + 1]`. */
  connections: Connection[];
};

export type Connection = {
  stopId: string;
  arrivalSeconds: number;
  departureSeconds: number;
  connectionSeconds: number;
  minTransferTime: number | null;
  guaranteed: boolean;
};

export interface TransferSearchParams {
  feedId: FeedId;
  fromStopId: string;
  toStopIds: string[];
  serviceDate: ServiceDateFilter;
  afterSeconds: number;
  /** Inclusive upper bound on the first leg's departure; see `getOutboundLegs`. */
  untilSeconds: number;
}

/**
 * Every 1-transfer journey from `fromStopId` to `toStopIds` on one service
 * date, at most one per first-leg trip (the one arriving earliest).
 *
 * Two queries, then an in-memory join. Doing it the other way - a query per
 * candidate transfer point - would mean hundreds of round trips, and a single
 * four-way self-join of `stop_times` is worse still: SQLite has no bound on
 * the second leg's departure there, so it pairs every downstream stop with
 * every later departure for the rest of the day (measured 2.2s, against 5ms
 * for the shape below).
 *
 * Both legs are drawn from the same service date. A connection that straddles
 * midnight into the *next* service date is therefore not found - acceptable
 * because GTFS service days already run past midnight (LIRR to 25:21), so the
 * only losses are waits that would also have to clear MAX_CONNECTION_SECONDS
 * at the very end of the operating day.
 */
export function findTransferJourneys(params: TransferSearchParams): TransferJourney[] {
  const { feedId, fromStopId, toStopIds, serviceDate, afterSeconds, untilSeconds } = params;

  const minTransferTimes = getSameStopMinTransferTimes(feedId);
  const excluded = [
    ...(EXCLUDED_TRANSFER_STOP_IDS[feedId] ?? []),
    fromStopId,
    ...toStopIds,
  ];

  const outbound = getOutboundLegs(feedId, fromStopId, excluded, serviceDate, afterSeconds, untilSeconds);
  if (!outbound.length) return [];

  // The earliest instant any second leg could possibly depart. Uses the
  // smallest minimum in play so the bound can never cut off a connection at a
  // stop whose own rule is looser than the default.
  const smallestMinimum = Math.min(DEFAULT_MIN_CONNECTION_SECONDS, ...minTransferTimes.values());
  const inbound = getInboundLegs(feedId, toStopIds, excluded, serviceDate, afterSeconds + smallestMinimum);
  if (!inbound.length) return [];

  // getInboundLegs already orders by (stop_id, departure_seconds), so each
  // bucket comes out sorted without a second pass.
  const byBoardingStop = new Map<string, LegRow[]>();
  for (const leg of inbound) {
    const bucket = byBoardingStop.get(leg.board_stop_id);
    if (bucket) bucket.push(leg);
    else byBoardingStop.set(leg.board_stop_id, [leg]);
  }

  const guaranteedPairs = getGuaranteedTransferTripPairs(feedId);
  const bestByFirstLeg = new Map<string, TransferJourney>();

  for (const first of outbound) {
    const candidates = byBoardingStop.get(first.alight_stop_id);
    if (!candidates) continue;

    const minimum = minTransferTimes.get(first.alight_stop_id) ?? DEFAULT_MIN_CONNECTION_SECONDS;

    let best: LegRow | null = null;
    for (const second of candidates) {
      // Staying on the same train is not a transfer. It is also not merely
      // redundant here: the trip continues to the destination, so this pair
      // would masquerade as a 1-transfer journey of a direct trip.
      if (second.trip_id === first.trip_id) continue;

      const wait = second.board_departure_seconds - first.alight_arrival_seconds;
      if (wait < minimum) continue;
      // Sorted by departure, so everything after this waits longer still.
      if (wait > MAX_CONNECTION_SECONDS) break;

      if (best === null || second.alight_arrival_seconds < best.alight_arrival_seconds) best = second;
    }

    if (best === null) continue;

    const journey: TransferJourney = {
      legs: [first, best],
      connections: [{
        stopId: first.alight_stop_id,
        arrivalSeconds: first.alight_arrival_seconds,
        departureSeconds: best.board_departure_seconds,
        connectionSeconds: best.board_departure_seconds - first.alight_arrival_seconds,
        minTransferTime: minTransferTimes.get(first.alight_stop_id) ?? null,
        guaranteed: guaranteedPairs.has(`${first.trip_id}|${best.trip_id}`),
      }],
    };

    // One journey per first-leg trip: the same train reaches several usable
    // interchanges, and offering the rider a choice of where to change when
    // one of them arrives strictly earlier is noise.
    const incumbent = bestByFirstLeg.get(first.trip_id);
    if (!incumbent || best.alight_arrival_seconds < incumbent.legs[1].alight_arrival_seconds) {
      bestByFirstLeg.set(first.trip_id, journey);
    }
  }

  return [...bestByFirstLeg.values()];
}
