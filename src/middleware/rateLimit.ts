import type { MiddlewareHandler } from 'hono';

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 100;

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

  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
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
    return c.json({ error: 'Too many requests', code: 'RATE_LIMITED' }, 429);
  }

  await next();
};
