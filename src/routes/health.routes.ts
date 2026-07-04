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
  description:
    'Returns server status and per-feed static data counts and sync timestamps. ' +
    'Responds 503 while the initial data load is in progress (the instance cannot ' +
    'serve requests yet); load balancers should treat it as a readiness probe.',
  responses: {
    200: { content: { 'application/json': { schema: HealthResponseSchema } }, description: 'Ready to serve requests' },
    503: { content: { 'application/json': { schema: HealthResponseSchema } }, description: 'Seeding initial data; not ready' },
  },
});

healthRouter.openapi(getHealthRoute, (c) => {
  // Read purely from in-memory state — no SQLite. This is a readiness probe hit
  // every 15s by Fly with a tight timeout; the counts come from `state.health`,
  // refreshed on startup and after each sync (see services/healthCache.ts).

  // While `seeding` is true (empty-DB first boot) every real endpoint 503s, so
  // fail the readiness probe to keep the load balancer from routing here until
  // the initial load finishes. A background refresh (`syncing`) still serves fine.
  const ready = !state.seeding;
  const { totals, feeds } = state.health;

  return c.json({
    status: ready ? ('ok' as const) : ('seeding' as const),
    syncing: state.syncing.subway || state.syncing.lirr || state.syncing.mnr,
    totals,
    static_feeds: {
      subway: { ...feeds.subway, syncing: state.syncing.subway },
      lirr: { ...feeds.lirr, syncing: state.syncing.lirr },
      mnr: { ...feeds.mnr, syncing: state.syncing.mnr },
    },
  }, ready ? (200 as const) : (503 as const));
});
