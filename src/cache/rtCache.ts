import * as protobuf from 'protobufjs';
import { join } from 'path';
import type { FeedMessage } from '../types/gtfs';
import { MTA_RT_BASE, getRtCacheTtlMs } from '../services/feed.service';
import { config } from '../config';
import { log } from '../utils/logger';

interface CacheEntry {
  feedMessage: FeedMessage;
  fetchedAt: number;
}

let FeedMessageType: protobuf.Type | undefined;
let feedMessageTypePromise: Promise<protobuf.Type> | undefined;

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<FeedMessage>>();

// Feed paths currently known to be failing upstream. With a 10s TTL a broken
// feed would otherwise log on nearly every request, so only the transitions
// into and out of degraded state are recorded — that's the signal worth
// alerting on ("ACE has been down for 20 minutes"), not the per-request noise.
const degraded = new Set<string>();

function markDegraded(feedPath: string, err: unknown, servingStale: boolean): void {
  if (degraded.has(feedPath)) return;
  degraded.add(feedPath);
  log.error(
    { err, feedPath, serving_stale: servingStale },
    servingStale ? 'feed degraded, serving stale cache' : 'feed degraded, no cache to fall back on',
  );
}

function markRecovered(feedPath: string): void {
  if (!degraded.delete(feedPath)) return;
  log.info({ feedPath }, 'feed recovered');
}

function getFeedMessageType(): Promise<protobuf.Type> {
  if (FeedMessageType) return Promise.resolve(FeedMessageType);
  if (feedMessageTypePromise) return feedMessageTypePromise;
  // The MTA's vendor extensions ride on the same FeedMessage, so all three
  // load into one root. MTARR is field 1005 and Mercury 1001 on Alert /
  // EntitySelector, which don't collide. The NYCT extensions are deliberately
  // absent: they claim 1001 on FeedHeader, which Mercury also claims, and
  // loading both throws "duplicate id 1001 in Type .transit_realtime.FeedHeader".
  feedMessageTypePromise = protobuf
    .load([
      join(import.meta.dir, '../proto/gtfs-realtime.proto'),
      join(import.meta.dir, '../proto/gtfs-realtime-MTARR.proto'),
      join(import.meta.dir, '../proto/gtfs-realtime-service-status.proto'),
    ])
    .then((root) => {
      FeedMessageType = root.lookupType('transit_realtime.FeedMessage');
      return FeedMessageType;
    });
  return feedMessageTypePromise;
}

async function fetchAndParse(feedPath: string): Promise<FeedMessage> {
  const url = `${MTA_RT_BASE}/${encodeURIComponent(feedPath)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(config.rtFetchTimeoutMs) });
  if (!response.ok) {
    throw new Error(`MTA feed ${feedPath} returned HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const type = await getFeedMessageType();
  const msg = type.decode(new Uint8Array(buffer)) as unknown as FeedMessage;
  cache.set(feedPath, { feedMessage: msg, fetchedAt: Date.now() });
  markRecovered(feedPath);
  return msg;
}

/** Test-only: drop all cached entries and pending fetches. */
export function __resetRtCacheForTests(): void {
  cache.clear();
  pending.clear();
  degraded.clear();
}

export async function getFeed(feedPath: string): Promise<{ feedMessage: FeedMessage; stale: boolean; feed_error?: string }> {
  const cached = cache.get(feedPath);

  if (cached && Date.now() - cached.fetchedAt < getRtCacheTtlMs(feedPath)) {
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
    markDegraded(feedPath, err, cached !== undefined);
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
