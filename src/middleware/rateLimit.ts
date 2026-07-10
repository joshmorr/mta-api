import type { MiddlewareHandler } from 'hono';
import { config } from '../config';

// Per-instance, fixed-window throttle. NOTE: this is deliberately NOT a global
// quota. fly.toml runs min_machines_running >= 2, each machine holds its own
// `store`, and the LB spreads a client's requests across machines — so the
// effective ceiling a client hits is (machines * rateLimitMax), and the
// X-RateLimit-Remaining a client sees varies by which machine served it. The
// goal here is to protect each instance from overload/abuse, not to enforce a
// cluster-wide cap. Upstream MTA feeds are already shielded by the RT cache
// (20s TTL + promise dedup), so a true global quota would need shared state
// (e.g. Redis) that this project intentionally avoids.
const WINDOW_MS = config.rateLimitWindowMs;
const MAX_REQUESTS = config.rateLimitMax;

const store = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of store) {
    if (now >= entry.resetAt) store.delete(ip);
  }
}, WINDOW_MS).unref();

export const rateLimit: MiddlewareHandler = async (c, next) => {
  if (c.req.path === '/health') {
    await next();
    return;
  }

  // In production every request arrives via Fly's edge, which always sets
  // fly-client-ip, so each real client gets its own bucket. The 'unknown'
  // fallback only bites if the server is reached without that header (direct
  // hits, local dev, a different edge) — there all header-less requests would
  // share one bucket and throttle each other.
  const ip =
    c.req.header('fly-client-ip')?.trim() ||
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown';
  const now = Date.now();
  let entry = store.get(ip);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 1, resetAt: now + WINDOW_MS };
    store.set(ip, entry);
  } else {
    entry.count++;
  }

  c.header('X-RateLimit-Limit', String(MAX_REQUESTS));
  c.header('X-RateLimit-Remaining', String(Math.max(0, MAX_REQUESTS - entry.count)));
  c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

  if (entry.count > MAX_REQUESTS) {
    // Retry-After (delta seconds) is the standard header clients/libraries
    // honor for backoff; X-RateLimit-Reset (epoch seconds) is informational.
    c.header('Retry-After', String(Math.max(0, Math.ceil((entry.resetAt - now) / 1000))));
    return c.json({ error: 'Too many requests', code: 'RATE_LIMITED' }, 429);
  }

  await next();
};
