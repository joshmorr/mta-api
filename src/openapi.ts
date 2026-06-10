import { OpenAPIHono } from '@hono/zod-openapi';
import { config } from './config';
import {
  stopsRouter,
  routesRouter,
  arrivalsRouter,
  vehiclesRouter,
  alertsRouter,
  healthRouter,
} from './routes';

/**
 * OpenAPI document metadata. Single source of truth shared by the live
 * server (`app.doc('/doc', ...)` in `index.ts`) and the static spec dump
 * (`scripts/openapi.ts`), so the committed `openapi.json` never drifts from
 * what the running server serves.
 */
export const openApiDocConfig = {
  openapi: '3.0.0',
  info: {
    title: 'MTA API',
    version: '1.0.0',
    description:
      'REST API for NYC MTA transit data — subway, LIRR, and Metro-North routes, stops, arrivals, vehicles, and service alerts.',
  },
  servers: [{ url: `http://${config.host}:${config.port}`, description: 'Local' }],
};

/**
 * Build the OpenAPI 3.0 document without booting the server. Mounts the same
 * routers as `index.ts` at the same paths, but skips middleware, the seeding
 * guard, and `startup()` — handlers are never executed, only their route
 * definitions are read. Used by `scripts/openapi.ts` to emit `openapi.json`.
 */
export function buildOpenApiDocument() {
  const app = new OpenAPIHono();
  app.route('/stops', stopsRouter);
  app.route('/routes', routesRouter);
  app.route('/arrivals', arrivalsRouter);
  app.route('/vehicles', vehiclesRouter);
  app.route('/alerts', alertsRouter);
  app.route('/health', healthRouter);
  return app.getOpenAPIDocument(openApiDocConfig);
}
