import type { FeedId } from '../types/gtfs';
import { config } from '../config';

export const MTA_RT_BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds';

/** Service alerts. Not route-scoped, so it is absent from SUBWAY_ROUTE_TO_FEED. */
export const ALERTS_FEED_PATH = 'camsys/all-alerts';

export const SUBWAY_ROUTE_TO_FEED: Record<string, string> = {
  '1': 'nyct/gtfs',
  '2': 'nyct/gtfs',
  '3': 'nyct/gtfs',
  '4': 'nyct/gtfs',
  '5': 'nyct/gtfs',
  '6': 'nyct/gtfs',
  '6X': 'nyct/gtfs',
  '7': 'nyct/gtfs',
  '7X': 'nyct/gtfs',
  'GS': 'nyct/gtfs',
  'A': 'nyct/gtfs-ace',
  'C': 'nyct/gtfs-ace',
  'E': 'nyct/gtfs-ace',
  'H': 'nyct/gtfs-ace',
  'FS': 'nyct/gtfs-ace',
  'B': 'nyct/gtfs-bdfm',
  'D': 'nyct/gtfs-bdfm',
  'F': 'nyct/gtfs-bdfm',
  'FX': 'nyct/gtfs-bdfm',
  'M': 'nyct/gtfs-bdfm',
  'G': 'nyct/gtfs-g',
  'J': 'nyct/gtfs-jz',
  'Z': 'nyct/gtfs-jz',
  'L': 'nyct/gtfs-l',
  'N': 'nyct/gtfs-nqrw',
  'Q': 'nyct/gtfs-nqrw',
  'R': 'nyct/gtfs-nqrw',
  'W': 'nyct/gtfs-nqrw',
  'SI': 'nyct/gtfs-si',
};

/**
 * Cache TTL for a feed path. Every vehicle feed shares `RT_CACHE_TTL_MS`; only
 * alerts differs (`ALERTS_RT_CACHE_TTL_MS`), because it is the one feed whose
 * cadence is off by an order of magnitude from the rest (~181s vs ~3-15s).
 *
 * Alerts publish on the order of minutes (one observed gap of 181s) at ~570KB,
 * roughly 6x the largest vehicle feed. At the shared vehicle-feed TTL they are
 * refetched many times per publish for nothing.
 *
 * The 30s default sits well below the ~180s that sample implies, for two
 * reasons: the measurement rests on a single observed gap, and cache age is the
 * only lag this API adds on top of upstream, so it is kept comfortably under a
 * minute. Raising it toward the real cadence would mean surfacing cache age on
 * the response first.
 */
export function getRtCacheTtlMs(feedPath: string): number {
  return feedPath === ALERTS_FEED_PATH ? config.alertsRtCacheTtlMs : config.rtCacheTtlMs;
}

export function getFeedPath(feedId: FeedId, routeId: string): string | undefined {
  if (feedId === 'lirr') return 'lirr/gtfs-lirr';
  if (feedId === 'mnr') return 'mnr/gtfs-mnr';
  return SUBWAY_ROUTE_TO_FEED[routeId];
}

export function getFeedPathsForRoutes(routes: Array<{ feed_id: FeedId; route_id: string }>): Set<string> {
  const paths = new Set<string>();
  for (const route of routes) {
    const path = getFeedPath(route.feed_id, route.route_id);
    if (path) paths.add(path);
  }
  return paths;
}
