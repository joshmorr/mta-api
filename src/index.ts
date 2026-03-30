import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { logger } from 'hono/logger';
import { timing } from 'hono/timing';
import { config } from './config';
import { startup } from './startup';
import { stopsRouter, routesRouter, arrivalsRouter, vehiclesRouter, alertsRouter, healthRouter } from './routes';

const app = new OpenAPIHono();

app.use('*', logger());
app.use('*', timing());

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error', code: 'INTERNAL' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

app.route('/stops', stopsRouter);
app.route('/routes', routesRouter);
app.route('/arrivals', arrivalsRouter);
app.route('/vehicles', vehiclesRouter);
app.route('/alerts', alertsRouter);
app.route('/health', healthRouter);

app.doc('/doc', {
  openapi: '3.0.0',
  info: {
    title: 'MTA API',
    version: '1.0.0',
    description: 'REST API for NYC MTA transit data — subway, LIRR, and Metro-North routes, stops, arrivals, vehicles, and service alerts.',
  },
  servers: [{ url: `http://${config.host}:${config.port}`, description: 'Local' }],
});

app.get('/ui', swaggerUI({ url: '/doc' }));

startup()
  .then(() => console.error(`[startup] Server listening on http://${config.host}:${config.port}`))
  .catch((err) => {
    console.error('[startup] Fatal error:', err);
    process.exit(1);
  });

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
};
