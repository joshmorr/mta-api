import { describe, expect, it, beforeEach } from 'bun:test';
import { createSyncManager, type SyncWorkerLike } from '../../services/syncManager';
import { state } from '../../state';
import type { FeedId } from '../../types/gtfs';

type Reply = { id: number; feed: FeedId; ok: boolean; error?: string };

/** In-memory stand-in for a Worker — no real thread, no DB. */
class FakeWorker implements SyncWorkerLike {
  onmessage: ((event: { data: Reply }) => void) | null = null;
  posted: { id: number; feed: FeedId }[] = [];
  private listeners: Record<string, ((event: unknown) => void)[]> = {};

  postMessage(message: { id: number; feed: FeedId }) {
    this.posted.push(message);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  // --- test helpers ---
  reply(r: Reply) {
    this.onmessage?.({ data: r });
  }
  emit(type: string) {
    for (const l of this.listeners[type] ?? []) l(undefined);
  }
}

function makeManager() {
  const workers: FakeWorker[] = [];
  const factory = () => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  };
  return { manager: createSyncManager(factory), workers };
}

/** Await a promise expected to reject and return its error. */
async function catchReject(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected promise to reject, but it resolved');
}

describe('syncManager', () => {
  beforeEach(() => {
    state.syncing.subway = false;
    state.syncing.lirr = false;
    state.syncing.mnr = false;
  });

  it('marks a feed syncing, posts to the worker, and resolves on an ok reply', async () => {
    const { manager, workers } = makeManager();

    const p = manager.requestSync('subway');
    expect(state.syncing.subway).toBe(true);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toEqual([{ id: 1, feed: 'subway' }]);

    workers[0]!.reply({ id: 1, feed: 'subway', ok: true });
    expect(await p).toBeUndefined();
    expect(state.syncing.subway).toBe(false);
  });

  it('rejects with the worker error and clears the flag on a failed reply', async () => {
    const { manager, workers } = makeManager();

    const p = manager.requestSync('lirr');
    const { id } = workers[0]!.posted[0]!;
    workers[0]!.reply({ id, feed: 'lirr', ok: false, error: 'HTTP 500' });

    const err = await catchReject(p);
    expect(err.message).toContain('HTTP 500');
    expect(state.syncing.lirr).toBe(false);
  });

  it('reuses one worker and resolves concurrent requests by id, even out of order', async () => {
    const { manager, workers } = makeManager();

    const pSubway = manager.requestSync('subway');
    const pMnr = manager.requestSync('mnr');
    expect(workers).toHaveLength(1); // single persistent worker
    const [first, second] = workers[0]!.posted;

    // Reply to the second request first — id matching must still route correctly.
    workers[0]!.reply({ id: second!.id, feed: 'mnr', ok: true });
    expect(await pMnr).toBeUndefined();
    expect(state.syncing.mnr).toBe(false);
    expect(state.syncing.subway).toBe(true); // still pending

    workers[0]!.reply({ id: first!.id, feed: 'subway', ok: true });
    expect(await pSubway).toBeUndefined();
    expect(state.syncing.subway).toBe(false);
  });

  it('rejects in-flight work on worker error and respawns on the next request', async () => {
    const { manager, workers } = makeManager();

    const p = manager.requestSync('subway');
    workers[0]!.emit('error');
    const err = await catchReject(p);
    expect(err.message).toMatch(/worker/);
    expect(state.syncing.subway).toBe(false);

    const p2 = manager.requestSync('mnr');
    expect(workers).toHaveLength(2); // spawned a fresh worker
    workers[1]!.reply({ id: workers[1]!.posted[0]!.id, feed: 'mnr', ok: true });
    expect(await p2).toBeUndefined();
  });
});
