import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HealthResponseSchema } from '../schemas/api';
import { state } from '../state';

export const healthRouter = new OpenAPIHono();

const getHealthRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Health'],
  operationId: 'getHealth',
  summary: 'API health and feed status',
  description: 'Returns server status and per-feed static data counts and sync timestamps.',
  responses: {
    200: { content: { 'application/json': { schema: HealthResponseSchema } }, description: 'Server is up' },
  },
});

healthRouter.openapi(getHealthRoute, (c) => {
  // Read purely from in-memory state — no SQLite. This is a liveness probe hit
  // every 15s by Fly with a tight timeout; the counts come from `state.health`,
  // refreshed once at startup (see services/healthCache.ts).
  const { totals, feeds } = state.health;

  return c.json({
    status: 'ok' as const,
    totals,
    static_feeds: feeds,
  }, 200 as const);
});
