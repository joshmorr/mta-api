import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { cacheHeaders } from '../../src/middleware/cacheHeaders';

function makeApp() {
  const app = new Hono();
  app.use('*', cacheHeaders);
  app.get('/arrivals', (c) => c.json({ ok: true }));
  app.get('/stops', (c) => c.json({ ok: true }));
  app.get('/stops/:id', (c) => c.json({ ok: true }));
  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/boom', (c) => c.json({ error: 'x' }, 503));
  app.post('/arrivals', (c) => c.json({ ok: true }));
  return app;
}

describe('cacheHeaders middleware', () => {
  it('sets a short cache on realtime GETs', async () => {
    const res = await makeApp().request('/arrivals');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=5, stale-while-revalidate=20');
  });

  it('sets a long cache on static GETs, including subpaths', async () => {
    const expected = 'public, max-age=3600, stale-while-revalidate=86400';
    expect((await makeApp().request('/stops')).headers.get('Cache-Control')).toBe(expected);
    expect((await makeApp().request('/stops/127')).headers.get('Cache-Control')).toBe(expected);
  });

  it('does not cache unmapped paths like /health', async () => {
    const res = await makeApp().request('/health');
    expect(res.headers.get('Cache-Control')).toBeNull();
  });

  it('does not cache error responses', async () => {
    const res = await makeApp().request('/boom');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBeNull();
  });

  it('does not cache non-GET methods', async () => {
    const res = await makeApp().request('/arrivals', { method: 'POST' });
    expect(res.headers.get('Cache-Control')).toBeNull();
  });
});
