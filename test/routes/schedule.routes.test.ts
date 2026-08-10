import { describe, expect, it, beforeEach } from 'bun:test';
import { scheduleRouter } from '../../src/routes/schedule.routes';
import { makeTestApp } from '../helpers/app';
import { resetDb, seedLirrSchedule, seedSubwaySchedule } from '../helpers/seed';

const app = makeTestApp(scheduleRouter, '/schedule');

describe('GET /schedule', () => {
  beforeEach(() => {
    resetDb();
  });

  it('returns 400 when feed is missing', async () => {
    const res = await app.request('/schedule?from=44&to=237');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_PARAM');
  });

  it('returns 400 when feed is invalid', async () => {
    const res = await app.request('/schedule?from=44&to=237&feed=bus');
    expect(res.status).toBe(400);
  });

  it('returns 400 when `to` is missing, pointing at /arrivals', async () => {
    const res = await app.request('/schedule?from=44&feed=lirr');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('INVALID_PARAM');
    expect(body.error).toMatch(/^to: /);
    expect(body.error).toMatch(/\/arrivals/);
  });

  it('returns 400 when `from` is missing', async () => {
    const res = await app.request('/schedule?to=237&feed=lirr');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/from/);
  });

  it('returns 400 when date is not YYYYMMDD', async () => {
    const res = await app.request('/schedule?from=44&to=237&feed=lirr&date=2026-08-10');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/date/);
  });

  it('returns 400 when after is not a number', async () => {
    const res = await app.request('/schedule?from=44&to=237&feed=lirr&after=soon');
    expect(res.status).toBe(400);
  });

  it('clamps limit to 100', async () => {
    seedLirrSchedule();
    const res = await app.request('/schedule?from=44&to=237&feed=lirr&date=20240115&limit=99999');
    expect(res.status).toBe(200);
    // Just confirms the request succeeds with an over-max limit rather than 400ing.
  });

  it('returns 404 for an unknown origin stop, with an origin-specific message', async () => {
    seedLirrSchedule();
    const res = await app.request('/schedule?from=nope&to=237&feed=lirr');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('NOT_FOUND');
    expect(body.error).toMatch(/Origin stop nope not found/);
  });

  it('returns 404 for an unknown destination stop, with a destination-specific message', async () => {
    seedLirrSchedule();
    const res = await app.request('/schedule?from=44&feed=lirr&to=nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Destination stop nope not found/);
  });

  it('returns the real Deer Park -> Penn Station example end to end', async () => {
    seedLirrSchedule();
    const res = await app.request('/schedule?from=44&feed=lirr&to=237&date=20240115&limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      from_stop_name: string;
      to_stop_name: string;
      source: string;
      departures: Array<{ trip_id: string; destination: { stop_name: string; duration_seconds: number } }>;
    };
    expect(body.from_stop_name).toBe('Deer Park');
    expect(body.to_stop_name).toBe('Penn Station');
    expect(body.source).toBe('scheduled');
    expect(body.departures).toHaveLength(1);
    expect(body.departures[0].destination.stop_name).toBe('Penn Station');
    expect(body.departures[0].destination.duration_seconds).toBeGreaterThan(0);
  });

  it('resolves subway platforms to their parent stations on both ends', async () => {
    seedSubwaySchedule();
    const res = await app.request('/schedule?from=101N&to=127N&feed=subway&date=20240115');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { from_stop_id: string; to_stop_id: string };
    expect(body.from_stop_id).toBe('101');
    expect(body.to_stop_id).toBe('127');
  });
});
