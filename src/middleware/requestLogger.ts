import type { MiddlewareHandler } from 'hono';
import { pinoLogger } from 'hono-pino';
import { log } from '../utils/logger';

/**
 * Access log. Replaces `hono/logger`, which wrote a two-line `<-- / -->` pair
 * per request to *stdout* — unstructured, uncorrelated under concurrency, and
 * on the wrong stream (see src/utils/logger.ts).
 *
 * `/health` is skipped. fly.toml polls it every 15s, and at two lines a request
 * that was ~11.5k lines/day/machine of probe traffic burying everything else.
 * `rateLimit` already exempts the same path for the same reason.
 */

// hono-pino logs `req.url` as the path only, dropping the query string. That is
// the right default for privacy but strips the entire meaning of a request here
// — `GET /arrivals 503` says nothing about *which* stop or feed failed — so the
// params are re-attached explicitly, minus the ones that locate a person.
const LOCATION_PARAMS = new Set(['lat', 'lon']);

function safeQuery(url: string): Record<string, string> | undefined {
  const q = new URL(url).searchParams;
  const out: Record<string, string> = {};
  for (const [k, v] of q) {
    out[k] = LOCATION_PARAMS.has(k) ? '[redacted]' : v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const honoPino = pinoLogger({
  pino: log,
  http: {
    reqId: () => crypto.randomUUID(),
    onResLevel: (c) => (c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info'),
  },
});

export const requestLogger: MiddlewareHandler = async (c, next) => {
  if (c.req.path === '/health') {
    await next();
    return;
  }

  return honoPino(c, async () => {
    const query = safeQuery(c.req.url);
    if (query) c.get('logger')?.assign({ query });
    await next();
  });
};
