import { describe, expect, it, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { rateLimit } from '../../middleware/rateLimit';

function makeApp() {
  const app = new Hono();
  app.use('*', rateLimit);
  app.get('/health', (c) => c.text('ok'));
  app.get('/anything', (c) => c.text('ok'));
  return app;
}

function req(path: string, ip = '1.2.3.4') {
  return new Request(`http://x${path}`, { headers: { 'x-forwarded-for': ip } });
}

describe('rateLimit middleware', () => {
  // Each test uses a unique IP so the module-level store doesn't leak state.
  let counter = 0;
  beforeEach(() => {
    counter++;
  });
  const ip = () => `10.0.0.${counter}`;

  it('skips rate limiting for /health', async () => {
    const app = makeApp();
    for (let i = 0; i < 200; i++) {
      const res = await app.request(req('/health', ip()));
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBeNull();
    }
  });

  it('sets RateLimit headers on regular requests', async () => {
    const app = makeApp();
    const res = await app.request(req('/anything', ip()));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('99');
    expect(Number(res.headers.get('X-RateLimit-Reset'))).toBeGreaterThan(0);
  });

  it('decrements Remaining across calls from the same IP', async () => {
    const app = makeApp();
    const myIp = ip();
    await app.request(req('/anything', myIp));
    const res = await app.request(req('/anything', myIp));
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('98');
  });

  it('returns 429 once MAX_REQUESTS is exceeded', async () => {
    const app = makeApp();
    const myIp = ip();
    let lastStatus = 0;
    for (let i = 0; i < 100; i++) {
      const res = await app.request(req('/anything', myIp));
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(200); // 100th request — at the limit, still allowed
    const overflow = await app.request(req('/anything', myIp));
    expect(overflow.status).toBe(429);
    const body = (await overflow.json()) as { code: string };
    expect(body.code).toBe('RATE_LIMITED');
  });

  it('uses the first entry when x-forwarded-for is comma-separated', async () => {
    const app = makeApp();
    const a = `${ip()}, 9.9.9.9, 8.8.8.8`;
    const b = `${ip()}-other, 9.9.9.9, 8.8.8.8`;
    // Same first IP → shared bucket.
    const r1 = await app.request(req('/anything', a));
    const r2 = await app.request(req('/anything', a));
    expect(r1.headers.get('X-RateLimit-Remaining')).toBe('99');
    expect(r2.headers.get('X-RateLimit-Remaining')).toBe('98');
    // Different first IP → separate bucket.
    const r3 = await app.request(req('/anything', b));
    expect(r3.headers.get('X-RateLimit-Remaining')).toBe('99');
  });

  it('prefers fly-client-ip over a spoofable x-forwarded-for', async () => {
    const app = makeApp();
    const real = ip();
    // Attacker rotates the forgeable XFF header but Fly-Client-IP is constant.
    const r1 = await app.request(
      new Request('http://x/anything', {
        headers: { 'fly-client-ip': real, 'x-forwarded-for': '1.1.1.1' },
      }),
    );
    const r2 = await app.request(
      new Request('http://x/anything', {
        headers: { 'fly-client-ip': real, 'x-forwarded-for': '2.2.2.2' },
      }),
    );
    expect(r1.headers.get('X-RateLimit-Remaining')).toBe('99');
    expect(r2.headers.get('X-RateLimit-Remaining')).toBe('98'); // same bucket
  });

  it('falls back to "unknown" when no x-forwarded-for header is present', async () => {
    const app = makeApp();
    const res = await app.request(new Request('http://x/anything'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
  });
});
