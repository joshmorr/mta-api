import { describe, expect, it, beforeEach } from 'bun:test';
import { stopsRouter } from '../../routes/stops.routes';
import { makeTestApp } from '../helpers/app';
import { resetDb, seedSubway, seedLirr } from '../helpers/seed';

const app = makeTestApp(stopsRouter, '/stops');

describe('GET /stops', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    seedLirr();
  });

  it('returns 400 when feed is invalid', async () => {
    const res = await app.request('/stops?feed=bus');
    expect(res.status).toBe(400);
  });

  it('returns 400 when radius exceeds 1600', async () => {
    const res = await app.request('/stops?lat=40.7&lon=-74&radius=2000');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/radius/);
  });

  it('lists all stops by default (subway parents + rail flat stops)', async () => {
    const res = await app.request('/stops');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stops: Array<{ feed_id: string; stop_id: string; platforms: string[] }> };
    const ids = body.stops.map((s) => `${s.feed_id}:${s.stop_id}`).sort();
    expect(ids).toEqual(['lirr:1', 'lirr:2', 'subway:127']);
    // Subway parent has its platforms enumerated
    const sub = body.stops.find((s) => s.feed_id === 'subway')!;
    expect(sub.platforms.sort()).toEqual(['127N', '127S']);
    // LIRR stops have empty platforms
    expect(body.stops.find((s) => s.feed_id === 'lirr')!.platforms).toEqual([]);
  });

  it('searches by name with q', async () => {
    const res = await app.request('/stops?q=times');
    const body = (await res.json()) as { stops: Array<{ stop_name: string }> };
    expect(body.stops).toHaveLength(1);
    expect(body.stops[0].stop_name).toContain('Times');
  });

  it('searches by proximity with lat/lon', async () => {
    const res = await app.request('/stops?lat=40.7505&lon=-73.9934&radius=1500');
    const body = (await res.json()) as { stops: Array<{ stop_id: string }> };
    expect(body.stops.length).toBeGreaterThan(0);
  });

  it('honors feed filter on listings', async () => {
    const res = await app.request('/stops?feed=lirr');
    const body = (await res.json()) as { stops: Array<{ feed_id: string }> };
    expect(body.stops.every((s) => s.feed_id === 'lirr')).toBe(true);
  });
});

describe('GET /stops/:stop_id', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
  });

  it('returns 400 when feed missing (Zod)', async () => {
    const res = await app.request('/stops/127');
    expect(res.status).toBe(400);
  });

  it('returns 200 with subway platforms enriched with direction labels', async () => {
    const res = await app.request('/stops/127?feed=subway');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stop_id: string;
      platforms: Array<{ stop_id: string; direction: string }>;
    };
    expect(body.stop_id).toBe('127');
    const dirs = body.platforms.reduce<Record<string, string>>((acc, p) => {
      acc[p.stop_id] = p.direction;
      return acc;
    }, {});
    expect(dirs['127N']).toMatch(/Uptown|Northbound/);
    expect(dirs['127S']).toMatch(/Downtown|Southbound/);
  });

  it('resolves a platform stop_id to its parent station', async () => {
    const res = await app.request('/stops/127N?feed=subway');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stop_id: string; platforms: unknown[] };
    expect(body.stop_id).toBe('127');
    expect(body.platforms).toHaveLength(2);
  });

  it('returns 404 when stop is missing', async () => {
    const res = await app.request('/stops/nope?feed=subway');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });
});
