import { db } from '../client';

export function getDbCounts(): {
  totalStops: number;
  totalRoutes: number;
  subwayStops: number;
  subwayRoutes: number;
  lirrStops: number;
  lirrRoutes: number;
  mnrStops: number;
  mnrRoutes: number;
} {
  return db
    .query<{
      totalStops: number;
      totalRoutes: number;
      subwayStops: number;
      subwayRoutes: number;
      lirrStops: number;
      lirrRoutes: number;
      mnrStops: number;
      mnrRoutes: number;
    }, []>(
      `SELECT
        (SELECT COUNT(*) FROM stops WHERE (feed_id = 'subway' AND location_type = 1) OR (feed_id != 'subway' AND (parent_station IS NULL OR parent_station = ''))) as totalStops,
        (SELECT COUNT(*) FROM routes) as totalRoutes,
        (SELECT COUNT(*) FROM stops WHERE feed_id = 'subway' AND location_type = 1) as subwayStops,
        (SELECT COUNT(*) FROM routes WHERE feed_id = 'subway') as subwayRoutes,
        (SELECT COUNT(*) FROM stops WHERE feed_id = 'lirr' AND (parent_station IS NULL OR parent_station = '')) as lirrStops,
        (SELECT COUNT(*) FROM routes WHERE feed_id = 'lirr') as lirrRoutes,
        (SELECT COUNT(*) FROM stops WHERE feed_id = 'mnr' AND (parent_station IS NULL OR parent_station = '')) as mnrStops,
        (SELECT COUNT(*) FROM routes WHERE feed_id = 'mnr') as mnrRoutes`,
    )
    .get() ?? {
      totalStops: 0,
      totalRoutes: 0,
      subwayStops: 0,
      subwayRoutes: 0,
      lirrStops: 0,
      lirrRoutes: 0,
      mnrStops: 0,
      mnrRoutes: 0,
    };
}
