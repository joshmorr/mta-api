import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { fetchAlerts } from '../services/alerts.service';
import { AlertListResponseSchema, ErrorSchema } from '../schemas/api';

export const alertsRouter = new OpenAPIHono();

const getAlertsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Alerts'],
  summary: 'Get service alerts',
  description: 'Returns active MTA service alerts, optionally filtered by route or stop.',
  request: {
    query: z.object({
      routes: z.string().optional().openapi({ description: 'Comma-separated route IDs to filter alerts by', example: 'A,C' }),
      stop_id: z.string().optional().openapi({ description: 'Filter alerts affecting a specific stop', example: '127' }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: AlertListResponseSchema } }, description: 'Service alerts' },
    503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Alerts feed unavailable' },
  },
});

alertsRouter.openapi(getAlertsRoute, async (c) => {
  const routesParam = c.req.query('routes');
  const stopId      = c.req.query('stop_id');
  const routeFilter = routesParam
    ? routesParam.split(',').map((r) => r.trim()).filter(Boolean)
    : undefined;

  try {
    const { generated_at, stale, feed_error, alerts } = await fetchAlerts();

    let filtered = alerts;
    if (routeFilter) {
      filtered = filtered.filter((a) =>
        a.routes_affected.some((r) => routeFilter.includes(r))
      );
    }
    if (stopId) {
      filtered = filtered.filter((a) => a.stops_affected.includes(stopId));
    }

    return c.json({
      generated_at,
      stale,
      ...(feed_error ? { feed_error } : {}),
      alerts: filtered,
    }, 200 as const);
  } catch {
    return c.json({ error: 'Alerts feed unavailable', code: 'FEED_ERROR' }, 503 as const);
  }
});
