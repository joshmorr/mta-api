import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { getDbCounts } from '../db/queries/health';
import { getLastSynced } from '../services/static.service';
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
    200: { content: { 'application/json': { schema: HealthResponseSchema } }, description: 'Health status' },
  },
});

healthRouter.openapi(getHealthRoute, (c) => {
  const counts = getDbCounts();

  return c.json({
    status: 'ok' as const,
    syncing: state.syncing.subway || state.syncing.lirr || state.syncing.mnr,
    totals: {
      stop_count: counts.totalStops,
      route_count: counts.totalRoutes,
    },
    static_feeds: {
      subway: {
        last_synced: getLastSynced('subway'),
        stop_count: counts.subwayStops,
        route_count: counts.subwayRoutes,
        syncing: state.syncing.subway,
      },
      lirr: {
        last_synced: getLastSynced('lirr'),
        stop_count: counts.lirrStops,
        route_count: counts.lirrRoutes,
        syncing: state.syncing.lirr,
      },
      mnr: {
        last_synced: getLastSynced('mnr'),
        stop_count: counts.mnrStops,
        route_count: counts.mnrRoutes,
        syncing: state.syncing.mnr,
      },
    },
  }, 200 as const);
});
