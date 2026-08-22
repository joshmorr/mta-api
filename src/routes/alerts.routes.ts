import { createRoute, z } from '@hono/zod-openapi';
import { getAlerts, parseDirection } from '../services/alerts.service';
import { createApiRouter } from '../utils/openapi';
import { log } from '../utils/logger';
import { AlertListResponseSchema, ErrorSchema } from '../schemas/api';

export const alertsRouter = createApiRouter();

const getAlertsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Alerts'],
  operationId: 'getAlerts',
  summary: 'Get service alerts',
  description: 'Returns active MTA service alerts, optionally filtered by route or stop.',
  request: {
    query: z.object({
      routes: z.string().optional().openapi({ description: 'Comma-separated route IDs to filter alerts by', example: 'A,C' }),
      stop_id: z.string().optional().openapi({ description: 'Filter alerts affecting a specific stop', example: '127' }),
      direction: z.enum(['N', 'S', '0', '1']).optional().openapi({
        description: 'Filter alerts by direction of travel at the given stop. N or 0 = Northbound, S or 1 = Southbound. Only applies in combination with stop_id.',
        example: 'S',
      }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: AlertListResponseSchema } }, description: 'Service alerts' },
    503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Alerts feed unavailable' },
  },
});

alertsRouter.openapi(getAlertsRoute, async (c) => {
  const { routes: routesParam, stop_id: stopId, direction: dirParam } = c.req.valid('query');
  const routes = routesParam
    ? routesParam.split(',').map((r) => r.trim()).filter(Boolean)
    : undefined;

  try {
    const { generated_at, stale, feed_error, alerts } = await getAlerts({
      routes,
      stopId,
      direction: parseDirection(dirParam),
    });

    return c.json({
      generated_at,
      stale,
      ...(feed_error ? { feed_error } : {}),
      alerts,
    }, 200 as const);
  } catch (err) {
    log.error({ err, routes, stop: stopId }, 'alerts feed unavailable');
    return c.json({ error: 'Alerts feed unavailable', code: 'FEED_ERROR' }, 503 as const);
  }
});
