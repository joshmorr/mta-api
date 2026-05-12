import { describe, expect, it, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { rateLimit } from '../../middleware/rateLimit';

const realDateNow = Date.now;
afterEach(() => {
  Date.now = realDateNow;
});

function makeApp() {
  const app = new Hono();
  app.use('*', rateLimit);
  app.get('/anything', (c) => c.text('ok'));
  return app;
}

function req(ip: string) {
  return new Request('http://x/anything', { headers: { 'x-forwarded-for': ip } });
}

describe('rateLimit window reset', () => {
  it('returns to 200 after WINDOW_MS elapses, with a fresh budget', async () => {
    let now = 1_700_000_000_000;
    Date.now = () => now;
    const app = makeApp();
    const ip = '10.99.0.1';

    // Burn through the budget — 100th call still 200, 101st is 429.
    for (let i = 0; i < 100; i++) await app.request(req(ip));
    expect((await app.request(req(ip))).status).toBe(429);

    // Advance just past the 60s window.
    now += 60_001;
    const after = await app.request(req(ip));
    expect(after.status).toBe(200);
    expect(after.headers.get('X-RateLimit-Remaining')).toBe('99'); // counter reset, this was call 1
  });

  it('emits a sane X-RateLimit-Reset header (epoch seconds in the near future)', async () => {
    const fixed = 1_700_000_000_000;
    Date.now = () => fixed;
    const app = makeApp();
    const res = await app.request(req('10.99.0.2'));
    const reset = Number(res.headers.get('X-RateLimit-Reset'));
    // Expect ~now+60s in epoch seconds (ceil)
    expect(reset).toBe(Math.ceil((fixed + 60_000) / 1000));
  });
});
