import { describe, expect, it, beforeEach } from 'bun:test';
import { tripsRouter } from '../../src/routes/trips.routes';
import { makeTestApp } from '../helpers/app';
import { resetDb, seedLirrSchedule, seedMnrSchedule } from '../helpers/seed';

const app = makeTestApp(tripsRouter, '/trips');

describe('GET /trips/:trip_id', () => {
  beforeEach(() => {
    resetDb();
  });

  it('returns 400 when feed is missing', async () => {
    const res = await app.request('/trips/GO201_26_SCHED');
    expect(res.status).toBe(400);
  });

  it('returns 400 when date is not YYYYMMDD', async () => {
    seedLirrSchedule();
    const res = await app.request('/trips/GO201_26_SCHED?feed=lirr&date=8/10/2026');
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown trip', async () => {
    seedLirrSchedule();
    const res = await app.request('/trips/nope?feed=lirr');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns 404 for MNR with a feed-specific message, without a suffix-match attempt', async () => {
    seedMnrSchedule();
    const res = await app.request('/trips/some-realtime-id?feed=mnr');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Metro-North's realtime trip IDs can't be resolved/);
  });

  it('resolves a real LIRR trip end to end', async () => {
    seedLirrSchedule();
    const res = await app.request('/trips/GO201_26_SCHED?feed=lirr&date=20240115');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matched_by: string;
      resolved_trip_id: string;
      route_long_name: string;
      origin: { stop_id: string };
      destination: { stop_id: string };
      stops: unknown[];
    };
    expect(body.matched_by).toBe('exact');
    expect(body.resolved_trip_id).toBe('GO201_26_SCHED');
    expect(body.route_long_name).toBe('Ronkonkoma Branch');
    expect(body.origin.stop_id).toBe('44');
    expect(body.destination.stop_id).toBe('237');
    expect(body.stops).toHaveLength(3);
  });
});
