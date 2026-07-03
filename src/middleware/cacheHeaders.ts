import type { MiddlewareHandler } from 'hono';

/**
 * Adds `Cache-Control` to successful GET responses so a CDN / edge cache (Fly,
 * Cloudflare) can absorb read traffic without the app changing. Everything we
 * serve is already time-bounded-stale by design — realtime is capped by the RT
 * cache TTL, static data changes at most daily — so short shared caching with
 * `stale-while-revalidate` is safe and keeps origin load flat as traffic grows.
 *
 * Only 2xx GETs are tagged; errors (400/404/429/503) and the seeding gate must
 * never be cached, so they are left with no caching directive.
 */

// Realtime-backed endpoints: track upstream freshness closely.
const REALTIME_PREFIXES = ['/arrivals', '/vehicles', '/alerts'];
const REALTIME_CACHE = 'public, max-age=5, stale-while-revalidate=20';

// Static-backed endpoints: change at most once a day.
const STATIC_PREFIXES = ['/stops', '/routes'];
const STATIC_CACHE = 'public, max-age=3600, stale-while-revalidate=86400';

function cacheControlFor(path: string): string | undefined {
  if (REALTIME_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return REALTIME_CACHE;
  if (STATIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return STATIC_CACHE;
  return undefined;
}

export const cacheHeaders: MiddlewareHandler = async (c, next) => {
  await next();

  if (c.req.method !== 'GET') return;
  if (c.res.status !== 200) return;
  if (c.res.headers.has('Cache-Control')) return;

  const value = cacheControlFor(c.req.path);
  if (value) c.header('Cache-Control', value);
};
