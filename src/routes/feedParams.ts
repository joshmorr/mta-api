import type { FeedId } from '../types/gtfs';

export function parseFeedId(value: string | undefined): FeedId | undefined {
  if (value === 'subway' || value === 'lirr' || value === 'mnr') return value;
  return undefined;
}