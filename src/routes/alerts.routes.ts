import { Hono } from 'hono';
import { fetchAlerts } from '../services/alerts.service';

export const alertsRouter = new Hono();

alertsRouter.get('/', async (c) => {
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
    });
  } catch {
    return c.json({ error: 'Alerts feed unavailable', code: 'FEED_ERROR' }, 503, {
      'Retry-After': '30',
    });
  }
});
