// The seeding-state gate lives inline in src/index.ts:16–21. Importing
// index.ts triggers startup() and registers intervals, which is undesirable
// for tests, so we replicate the middleware here against the real `state`
// singleton to verify the same behavior.
import { describe, expect, it, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { state } from '../../state';

function makeAppWithGate() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (state.seeding && c.req.path !== '/health') {
      return c.json({ error: 'Service is seeding initial data', code: 'SEEDING' }, 503);
    }
    await next();
  });
  app.get('/health', (c) => c.text('ok'));
  app.get('/anything', (c) => c.text('ok'));
  return app;
}

describe('seeding-state gate middleware', () => {
  afterEach(() => {
    state.seeding = false;
  });

  it('returns 503 with code SEEDING for non-/health paths while seeding', async () => {
    state.seeding = true;
    const res = await makeAppWithGate().request('/anything');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SEEDING');
  });

  it('lets /health through even while seeding', async () => {
    state.seeding = true;
    const res = await makeAppWithGate().request('/health');
    expect(res.status).toBe(200);
  });

  it('passes everything through once seeding completes', async () => {
    state.seeding = false;
    const res = await makeAppWithGate().request('/anything');
    expect(res.status).toBe(200);
  });
});
