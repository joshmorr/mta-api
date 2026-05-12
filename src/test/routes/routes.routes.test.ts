import { describe, expect, it, beforeEach } from 'bun:test';
import { routesRouter } from '../../routes/routes.routes';
import { makeTestApp } from '../helpers/app';
import { resetDb, seedSubway, seedLirr } from '../helpers/seed';

const app = makeTestApp(routesRouter, '/routes');

describe('GET /routes', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    seedLirr();
  });

  it('returns 400 when feed is invalid', async () => {
    // The handler validates `feed` manually before parseFeedId, so this is
    // the handler's check (not Zod) — Zod only validates the enum.
    const res = await app.request('/routes?feed=bus');
    expect(res.status).toBe(400);
  });

  it('lists all routes across feeds when no filter', async () => {
    const res = await app.request('/routes');
    const body = (await res.json()) as { routes: Array<{ feed_id: string; route_id: string; name: string; color: string }> };
    expect(body.routes.map((r) => `${r.feed_id}:${r.route_id}`).sort()).toEqual(['lirr:PW', 'subway:1']);
    const sub = body.routes.find((r) => r.feed_id === 'subway')!;
    expect(sub.name).toBe('1');
    expect(sub.color).toBe('#EE352E');
  });

  it('honors feed filter', async () => {
    const res = await app.request('/routes?feed=lirr');
    const body = (await res.json()) as { routes: Array<{ feed_id: string }> };
    expect(body.routes.every((r) => r.feed_id === 'lirr')).toBe(true);
  });
});

describe('GET /routes/:route_id', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
  });

  it('returns 400 when feed missing (Zod)', async () => {
    const res = await app.request('/routes/1');
    expect(res.status).toBe(400);
  });

  it('returns 200 with route detail', async () => {
    const res = await app.request('/routes/1?feed=subway');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { route_id: string; name: string; long_name: string; color: string };
    expect(body.route_id).toBe('1');
    expect(body.long_name).toBe('Broadway - 7 Avenue Local');
    expect(body.color).toBe('#EE352E');
  });

  it('returns 404 when route is missing', async () => {
    const res = await app.request('/routes/NOPE?feed=subway');
    expect(res.status).toBe(404);
  });
});
