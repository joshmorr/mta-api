import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { getDbCounts } from '../db/queries/health';
import { getLastSynced } from '../services/static.service';
import { HealthResponseSchema } from '../schemas/api';

export const healthRouter = new OpenAPIHono();

const getHealthRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Health'],
  summary: 'API health and feed status',
  description: 'Returns server status and per-feed static data counts and sync timestamps.',
  responses: {
    200: { content: { 'application/json': { schema: HealthResponseSchema } }, description: 'Health status' },
  },
});

healthRouter.openapi(getHealthRoute, (c) => {
  const counts = getDbCounts();

  return c.json({
    status: 'ok' as const,
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
  }, 200 as const);
});
