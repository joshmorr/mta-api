import { runMigrations } from './db/client';
import { config } from './config';
import { isDbEmpty, isFeedStale } from './services/static.service';
import { refreshHealthCache } from './services/healthCache';
import { requestSync } from './services/syncManager';
import { state } from './state';

export async function startup() {
  runMigrations();
  // Prime the /health cache from whatever is already on disk before serving.
  refreshHealthCache();

  if (!config.syncEnabled) {
    console.log('[startup] SYNC_ENABLED=false — this instance will not sync static feeds (read-only).');
    return;
  }

  if (isDbEmpty()) {
    console.log('[startup] DB is empty — seeding all feeds in background...');
    state.seeding = true;
    requestSync('subway')
      .then(() => requestSync('lirr'))
      .then(() => requestSync('mnr'))
      .catch((e) => console.error('[startup] initial seed error:', e))
      .finally(() => { state.seeding = false; });
  } else {
    if (isFeedStale('subway', config.subwaySyncIntervalMs)) {
      requestSync('subway').catch((e) => console.error('[startup] subway sync error:', e));
    }
    if (isFeedStale('lirr', config.railSyncIntervalMs)) {
      requestSync('lirr').catch((e) => console.error('[startup] lirr sync error:', e));
    }
    if (isFeedStale('mnr', config.railSyncIntervalMs)) {
      requestSync('mnr').catch((e) => console.error('[startup] mnr sync error:', e));
    }
  }

  setInterval(() => {
    requestSync('subway').catch((e) => console.error('[sync] subway error:', e));
  }, config.subwaySyncIntervalMs);

  setInterval(() => {
    requestSync('lirr').catch((e) => console.error('[sync] lirr error:', e));
    requestSync('mnr').catch((e) => console.error('[sync] mnr error:', e));
  }, config.railSyncIntervalMs);
}
