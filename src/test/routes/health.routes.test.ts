import { describe, expect, it, beforeEach } from 'bun:test';
import { healthRouter } from '../../routes/health.routes';
import { makeTestApp } from '../helpers/app';
import { setFeedMeta } from '../../db/queries/staticFeed';
import { refreshHealthCache } from '../../services/healthCache';
import { resetDb, seedSubway, seedLirr } from '../helpers/seed';
import { state } from '../../state';

const app = makeTestApp(healthRouter, '/health');

type HealthBody = {
  status: string;
  syncing: boolean;
  totals: { stop_count: number; route_count: number };
  static_feeds: Record<
    string,
    { last_synced: number | null; stop_count: number; route_count: number; syncing: boolean }
  >;
};

describe('GET /health', () => {
  beforeEach(() => {
    resetDb();
    // /health serves cached counts; reset the cache to reflect the emptied DB.
    refreshHealthCache();
    state.syncing.subway = false;
    state.syncing.lirr = false;
    state.syncing.mnr = false;
  });

  it('returns ok with zeros when DB is empty and no feeds synced', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.syncing).toBe(false);
    expect(body.totals).toEqual({ stop_count: 0, route_count: 0 });
    expect(body.static_feeds.subway.last_synced).toBeNull();
    expect(body.static_feeds.subway.stop_count).toBe(0);
    expect(body.static_feeds.subway.syncing).toBe(false);
  });

  it('reflects per-feed counts and last_synced timestamps', async () => {
    seedSubway();
    seedLirr();
    setFeedMeta('subway');
    refreshHealthCache();

    const res = await app.request('/health');
    const body = (await res.json()) as HealthBody;
    expect(body.totals.stop_count).toBe(3); // 1 subway parent + 2 lirr
    expect(body.totals.route_count).toBe(2);
    expect(body.static_feeds.subway).toEqual({
      last_synced: expect.any(Number) as never,
      stop_count: 1,
      route_count: 1,
      syncing: false,
    });
    expect(body.static_feeds.lirr.stop_count).toBe(2);
    expect(body.static_feeds.lirr.last_synced).toBeNull();
  });

  it('fails readiness with 503 and status "seeding" while the initial seed runs', async () => {
    state.seeding = true;
    try {
      const res = await app.request('/health');
      expect(res.status).toBe(503);
      const body = (await res.json()) as HealthBody;
      expect(body.status).toBe('seeding');
    } finally {
      state.seeding = false;
    }
  });

  it('surfaces in-progress syncs from state', async () => {
    state.syncing.subway = true;

    const res = await app.request('/health');
    const body = (await res.json()) as HealthBody;
    expect(body.syncing).toBe(true);
    expect(body.static_feeds.subway.syncing).toBe(true);
    expect(body.static_feeds.lirr.syncing).toBe(false);
    expect(body.static_feeds.mnr.syncing).toBe(false);
  });
});
