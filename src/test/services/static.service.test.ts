import { describe, expect, it, beforeEach } from 'bun:test';
import { isFeedStale } from '../../services/static.service';
import { setFeedMeta } from '../../db/queries/staticFeed';
import { resetDb } from '../helpers/seed';
import { db } from '../../db/client';

describe('isFeedStale', () => {
  beforeEach(() => {
    resetDb();
  });

  it('returns true when feed has never been synced (no row)', () => {
    expect(isFeedStale('subway', 3_600_000)).toBe(true);
  });

  it('returns true when last sync is older than maxAgeMs', () => {
    const twoHoursAgoSec = Math.floor(Date.now() / 1000) - 7200;
    db.run(`INSERT INTO feed_meta (feed_id, last_synced) VALUES ('subway', ?)`, [twoHoursAgoSec]);
    expect(isFeedStale('subway', 3_600_000)).toBe(true); // 1h max
  });

  it('returns false when last sync is within maxAgeMs', () => {
    const thirtyMinAgoSec = Math.floor(Date.now() / 1000) - 1800;
    db.run(`INSERT INTO feed_meta (feed_id, last_synced) VALUES ('subway', ?)`, [thirtyMinAgoSec]);
    expect(isFeedStale('subway', 3_600_000)).toBe(false);
  });

  it('returns false when synced just now', () => {
    setFeedMeta('subway');
    expect(isFeedStale('subway', 3_600_000)).toBe(false);
  });

  it('keys on feedId', () => {
    setFeedMeta('lirr');
    expect(isFeedStale('lirr', 3_600_000)).toBe(false);
    expect(isFeedStale('subway', 3_600_000)).toBe(true);
  });
});
