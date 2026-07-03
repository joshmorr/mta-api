/**
 * Main-thread dispatcher for static-feed syncs. Instead of running the heavy
 * unzip/parse/insert inline (which blocks Bun's single event loop and makes the
 * HTTP server unresponsive), it hands the work to a persistent Worker thread and
 * resolves a promise when the worker reports back.
 *
 * The Worker is spawned lazily on the first requestSync, so merely importing this
 * module (e.g. in tests, or transitively) never starts a thread.
 */
import { state } from '../state';
import type { FeedId } from '../types/gtfs';

type WorkerReply = { id: number; feed: FeedId; ok: boolean; error?: string };

/** Minimal structural type of a Worker so tests can inject a fake (no real thread). */
export interface SyncWorkerLike {
  postMessage(message: { id: number; feed: FeedId }): void;
  onmessage: ((event: { data: WorkerReply }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  terminate?: () => void;
}

export type WorkerFactory = () => SyncWorkerLike;

const defaultFactory: WorkerFactory = () =>
  new Worker(new URL('./syncWorker.ts', import.meta.url)) as unknown as SyncWorkerLike;

export function createSyncManager(factory: WorkerFactory = defaultFactory) {
  let worker: SyncWorkerLike | null = null;
  let nextId = 1;
  const pending = new Map<number, { feed: FeedId; resolve: () => void; reject: (e: Error) => void }>();

  function handleReply(reply: WorkerReply) {
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    state.syncing[entry.feed] = false;
    if (reply.ok) entry.resolve();
    else entry.reject(new Error(reply.error ?? `sync ${entry.feed} failed`));
  }

  /** Reject every in-flight request and drop the worker so the next call respawns. */
  function failAll(err: Error) {
    for (const [id, entry] of pending) {
      state.syncing[entry.feed] = false;
      entry.reject(err);
      pending.delete(id);
    }
    worker = null;
  }

  function ensureWorker(): SyncWorkerLike {
    if (worker) return worker;
    const w = factory();
    w.onmessage = (event) => handleReply(event.data);
    if (w.addEventListener) {
      w.addEventListener('error', () => failAll(new Error('sync worker errored')));
      w.addEventListener('close', () => failAll(new Error('sync worker exited')));
    } else {
      w.onerror = () => failAll(new Error('sync worker errored'));
    }
    worker = w;
    return w;
  }

  /** Dispatch a feed sync to the worker; resolves when it completes, rejects on failure. */
  function requestSync(feed: FeedId): Promise<void> {
    const w = ensureWorker();
    const id = nextId++;
    state.syncing[feed] = true;
    return new Promise<void>((resolve, reject) => {
      pending.set(id, { feed, resolve, reject });
      w.postMessage({ id, feed });
    });
  }

  return { requestSync };
}

export const syncManager = createSyncManager();
export const requestSync = (feed: FeedId): Promise<void> => syncManager.requestSync(feed);
