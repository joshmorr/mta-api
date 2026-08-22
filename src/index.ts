import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { timing } from 'hono/timing';
import { config } from './config';
import { startup } from './startup';
import {
  stopsRouter,
  routesRouter,
  arrivalsRouter,
  vehiclesRouter,
  alertsRouter,
  healthRouter,
  scheduleRouter,
  tripsRouter,
} from './routes';
import { rateLimit } from './middleware/rateLimit';
import { cacheHeaders } from './middleware/cacheHeaders';
import { openApiDocConfig, normalizeOpenApiPaths } from './openapi';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildMcpServer } from './mcp/server';
import { log } from './utils/logger';
import { requestLogger } from './middleware/requestLogger';

const app = new OpenAPIHono();

app.use('*', requestLogger);
app.use('*', timing());
app.use('*', cacheHeaders);
app.use('*', rateLimit);

app.onError((err, c) => {
  // The access log records the 500, but not *which* request produced it, so
  // carry the request identity alongside the stack.
  log.error({ err, method: c.req.method, path: c.req.path }, 'unhandled error');
  return c.json({ error: 'Internal server error', code: 'INTERNAL' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

app.route('/stops', stopsRouter);
app.route('/routes', routesRouter);
app.route('/arrivals', arrivalsRouter);
app.route('/vehicles', vehiclesRouter);
app.route('/alerts', alertsRouter);
app.route('/health', healthRouter);
app.route('/schedule', scheduleRouter);
app.route('/trips', tripsRouter);

// Serve the spec with Hono `:param` path keys normalized to OpenAPI `{param}`,
// so the live endpoint matches the committed `openapi.json` and codegen tools
// (openapi-typescript, orval, …) that consume `/doc` get spec-compliant paths.
app.get('/doc', (c) => c.json(normalizeOpenApiPaths(app.getOpenAPIDocument(openApiDocConfig))));

app.get('/ui', swaggerUI({ url: '/doc' }));

// MCP over streamable HTTP, serving the same tools as the stdio entrypoint.
// Deliberately outside the OpenAPI document: /doc describes the REST surface,
// and an MCP client discovers this endpoint's capabilities by handshake.
const mcp = createMcpHandler(buildMcpServer, {
  onerror: (err) => log.error({ err, transport: 'http' }, 'mcp error'),
});
app.all('/mcp', (c) => mcp.fetch(c.req.raw));

startup()
  .then(() => log.info({ host: config.host, port: config.port }, 'server listening'))
  .catch((err) => {
    log.fatal({ err }, 'startup failed');
    process.exit(1);
  });

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
};
