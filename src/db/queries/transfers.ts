import { db } from '../client';
import type { FeedId } from '../../types/gtfs';

/**
 * The `(from_trip_id, to_trip_id)` pairs the feed publishes as guaranteed
 * connections (`transfer_type = 1` — the departing train waits).
 *
 * Loaded whole and hashed rather than queried per candidate: there is no index
 * on `transfers(feed_id, from_trip_id)`, and the tables are small enough that
 * one scan beats thousands of seeks (LIRR 417 rows, MNR 13,743, subway 0 —
 * subway publishes station adjacency instead, never trip pairs).
 *
 * This labels a journey the transfer search already found. It can *not*
 * enumerate the search space: the LIRR rows cover 7 stations and omit
 * Penn and Woodside entirely, so absence of a row means "unenumerated", not
 * "impossible". See `.claude/skills/mta-gtfs/references/static.md` §transfers.
 */
export function getGuaranteedTransferTripPairs(feedId: FeedId): Set<string> {
  const rows = db
    .query<{ from_trip_id: string; to_trip_id: string }, [FeedId]>(
      `SELECT from_trip_id, to_trip_id
       FROM transfers
       WHERE feed_id = ?
         AND transfer_type = 1
         AND from_trip_id IS NOT NULL
         AND to_trip_id IS NOT NULL`,
    )
    .all(feedId);

  return new Set(rows.map((r) => `${r.from_trip_id}|${r.to_trip_id}`));
}

/**
 * Per-station minimum connection times, from the `transfer_type = 2` rows
 * where a station points at itself (`from_stop_id = to_stop_id`) — the feed
 * saying "changing trains here takes at least this long".
 *
 * Sparse by design: LIRR publishes exactly one (Jamaica, 300s). Stops absent
 * from the map fall back to the search's own default.
 *
 * `MIN` collapses the duplicate rows subway ships for some complexes; taking
 * the smallest keeps a stricter row from silently hiding connections that the
 * feed's own looser row allows.
 */
export function getSameStopMinTransferTimes(feedId: FeedId): Map<string, number> {
  const rows = db
    .query<{ stop_id: string; min_transfer_time: number }, [FeedId]>(
      `SELECT from_stop_id AS stop_id, MIN(min_transfer_time) AS min_transfer_time
       FROM transfers
       WHERE feed_id = ?
         AND transfer_type = 2
         AND from_stop_id = to_stop_id
         AND min_transfer_time IS NOT NULL
       GROUP BY from_stop_id`,
    )
    .all(feedId);

  return new Map(rows.map((r) => [r.stop_id, r.min_transfer_time]));
}
