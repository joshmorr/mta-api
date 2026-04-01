import { describe, expect, it, mock, beforeEach } from 'bun:test';

// mock.module is hoisted before imports by Bun's test runner
const mockGetFeedMeta = mock(() => null as number | null);

mock.module('../../db/queries/staticFeed', () => ({
  getFeedMeta: mockGetFeedMeta,
  clearFeedData: () => {},
  isDbEmpty: () => false,
  setFeedMeta: () => {},
  upsertCalendar: () => {},
  upsertCalendarDates: () => {},
  upsertRoutes: () => {},
  upsertStops: () => {},
  upsertStopTimesBatch: () => ({ push: () => {}, flush: () => {} }),
  upsertTrips: () => {},
}));

import { isFeedStale } from '../../services/static.service';

describe('isFeedStale', () => {
  beforeEach(() => {
    mockGetFeedMeta.mockReset();
  });

  it('returns true when feed has never been synced (null)', () => {
    mockGetFeedMeta.mockReturnValue(null);
    expect(isFeedStale('subway', 3600_000)).toBe(true);
  });

  it('returns true when last sync is older than maxAgeMs', () => {
    const twoHoursAgoSec = Math.floor(Date.now() / 1000) - 7200;
    mockGetFeedMeta.mockReturnValue(twoHoursAgoSec);
    // maxAgeMs = 1 hour → 2-hour-old feed is stale
    expect(isFeedStale('subway', 3600_000)).toBe(true);
  });

  it('returns false when last sync is within maxAgeMs', () => {
    const thirtyMinAgoSec = Math.floor(Date.now() / 1000) - 1800;
    mockGetFeedMeta.mockReturnValue(thirtyMinAgoSec);
    // maxAgeMs = 1 hour → 30-min-old feed is fresh
    expect(isFeedStale('subway', 3600_000)).toBe(false);
  });

  it('returns false when synced just now', () => {
    mockGetFeedMeta.mockReturnValue(Math.floor(Date.now() / 1000));
    expect(isFeedStale('subway', 3600_000)).toBe(false);
  });

  it('passes feedId through to getFeedMeta', () => {
    mockGetFeedMeta.mockReturnValue(null);
    isFeedStale('lirr', 3600_000);
    expect(mockGetFeedMeta).toHaveBeenCalledWith('lirr');
  });
});
