import * as protobuf from 'protobufjs';
import { join } from 'path';
import type { FeedMessage } from '../types/gtfs';
import { MTA_RT_BASE } from '../services/feedRouter';
import { config } from '../config';

interface CacheEntry {
  feedMessage: FeedMessage;
  fetchedAt: number;
}

let FeedMessageType: protobuf.Type;
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<FeedMessage>>();

async function getFeedMessageType(): Promise<protobuf.Type> {
  if (FeedMessageType) return FeedMessageType;
  const root = await protobuf.load(join(import.meta.dir, '../proto/gtfs-realtime.proto'));
  FeedMessageType = root.lookupType('transit_realtime.FeedMessage');
  return FeedMessageType;
}

async function fetchAndParse(feedPath: string): Promise<FeedMessage> {
  const url = `${MTA_RT_BASE}/${feedPath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`MTA feed ${feedPath} returned HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const type = await getFeedMessageType();
  const msg = type.decode(new Uint8Array(buffer)) as unknown as FeedMessage;
  cache.set(feedPath, { feedMessage: msg, fetchedAt: Date.now() });
  return msg;
}

export async function getFeed(feedPath: string): Promise<{ feedMessage: FeedMessage; stale: boolean; feed_error?: string }> {
  const cached = cache.get(feedPath);

  if (cached && Date.now() - cached.fetchedAt < config.rtCacheTtlMs) {
    return { feedMessage: cached.feedMessage, stale: false };
  }

  if (pending.has(feedPath)) {
    try {
      const feedMessage = await pending.get(feedPath)!;
      return { feedMessage, stale: false };
    } catch {
      // fall through to stale check below
    }
  }

  const promise = fetchAndParse(feedPath).finally(() => pending.delete(feedPath));
  pending.set(feedPath, promise);

  try {
    const feedMessage = await promise;
    return { feedMessage, stale: false };
  } catch (err) {
    if (cached) {
      return {
        feedMessage: cached.feedMessage,
        stale: true,
        feed_error: err instanceof Error ? err.message : 'Unknown feed error',
      };
    }
    throw err;
  }
}
