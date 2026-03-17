import { describe, expect, it } from 'bun:test';
import { parseFeedId } from '../../utils/feedParams';

describe('parseFeedId', () => {
  it.each(['subway', 'lirr', 'mnr'] as const)('returns "%s" for valid feed id', (id) => {
    expect(parseFeedId(id)).toBe(id);
  });

  it('returns undefined for an unrecognized string', () => {
    expect(parseFeedId('bus')).toBeUndefined();
    expect(parseFeedId('SUBWAY')).toBeUndefined();
    expect(parseFeedId('Subway')).toBeUndefined();
    expect(parseFeedId('')).toBeUndefined();
    expect(parseFeedId('nyct')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(parseFeedId(undefined)).toBeUndefined();
  });
});
