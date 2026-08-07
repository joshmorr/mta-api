import { createRoute, z } from '@hono/zod-openapi';
import { listRoutes, getRoute } from '../services/routes.service';
import { createApiRouter } from '../utils/openapi';
import { RouteListResponseSchema, RouteResponseSchema, ErrorSchema } from '../schemas/api';

export const routesRouter = createApiRouter();

const listRoutesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Routes'],
  operationId: 'listRoutes',
  summary: 'List routes',
  description: 'Returns all routes, optionally filtered by feed.',
  request: {
    query: z.object({
      feed: z.enum(['subway', 'lirr', 'mnr']).optional().openapi({ description: 'Filter by feed' }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: RouteListResponseSchema } }, description: 'List of routes' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid feed' },
  },
});

routesRouter.openapi(listRoutesRoute, (c) => {
  const { feed } = c.req.valid('query');
  return c.json({ routes: listRoutes(feed) }, 200 as const);
});

const getRouteRoute = createRoute({
  method: 'get',
  path: '/:route_id',
  tags: ['Routes'],
  operationId: 'getRoute',
  summary: 'Get route by ID',
  request: {
    params: z.object({
      route_id: z.string().openapi({ description: 'Route ID', example: 'A' }),
    }),
    query: z.object({
      feed: z.enum(['subway', 'lirr', 'mnr']).openapi({ description: 'Feed the route belongs to' }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: RouteResponseSchema } }, description: 'Route detail' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid parameters' },
    404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Route not found' },
  },
});

routesRouter.openapi(getRouteRoute, (c) => {
  const { route_id: routeId } = c.req.valid('param');
  const { feed: feedId } = c.req.valid('query');

  const route = getRoute(routeId, feedId);

  if (!route) {
    return c.json({ error: `Route ${routeId} not found`, code: 'NOT_FOUND' }, 404 as const);
  }

  return c.json(route, 200 as const);
});
