import { describe, expect, it } from 'bun:test';
import {
  ALERTS_FEED_PATH,
  ALERTS_RT_CACHE_TTL_MS,
  getFeedPath,
  getFeedPathsForRoutes,
  getRtCacheTtlMs,
  SUBWAY_ROUTE_TO_FEED,
} from '../../src/services/feed.service';
import { config } from '../../src/config';

describe('getFeedPath', () => {
  it('returns the LIRR feed path regardless of routeId', () => {
    expect(getFeedPath('lirr', '')).toBe('lirr/gtfs-lirr');
    expect(getFeedPath('lirr', 'Port Washington')).toBe('lirr/gtfs-lirr');
  });

  it('returns the MNR feed path regardless of routeId', () => {
    expect(getFeedPath('mnr', '')).toBe('mnr/gtfs-mnr');
    expect(getFeedPath('mnr', 'Hudson')).toBe('mnr/gtfs-mnr');
  });

  it('returns the correct subway feed for each route group', () => {
    // 1-7
    for (const r of ['1', '2', '3', '4', '5', '6', '6X', '7', '7X', 'GS']) {
      expect(getFeedPath('subway', r)).toBe('nyct/gtfs');
    }
    // ACE
    for (const r of ['A', 'C', 'E', 'H', 'FS']) {
      expect(getFeedPath('subway', r)).toBe('nyct/gtfs-ace');
    }
    // BDFM
    for (const r of ['B', 'D', 'F', 'FX', 'M']) {
      expect(getFeedPath('subway', r)).toBe('nyct/gtfs-bdfm');
    }
    expect(getFeedPath('subway', 'G')).toBe('nyct/gtfs-g');
    for (const r of ['J', 'Z']) {
      expect(getFeedPath('subway', r)).toBe('nyct/gtfs-jz');
    }
    expect(getFeedPath('subway', 'L')).toBe('nyct/gtfs-l');
    for (const r of ['N', 'Q', 'R', 'W']) {
      expect(getFeedPath('subway', r)).toBe('nyct/gtfs-nqrw');
    }
    expect(getFeedPath('subway', 'SI')).toBe('nyct/gtfs-si');
  });

  it('returns undefined for an unrecognized subway route', () => {
    expect(getFeedPath('subway', 'X')).toBeUndefined();
    expect(getFeedPath('subway', '')).toBeUndefined();
    expect(getFeedPath('subway', 'a')).toBeUndefined(); // case-sensitive
  });

  it('covers every entry in SUBWAY_ROUTE_TO_FEED', () => {
    for (const [routeId, feedPath] of Object.entries(SUBWAY_ROUTE_TO_FEED)) {
      expect(getFeedPath('subway', routeId)).toBe(feedPath);
    }
  });
});

describe('getFeedPathsForRoutes', () => {
  it('returns an empty Set for an empty array', () => {
    expect(getFeedPathsForRoutes([])).toEqual(new Set());
  });

  it('deduplicates feed paths when multiple routes share a feed', () => {
    const routes = [
      { feed_id: 'subway' as const, route_id: 'A' },
      { feed_id: 'subway' as const, route_id: 'C' },
      { feed_id: 'subway' as const, route_id: 'E' },
    ];
    const result = getFeedPathsForRoutes(routes);
    expect(result).toEqual(new Set(['nyct/gtfs-ace']));
  });

  it('collects multiple distinct feed paths', () => {
    const routes = [
      { feed_id: 'subway' as const, route_id: '1' },
      { feed_id: 'subway' as const, route_id: 'A' },
      { feed_id: 'subway' as const, route_id: 'G' },
    ];
    const result = getFeedPathsForRoutes(routes);
    expect(result).toEqual(new Set(['nyct/gtfs', 'nyct/gtfs-ace', 'nyct/gtfs-g']));
  });

  it('handles LIRR and MNR entries', () => {
    const routes = [
      { feed_id: 'lirr' as const, route_id: 'Port Washington' },
      { feed_id: 'mnr' as const, route_id: 'Hudson' },
    ];
    const result = getFeedPathsForRoutes(routes);
    expect(result).toEqual(new Set(['lirr/gtfs-lirr', 'mnr/gtfs-mnr']));
  });

  it('omits unknown subway routes', () => {
    const routes = [
      { feed_id: 'subway' as const, route_id: 'A' },
      { feed_id: 'subway' as const, route_id: 'UNKNOWN' },
    ];
    const result = getFeedPathsForRoutes(routes);
    expect(result).toEqual(new Set(['nyct/gtfs-ace']));
  });

  it('mixes feeds and deduplicates across them', () => {
    const routes = [
      { feed_id: 'subway' as const, route_id: 'N' },
      { feed_id: 'subway' as const, route_id: 'Q' },
      { feed_id: 'lirr' as const, route_id: 'anything' },
      { feed_id: 'lirr' as const, route_id: 'again' },
    ];
    const result = getFeedPathsForRoutes(routes);
    expect(result).toEqual(new Set(['nyct/gtfs-nqrw', 'lirr/gtfs-lirr']));
  });
});

describe('getRtCacheTtlMs', () => {
  it('gives the alerts feed its own TTL', () => {
    expect(getRtCacheTtlMs(ALERTS_FEED_PATH)).toBe(ALERTS_RT_CACHE_TTL_MS);
  });

  it('caches alerts longer than the vehicle feeds', () => {
    // The whole point of the carve-out: alerts publish ~181s apart at ~570KB,
    // so they must not share the vehicle-feed TTL.
    expect(ALERTS_RT_CACHE_TTL_MS).toBeGreaterThan(config.rtCacheTtlMs);
  });

  it('keeps the alerts TTL under a minute', () => {
    // Cache age is the only lag this API adds on top of upstream, so it stays
    // comfortably under a minute. Raising it toward the ~180s upstream cadence
    // would mean surfacing cache age on the response first. Guard the bound,
    // not the number.
    expect(ALERTS_RT_CACHE_TTL_MS).toBeLessThan(60_000);
  });

  it('uses the shared TTL for every vehicle feed path', () => {
    const vehicleFeeds = new Set([
      ...Object.values(SUBWAY_ROUTE_TO_FEED),
      'lirr/gtfs-lirr',
      'mnr/gtfs-mnr',
    ]);

    expect(vehicleFeeds.size).toBe(10);
    for (const path of vehicleFeeds) {
      expect(getRtCacheTtlMs(path)).toBe(config.rtCacheTtlMs);
    }
  });

  it('falls back to the shared TTL for an unrecognized path', () => {
    expect(getRtCacheTtlMs('nyct/gtfs-future-line')).toBe(config.rtCacheTtlMs);
  });
});
