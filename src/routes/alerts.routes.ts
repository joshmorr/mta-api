import { createRoute, z } from '@hono/zod-openapi';
import { getAlerts, getAlertsSnapshotTimestamp, parseDirection } from '../services/alerts.service';
import { createApiRouter } from '../utils/openapi';
import { log } from '../utils/logger';
import { AlertListResponseSchema, ErrorSchema } from '../schemas/api';

export const alertsRouter = createApiRouter();

/**
 * Weak validator for one alerts representation.
 *
 * Keyed on the feed's own `header.timestamp` rather than a hash of the body:
 * the alerts response is deterministic given a snapshot, but hashing it would
 * mean building the very payload the 304 exists to avoid. (On `/arrivals` a
 * body hash would be outright wrong - that response embeds wall-clock values
 * that move every second while the feed sits still.)
 *
 * The query parameters are part of the key for correctness, not decoration.
 * One snapshot yields different bodies for `?routes=A` and `?stop_id=127`, so a
 * timestamp-only validator would let a client replaying an ETag across queries
 * collect a 304 for a representation it never fetched. Normalizing first -
 * sorted routes, direction post-`parseDirection` so `N` and `0` collapse -
 * keeps the validator stable across spellings of the same request.
 */
function etagFor(
  generatedAt: number,
  key: { routes?: string[]; stopId?: string; direction?: 0 | 1 },
): string {
  const params = [
    (key.routes ?? []).slice().sort().join(','),
    key.stopId ?? '',
    key.direction === undefined ? '' : String(key.direction),
  ].join('|');
  // Hashed rather than inlined: stop_id is caller-supplied and an ETag is a
  // quoted-string, so raw interpolation would be an escaping problem.
  return `W/"${generatedAt}-${Bun.hash(params).toString(36)}"`;
}

const ETagHeader = z.object({
  ETag: z.string().openapi({
    description: 'Weak validator for this alerts snapshot. Send it back as If-None-Match to poll cheaply.',
    example: 'W/"1705330800-1a2b3c4d"',
  }),
});

const getAlertsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Alerts'],
  operationId: 'getAlerts',
  summary: 'Get service alerts',
  description:
    'Returns active MTA service alerts, optionally filtered by route or stop.\n\n' +
    'Supports conditional GET: every 200 carries an `ETag`, and resending it as ' +
    '`If-None-Match` yields `304 Not Modified` while the upstream snapshot is unchanged. ' +
    'This feed publishes on the order of minutes against a much shorter cache TTL, so a ' +
    'polling client will usually revalidate rather than re-download the (large) alert list. ' +
    'A degraded upstream always returns 200 so the `stale` flag stays visible.',
  request: {
    query: z.object({
      routes: z.string().optional().openapi({ description: 'Comma-separated route IDs to filter alerts by', example: 'A,C' }),
      stop_id: z.string().optional().openapi({ description: 'Filter alerts affecting a specific stop', example: '127' }),
      direction: z.enum(['N', 'S', '0', '1']).optional().openapi({
        description: 'Filter alerts by direction of travel at the given stop. N or 0 = Northbound, S or 1 = Southbound. Only applies in combination with stop_id.',
        example: 'S',
      }),
    }),
    headers: z.object({
      'if-none-match': z.string().optional().openapi({
        description: 'ETag from a previous response. Matching the current snapshot yields 304.',
        example: 'W/"1705330800-1a2b3c4d"',
      }),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AlertListResponseSchema } },
      description: 'Service alerts',
      headers: ETagHeader,
    },
    304: {
      description: 'Alerts snapshot unchanged since the supplied If-None-Match',
      headers: ETagHeader,
    },
    503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Alerts feed unavailable' },
  },
});

alertsRouter.openapi(getAlertsRoute, async (c) => {
  const { routes: routesParam, stop_id: stopId, direction: dirParam } = c.req.valid('query');
  const routes = routesParam
    ? routesParam.split(',').map((r) => r.trim()).filter(Boolean)
    : undefined;
  const direction = parseDirection(dirParam);
  const filter = { routes, stopId, direction };

  try {
    const ifNoneMatch = c.req.header('If-None-Match');
    if (ifNoneMatch) {
      // Cheap probe first: this reads the snapshot's timestamp without walking
      // a single alert entity, so a match short-circuits the actual work rather
      // than only the transfer.
      const { generated_at, stale } = await getAlertsSnapshotTimestamp();
      // Never 304 while degraded: the timestamp is frozen *because* upstream
      // stopped publishing, and an empty body would hide `stale`/`feed_error`.
      if (!stale && ifNoneMatch === etagFor(generated_at, filter)) {
        c.header('ETag', ifNoneMatch);
        return c.body(null, 304 as const);
      }
    }

    const { generated_at, stale, feed_error, alerts } = await getAlerts(filter);

    // Derived from the payload's own timestamp, not the probe's, so the
    // validator can never describe a snapshot other than the one being sent.
    c.header('ETag', etagFor(generated_at, filter));

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
