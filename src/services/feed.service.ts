import type { FeedId } from '../types/gtfs';

export const MTA_RT_BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds';

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
