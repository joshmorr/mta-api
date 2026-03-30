import { runMigrations } from './db/client';
import { config } from './config';
import {
  syncSubwayFeed,
  syncLirrFeed,
  syncMnrFeed,
  isDbEmpty,
  isFeedStale,
} from './services/static.service';
import { state } from './state';

export async function startup() {
  runMigrations();

  if (isDbEmpty()) {
    console.log('[startup] DB is empty — seeding all feeds in background...');
    state.seeding = true;
    syncSubwayFeed()
      .then(() => syncLirrFeed())
      .then(() => syncMnrFeed())
      .catch((e) => console.error('[startup] initial seed error:', e))
      .finally(() => { state.seeding = false; });
  } else {
    if (isFeedStale('subway', config.subwaySyncIntervalMs)) {
      syncSubwayFeed().catch((e) => console.error('[startup] subway sync error:', e));
    }
    if (isFeedStale('lirr', config.railSyncIntervalMs)) {
      syncLirrFeed().catch((e) => console.error('[startup] lirr sync error:', e));
    }
    if (isFeedStale('mnr', config.railSyncIntervalMs)) {
      syncMnrFeed().catch((e) => console.error('[startup] mnr sync error:', e));
    }
  }

  setInterval(() => {
    syncSubwayFeed().catch((e) => console.error('[sync] subway error:', e));
  }, config.subwaySyncIntervalMs);

  setInterval(() => {
    syncLirrFeed().catch((e) => console.error('[sync] lirr error:', e));
    syncMnrFeed().catch((e) => console.error('[sync] mnr error:', e));
  }, config.railSyncIntervalMs);
}
