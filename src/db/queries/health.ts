import { db } from '../client';

export function getDbCounts(): { stops: number; routes: number } {
  return db
    .query<{ stops: number; routes: number }, []>(
      `SELECT
        (SELECT COUNT(*) FROM stops WHERE location_type = 1) as stops,
        (SELECT COUNT(*) FROM routes) as routes`,
    )
    .get() ?? { stops: 0, routes: 0 };
}
