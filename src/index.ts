import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
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
} from './services/static.service';
import { getDbCounts } from './db/queries/health';
import { stopsRouter } from './routes/stops.routes';
import { routesRouter } from './routes/routes.routes';
import { arrivalsRouter } from './routes/arrivals.routes';
import { vehiclesRouter } from './routes/vehicles.routes';
import { alertsRouter } from './routes/alerts.routes';

const app = new OpenAPIHono();

app.use('*', logger());
app.use('*', timing());

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error', code: 'INTERNAL' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

// Routes
app.route('/stops', stopsRouter);
app.route('/routes', routesRouter);
app.route('/arrivals', arrivalsRouter);
app.route('/vehicles', vehiclesRouter);
app.route('/alerts', alertsRouter);

app.get('/health', (c) => {
  const counts = getDbCounts();

  return c.json({
    status: 'ok',
    totals: {
      stop_count: counts.totalStops,
      route_count: counts.totalRoutes,
    },
    static_feeds: {
      subway: {
        last_synced: getLastSynced('subway'),
        stop_count: counts.subwayStops,
        route_count: counts.subwayRoutes,
      },
      lirr: {
        last_synced: getLastSynced('lirr'),
        stop_count: counts.lirrStops,
        route_count: counts.lirrRoutes,
      },
      mnr: {
        last_synced: getLastSynced('mnr'),
        stop_count: counts.mnrStops,
        route_count: counts.mnrRoutes,
      },
    },
  });
});

// OpenAPI spec
app.doc('/doc', {
  openapi: '3.0.0',
  info: {
    title: 'MTA API',
    version: '1.0.0',
    description: 'REST API for NYC MTA transit data — subway, LIRR, and Metro-North routes, stops, arrivals, vehicles, and service alerts.',
  },
  servers: [{ url: `http://${config.host}:${config.port}`, description: 'Local' }],
});

// Swagger UI
app.get('/ui', swaggerUI({ url: '/doc' }));

// Startup
async function start() {
  runMigrations();

  const empty = isDbEmpty();

  if (empty) {
    console.error('[startup] DB is empty — seeding all feeds before starting server...');
    await syncSubwayFeed();
    await syncLirrFeed();
    await syncMnrFeed();
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
