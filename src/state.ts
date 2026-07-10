import type { FeedId } from './types/gtfs';

type FeedHealth = { last_synced: number | null; stop_count: number; route_count: number };

const emptyFeedHealth = (): FeedHealth => ({ last_synced: null, stop_count: 0, route_count: 0 });

export const state = {
  /**
   * Cached static-data counts + sync timestamps for /health. Refreshed once at
   * startup, so the readiness probe never runs SQLite COUNT(*) scans on its hot
   * path — under CPU contention those reads ballooned to tens of seconds and
   * blew Fly's health-check timeout, marking the machine unhealthy.
   */
  health: {
    totals: { stop_count: 0, route_count: 0 },
    feeds: {
      subway: emptyFeedHealth(),
      lirr: emptyFeedHealth(),
      mnr: emptyFeedHealth(),
    } as Record<FeedId, FeedHealth>,
  },
};
