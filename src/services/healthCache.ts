/**
 * Recomputes the cached /health counts in `state.health` from the DB. Called at
 * startup and after each completed sync — the only moments the underlying counts
 * can change — so the /health readiness probe reads pure in-memory state and never
 * queries SQLite on its hot path (see state.health for why that matters).
 */
import { getDbCounts } from '../db/queries/health';
import { getLastSynced } from './static.service';
import { state } from '../state';

export function refreshHealthCache(): void {
  const counts = getDbCounts();
  state.health.totals = { stop_count: counts.totalStops, route_count: counts.totalRoutes };
  state.health.feeds.subway = {
    last_synced: getLastSynced('subway'),
    stop_count: counts.subwayStops,
    route_count: counts.subwayRoutes,
  };
  state.health.feeds.lirr = {
    last_synced: getLastSynced('lirr'),
    stop_count: counts.lirrStops,
    route_count: counts.lirrRoutes,
  };
  state.health.feeds.mnr = {
    last_synced: getLastSynced('mnr'),
    stop_count: counts.mnrStops,
    route_count: counts.mnrRoutes,
  };
}
