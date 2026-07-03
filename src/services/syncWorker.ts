/**
 * Runs on a dedicated Worker thread. Its whole job is to run the heavy
 * fetch + unzip + parse + SQLite-insert of a static GTFS feed OFF the main
 * HTTP thread, so the server's event loop never blocks (see syncManager.ts).
 *
 * Because a Worker has its own module graph, importing the query layer here
 * opens this thread's OWN bun:sqlite connection to the same DB file. WAL mode
 * (set in db/client.ts) lets this writer coexist with the main thread's reads.
 */
import { runMigrations } from '../db/client';
import { syncSubwayFeed, syncLirrFeed, syncMnrFeed } from './static.service';
import type { FeedId } from '../types/gtfs';

declare const self: Worker;

// Ensure the schema exists on THIS connection before any sync writes
// (idempotent — CREATE TABLE IF NOT EXISTS). Covers first empty-DB boot.
runMigrations();

const SYNC_FNS: Record<FeedId, () => Promise<void>> = {
  subway: syncSubwayFeed,
  lirr: syncLirrFeed,
  mnr: syncMnrFeed,
};

type SyncRequest = { id: number; feed: FeedId };

// Serialize work so two heavy syncs never run in parallel on the one vCPU.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent) => {
  const { id, feed } = event.data as SyncRequest;
  queue = queue.then(async () => {
    try {
      await SYNC_FNS[feed]();
      self.postMessage({ id, feed, ok: true });
    } catch (err) {
      self.postMessage({
        id,
        feed,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
};
