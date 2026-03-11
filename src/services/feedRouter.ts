export const MTA_RT_BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds';

export const ROUTE_TO_FEED: Record<string, string> = {
  '1': 'nyct/gtfs',    '2': 'nyct/gtfs',    '3': 'nyct/gtfs',
  '4': 'nyct/gtfs',    '5': 'nyct/gtfs',    '6': 'nyct/gtfs',   'GS': 'nyct/gtfs',
  'A': 'nyct/gtfs-ace', 'C': 'nyct/gtfs-ace', 'E': 'nyct/gtfs-ace',
  'H': 'nyct/gtfs-ace', 'FS': 'nyct/gtfs-ace',
  'B': 'nyct/gtfs-bdfm', 'D': 'nyct/gtfs-bdfm', 'F': 'nyct/gtfs-bdfm', 'M': 'nyct/gtfs-bdfm',
  'G': 'nyct/gtfs-g',
  'J': 'nyct/gtfs-jz',  'Z': 'nyct/gtfs-jz',
  'L': 'nyct/gtfs-l',
  'N': 'nyct/gtfs-nqrw', 'Q': 'nyct/gtfs-nqrw', 'R': 'nyct/gtfs-nqrw', 'W': 'nyct/gtfs-nqrw',
  'SI':   'nyct/gtfs-si',
  'LIRR': 'lirr/gtfs-lirr',
  'MNR':  'mnr/gtfs-mnr',
};

export function getFeedPath(routeId: string): string | undefined {
  return ROUTE_TO_FEED[routeId];
}

export function getFeedPathsForRoutes(routeIds: string[]): Set<string> {
  const paths = new Set<string>();
  for (const id of routeIds) {
    const path = ROUTE_TO_FEED[id];
    if (path) paths.add(path);
  }
  return paths;
}
