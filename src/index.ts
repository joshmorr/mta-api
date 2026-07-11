import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { logger } from 'hono/logger';
import { timing } from 'hono/timing';
import { config } from './config';
import { startup } from './startup';
import { stopsRouter, routesRouter, arrivalsRouter, vehiclesRouter, alertsRouter, healthRouter } from './routes';
import { rateLimit } from './middleware/rateLimit';
import { cacheHeaders } from './middleware/cacheHeaders';
import { openApiDocConfig, normalizeOpenApiPaths } from './openapi';

const app = new OpenAPIHono();

app.use('*', logger());
app.use('*', timing());
app.use('*', cacheHeaders);
app.use('*', rateLimit);

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

// Serve the spec with Hono `:param` path keys normalized to OpenAPI `{param}`,
// so the live endpoint matches the committed `openapi.json` and codegen tools
// (openapi-typescript, orval, …) that consume `/doc` get spec-compliant paths.
app.get('/doc', (c) => c.json(normalizeOpenApiPaths(app.getOpenAPIDocument(openApiDocConfig))));

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
