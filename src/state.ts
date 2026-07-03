import type { FeedId } from './types/gtfs';

export const state = {
  /** True while the initial empty-DB seed is running; gates non-health routes with 503. */
  seeding: false,
  /** Per-feed in-progress flag, driven by the sync manager. Surfaced on /health. */
  syncing: { subway: false, lirr: false, mnr: false } as Record<FeedId, boolean>,
};
