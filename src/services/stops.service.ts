import {
  findStopsByProximity,
  findStopsByName,
  getAllStops,
  getPlatformIds,
  getStopById,
  getPlatforms,
  getParentId,
} from '../db/queries/stops';
import type { StopRow } from '../db/queries/stops';
import type { FeedId } from '../types/gtfs';
import type { StopSummary, StopDetail } from '../types/api';

export interface StopSearchParams {
  q?: string;
  lat?: number;
  lon?: number;
  feed?: FeedId;
  radius: number;
  limit: number;
}

/**
 * Search stops by proximity, by name, or unfiltered — in that precedence order.
 *
 * Proximity search converts the metre radius into a lat/lon bounding box rather
 * than doing true great-circle distance: the box is what the index can seek on,
 * and the SQL then orders by squared euclidean distance within it. One degree of
 * latitude is ~111km everywhere; longitude degrees shrink by cos(latitude), so
 * the lon delta is widened accordingly.
 */
export function searchStops({ q, lat, lon, feed, radius, limit }: StopSearchParams): StopSummary[] {
  let rows: StopRow[];

  if (lat !== undefined && lon !== undefined) {
    const latDelta = radius / 111_000;
    const lonDelta = radius / (111_000 * Math.cos((lat * Math.PI) / 180));
    rows = findStopsByProximity(lat, lon, latDelta, lonDelta, limit, feed);
  } else if (q) {
    rows = findStopsByName(q, limit, feed);
  } else {
    rows = getAllStops(limit, feed);
  }

  return rows.map((s) => ({
    feed_id:   s.feed_id,
    stop_id:   s.stop_id,
    stop_name: s.stop_name,
    lat:       s.stop_lat,
    lon:       s.stop_lon,
    platforms: s.feed_id === 'subway' ? getPlatformIds(s.feed_id, s.stop_id) : [],
  }));
}

/**
 * Full detail for one stop, or null when the (feed, stop) pair does not exist.
 *
 * Subway stops are hierarchical: a request for a platform (`127N`) resolves up
 * to its parent station (`127`) so callers always get the station-level view
 * with every platform listed. LIRR and MNR are flat, so the ID is used as-is.
 */
export function getStopDetail(stopId: string, feedId: FeedId): StopDetail | null {
  const stop = getStopById(stopId, feedId);
  if (!stop) return null;

  const parentId = stop.feed_id === 'subway' && stop.location_type === 0
    ? getParentId(stop.feed_id, stopId) ?? stopId
    : stopId;
  const parent = parentId !== stopId
    ? getStopById(parentId, stop.feed_id) ?? stop
    : stop;

  const platforms = parent.feed_id === 'subway' ? getPlatforms(parent.feed_id, parent.stop_id) : [];

  return {
    feed_id:   parent.feed_id,
    stop_id:   parent.stop_id,
    stop_name: parent.stop_name,
    lat:       parent.stop_lat,
    lon:       parent.stop_lon,
    platforms: platforms.map((platform) => ({
      stop_id:   platform.stop_id,
      direction: inferDirection(platform.stop_id),
    })),
  };
}

/** Subway platform IDs encode direction as an `N`/`S` suffix on the parent ID. */
function inferDirection(stopId: string): string {
  if (stopId.endsWith('N')) return 'Uptown / Northbound';
  if (stopId.endsWith('S')) return 'Downtown / Southbound';
  return stopId;
}
