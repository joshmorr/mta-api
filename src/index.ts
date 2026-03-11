import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { timing } from 'hono/timing';
import { runMigrations } from './db/client';
import { config } from './config';
import {
  syncSubwayFeed,
  syncLirrFeed,
  syncMnrFeed,
  isDbEmpty,
  isFeedStale,
  getLastSynced,
} from './services/staticFeed';
import { db } from './db/client';
import { stopsRouter } from './routes/stops';
import { arrivalsRouter } from './routes/arrivals';
import { routesRouter } from './routes/routes';
import { vehiclesRouter } from './routes/vehicles';
import { alertsRouter } from './routes/alerts';

const app = new Hono();

app.use('*', logger());
app.use('*', timing());

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error', code: 'INTERNAL' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

// Routes
app.route('/stops', stopsRouter);
app.route('/stops', arrivalsRouter);
app.route('/routes', routesRouter);
app.route('/routes', vehiclesRouter);
app.route('/alerts', alertsRouter);

app.get('/health', (c) => {
  const counts = db
    .query<{ stops: number; routes: number }, []>(
      `SELECT
        (SELECT COUNT(*) FROM stops WHERE location_type = 1) as stops,
        (SELECT COUNT(*) FROM routes) as routes`
    )
    .get();

  return c.json({
    status: 'ok',
    static_feeds: {
      subway: {
        last_synced:  getLastSynced('subway'),
        stop_count:   counts?.stops ?? 0,
        route_count:  counts?.routes ?? 0,
      },
      lirr: { last_synced: getLastSynced('lirr') },
      mnr:  { last_synced: getLastSynced('mnr') },
    },
  });
});

// Startup
async function start() {
  runMigrations();

  const empty = isDbEmpty();

  if (empty) {
    console.error('[startup] DB is empty — seeding all feeds before starting server...');
    await Promise.all([syncSubwayFeed(), syncLirrFeed(), syncMnrFeed()]);
  } else {
    // Kick off stale refreshes in the background
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

  // Schedule ongoing refreshes
  setInterval(() => {
    syncSubwayFeed().catch((e) => console.error('[sync] subway error:', e));
  }, config.subwaySyncIntervalMs);

  setInterval(() => {
    syncLirrFeed().catch((e) => console.error('[sync] lirr error:', e));
    syncMnrFeed().catch((e) => console.error('[sync] mnr error:', e));
  }, config.railSyncIntervalMs);

  console.error(`[startup] Server listening on http://${config.host}:${config.port}`);
}

start().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
};

