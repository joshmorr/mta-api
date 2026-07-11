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
 * Normalize Hono's `:param` path keys to OpenAPI `{param}` templating.
 *
 * The routes are registered with Hono's `:param` syntax, which zod-openapi
 * carries verbatim into the emitted path keys (e.g. `/stops/:stop_id`).
 * Standard OpenAPI — and the codegen tools that consume the spec
 * (openapi-typescript, orval, …) — expect `{param}`. Path parameters are
 * already declared correctly under each operation's `parameters`, so this
 * only rewrites the path map keys; the runtime routes are untouched.
 */
export function normalizeOpenApiPaths<T extends { paths?: Record<string, unknown> }>(
  doc: T,
): T {
  const normalizedPaths: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    normalizedPaths[path.replace(/:([^/]+)/g, '{$1}')] = item;
  }
  doc.paths = normalizedPaths as T['paths'];
  return doc;
}

/**
 * Build the OpenAPI 3.0 document without booting the server. Mounts the same
 * routers as `index.ts` at the same paths, but skips middleware, the seeding
 * guard, and `startup()` — handlers are never executed, only their route
 * definitions are read. Used by `scripts/openapi.ts` to emit `openapi.json`.
 * Paths are normalized to `{param}` templating so the emitted spec matches
 * what the live `/doc` endpoint serves.
 */
export function buildOpenApiDocument() {
  const app = new OpenAPIHono();
  app.route('/stops', stopsRouter);
  app.route('/routes', routesRouter);
  app.route('/arrivals', arrivalsRouter);
  app.route('/vehicles', vehiclesRouter);
  app.route('/alerts', alertsRouter);
  app.route('/health', healthRouter);
  return normalizeOpenApiPaths(app.getOpenAPIDocument(openApiDocConfig));
}
