import { Hono } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';

/**
 * Wrap a router in a fresh Hono app at the given mount path so tests can
 * exercise it via `app.request(...)` in isolation from the rest of the API.
 */
export function makeTestApp(router: OpenAPIHono, mount: string): Hono {
  const app = new Hono();
  app.route(mount, router);
  return app;
}
